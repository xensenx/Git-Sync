"use strict";

const { Notice }                            = require("obsidian");
const { MAX_FILE_SIZE }                     = require("./constants");
const { parallelBatch, normalisePath, sanitisePath, computeGitBlobSha,
        arrayBufferToBase64, base64ToArrayBuffer, normaliseLineEndings,
        shouldIgnorePath, buildCommitMessage, sleep,
        detectCaseCollisions }              = require("./utils");
const { ConflictResolutionModal }           = require("./modals");
const { buildDiffPlan, applyResolutions }   = require("./conflict-resolver");

// ─────────────────────────────────────────────────────────────────────
//  PULL  (GitHub → Local)
//
//  Flow:
//    1. initRepoIfNeeded — bootstraps empty repos
//    2. Fetch latest remote commit + full tree
//    3. Hash all local files in parallel  (needed for conflict detection)
//       — buffers are NOT retained (prevents OOM on large vaults)
//    4. Build three-way diff plan (remote vs local vs cache)
//    5. If there are conflicts, show ConflictResolutionModal and wait
//    6. Execute downloads, local deletions, and any conflict-driven uploads
//       — cache is updated INCREMENTALLY as each file succeeds
//    7. Persist final syncCache + commit cursor
//
//  "Conflict" during a pull means a file has changed BOTH locally (since
//  the last sync) AND remotely (since the last sync).  The user chooses:
//    • Keep Local  — discard the incoming remote version
//    • Keep Remote — overwrite local with remote (standard pull behaviour)
//    • Keep Both   — rename local to a conflict copy, download remote
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {object}   opts.app           — Obsidian App
 * @param {object}   opts.client        — GitHubClient instance
 * @param {object}   opts.settings      — plugin settings (mutated in place)
 * @param {Function} opts.saveSettings  — async () => void
 * @param {Function} opts.onStatusChange — (state, detail?) => void
 */
async function executePull({ app, client, settings, saveSettings, onStatusChange }) {
  const vault       = app.vault;
  const concurrency = Math.max(1, settings.concurrency || 5);
  const status      = new Notice("Pull: connecting…", 0);
  const setMsg      = (msg) => status.setMessage(msg);

  try {
    // ── 1. Bootstrap ────────────────────────────────────────────────
    await client.initRepoIfNeeded();

    // ── 2. Fetch remote state ───────────────────────────────────────
    setMsg("Pull: fetching remote state…");
    const { commitSha, treeSha } = await client.getLatestCommit();
    const remoteTree  = await client.getFullTree(treeSha);

    // Sanitise remote paths — reject any with ".." traversals
    const remoteBlobs = [];
    let pathTraversalCount = 0;
    for (const n of remoteTree) {
      if (n.type !== "blob") continue;
      const safe = sanitisePath(n.path);
      if (!safe) { pathTraversalCount++; continue; }
      if (shouldIgnorePath(safe, settings)) continue;
      remoteBlobs.push({ path: safe, sha: n.sha });
    }
    if (pathTraversalCount > 0) {
      new Notice(
        `⚠️ ${pathTraversalCount} remote file(s) with unsafe paths (containing "..") were skipped.`,
        10000
      );
    }

    const remoteFolders = remoteTree.filter((n) => n.type === "tree");

    // Detect case-sensitivity collisions in remote tree
    const remotePaths = remoteBlobs.map((b) => b.path);
    const caseCollisions = detectCaseCollisions(remotePaths);
    const caseSkipPaths = new Set();
    if (caseCollisions.length > 0) {
      new Notice(
        `⚠️ ${caseCollisions.length} case-sensitivity collision(s) detected in remote repo. ` +
        `Duplicate variants will be skipped to prevent crashes.`,
        10000
      );
      for (const { variants } of caseCollisions) {
        // Keep the first variant, skip the rest
        for (let i = 1; i < variants.length; i++) {
          caseSkipPaths.add(variants[i]);
        }
      }
    }

    // Filter out case-collision duplicates
    const safeRemoteBlobs = remoteBlobs.filter((b) => !caseSkipPaths.has(b.path));

    // ── 3. Hash local files (NO buffer retention — prevents OOM) ────
    setMsg("Pull: reading local files…");
    const allLocalFiles = vault.getFiles().filter(
      (f) => !shouldIgnorePath(normalisePath(f.path), settings) && f.stat.size <= MAX_FILE_SIZE
    );

    // Collect oversized paths
    const oversizedPaths = new Set(
      vault.getFiles()
        .filter((f) => f.stat.size > MAX_FILE_SIZE && !shouldIgnorePath(normalisePath(f.path), settings))
        .map((f) => normalisePath(f.path))
    );

    const hashResults  = await parallelBatch(allLocalFiles, concurrency, async (file) => {
      const buf = await vault.readBinary(file);
      const normalised = normaliseLineEndings(buf, file.path);
      const sha = await computeGitBlobSha(normalised);
      // Do NOT retain buf — prevents OOM on large vaults
      return { path: normalisePath(file.path), sha };
    });

    const hashFailed   = hashResults.filter((r) => !r.ok);
    const localEntries = hashResults.filter((r) => r.ok).map((r) => r.value);
    if (hashFailed.length > 0)
      new Notice(`${hashFailed.length} local file(s) could not be read and were skipped.`, 6000);

    // ── 4. Three-way diff ───────────────────────────────────────────
    setMsg("Pull: analysing changes…");
    const cache = settings.syncCache || {};
    const plan  = buildDiffPlan(localEntries, safeRemoteBlobs, cache, settings, shouldIgnorePath, oversizedPaths);

    // ── 5. Conflict resolution ──────────────────────────────────────
    if (plan.conflicts.length > 0) {
      setMsg(`Pull: ${plan.conflicts.length} conflict(s) need resolution…`);
      await sleep(400);
      status.hide();

      // Tell the status bar we're waiting for the user, not actively syncing
      onStatusChange("waiting");

      // Read buffers only for conflicted files (needed for keep-local/keep-both)
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
          `Pull cancelled — ${plan.conflicts.length} conflict(s) unresolved. ` +
          `Pull again to retry.`,
          8000
        );
        onStatusChange("conflicts", `${plan.conflicts.length} unresolved`);
        return;
      }

      // Back to active syncing
      onStatusChange("syncing");
      await applyResolutions(plan, resolutions, localBuffers, vault);
    }

    // ── Nothing to do? ──────────────────────────────────────────────
    if (
      plan.toDownload.length    === 0 &&
      plan.toDeleteLocal.length === 0 &&
      plan.toUpload.length      === 0   // "keep-local" / "keep-both" may add uploads
    ) {
      setMsg("Pull: already up to date.");
      settings.lastKnownRemoteCommit = commitSha;
      settings.lastSyncTime          = Date.now();
      await saveSettings();
      onStatusChange("synced");
      setTimeout(() => status.hide(), 4000);
      return;
    }

    // ── 6a. Ensure remote folders exist locally ─────────────────────
    for (const folder of remoteFolders) {
      const fp = sanitisePath(folder.path);
      if (!fp) continue;
      if (shouldIgnorePath(fp, settings)) continue;
      if (!vault.getAbstractFileByPath(fp)) {
        try { await vault.createFolder(fp); } catch { /* already exists */ }
      }
    }

    // ── 6b. Downloads (with incremental cache updates) ──────────────
    let downloaded   = 0;
    const dlFailed   = [];
    const newCache   = { ...cache };

    if (plan.toDownload.length > 0) {
      setMsg(`Pull: downloading ${plan.toDownload.length} file(s)…`);
      const dlResults = await parallelBatch(plan.toDownload, concurrency, async (item) => {
        const b64 = await client.getBlob(item.sha);
        const buf = base64ToArrayBuffer(b64);
        await _writeFile(vault, item.path, buf);
        downloaded++;
        setMsg(`Pull: downloading… ${downloaded}/${plan.toDownload.length}`);
        return { path: item.path, sha: item.sha };
      });

      for (const r of dlResults) {
        if (r.ok) {
          // Incremental cache update — even if we crash later, these files
          // won't generate fake conflicts on the next sync
          newCache[r.value.path] = r.value.sha;
        } else {
          dlFailed.push(r.item?.path || "?");
          console.error(`[DGS] Download failed for "${r.item?.path}":`, r.error);
        }
      }

      // Persist cache incrementally after downloads complete
      if (downloaded > 0) {
        settings.syncCache = { ...settings.syncCache, ...newCache };
        await saveSettings();
      }

      if (dlFailed.length > 0)
        new Notice(`${dlFailed.length} file(s) failed to download: ${dlFailed.join(", ")}`, 10000);
    }

    // ── 6c. Local deletions ──────────────────────────────────────────
    let deletedLocally = 0;
    const deletedFolderCandidates = new Set(); // parent dirs to check after deletions

    if (plan.toDeleteLocal.length > 0) {
      setMsg(`Pull: removing ${plan.toDeleteLocal.length} file(s) deleted remotely…`);
      for (const fp of plan.toDeleteLocal) {
        try {
          const existing = vault.getAbstractFileByPath(fp);
          if (existing) await vault.trash(existing, true);
          delete newCache[fp];
          deletedLocally++;
          // Collect every ancestor dir of this file as a pruning candidate
          const parts = fp.split("/");
          for (let i = parts.length - 1; i > 0; i--) {
            deletedFolderCandidates.add(parts.slice(0, i).join("/"));
          }
        } catch (e) {
          console.warn(`[DGS] Could not remove "${fp}": ${e.message}`);
        }
      }

      // Prune folders that are now empty, deepest first (longest path first)
      // Use adapter.list() for accurate filesystem state instead of Obsidian's
      // cached children array, which may not include hidden OS files and may
      // have stale references due to race conditions
      const sortedDirs = [...deletedFolderCandidates].sort((a, b) => b.length - a.length);
      // Small delay to let the filesystem catch up with the trash operations
      if (sortedDirs.length > 0) await sleep(200);

      for (const dir of sortedDirs) {
        if (shouldIgnorePath(dir, settings)) continue;
        // Skip if remote still has files under this folder
        const remoteStillHas = safeRemoteBlobs.some((rb) => rb.path.startsWith(dir + "/"));
        if (remoteStillHas) continue;

        try {
          // Use adapter.list() to check actual filesystem contents
          // This catches hidden OS files (.DS_Store, desktop.ini) that
          // Obsidian's getAbstractFileByPath().children would miss
          const listing = await vault.adapter.list(dir);
          const isEmpty = (!listing.files || listing.files.length === 0) &&
                          (!listing.folders || listing.folders.length === 0);
          if (isEmpty) {
            const folder = vault.getAbstractFileByPath(dir);
            if (folder) {
              try { await vault.trash(folder, true); } catch { /* ignore */ }
            }
          }
        } catch {
          // Directory might already be deleted — ignore
        }
      }
    }

    // ── 6d. Conflict-driven uploads (keep-local / keep-both) ─────────
    //   When the user chose "Keep Local" or "Keep Both", applyResolutions()
    //   queued those files into plan.toUpload. We upload the blobs, create a
    //   commit on top of the downloads we just did, and record the new blob
    //   SHAs in the cache so the next push/pull won't re-detect them as changed.
    let uploadedByConflict = 0;
    let finalCommitSha = commitSha;   // track the latest commit for cache persistence

    if (plan.toUpload.length > 0) {
      setMsg(`Pull: uploading ${plan.toUpload.length} conflict-resolved file(s)…`);

      // Read buffers for upload entries that don't have them yet
      for (const entry of plan.toUpload) {
        if (entry.buf) continue;
        const file = vault.getAbstractFileByPath(entry.path);
        if (file) {
          try {
            const raw = await vault.readBinary(file);
            entry.buf = normaliseLineEndings(raw, entry.path);
          } catch { /* skip */ }
        }
      }

      const uploadable = plan.toUpload.filter((e) => e.buf);
      const ulResults = await parallelBatch(uploadable, concurrency, async (entry) => {
        const b64     = arrayBufferToBase64(entry.buf);
        const blobSha = await client.createBlob(b64);
        uploadedByConflict++;
        return { path: entry.path, sha: blobSha };
      });

      // Build a commit for these conflict-resolved uploads
      const uploaded = ulResults.filter((r) => r.ok).map((r) => r.value);
      const ulFailed = ulResults.filter((r) => !r.ok);

      if (ulFailed.length > 0)
        new Notice(`${ulFailed.length} conflict-resolved file(s) failed to upload.`, 8000);

      if (uploaded.length > 0) {
        // Re-fetch the latest commit so our tree is based on the state
        // that already includes any files we just downloaded (step 6b).
        const { commitSha: latestSha, treeSha: latestTree } = await client.getLatestCommit();
        const treeItems    = uploaded.map((f) => ({
          path: f.path, mode: "100644", type: "blob", sha: f.sha,
        }));
        const newTreeSha   = await client.createTree(latestTree, treeItems, []);
        const msg          = buildCommitMessage(settings.deviceName);
        const newCommitSha = await client.createCommit(msg, newTreeSha, latestSha);
        await client.updateRef(newCommitSha);

        // Track the actual latest commit SHA for cache persistence
        finalCommitSha = newCommitSha;

        // Record the blob SHAs we committed. Do this BEFORE the remote-blob
        // sweep below so these paths are not overwritten with the old remote SHA.
        for (const f of uploaded) newCache[f.path] = f.sha;
      }
    }

    // ── 7. Persist cache ────────────────────────────────────────────
    //
    // Build the final cache in three passes, lowest-to-highest priority:
    //
    //   1. Remote blob SHAs   — the new ground truth for everything we pulled
    //   2. upToDate paths     — local SHA confirmed identical to remote
    //   3. Conflict-upload SHAs — already written above; do NOT overwrite
    //      them here. Skip any path already set in newCache that differs from
    //      the remote tree (those are conflict copies / keep-local files).
    //
    // Pass 1: seed from remote
    for (const rb of safeRemoteBlobs) {
      if (!shouldIgnorePath(rb.path, settings)) {
        // Only set if we haven't already recorded a more-specific SHA above
        // (i.e. a conflict upload that was just committed).
        if (!newCache[rb.path] || newCache[rb.path] === cache[rb.path]) {
          newCache[rb.path] = rb.sha;
        }
      }
    }
    // Pass 2: confirm upToDate entries use their local SHA
    //  (local SHA === remote SHA for these, so it's the same value — but
    //   writing it explicitly is safer against any future tree-SHA vs blob-SHA confusion)
    for (const path of plan.upToDate) {
      const local = localEntries.find((e) => e.path === path);
      if (local) newCache[path] = local.sha;
    }
    // Pass 3: prune cache for locally deleted files not on remote
    const localPathSet = new Set(localEntries.map((e) => e.path));
    const remotePathSet = new Set(safeRemoteBlobs.map((r) => r.path));
    for (const cachedPath of Object.keys(newCache)) {
      if (!localPathSet.has(cachedPath) && !remotePathSet.has(cachedPath) && !oversizedPaths.has(cachedPath)) {
        delete newCache[cachedPath];
      }
    }

    settings.syncCache             = newCache;
    // Use the latest commit SHA (may be a conflict-upload commit, not the original)
    settings.lastKnownRemoteCommit = finalCommitSha;
    settings.lastSyncTime          = Date.now();
    await saveSettings();

    // ── Summary ─────────────────────────────────────────────────────
    const parts = [];
    if (downloaded > 0)       parts.push(`${downloaded} downloaded`);
    if (deletedLocally > 0)   parts.push(`${deletedLocally} deleted locally`);
    if (uploadedByConflict > 0) parts.push(`${uploadedByConflict} conflict copies uploaded`);
    if (dlFailed.length > 0)  parts.push(`${dlFailed.length} failed`);

    setMsg(`Pull complete — ${parts.length > 0 ? parts.join(", ") : "already up to date"}.`);
    onStatusChange("synced");
    setTimeout(() => status.hide(), 6000);

  } catch (e) {
    console.error("[DGS] Pull error:", e);
    const msg = _humaniseError(e);
    setMsg(`Pull failed: ${msg}`);
    onStatusChange(e.status === 0 ? "offline" : "error", msg);
    setTimeout(() => status.hide(), 12000);
  }
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/**
 * Write a binary buffer to a vault path, creating ALL ancestor folders as needed.
 * Overwrites if the file exists; creates if not.
 * Rejects paths containing ".." for security.
 */
async function _writeFile(vault, filePath, buf) {
  // Security: reject path traversal
  const safe = sanitisePath(filePath);
  if (!safe) {
    throw new Error(`Refusing to write file with unsafe path: "${filePath}"`);
  }

  const existing = vault.getAbstractFileByPath(safe);
  if (existing) {
    await vault.adapter.writeBinary(safe, buf);
    return;
  }

  // Create ALL ancestor directories, not just the immediate parent
  const parts = safe.split("/");
  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!vault.getAbstractFileByPath(dir)) {
        try { await vault.createFolder(dir); } catch { /* already exists */ }
      }
    }
  }
  await vault.createBinary(safe, buf);
}

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

module.exports = { executePull };
