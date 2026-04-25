"use strict";

const { setIcon, Notice }       = require("obsidian");
const { STATUS_POLL_MS }        = require("./constants");
const { normalisePath, shouldIgnorePath, formatRelativeTime } = require("./utils");

// ─────────────────────────────────────────────────────────────────────
//  Status Bar
//
//  Manages the clickable status bar item and the passive background
//  poll that keeps it honest (every STATUS_POLL_MS ms it checks whether
//  the remote commit SHA has changed).
//
//  Local changes are tracked INCREMENTALLY via vault events instead of
//  scanning the entire vault every poll cycle (prevents micro-stutters).
//
//  States:
//    idle           — configured, nothing known yet
//    unconfigured   — PAT / repo not set
//    syncing        — operation actively running (push or pull)
//    waiting        — paused, waiting for user to resolve conflicts in modal
//    synced         — last op succeeded, shows relative time
//    local-ahead    — local has changes not yet pushed
//    remote-ahead   — remote is ahead of last known commit
//    diverged       — both local and remote have changes
//    conflicts      — user dismissed the conflict modal without resolving
//    error          — last op failed (click to see message)
//    offline        — network unreachable
// ─────────────────────────────────────────────────────────────────────

class StatusBar {
  /**
   * @param {Plugin}   plugin   — the Obsidian Plugin instance
   * @param {Function} onSync   — () => void — called when user clicks while idle/synced
   */
  constructor(plugin, onSync) {
    this._plugin  = plugin;
    this._onSync  = onSync;
    this._state   = "idle";
    this._detail  = "";
    this._pollTimer       = null;
    this._relativeTimer   = null;
    this._eventRefs       = [];       // vault event references for cleanup
    this._localDirtyCount = 0;        // incremental dirty file counter
    this._needsFullScan   = true;     // do one full scan at startup
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  mount() {
    this._el     = this._plugin.addStatusBarItem();
    this._iconEl = this._el.createSpan({ cls: "dgs-statusbar-icon" });
    this._textEl = this._el.createSpan({ cls: "dgs-statusbar-text" });
    this._el.addClass("dgs-statusbar-item");
    this._el.addEventListener("click", () => this._onClick());

    const configured = this._plugin._isConfigured();
    this.set(configured ? "idle" : "unconfigured");

    // Relative-time refresh every 30 s
    this._relativeTimer = window.setInterval(() => {
      if (this._state === "synced") this.set("synced");
    }, 30_000);

    // Event-driven local change tracking (replaces full vault scan)
    this._registerVaultEvents();

    // Passive remote poll
    this._startPassivePoll();
  }

  destroy() {
    if (this._pollTimer)     clearInterval(this._pollTimer);
    if (this._relativeTimer) clearInterval(this._relativeTimer);
    // Clean up vault event listeners
    for (const ref of this._eventRefs) {
      this._plugin.app.vault.offref(ref);
    }
    this._eventRefs = [];
  }

  // ── Vault event tracking ────────────────────────────────────────

  _registerVaultEvents() {
    const vault = this._plugin.app.vault;

    const onModify = (file) => {
      const p = normalisePath(file.path);
      if (shouldIgnorePath(p, this._plugin.settings)) return;
      this._localDirtyCount++;
    };

    const onCreate = (file) => {
      const p = normalisePath(file.path);
      if (shouldIgnorePath(p, this._plugin.settings)) return;
      this._localDirtyCount++;
    };

    const onDelete = (file) => {
      const p = normalisePath(file.path);
      if (shouldIgnorePath(p, this._plugin.settings)) return;
      this._localDirtyCount++;
    };

    const onRename = (file, oldPath) => {
      const p = normalisePath(file.path);
      if (shouldIgnorePath(p, this._plugin.settings) &&
          shouldIgnorePath(normalisePath(oldPath), this._plugin.settings)) return;
      this._localDirtyCount++;
    };

    // Register events and keep references for cleanup
    this._eventRefs.push(vault.on("modify", onModify));
    this._eventRefs.push(vault.on("create", onCreate));
    this._eventRefs.push(vault.on("delete", onDelete));
    this._eventRefs.push(vault.on("rename", onRename));

    // Register refs with the plugin for automatic cleanup on unload
    for (const ref of this._eventRefs) {
      this._plugin.registerEvent(ref);
    }
  }

  /**
   * Reset the dirty counter after a successful sync.
   * Called externally when a push/pull completes.
   */
  resetDirtyCount() {
    this._localDirtyCount = 0;
    this._needsFullScan   = false;
  }

  // ── Public API ───────────────────────────────────────────────────

  /** Update the status bar to a named state with an optional detail string/object. */
  set(state, detail) {
    this._state = state;
    if (detail !== undefined) this._detail = detail;

    // Reset dirty counter when synced
    if (state === "synced") this.resetDirtyCount();

    // Guard: el may not exist yet if set() is called before mount()
    if (!this._el) return;

    const detailObj = (detail && typeof detail === "object") ? detail : {};
    const detailStr = (typeof detail === "string") ? detail : (this._detail || "");

    const s = this._plugin.settings || {};

    const states = {
      idle:          { icon: "cloud",         text: "DGS",                                                                          cls: "dgs-sb-idle" },
      unconfigured:  { icon: "cloud-off",     text: "Not configured",                                                               cls: "dgs-sb-unconfigured" },
      syncing:       { icon: "refresh-cw",    text: "Syncing…",                                                                     cls: "dgs-sb-syncing" },
      waiting:       { icon: "git-merge",     text: "Resolve conflicts",                                                            cls: "dgs-sb-conflicts" },
      synced:        { icon: "check-circle-2",text: `Synced${s.lastSyncTime ? " · " + formatRelativeTime(s.lastSyncTime) : ""}`,    cls: "dgs-sb-synced" },
      "local-ahead": { icon: "upload-cloud",  text: detailObj.count ? `${detailObj.count} to push` : "Local changes",               cls: "dgs-sb-local-ahead" },
      "remote-ahead":{ icon: "download-cloud",text: "Remote changes",                                                               cls: "dgs-sb-remote-ahead" },
      diverged:      { icon: "git-compare",   text: `${detailObj.localAhead || "?"} local · remote changed`,                        cls: "dgs-sb-diverged" },
      conflicts:     { icon: "git-merge",     text: detailStr || "Conflicts",                                                       cls: "dgs-sb-conflicts" },
      error:         { icon: "alert-triangle",text: "Sync error",                                                                   cls: "dgs-sb-error" },
      offline:       { icon: "wifi-off",      text: "Offline",                                                                      cls: "dgs-sb-offline" },
    };

    const cfg = states[state] || states.idle;

    this._el.className = "dgs-statusbar-item";
    this._iconEl.empty();
    this._textEl.empty();
    try { setIcon(this._iconEl, cfg.icon); } catch { this._iconEl.setText("•"); }
    this._textEl.setText(cfg.text);
    this._el.addClass(cfg.cls);
  }

  get state() { return this._state; }

  // ── Passive Poll ─────────────────────────────────────────────────

  _startPassivePoll() {
    // First check after 15 s (let Obsidian finish loading)
    setTimeout(() => this._poll(), 15_000);
    this._pollTimer = window.setInterval(() => this._poll(), STATUS_POLL_MS);
  }

  async _poll() {
    if (this._state === "syncing" || this._state === "waiting") return;
    if (!this._plugin._isConfigured()) { this.set("unconfigured"); return; }

    try {
      const client        = this._plugin._client();
      const { commitSha } = await client.getLatestCommit();
      const s             = this._plugin.settings;

      const remoteAhead = !!(s.lastKnownRemoteCommit && commitSha !== s.lastKnownRemoteCommit);

      // Use event-driven dirty count instead of scanning every file
      let localAhead = this._localDirtyCount;

      // Only do a full scan once at startup (or if explicitly requested)
      if (this._needsFullScan) {
        this._needsFullScan = false;
        localAhead = 0;
        const cache = s.syncCache || {};
        const localPaths = new Set();

        for (const f of this._plugin.app.vault.getFiles()) {
          const p = normalisePath(f.path);
          if (shouldIgnorePath(p, s)) continue;
          localPaths.add(p);
          if (!cache[p])                            localAhead++;
          else if (s.lastSyncTime && f.stat.mtime > s.lastSyncTime) localAhead++;
        }
        for (const cp of Object.keys(cache)) {
          if (!shouldIgnorePath(cp, s) && !localPaths.has(cp)) localAhead++;
        }
        this._localDirtyCount = localAhead;
      }

      if      (localAhead > 0 && remoteAhead) this.set("diverged",       { localAhead });
      else if (localAhead > 0)                this.set("local-ahead",    { count: localAhead });
      else if (remoteAhead)                   this.set("remote-ahead");
      else if (this._state !== "conflicts")   this.set("synced");

    } catch (e) {
      if      (e.status === 0)     this.set("offline");
      else if (this._state !== "conflicts" && this._state !== "synced")
        this.set("error", e.message);
    }
  }

  // ── Click handler ────────────────────────────────────────────────

  _onClick() {
    switch (this._state) {
      case "syncing":
        new Notice("A sync operation is already in progress.", 3000);
        break;
      case "waiting":
        new Notice("Waiting for conflict resolution — check the open dialog.", 4000);
        break;
      case "unconfigured":
        new Notice("Connection not configured — open plugin settings.", 5000);
        break;
      case "error":
        new Notice(`Last error: ${this._detail || "Unknown"}`, 8000);
        break;
      case "conflicts":
        new Notice("Open the command palette and run Push or Pull to resolve conflicts.", 6000);
        break;
      default:
        this._onSync();
    }
  }
}

module.exports = { StatusBar };
