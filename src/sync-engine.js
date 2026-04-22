"use strict";

const { Notice } = require("obsidian");
const { normalisePath, shouldIgnorePath, computeGitBlobSha, arrayBufferToBase64, base64ToArrayBuffer, buildCommitMessage, parallelBatch } = require("./utils");

// ─────────────────────────────────────────────────────────────────────
//  THREE-WAY SYNC ENGINE
// ─────────────────────────────────────────────────────────────────────

/**
 * Computes the three-way sync plan by comparing local state, remote state,
 * and the last-known-good cache (base).
 */
function buildSyncPlan(localEntries, remoteBlobs, cache, settings) {
  const plan = {
    toUpload: [],
    toDownload: [],
    toDeleteRemote: [],
    toDeleteLocal: [],
    conflicts: [],
    upToDate: [],
    toCleanCache: [],
  };

  const localMap = new Map();
  for (const e of localEntries) localMap.set(e.path, e);

  const remoteMap = new Map();
  for (const n of remoteBlobs) remoteMap.set(normalisePath(n.path), n.sha);

  const allPaths = new Set([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...Object.keys(cache),
  ]);

  for (const path of allPaths) {
    if (shouldIgnorePath(path, settings)) continue;

    const base = cache[path] || null;
    const local = localMap.get(path);
    const localSha = local ? local.sha : null;
    const remoteSha = remoteMap.get(path) || null;

    // Case 1: All identical
    if (localSha === remoteSha && localSha === base) {
      if (localSha) plan.upToDate.push(path);
      continue;
    }

    // Case 2: No base (first time seen)
    if (!base) {
      if (localSha && !remoteSha) {
        plan.toUpload.push(local);
      } else if (!localSha && remoteSha) {
        plan.toDownload.push({ path, sha: remoteSha });
      } else if (localSha && remoteSha) {
        if (localSha === remoteSha) plan.upToDate.push(path);
        else plan.conflicts.push({ path, localSha, remoteSha, baseSha: null });
      }
      // both null — ghost allPaths entry, skip
      continue;
    }

    // Case 3: Base exists
    const localUnchanged = localSha === base;
    const remoteUnchanged = remoteSha === base;

    if (localUnchanged && remoteUnchanged) {
      plan.upToDate.push(path);
    } else if (!localUnchanged && remoteUnchanged) {
      if (localSha) plan.toUpload.push(local);
      else plan.toDeleteRemote.push(path);
    } else if (localUnchanged && !remoteUnchanged) {
      if (remoteSha) plan.toDownload.push({ path, sha: remoteSha });
      else plan.toDeleteLocal.push(path);
    } else {
      // Both changed
      if (localSha === remoteSha) {
        if (!localSha && !remoteSha) plan.toCleanCache.push(path);
        else plan.upToDate.push(path);
      } else {
        plan.conflicts.push({ path, localSha, remoteSha, baseSha: base });
      }
    }
  }

  return plan;
}

/**
 * Mutates plan in-place: moves resolved conflicts into upload/download/delete queues.
 */
async function applyConflictResolutions(plan, resolutions, localBuffers, vault) {
  for (const conflict of [...plan.conflicts]) {
    const resolution = resolutions[conflict.path];
    if (!resolution) continue;

    switch (resolution) {
      case "keep-local":
        if (conflict.localSha) {
          const buf = localBuffers.get(conflict.path);
          if (buf) plan.toUpload.push({ path: conflict.path, sha: conflict.localSha, buf });
          else console.warn(`[DGS] keep-local: missing buffer for "${conflict.path}"`);
        } else {
          plan.toDeleteRemote.push(conflict.path);
        }
        break;

      case "keep-remote":
        if (conflict.remoteSha) {
          plan.toDownload.push({ path: conflict.path, sha: conflict.remoteSha });
        } else {
          plan.toDeleteLocal.push(conflict.path);
        }
        break;

      case "keep-both": {
        if (conflict.localSha && conflict.remoteSha) {
          // Rename local file to a conflict copy, then download remote to original path
          const lastDot = conflict.path.lastIndexOf(".");
          const hasExt = lastDot > conflict.path.lastIndexOf("/");
          const ext = hasExt ? conflict.path.slice(lastDot) : "";
          const base = hasExt ? conflict.path.slice(0, lastDot) : conflict.path;
          const dateStr = new Date().toISOString().slice(0, 10);
          const newPath = `${base} (Local Conflict ${dateStr})${ext}`;

          const file = vault.getAbstractFileByPath(conflict.path);
          if (file) {
            try {
              await vault.rename(file, newPath);
              const renamedBuf = await vault.adapter.readBinary(newPath);
              const renamedSha = await computeGitBlobSha(renamedBuf);
              plan.toUpload.push({ path: newPath, sha: renamedSha, buf: renamedBuf });
            } catch (renameErr) {
              console.warn(`[DGS] keep-both rename failed for "${conflict.path}": ${renameErr.message}`);
              // Fall back to keep-local
              const buf = localBuffers.get(conflict.path);
              if (buf) plan.toUpload.push({ path: conflict.path, sha: conflict.localSha, buf });
            }
          }
          plan.toDownload.push({ path: conflict.path, sha: conflict.remoteSha });
        } else if (conflict.localSha) {
          const buf = localBuffers.get(conflict.path);
          if (buf) plan.toUpload.push({ path: conflict.path, sha: conflict.localSha, buf });
        } else if (conflict.remoteSha) {
          plan.toDownload.push({ path: conflict.path, sha: conflict.remoteSha });
        }
        break;
      }
    }
  }
  plan.conflicts = [];
}

/**
 * Executes a fully-resolved sync plan: downloads, deletes, uploads, commits.
 */
async function executeSyncPlan(
  plan, client, concurrency, commitSha, treeSha,
  remoteTree, localEntries, cache, setMsg, silent, vault, settings, saveSettingsFn
) {
  const newCache = { ...cache };
  let downloaded = 0, uploaded = 0, deletedLocal = 0, deletedRemote = 0;

  // Nothing to do?
  if (
    plan.toUpload.length === 0 &&
    plan.toDownload.length === 0 &&
    plan.toDeleteRemote.length === 0 &&
    plan.toDeleteLocal.length === 0
  ) {
    setMsg("Sync: already up to date.");
    for (const e of localEntries) newCache[e.path] = e.sha;
    for (const p of plan.toCleanCache) delete newCache[p];
    settings.syncCache = newCache;
    settings.lastKnownRemoteCommit = commitSha;
    settings.lastSyncTime = Date.now();
    await saveSettingsFn();
    return;
  }

  // ── Downloads ──
  if (plan.toDownload.length > 0) {
    setMsg(`Sync: downloading ${plan.toDownload.length} file(s)…`);
    const folders = remoteTree.filter((n) => n.type === "tree");
    for (const folder of folders) {
      const fp = normalisePath(folder.path);
      if (shouldIgnorePath(fp, settings)) continue;
      if (!vault.getAbstractFileByPath(fp)) {
        try { await vault.createFolder(fp); } catch { /* exists */ }
      }
    }
    const dlResults = await parallelBatch(plan.toDownload, concurrency, async (item) => {
      const fp = item.path;
      const b64 = await client.getBlob(item.sha);
      const buf = base64ToArrayBuffer(b64);
      const existing = vault.getAbstractFileByPath(fp);
      if (existing) {
        await vault.adapter.writeBinary(fp, buf);
      } else {
        const parts = fp.split("/");
        if (parts.length > 1) {
          const dir = parts.slice(0, -1).join("/");
          if (!vault.getAbstractFileByPath(dir)) {
            try { await vault.createFolder(dir); } catch { /* exists */ }
          }
        }
        await vault.createBinary(fp, buf);
      }
      downloaded++;
      setMsg(`Sync: downloading… ${downloaded}/${plan.toDownload.length}`);
      return { path: fp, sha: item.sha };
    });
    for (const r of dlResults) { if (r.ok) newCache[r.value.path] = r.value.sha; }
    const dlFailed = dlResults.filter((r) => !r.ok);
    if (dlFailed.length > 0 && !silent)
      new Notice(`${dlFailed.length} file(s) failed to download.`, 8000);
  }

  // ── Local deletions ──
  if (plan.toDeleteLocal.length > 0) {
    setMsg(`Sync: removing ${plan.toDeleteLocal.length} local file(s) deleted remotely…`);
    for (const fp of plan.toDeleteLocal) {
      try {
        const existing = vault.getAbstractFileByPath(fp);
        if (existing) await vault.trash(existing, true);
        delete newCache[fp];
        deletedLocal++;
      } catch (e) {
        console.warn(`[DGS] Could not delete "${fp}": ${e.message}`);
      }
    }
  }

  // ── Uploads ──
  let uploadedEntries = [];
  if (plan.toUpload.length > 0) {
    setMsg(`Sync: uploading ${plan.toUpload.length} file(s)…`);
    const ulResults = await parallelBatch(plan.toUpload, concurrency, async (item) => {
      const b64 = arrayBufferToBase64(item.buf);
      const blobSha = await client.createBlob(b64);
      uploaded++;
      setMsg(`Sync: uploading… ${uploaded}/${plan.toUpload.length}`);
      return { path: item.path, sha: blobSha };
    });
    uploadedEntries = ulResults.filter((r) => r.ok).map((r) => r.value);
    for (const e of uploadedEntries) newCache[e.path] = e.sha;
    const ulFailed = ulResults.filter((r) => !r.ok);
    if (ulFailed.length > 0 && !silent)
      new Notice(`${ulFailed.length} file(s) failed to upload.`, 8000);
  }

  // ── Commit ──
  let newCommitSha = commitSha;
  if (uploadedEntries.length > 0 || plan.toDeleteRemote.length > 0) {
    setMsg("Sync: creating commit…");
    const treeItems = uploadedEntries.map((f) => ({
      path: f.path, mode: "100644", type: "blob", sha: f.sha,
    }));
    const newTreeSha = await client.createTree(treeSha, treeItems, plan.toDeleteRemote);
    const msg = buildCommitMessage(settings.deviceName);
    newCommitSha = await client.createCommit(msg, newTreeSha, commitSha);
    setMsg("Sync: updating branch ref…");
    await client.updateRef(newCommitSha);
    for (const dp of plan.toDeleteRemote) delete newCache[dp];
    deletedRemote = plan.toDeleteRemote.length;
  }

  // Refresh cache for confirmed-upToDate files
  for (const path of plan.upToDate) {
    const localEntry = localEntries.find((e) => e.path === path);
    if (localEntry) newCache[path] = localEntry.sha;
  }
  for (const p of plan.toCleanCache) delete newCache[p];

  // Persist
  settings.syncCache = newCache;
  settings.lastKnownRemoteCommit = newCommitSha;
  settings.lastSyncTime = Date.now();
  await saveSettingsFn();

  // Summary
  const parts = [];
  if (downloaded > 0) parts.push(`${downloaded} downloaded`);
  if (uploaded > 0) parts.push(`${uploaded} uploaded`);
  if (deletedLocal > 0) parts.push(`${deletedLocal} deleted locally`);
  if (deletedRemote > 0) parts.push(`${deletedRemote} deleted remotely`);
  const summary = parts.length > 0 ? parts.join(", ") : "already up to date";
  setMsg(`Sync complete — ${summary}.`);
}

module.exports = { buildSyncPlan, applyConflictResolutions, executeSyncPlan };
