"use strict";

const { computeGitBlobSha, normalisePath } = require("./utils");

// ─────────────────────────────────────────────────────────────────────
//  Three-Way Conflict Detection & Resolution
//
//  Used by both Push and Pull to identify files that have diverged
//  between local, remote, and the last-known-good cache (base).
//
//  The "base" (syncCache) is the blob SHA of each file at the time of
//  the last successful push or pull. It is the common ancestor.
//
//  Conflict decision table (base = last synced SHA):
//
//   local  │ remote │ base   │ outcome
//  ────────┼────────┼────────┼───────────────────────────────────────
//   ==base │ ==base │ any    │ up to date — nothing to do
//   !=base │ ==base │ any    │ local changed only → upload / del-remote
//   ==base │ !=base │ any    │ remote changed only → download / del-local
//   !=base │ !=base │ any    │ both changed → CONFLICT
//   local  │ null   │ null   │ local-only new file → upload
//   null   │ remote │ null   │ remote-only new file → download
//   local  │ remote │ null   │ both created with diff content → CONFLICT
//   local  │ remote │ null   │ both created with same content → up to date
// ─────────────────────────────────────────────────────────────────────

/**
 * Classify every path that appears in local, remote, or cache into one of:
 *   toUpload       — { path, sha, buf }
 *   toDownload     — { path, sha }
 *   toDeleteRemote — path string
 *   toDeleteLocal  — path string
 *   conflicts      — { path, localSha, remoteSha, baseSha }
 *   upToDate       — path string
 *
 * @param {Array<{path, sha, buf}>} localEntries  — hashed local files
 * @param {Array<{path, sha}>}      remoteBlobs   — blobs from GitHub tree
 * @param {Object}                  cache         — settings.syncCache
 * @param {Object}                  settings      — plugin settings (for shouldIgnorePath)
 * @param {Function}                shouldIgnore  — shouldIgnorePath(path, settings)
 * @param {Set<string>}             [oversizedPaths] — paths of files >50 MB (invisible to diff)
 */
function buildDiffPlan(localEntries, remoteBlobs, cache, settings, shouldIgnore, oversizedPaths) {
  const plan = {
    toUpload:       [],   // { path, sha, buf }
    toDownload:     [],   // { path, sha }
    toDeleteRemote: [],   // path strings
    toDeleteLocal:  [],   // path strings
    conflicts:      [],   // { path, localSha, remoteSha, baseSha }
    upToDate:       [],   // path strings
  };

  const localMap  = new Map(localEntries.map((e) => [e.path, e]));
  const remoteMap = new Map(remoteBlobs.map((n) => [normalisePath(n.path), n.sha]));

  // Set of oversized paths to skip entirely — they exist on both sides
  // but are invisible to the local scan because of the size filter
  const skipSet = oversizedPaths || new Set();

  const allPaths = new Set([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...Object.keys(cache),
  ]);

  for (const path of allPaths) {
    if (shouldIgnore(path, settings)) continue;
    // Skip oversized files — they must not be treated as "deleted locally"
    if (skipSet.has(path)) continue;

    const base      = cache[path]          || null;
    const local     = localMap.get(path);
    const localSha  = local?.sha           || null;
    const remoteSha = remoteMap.get(path)  || null;

    // ── No base (first time this path is seen) ──────────────────────
    if (!base) {
      if (localSha && !remoteSha) {
        plan.toUpload.push(local);
      } else if (!localSha && remoteSha) {
        plan.toDownload.push({ path, sha: remoteSha });
      } else if (localSha && remoteSha) {
        if (localSha === remoteSha) plan.upToDate.push(path);
        else plan.conflicts.push({ path, localSha, remoteSha, baseSha: null });
      }
      // both null → ghost entry in allPaths, skip
      continue;
    }

    // ── Base exists ─────────────────────────────────────────────────
    const localChanged  = localSha  !== base;
    const remoteChanged = remoteSha !== base;

    if (!localChanged && !remoteChanged) {
      plan.upToDate.push(path);
    } else if (localChanged && !remoteChanged) {
      if (localSha) plan.toUpload.push(local);
      else          plan.toDeleteRemote.push(path);
    } else if (!localChanged && remoteChanged) {
      if (remoteSha) plan.toDownload.push({ path, sha: remoteSha });
      else           plan.toDeleteLocal.push(path);
    } else {
      // Both changed
      if (localSha === remoteSha) {
        plan.upToDate.push(path);               // same content, no conflict
      } else {
        plan.conflicts.push({ path, localSha, remoteSha, baseSha: base });
      }
    }
  }

  return plan;
}

/**
 * Apply user resolutions from ConflictResolutionModal into an existing plan.
 * Mutates plan.conflicts → empties it, pushing resolved items into other queues.
 *
 * @param {Object}   plan          — from buildDiffPlan
 * @param {Object}   resolutions   — { [path]: "keep-local" | "keep-remote" | "keep-both" }
 * @param {Map}      localBuffers  — path → ArrayBuffer
 * @param {Vault}    vault         — Obsidian vault
 */
async function applyResolutions(plan, resolutions, localBuffers, vault) {
  for (const conflict of [...plan.conflicts]) {
    const resolution = resolutions[conflict.path];
    if (!resolution) continue;

    switch (resolution) {
      case "keep-local": {
        if (conflict.localSha) {
          const buf = localBuffers.get(conflict.path);
          if (buf) plan.toUpload.push({ path: conflict.path, sha: conflict.localSha, buf });
          else console.warn(`[DGS] keep-local: missing buffer for "${conflict.path}"`);
        } else {
          plan.toDeleteRemote.push(conflict.path);
        }
        break;
      }

      case "keep-remote": {
        if (conflict.remoteSha) {
          plan.toDownload.push({ path: conflict.path, sha: conflict.remoteSha });
        } else {
          plan.toDeleteLocal.push(conflict.path);
        }
        break;
      }

      case "keep-both": {
        if (conflict.localSha && conflict.remoteSha) {
          // Rename the local file to a conflict copy, then download remote to the original path.
          const newPath = _uniqueConflictPath(conflict.path, vault);

          const file = vault.getAbstractFileByPath(conflict.path);
          if (file) {
            try {
              await vault.rename(file, newPath);
              const renamedBuf = await vault.adapter.readBinary(newPath);
              const renamedSha = await computeGitBlobSha(renamedBuf);
              plan.toUpload.push({ path: newPath, sha: renamedSha, buf: renamedBuf });
            } catch (renameErr) {
              console.warn(
                `[DGS] keep-both rename failed for "${conflict.path}": ${renameErr.message}. ` +
                `Falling back to keep-local.`
              );
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
 * Generate a unique conflict-copy filename.
 *
 * Handles:
 * - Normal files:  "folder/notes.md" → "folder/notes (Local Conflict 2026-04-24).md"
 * - Dotfiles:      "folder/.env"     → "folder/.env (Local Conflict 2026-04-24)"
 * - Collisions:    appends (2), (3), etc. until unique
 *
 * @param {string} origPath — original file path
 * @param {Vault}  vault    — Obsidian vault for existence checks
 * @returns {string} unique path for the conflict copy
 */
function _uniqueConflictPath(origPath, vault) {
  const dateStr   = new Date().toISOString().slice(0, 10);
  const slashIdx  = origPath.lastIndexOf("/");
  const fileName  = slashIdx >= 0 ? origPath.slice(slashIdx + 1) : origPath;
  const dirPrefix = slashIdx >= 0 ? origPath.slice(0, slashIdx + 1) : "";

  let baseName, ext;

  // Handle dotfiles (e.g. ".env", ".gitignore") — treat as extensionless
  if (fileName.startsWith(".") && fileName.indexOf(".", 1) === -1) {
    // Pure dotfile like ".env" — no separate extension
    baseName = fileName;
    ext      = "";
  } else {
    const lastDot = fileName.lastIndexOf(".");
    if (lastDot > 0) {
      baseName = fileName.slice(0, lastDot);
      ext      = fileName.slice(lastDot);
    } else {
      baseName = fileName;
      ext      = "";
    }
  }

  // Try without counter first, then increment
  for (let counter = 0; counter < 100; counter++) {
    const suffix = counter === 0
      ? `(Local Conflict ${dateStr})`
      : `(Local Conflict ${dateStr} ${counter + 1})`;
    const candidate = `${dirPrefix}${baseName} ${suffix}${ext}`;
    if (!vault.getAbstractFileByPath(candidate)) return candidate;
  }

  // Extremely unlikely fallback
  return `${dirPrefix}${baseName} (Local Conflict ${dateStr} ${Date.now()})${ext}`;
}

module.exports = { buildDiffPlan, applyResolutions };
