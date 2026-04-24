"use strict";

const { Notice }                            = require("obsidian");
const { MAX_FILE_SIZE }                     = require("./constants");
const { parallelBatch, normalisePath, computeGitBlobSha, normaliseLineEndings,
        arrayBufferToBase64, shouldIgnorePath, buildCommitMessage, sleep,
        detectCaseCollisions } = require("./utils");
const { ForcePushModal, ConflictResolutionModal } = require("./modals");
const { buildDiffPlan, applyResolutions }   = require("./conflict-resolver");

// ─────────────────────────────────────────────────────────────────────
//  PUSH  (Local → GitHub)
//
//  Flow:
//    1. initRepoIfNeeded — bootstraps empty repos
//    2. Fetch latest remote commit + full tree
//    3. Safety gate: if remote has moved since our last sync, show
//       ForcePushModal before proceeding (unless forcePush = true)
//    4. Hash all local files in parallel (WITHOUT retaining buffers)
//    5. Build three-way diff plan (local vs remote vs cache)
//    6. If there are conflicts, show ConflictResolutionModal and wait
//    7. Read buffers ONLY for files that need uploading
//    8. Upload changed blobs in parallel (with rate-limit awareness)
//    9. Create tree, commit, update ref
//   10. Persist updated syncCache + commit cursor
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {object}   opts.app         — Obsidian App
 * @param {object}   opts.client      — GitHubClient instance
 * @param {object}   opts.settings    — plugin settings (mutated in place)
 * @param {Function} opts.saveSettings — async () => void
 * @param {Function} opts.onStatusChange — (state, detail?) => void
 * @param {boolean}  [opts.forcePush=false] — skip the remote-ahead guard
 */
async function executePush({ app, client, settings, saveSettings, onStatusChange, forcePush = false }) {
  const vault       = app.vault;
  const concurrency = Math.max(1, settings.concurrency || 5);
  const status      = new Notice("Push: connecting…", 0);
  const setMsg      = (msg) => status.setMessage(msg);

  try {
    // ── 1. Bootstrap ────────────────────────────────────────────────
    const initialised = await client.initRepoIfNeeded();
    if (initialised) {
      setMsg("Push: initialised empty repository.");
      await sleep(800);
    }

    // ── 2. Fetch remote state ───────────────────────────────────────
    setMsg("Push: reading remote state…");
    const { commitSha, treeSha } = await client.getLatestCommit();
    const remoteTree  = await client.getFullTree(treeSha);
    const remoteBlobs = remoteTree
      .filter((n) => n.type === "blob" && !shouldIgnorePath(normalisePath(n.path), settings))
      .map((n) => ({ path: normalisePath(n.path), sha: n.sha }));

    // ── 3. Safety gate: remote has advanced since last sync ─────────
    const remoteAhead = (
      settings.lastKnownRemoteCommit &&
      settings.lastKnownRemoteCommit !== commitSha
    );

    if (!forcePush && remoteAhead) {
      status.hide();
      await new Promise((resolve) => {
        new ForcePushModal(
          app,
          commitSha,
          () => { resolve("force"); },
          () => { resolve("cancel"); }
        ).open();
      }).then(async (decision) => {
        if (decision === "force") {
          // Re-run with force flag — starts a fresh push
          await executePush({ app, client, settings, saveSettings, onStatusChange, forcePush: true });
        } else {
          new Notice("Push cancelled. Pull first to incorporate remote changes.", 6000);
          onStatusChange("idle");
        }
      });
      return;
    }

    // ── 4. Scan & hash local files (phase 1: hash only, no buffers retained) ──
    const allFiles   = vault.getFiles();
    const oversized  = allFiles.filter(
      (f) => f.stat.size > MAX_FILE_SIZE && !shouldIgnorePath(normalisePath(f.path), settings)
    );
    const localFiles = allFiles.filter(
      (f) => !shouldIgnorePath(normalisePath(f.path), settings) && f.stat.size <= MAX_FILE_SIZE
    );

    // Collect oversized paths so the diff engine skips them (prevents >50MB deletion bug)
    const oversizedPaths = new Set(oversized.map((f) => normalisePath(f.path)));

    if (oversized.length > 0)
      new Notice(`${oversized.length} file(s) over 50 MB were skipped (GitHub limit).`, 6000);

    if (localFiles.length === 0) {
      setMsg("Push: nothing to push — vault is empty.");
      onStatusChange("synced");
      setTimeout(() => status.hide(), 4000);
      return;
    }

    // Phase 1: Hash all files but do NOT keep buffers in memory (prevents OOM)
    setMsg(`Push: hashing ${localFiles.length} local file(s)…`);
    const hashResults  = await parallelBatch(localFiles, concurrency, async (file) => {
      const buf = await vault.readBinary(file);
      const normalised = normaliseLineEndings(buf, file.path);
      const sha = await computeGitBlobSha(normalised);
      // Only return path + sha — buffer is discarded to save memory
      return { path: normalisePath(file.path), sha };
    });

    const hashFailed   = hashResults.filter((r) => !r.ok);
    const localEntries = hashResults.filter((r) => r.ok).map((r) => r.value);
    if (hashFailed.length > 0)
      new Notice(`${hashFailed.length} file(s) could not be read and were skipped.`, 8000);

    if (localEntries.length === 0) {
      setMsg("Push failed — no local files could be read.");
      onStatusChange("error", "No files readable");
      setTimeout(() => status.hide(), 8000);
      return;
    }

    // ── 5. Three-way diff ───────────────────────────────────────────
    setMsg("Push: analysing changes…");
    const cache = settings.syncCache || {};
    const plan  = buildDiffPlan(localEntries, remoteBlobs, cache, settings, shouldIgnorePath, oversizedPaths);

    // ── 6. Conflict resolution ──────────────────────────────────────
    if (plan.conflicts.length > 0) {
      setMsg(`Push: ${plan.conflicts.length} conflict(s) need resolution…`);
      await sleep(400);
      status.hide();

      // Tell the status bar we're waiting for the user, not actively syncing
      onStatusChange("waiting");

      // Read buffers only for conflicted files (needed for keep-local / keep-both)
      const localBuffers = new Map();
      for (const c of plan.conflicts) {
        if (c.localSha) {
          const file = vault.getAbstractFileByPath(c.path);
          if (file) {
            try {
              const buf = await vault.readBinary(file);
              localBuffers.set(c.path, normaliseLineEndings(buf, c.path));
            } catch { /* skip */ }
          }
        }
      }

      const resolutions = await new Promise((resolve) => {
        new ConflictResolutionModal(
          app,
          plan.conflicts,
          (res) => resolve(res),
          ()    => resolve(null)
        ).open();
      });

      if (!resolutions) {
        new Notice(
          `Push cancelled — ${plan.conflicts.length} conflict(s) unresolved. ` +
          `Push again to retry.`,
          8000
        );
        onStatusChange("conflicts", `${plan.conflicts.length} unresolved`);
        return;
      }

      // Back to active syncing
      onStatusChange("syncing");
      await applyResolutions(plan, resolutions, localBuffers, vault);
    }

    // ── Nothing to do after conflict resolution? ────────────────────
    if (plan.toUpload.length === 0 && plan.toDeleteRemote.length === 0 &&
        plan.toDownload.length === 0 && plan.toDeleteLocal.length === 0) {
      setMsg("Push: already up to date — no local changes.");
      settings.lastKnownRemoteCommit = commitSha;
      settings.lastSyncTime          = Date.now();
      await saveSettings();
      onStatusChange("synced");
      setTimeout(() => status.hide(), 4000);
      return;
    }

    // ── 7. Read buffers for files that need uploading ───────────────
    //   (Phase 2: only read what we actually need to push)
    setMsg(`Push: reading ${plan.toUpload.length} file(s) to upload…`);
    for (const entry of plan.toUpload) {
      if (entry.buf) continue; // already has a buffer (from conflict resolution)
      const file = vault.getAbstractFileByPath(entry.path);
      if (file) {
        try {
          const raw = await vault.readBinary(file);
          entry.buf = normaliseLineEndings(raw, entry.path);
        } catch (e) {
          console.warn(`[DGS] Could not read "${entry.path}" for upload: ${e.message}`);
        }
      }
    }

    // Filter out entries where we failed to read the buffer
    const uploadable = plan.toUpload.filter((e) => e.buf);
    const readFailed = plan.toUpload.length - uploadable.length;
    if (readFailed > 0)
      new Notice(`${readFailed} file(s) could not be read for upload.`, 6000);

    // Abort if nothing can be uploaded and there are no deletions
    if (uploadable.length === 0 && plan.toDeleteRemote.length === 0) {
      setMsg("Push failed — no files could be prepared for upload.");
      onStatusChange("error", "No files to push");
      setTimeout(() => status.hide(), 8000);
      return;
    }

    // ── 8. Upload blobs in parallel (with inter-batch delay for rate limits) ──
    let uploadCount = 0;
    const uploadResults = await parallelBatch(uploadable, concurrency, async (entry) => {
      const b64     = arrayBufferToBase64(entry.buf);
      const blobSha = await client.createBlob(b64);
      uploadCount++;
      setMsg(`Push: uploading… ${uploadCount}/${uploadable.length}`);
      return { path: entry.path, sha: blobSha };
    });

    const uploadFailed  = uploadResults.filter((r) => !r.ok);
    const uploadedFiles = uploadResults.filter((r) => r.ok).map((r) => r.value);

    if (uploadFailed.length > 0) {
      const names = uploadFailed.map((r) => r.item?.path || "?").join(", ");
      new Notice(`${uploadFailed.length} file(s) failed to upload: ${names}`, 10000);
    }

    // Abort if every upload failed — don't create an empty / wrong commit
    if (uploadedFiles.length === 0 && uploadable.length > 0) {
      setMsg("Push failed — no files could be uploaded to GitHub.");
      onStatusChange("error", "All uploads failed");
      setTimeout(() => status.hide(), 10000);
      return;
    }

    // ── 9. Commit ───────────────────────────────────────────────────
    const deletionNote = plan.toDeleteRemote.length > 0
      ? ` (removing ${plan.toDeleteRemote.length} file(s) from remote)`
      : "";
    setMsg(`Push: creating commit${deletionNote}…`);

    const treeItems = uploadedFiles.map((f) => ({
      path: f.path, mode: "100644", type: "blob", sha: f.sha,
    }));

    // Force push: use force=true on ref update so it succeeds even if remote diverged
    const newTreeSha   = await client.createTree(treeSha, treeItems, plan.toDeleteRemote);
    const commitMsg    = buildCommitMessage(settings.deviceName);
    const newCommitSha = await client.createCommit(commitMsg, newTreeSha, commitSha);
    setMsg("Push: updating branch ref…");
    await client.updateRef(newCommitSha, forcePush);

    // ── 10. Persist cache ───────────────────────────────────────────
    //
    // Priority order, lowest → highest:
    //   1. Remote blob SHAs   — ground truth for everything we know remotely
    //   2. upToDate paths     — confirm local SHA (equals remote, but explicit)
    //   3. Uploaded blob SHAs — the exact SHA GitHub stored for each upload
    //   4. Remove deleted paths
    //   5. Prune orphaned cache keys (files deleted locally)
    //
    const newCache = { ...cache };

    // Pass 1 — remote tree
    for (const rb of remoteBlobs) {
      if (!shouldIgnorePath(rb.path, settings)) newCache[rb.path] = rb.sha;
    }
    // Pass 2 — unchanged files (local SHA === remote SHA)
    for (const path of plan.upToDate) {
      const local = localEntries.find((e) => e.path === path);
      if (local) newCache[path] = local.sha;
    }
    // Pass 3 — freshly uploaded files (blob SHA from GitHub)
    for (const f of uploadedFiles) newCache[f.path] = f.sha;
    // Pass 4 — purge remote deletions
    for (const dp of plan.toDeleteRemote) delete newCache[dp];
    // Pass 5 — prune orphaned cache keys (locally deleted files that aren't remote)
    const localPathSet = new Set(localEntries.map((e) => e.path));
    const remotePathSet = new Set(remoteBlobs.map((r) => r.path));
    for (const cachedPath of Object.keys(newCache)) {
      if (!localPathSet.has(cachedPath) && !remotePathSet.has(cachedPath) && !oversizedPaths.has(cachedPath)) {
        delete newCache[cachedPath];
      }
    }

    settings.syncCache             = newCache;
    settings.lastKnownRemoteCommit = newCommitSha;
    settings.lastSyncTime          = Date.now();
    await saveSettings();

    // ── Summary ─────────────────────────────────────────────────────
    const parts = [];
    if (uploadedFiles.length    > 0) parts.push(`${uploadedFiles.length} uploaded`);
    if (plan.toDeleteRemote.length > 0) parts.push(`${plan.toDeleteRemote.length} deleted from remote`);
    if (plan.upToDate.length    > 0) parts.push(`${plan.upToDate.length} unchanged`);
    if (uploadFailed.length     > 0) parts.push(`${uploadFailed.length} failed`);

    setMsg(`Push complete — ${parts.join(", ")}.`);
    onStatusChange("synced");
    setTimeout(() => status.hide(), 6000);

  } catch (e) {
    console.error("[DGS] Push error:", e);
    const msg = _humaniseError(e);
    setMsg(`Push failed: ${msg}`);
    onStatusChange(e.status === 0 ? "offline" : "error", msg);
    setTimeout(() => status.hide(), 12000);
  }
}

/** Turn raw errors into something readable in the status notice. */
function _humaniseError(e) {
  if (e.status === 0)   return "Network error — check your connection.";
  if (e.status === 401) return "Authentication failed — check your PAT.";
  if (e.status === 403) {
    const msg = (e.ghMessage || e.message || "").toLowerCase();
    if (msg.includes("rate limit") || msg.includes("abuse") || msg.includes("secondary"))
      return "GitHub rate limit hit — wait a few minutes and retry.";
    return "Forbidden — PAT may lack 'repo' scope.";
  }
  if (e.status === 404) return "Repository or branch not found — check settings.";
  if (e.status === 409) return "Repository conflict — try again.";
  return e.message || "Unknown error";
}

module.exports = { executePush };
