"use strict";

const { Plugin, Notice } = require("obsidian");
const { DEFAULT_SETTINGS, MAX_SYNC_FILE_SIZE, PASSIVE_POLL_INTERVAL_MS } = require("./constants");
const {
  sleep, parallelBatch, normalisePath, computeGitBlobSha,
  shouldIgnorePath, arrayBufferToBase64, base64ToArrayBuffer,
  buildCommitMessage, formatRelativeTime,
} = require("./utils");
const { GitHubClient } = require("./github-client");
const { ConflictResolutionModal, ConflictModal } = require("./modals");
const { buildSyncPlan, applyConflictResolutions, executeSyncPlan } = require("./sync-engine");
const { DirectGitHubSyncSettingTab } = require("./settings-tab");

// ─────────────────────────────────────────────
//  Main Plugin Class
// ─────────────────────────────────────────────

class DirectGitHubSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // ── Ribbon icons ──
    this.addRibbonIcon("upload-cloud", "Push to GitHub", () => this.push());
    this.addRibbonIcon("download-cloud", "Pull from GitHub", () => this.pull());
    this.addRibbonIcon("refresh-cw", "Sync vault with GitHub", () => this.sync());

    // ── Commands ──
    this.addCommand({ id: "push-to-github", name: "Push vault to GitHub", callback: () => this.push() });
    this.addCommand({ id: "pull-from-github", name: "Pull vault from GitHub", callback: () => this.pull() });
    this.addCommand({ id: "sync-vault", name: "Sync vault with GitHub", callback: () => this.sync() });

    // ── Settings tab ──
    this.addSettingTab(new DirectGitHubSyncSettingTab(this.app, this));

    // ── Status bar ──
    this._isSyncing = false;
    this._statusBarState = "idle";
    this._statusBarDetail = "";
    this._pendingConflicts = null;
    this._initStatusBar();

    // ── Passive monitor ──
    this._passiveTimer = null;
    this._startPassiveMonitor();

    // ── Smart sync ──
    this._smartSyncTimeout = null;

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.syncOnStartup && this.settings.autoSyncEnabled && this._isConfigured()) {
        // Delay startup sync to let the vault fully index
        setTimeout(() => this.sync({ silent: true }), 6000);
      }
      this._initSmartSync();
    });

    console.log("[DGS] Plugin loaded.");
  }

  onunload() {
    if (this._passiveTimer) clearInterval(this._passiveTimer);
    if (this._smartSyncTimeout) clearTimeout(this._smartSyncTimeout);
    if (this._relativeTimeTimer) clearInterval(this._relativeTimeTimer);
    console.log("[DGS] Plugin unloaded.");
  }

  // ── Persistence ───────────────────────────────────────────────────────

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    // Guard against corrupted saves
    if (!this.settings.syncCache || typeof this.settings.syncCache !== "object") {
      this.settings.syncCache = {};
    }
    // Migrate old lastPulledShas → syncCache
    if (this.settings.lastPulledShas && Object.keys(this.settings.lastPulledShas).length > 0) {
      if (!this.settings.syncCache || Object.keys(this.settings.syncCache).length === 0) {
        this.settings.syncCache = { ...this.settings.lastPulledShas };
      }
      this.settings.lastPulledShas = {};
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    try {
      await this.saveData(this.settings);
    } catch (e) {
      console.error("[DGS] Failed to save settings:", e);
      // Don't throw — a settings-save failure must not abort an in-progress sync
    }
  }

  // ── Validation ────────────────────────────────────────────────────────

  _validate() {
    const s = this.settings;
    const issues = [];
    if (!s.pat) issues.push("Personal Access Token (PAT) is not set.");
    if (!s.username) issues.push("GitHub username is not set.");
    if (!s.repo) issues.push("Repository name is not set.");
    if (!s.branch) issues.push("Branch is not set.");
    if (issues.length > 0) {
      throw new Error(
        "Connection not configured — open plugin settings and click Configure Connection:\n• " +
          issues.join("\n• ")
      );
    }
    if (!/^(ghp_|github_pat_|gho_|ghs_|ghr_)/.test(s.pat))
      throw new Error("PAT format looks incorrect — it should start with 'ghp_' or 'github_pat_'.");
  }

  _isConfigured() {
    const s = this.settings;
    return !!(s.pat && s.username && s.repo && s.branch);
  }

  _client() {
    const s = this.settings;
    return new GitHubClient(s.pat, s.username, s.repo, s.branch);
  }

  // ── Status Bar ────────────────────────────────────────────────────────

  _initStatusBar() {
    const { setIcon } = require("obsidian");
    this._setIcon = setIcon;

    this._statusBarEl = this.addStatusBarItem();
    this._statusBarEl.addClass("dgs-statusbar-item");
    this._statusBarIconEl = this._statusBarEl.createSpan({ cls: "dgs-statusbar-icon" });
    this._statusBarTextEl = this._statusBarEl.createSpan({ cls: "dgs-statusbar-text" });
    this._statusBarEl.addEventListener("click", () => this._onStatusBarClick());
    this._updateStatusBar(this._isConfigured() ? "idle" : "unconfigured");

    // Update relative time every 30s
    this._relativeTimeTimer = window.setInterval(() => {
      if (this._statusBarState === "synced") this._updateStatusBar("synced");
    }, 30000);
  }

  _updateStatusBar(state, detail) {
    const { setIcon } = require("obsidian");
    this._statusBarState = state;
    if (detail !== undefined) this._statusBarDetail = detail;

    const el = this._statusBarEl;
    el.className = "dgs-statusbar-item";

    const icon = this._statusBarIconEl;
    const text = this._statusBarTextEl;
    icon.empty();

    const detailObj = (detail && typeof detail === "object") ? detail : {};
    const detailStr = (typeof detail === "string") ? detail : "";

    const states = {
      idle:           { icon: "cloud",          text: "DGS",                                                       cls: "dgs-sb-idle" },
      unconfigured:   { icon: "cloud-off",       text: "Not configured",                                            cls: "dgs-sb-unconfigured" },
      syncing:        { icon: "refresh-cw",      text: "Syncing…",                                                  cls: "dgs-sb-syncing" },
      synced:         { icon: "check-circle-2",  text: `Synced${this.settings.lastSyncTime ? " · " + formatRelativeTime(this.settings.lastSyncTime) : ""}`, cls: "dgs-sb-synced" },
      "local-ahead":  { icon: "upload-cloud",    text: detailObj.count ? `${detailObj.count} to push` : "Local changes", cls: "dgs-sb-local-ahead" },
      "remote-ahead": { icon: "download-cloud",  text: "Remote changes",                                            cls: "dgs-sb-remote-ahead" },
      diverged:       { icon: "git-compare",     text: `${detailObj.localAhead || "?"} local, remote changed`,    cls: "dgs-sb-diverged" },
      conflicts:      { icon: "git-merge",       text: detailStr || "Conflicts",                                    cls: "dgs-sb-conflicts" },
      error:          { icon: "alert-triangle",  text: "Sync error",                                                cls: "dgs-sb-error" },
      offline:        { icon: "wifi-off",        text: "Offline",                                                   cls: "dgs-sb-offline" },
    };

    const s = states[state] || states.idle;
    try { setIcon(icon, s.icon); } catch { icon.setText("•"); }
    text.setText(s.text);
    el.addClass(s.cls);
  }

  _onStatusBarClick() {
    if (this._statusBarState === "syncing") {
      new Notice("Sync is already in progress.", 3000);
      return;
    }
    if (this._statusBarState === "unconfigured") {
      new Notice("Connection not configured — open plugin settings.", 4000);
      return;
    }
    if (this._statusBarState === "error") {
      new Notice(`Last sync error: ${this._statusBarDetail || "Unknown error"}`, 8000);
      return;
    }
    if (this._statusBarState === "conflicts" && this._pendingConflicts) {
      this._resumePendingConflicts();
      return;
    }
    this.sync();
  }

  // ── Passive Monitor ───────────────────────────────────────────────────

  _startPassiveMonitor() {
    setTimeout(() => this._checkSyncStatus(), 10000);
    this._passiveTimer = window.setInterval(() => this._checkSyncStatus(), PASSIVE_POLL_INTERVAL_MS);
  }

  async _checkSyncStatus() {
    if (this._isSyncing) return;
    if (!this._isConfigured()) { this._updateStatusBar("unconfigured"); return; }

    try {
      const client = this._client();
      const { commitSha } = await client.getLatestCommit();

      const remoteAhead = !!(
        this.settings.lastKnownRemoteCommit &&
        commitSha !== this.settings.lastKnownRemoteCommit
      );

      // Quick local estimate via mtimes
      const lastSync = this.settings.lastSyncTime || 0;
      const localFiles = this.app.vault
        .getFiles()
        .filter((f) => !shouldIgnorePath(normalisePath(f.path), this.settings));
      const cache = this.settings.syncCache || {};

      let localAhead = 0;
      const localPaths = new Set();
      for (const f of localFiles) {
        const p = normalisePath(f.path);
        localPaths.add(p);
        if (!cache[p]) { localAhead++; continue; }
        if (lastSync > 0 && f.stat.mtime > lastSync) localAhead++;
      }
      for (const cp of Object.keys(cache)) {
        if (!localPaths.has(cp) && !shouldIgnorePath(cp, this.settings)) localAhead++;
      }

      if (localAhead > 0 && remoteAhead) {
        this._updateStatusBar("diverged", { localAhead, remoteAhead: true });
      } else if (localAhead > 0) {
        this._updateStatusBar("local-ahead", { count: localAhead });
      } else if (remoteAhead) {
        this._updateStatusBar("remote-ahead");
      } else if (this._statusBarState !== "conflicts") {
        this._updateStatusBar("synced");
      }
    } catch (e) {
      if (e.status === 0) this._updateStatusBar("offline");
      // Don't overwrite a "conflicts" or "synced" state with a transient poll error
      else if (this._statusBarState !== "conflicts" && this._statusBarState !== "synced") {
        this._updateStatusBar("error", e.message);
      }
    }
  }

  // ── Smart Sync ────────────────────────────────────────────────────────
  //
  //  1. Tracks vault idle time — only fires after no file events for the
  //     configured interval.
  //  2. Performs a cheap remote-head check before running a full sync to
  //     avoid redundant API traffic on quiet devices.
  //  3. Stores pending conflict plans so they survive across the modal
  //     dismiss/re-open cycle.
  //  4. Re-arms itself cleanly on each fire rather than being one-shot.
  // ─────────────────────────────────────────────────────────────────────

  _initSmartSync() {
    if (!this.settings.autoSyncEnabled) return;

    const idleMs = Math.max(60_000, (this.settings.autoSyncInterval || 5) * 60_000);

    const arm = () => {
      if (this._smartSyncTimeout) clearTimeout(this._smartSyncTimeout);
      this._smartSyncTimeout = setTimeout(() => this._smartSyncFire(), idleMs);
    };

    this.registerEvent(this.app.vault.on("modify", arm));
    this.registerEvent(this.app.vault.on("create", arm));
    this.registerEvent(this.app.vault.on("delete", arm));
    this.registerEvent(this.app.vault.on("rename", arm));

    // Arm immediately so a startup sync can fire even with no activity
    arm();
  }

  async _smartSyncFire() {
    if (this._isSyncing) {
      // Sync already running; re-arm to check again after another idle window
      this._initSmartSync();
      return;
    }
    if (!this._isConfigured()) return;

    // Cheap pre-check: is there actually anything to do?
    try {
      const client = this._client();
      const { commitSha } = await client.getLatestCommit();
      const localHasChanges = this._hasLocalChanges();
      const remoteChanged = !!(
        this.settings.lastKnownRemoteCommit &&
        commitSha !== this.settings.lastKnownRemoteCommit
      );

      if (!localHasChanges && !remoteChanged) {
        // Nothing to do; update cursor if it was blank
        if (!this.settings.lastKnownRemoteCommit) {
          this.settings.lastKnownRemoteCommit = commitSha;
          await this.saveSettings();
        }
        return;
      }
    } catch (e) {
      if (e.status === 0) return; // offline — skip silently
      console.warn("[DGS] Smart sync pre-check failed:", e.message);
      return;
    }

    await this.sync({ silent: true });
  }

  /**
   * Fast heuristic: have any local files changed since the last sync?
   * Uses mtimes only — no hashing. Suitable for deciding whether to bother syncing.
   */
  _hasLocalChanges() {
    const lastSync = this.settings.lastSyncTime || 0;
    const cache = this.settings.syncCache || {};
    const localPaths = new Set();

    for (const f of this.app.vault.getFiles()) {
      const p = normalisePath(f.path);
      if (shouldIgnorePath(p, this.settings)) continue;
      localPaths.add(p);
      if (!cache[p]) return true;                              // new file
      if (lastSync > 0 && f.stat.mtime > lastSync) return true; // modified
    }
    // Files deleted locally but still in cache
    for (const cp of Object.keys(cache)) {
      if (!shouldIgnorePath(cp, this.settings) && !localPaths.has(cp)) return true;
    }
    return false;
  }

  /** Re-open the conflict modal for a pending smart-sync plan. */
  async _resumePendingConflicts() {
    if (!this._pendingConflicts) return;
    const {
      plan, localBuffers, client, concurrency,
      commitSha, treeSha, remoteTree, localEntries, cache,
    } = this._pendingConflicts;

    const resolutions = await new Promise((resolve) => {
      new ConflictResolutionModal(
        this.app,
        plan.conflicts,
        (res) => resolve(res),
        () => resolve(null)
      ).open();
    });

    if (!resolutions) {
      this._updateStatusBar(
        "conflicts",
        `${plan.conflicts.length} unresolved — click to resolve`
      );
      return;
    }

    this._pendingConflicts = null;
    this._isSyncing = true;
    this._updateStatusBar("syncing");

    try {
      await applyConflictResolutions(plan, resolutions, localBuffers, this.app.vault);
      await executeSyncPlan(
        plan, client, concurrency, commitSha, treeSha,
        remoteTree, localEntries, cache, () => {}, false,
        this.app.vault, this.settings, () => this.saveSettings()
      );
    } catch (e) {
      console.error("[DGS] Error resolving conflicts:", e);
      new Notice(`Sync failed after conflict resolution: ${e.message}`, 10000);
      this._updateStatusBar("error", e.message);
    } finally {
      this._isSyncing = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SYNC  (Bidirectional three-way)
  // ─────────────────────────────────────────────────────────────────────

  async sync({ silent = false } = {}) {
    if (this._isSyncing) {
      if (!silent) new Notice("Sync already in progress.", 3000);
      return;
    }
    try { this._validate(); } catch (e) {
      if (!silent) new Notice(e.message, 8000);
      this._updateStatusBar("error", e.message);
      return;
    }

    this._isSyncing = true;
    this._updateStatusBar("syncing");
    const client = this._client();
    const concurrency = Math.max(1, this.settings.concurrency || 5);
    const notice = silent ? null : new Notice("Sync: connecting…", 0);
    const setMsg = (msg) => { if (notice) notice.setMessage(msg); };

    try {
      // 0. Bootstrap empty repo
      const initialised = await client.initRepoIfNeeded();
      if (initialised) { setMsg("Sync: initialised empty repository."); await sleep(800); }

      // 1. Fetch remote state
      setMsg("Sync: fetching remote state…");
      const { commitSha, treeSha } = await client.getLatestCommit();
      const remoteTree = await client.getFullTree(treeSha);
      const remoteBlobs = remoteTree.filter(
        (n) => n.type === "blob" && !shouldIgnorePath(normalisePath(n.path), this.settings)
      );

      // 2. Snapshot local files
      setMsg("Sync: scanning local files…");
      const allFiles = this.app.vault
        .getFiles()
        .filter((f) => !shouldIgnorePath(normalisePath(f.path), this.settings));

      const oversized = allFiles.filter((f) => f.stat.size > MAX_SYNC_FILE_SIZE);
      const files = allFiles.filter((f) => f.stat.size <= MAX_SYNC_FILE_SIZE);
      if (oversized.length > 0) {
        const names = oversized.map((f) => f.path).join(", ");
        console.warn(`[DGS] Skipping ${oversized.length} file(s) > 50MB: ${names}`);
        if (!silent)
          new Notice(`${oversized.length} file(s) over 50MB were skipped (GitHub limit):\n${names}`, 8000);
      }

      // Hash local files
      setMsg(`Sync: hashing ${files.length} local file(s)…`);
      const hashResults = await parallelBatch(files, concurrency, async (file) => {
        const buf = await this.app.vault.readBinary(file);
        const sha = await computeGitBlobSha(buf);
        return { path: normalisePath(file.path), sha, buf };
      });

      const hashFailed = hashResults.filter((r) => !r.ok);
      const localEntries = hashResults.filter((r) => r.ok).map((r) => r.value);
      if (hashFailed.length > 0 && !silent)
        new Notice(`${hashFailed.length} file(s) could not be read and were skipped.`, 6000);

      // 3. Build three-way sync plan
      setMsg("Sync: analyzing changes…");
      const cache = this.settings.syncCache || {};
      const plan = buildSyncPlan(localEntries, remoteBlobs, cache, this.settings);

      const localBuffers = new Map();
      for (const e of localEntries) localBuffers.set(e.path, e.buf);

      // 4. Handle conflicts
      if (plan.conflicts.length > 0) {
        if (notice) notice.hide();

        if (silent) {
          // Smart sync: stash the plan, surface via status bar
          this._pendingConflicts = {
            plan, localBuffers, client, concurrency, commitSha, treeSha,
            remoteTree, localEntries, remoteBlobs, cache,
          };
          this._isSyncing = false;
          this._updateStatusBar(
            "conflicts",
            `${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? "" : "s"} — click to resolve`
          );
          return;
        }

        const resolutions = await new Promise((resolve) => {
          new ConflictResolutionModal(
            this.app,
            plan.conflicts,
            (res) => resolve(res),
            () => resolve(null)
          ).open();
        });

        if (!resolutions) {
          this._updateStatusBar(
            "conflicts",
            `${plan.conflicts.length} unresolved — click to resolve`
          );
          this._isSyncing = false;
          return;
        }

        await applyConflictResolutions(plan, resolutions, localBuffers, this.app.vault);
      }

      // 5. Execute
      await executeSyncPlan(
        plan, client, concurrency, commitSha, treeSha,
        remoteTree, localEntries, cache, setMsg, silent,
        this.app.vault, this.settings, () => this.saveSettings()
      );
      this._updateStatusBar("synced");

      if (notice) setTimeout(() => notice.hide(), 6000);

    } catch (e) {
      console.error("[DGS] Sync error:", e);
      if (notice) {
        notice.setMessage(`Sync failed: ${e.message}`);
        setTimeout(() => notice.hide(), 12000);
      }
      if (e.status === 0) this._updateStatusBar("offline");
      else this._updateStatusBar("error", e.message);
    } finally {
      this._isSyncing = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PUSH  (Local → GitHub)
  // ─────────────────────────────────────────────────────────────────────

  async push(forcePush = false) {
    try { this._validate(); } catch (e) { new Notice(e.message, 8000); return; }

    const client = this._client();
    const concurrency = Math.max(1, this.settings.concurrency || 5);
    const status = new Notice("Push: connecting…", 0);

    try {
      const initialised = await client.initRepoIfNeeded();
      if (initialised) { status.setMessage("Push: initialised empty repository."); await sleep(800); }

      status.setMessage("Push: reading local and remote state…");
      const [{ commitSha, treeSha }, allFiles] = await Promise.all([
        client.getLatestCommit(),
        Promise.resolve(this.app.vault.getFiles()),
      ]);

      // Safety: remote has moved since last sync
      if (!forcePush && this.settings.lastKnownRemoteCommit &&
        this.settings.lastKnownRemoteCommit !== commitSha) {
        status.hide();
        new ConflictModal(
          this.app,
          commitSha,
          () => this.push(true),
          () => new Notice("Push cancelled. Pull or Sync first to incorporate remote changes.", 6000)
        ).open();
        return;
      }

      const remoteTreePromise = client.getFullTree(treeSha);

      const files = allFiles.filter((f) => {
        const p = normalisePath(f.path);
        return !shouldIgnorePath(p, this.settings) && f.stat.size <= MAX_SYNC_FILE_SIZE;
      });
      const oversized = allFiles.filter(
        (f) => f.stat.size > MAX_SYNC_FILE_SIZE && !shouldIgnorePath(normalisePath(f.path), this.settings)
      );
      if (oversized.length > 0)
        new Notice(`${oversized.length} file(s) over 50MB skipped.`, 6000);

      if (files.length === 0) {
        status.setMessage("Push: nothing to push — vault is empty.");
        setTimeout(() => status.hide(), 4000);
        return;
      }

      status.setMessage(`Push: scanning ${files.length} local file(s)…`);
      const [remoteTree, hashResults] = await Promise.all([
        remoteTreePromise,
        parallelBatch(files, concurrency, async (file) => {
          const buf = await this.app.vault.readBinary(file);
          const sha = await computeGitBlobSha(buf);
          return { path: normalisePath(file.path), sha, buf };
        }),
      ]);

      const hashFailed = hashResults.filter((r) => !r.ok);
      const localEntries = hashResults.filter((r) => r.ok).map((r) => r.value);
      if (hashFailed.length > 0)
        new Notice(`${hashFailed.length} file(s) could not be read and were skipped.`, 8000);

      const remoteShaMap = {};
      for (const node of remoteTree) {
        if (node.type === "blob") remoteShaMap[normalisePath(node.path)] = node.sha;
      }

      const localPaths = new Set(localEntries.map((e) => e.path));
      const changed = localEntries.filter((e) => remoteShaMap[e.path] !== e.sha);
      const unchanged = localEntries.filter((e) => remoteShaMap[e.path] === e.sha);
      const toDeleteRemotely = Object.keys(remoteShaMap).filter((rPath) => {
        if (shouldIgnorePath(rPath, this.settings)) return false;
        return !localPaths.has(rPath);
      });

      if (changed.length === 0 && toDeleteRemotely.length === 0) {
        if (this.settings.lastKnownRemoteCommit && commitSha !== this.settings.lastKnownRemoteCommit) {
          status.setMessage("No local changes, but remote has new commits. Pull or Sync first.");
        } else {
          status.setMessage("Push: already up to date — no local changes.");
          this.settings.lastKnownRemoteCommit = commitSha;
          await this.saveSettings();
        }
        setTimeout(() => status.hide(), 5000);
        this._updateStatusBar("synced");
        return;
      }

      let uploadCount = 0;
      if (changed.length > 0) status.setMessage(`Push: uploading ${changed.length} file(s)…`);
      const uploadResults = await parallelBatch(changed, concurrency, async (f) => {
        const b64 = arrayBufferToBase64(f.buf);
        const blobSha = await client.createBlob(b64);
        uploadCount++;
        status.setMessage(`Push: uploading… ${uploadCount}/${changed.length}`);
        return { path: f.path, sha: blobSha };
      });
      const uploadFailed = uploadResults.filter((r) => !r.ok);
      const uploadedEntries = uploadResults.filter((r) => r.ok).map((r) => r.value);
      if (uploadFailed.length > 0)
        new Notice(`${uploadFailed.length} file(s) failed to upload.`, 8000);

      // Abort if all uploads failed — don't create an empty commit
      if (uploadedEntries.length === 0 && changed.length > 0) {
        status.setMessage("Push failed — no files could be uploaded.");
        setTimeout(() => status.hide(), 8000);
        this._updateStatusBar("error", "Upload failed");
        return;
      }

      const treeItems = [
        ...unchanged.map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: remoteShaMap[f.path] })),
        ...uploadedEntries.map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: f.sha })),
      ];

      const deletionMsg = toDeleteRemotely.length > 0 ? ` (removing ${toDeleteRemotely.length} file(s))` : "";
      status.setMessage(`Push: creating commit${deletionMsg}…`);
      const newTreeSha = await client.createTree(treeSha, treeItems, toDeleteRemotely);
      const msg = buildCommitMessage(this.settings.deviceName);
      const newCommitSha = await client.createCommit(msg, newTreeSha, commitSha);
      status.setMessage("Push: updating branch…");
      await client.updateRef(newCommitSha);

      const newCache = {};
      for (const item of treeItems) newCache[item.path] = item.sha;
      for (const e of uploadedEntries) newCache[e.path] = e.sha; // blob SHA takes precedence
      for (const dp of toDeleteRemotely) delete newCache[dp];
      this.settings.syncCache = newCache;
      this.settings.lastKnownRemoteCommit = newCommitSha;
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();

      const summary = [];
      if (uploadedEntries.length > 0) summary.push(`${uploadedEntries.length} uploaded`);
      if (toDeleteRemotely.length > 0) summary.push(`${toDeleteRemotely.length} deleted remotely`);
      if (unchanged.length > 0) summary.push(`${unchanged.length} unchanged`);
      status.setMessage(`Push complete — ${summary.join(", ")}.`);
      this._updateStatusBar("synced");
      setTimeout(() => status.hide(), 6000);

    } catch (e) {
      console.error("[DGS] Push error:", e);
      status.setMessage(`Push failed: ${e.message}`);
      if (e.status === 0) this._updateStatusBar("offline");
      else this._updateStatusBar("error", e.message);
      setTimeout(() => status.hide(), 12000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PULL  (GitHub → Local)
  // ─────────────────────────────────────────────────────────────────────

  async pull() {
    try { this._validate(); } catch (e) { new Notice(e.message, 8000); return; }

    const client = this._client();
    const concurrency = Math.max(1, this.settings.concurrency || 5);
    const status = new Notice("Pull: connecting…", 0);

    try {
      await client.initRepoIfNeeded();

      status.setMessage("Pull: fetching repository state…");
      const { commitSha, treeSha } = await client.getLatestCommit();
      const tree = await client.getFullTree(treeSha);

      const folders = tree.filter((n) => n.type === "tree");
      const blobs = tree.filter((n) => {
        const p = normalisePath(n.path);
        return n.type === "blob" && !shouldIgnorePath(p, this.settings);
      });

      const cache = this.settings.syncCache || {};
      const changed = blobs.filter((n) => cache[normalisePath(n.path)] !== n.sha);
      const remotePathSet = new Set(blobs.map((n) => normalisePath(n.path)));
      const toDeleteLocally = Object.keys(cache).filter((cp) => {
        if (shouldIgnorePath(cp, this.settings)) return false;
        return !remotePathSet.has(cp);
      });

      if (changed.length === 0 && toDeleteLocally.length === 0) {
        status.setMessage("Pull: already up to date.");
        this.settings.lastKnownRemoteCommit = commitSha;
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this._updateStatusBar("synced");
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // Ensure parent folders exist
      for (const folder of folders) {
        const fp = normalisePath(folder.path);
        if (shouldIgnorePath(fp, this.settings)) continue;
        if (!this.app.vault.getAbstractFileByPath(fp)) {
          try { await this.app.vault.createFolder(fp); } catch { /* exists */ }
        }
      }

      // Download — with local SHA protection
      const skippedConflicts = [];
      if (changed.length > 0) status.setMessage(`Pull: downloading ${changed.length} file(s)…`);
      let written = 0;
      const newCache = Object.assign({}, cache);

      const downloadResults = await parallelBatch(changed, concurrency, async (node) => {
        const fp = normalisePath(node.path);
        const existing = this.app.vault.getAbstractFileByPath(fp);

        // Protect files with un-pushed local edits
        if (existing && cache[fp]) {
          try {
            const localBuf = await this.app.vault.readBinary(existing);
            const localSha = await computeGitBlobSha(localBuf);
            if (localSha !== cache[fp]) {
              skippedConflicts.push(fp);
              return { path: fp, skipped: true };
            }
          } catch { /* can't read — allow overwrite */ }
        }

        const b64 = await client.getBlob(node.sha);
        const buf = base64ToArrayBuffer(b64);

        if (existing) {
          await this.app.vault.adapter.writeBinary(fp, buf);
        } else {
          const parts = fp.split("/");
          if (parts.length > 1) {
            const dir = parts.slice(0, -1).join("/");
            if (!this.app.vault.getAbstractFileByPath(dir)) {
              try { await this.app.vault.createFolder(dir); } catch { /* exists */ }
            }
          }
          await this.app.vault.createBinary(fp, buf);
        }
        written++;
        status.setMessage(`Pull: downloading… ${written}/${changed.length}`);
        return { path: fp, sha: node.sha };
      });

      const downloadFailed = downloadResults.filter((r) => !r.ok);
      const downloadedEntries = downloadResults
        .filter((r) => r.ok && !r.value.skipped)
        .map((r) => r.value);
      for (const entry of downloadedEntries) newCache[entry.path] = entry.sha;

      if (skippedConflicts.length > 0) {
        new Notice(
          `${skippedConflicts.length} file(s) have unpushed local edits and were NOT overwritten:\n${skippedConflicts.join("\n")}\n\nUse Sync to resolve conflicts.`,
          12000
        );
      }
      if (downloadFailed.length > 0)
        new Notice(`${downloadFailed.length} file(s) failed to download.`, 8000);

      // Delete locally — with local SHA protection
      let deleted = 0;
      const deleteSkipped = [];

      if (toDeleteLocally.length > 0) {
        status.setMessage(`Pull: removing ${toDeleteLocally.length} file(s) deleted remotely…`);
        for (const fp of toDeleteLocally) {
          try {
            const existing = this.app.vault.getAbstractFileByPath(fp);
            if (existing) {
              if (cache[fp]) {
                try {
                  const localBuf = await this.app.vault.readBinary(existing);
                  const localSha = await computeGitBlobSha(localBuf);
                  if (localSha !== cache[fp]) {
                    deleteSkipped.push(fp);
                    continue;
                  }
                } catch { /* can't read — allow delete */ }
              }
              await this.app.vault.trash(existing, true);
            }
            delete newCache[fp];
            deleted++;
          } catch (e) {
            console.warn(`[DGS] Could not delete "${fp}": ${e.message}`);
          }
        }
        if (deleteSkipped.length > 0) {
          new Notice(
            `${deleteSkipped.length} file(s) were NOT deleted — they have local edits:\n${deleteSkipped.join("\n")}`,
            10000
          );
        }
      }

      this.settings.syncCache = newCache;
      this.settings.lastKnownRemoteCommit = commitSha;
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();

      const summary = [];
      if (written > 0) summary.push(`${written} downloaded`);
      if (deleted > 0) summary.push(`${deleted} deleted locally`);
      if (skippedConflicts.length > 0) summary.push(`${skippedConflicts.length} protected`);
      if (deleteSkipped.length > 0) summary.push(`${deleteSkipped.length} skipped deletions`);
      const skipped = blobs.length - changed.length;
      if (skipped > 0) summary.push(`${skipped} unchanged`);
      status.setMessage(`Pull complete — ${summary.join(", ")}.`);
      this._updateStatusBar("synced");
      setTimeout(() => status.hide(), 6000);

    } catch (e) {
      console.error("[DGS] Pull error:", e);
      status.setMessage(`Pull failed: ${e.message}`);
      if (e.status === 0) this._updateStatusBar("offline");
      else this._updateStatusBar("error", e.message);
      setTimeout(() => status.hide(), 12000);
    }
  }
}

module.exports = { DirectGitHubSyncPlugin };
