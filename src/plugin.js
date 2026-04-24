"use strict";

/*
 * DirectGitHubSyncPlugin — main Plugin class (orchestrator)
 *
 * This file is intentionally thin. All operation logic lives in:
 *   push.js          — executePush()
 *   pull.js          — executePull()
 *   conflict-resolver.js — buildDiffPlan(), applyResolutions()
 *   status-bar.js    — StatusBar (passive remote poll + UI)
 *   github-client.js — GitHubClient
 *   modals.js        — ConflictResolutionModal, ForcePushModal
 *   utils.js         — pure helpers
 *   constants.js     — compile-time constants
 */

const { Plugin, Notice }             = require("obsidian");
const { DEFAULT_SETTINGS }           = require("./constants");
const { GitHubClient }               = require("./github-client");
const { StatusBar }                  = require("./status-bar");
const { executePush }                = require("./push");
const { executePull }                = require("./pull");
const { DirectGitHubSyncSettingTab } = require("./settings-tab");

class DirectGitHubSyncPlugin extends Plugin {

  // ── Lifecycle ──────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();

    // Status bar (also starts passive remote poll)
    this._statusBar = new StatusBar(this, () => {
      // Clicking status bar while idle/synced → pull (most common desire)
      this.pull();
    });
    this._statusBar.mount();

    // Ribbon icons
    this.addRibbonIcon("upload-cloud",   "Push vault to GitHub",   () => this.push());
    this.addRibbonIcon("download-cloud", "Pull vault from GitHub",  () => this.pull());

    // Commands
    this.addCommand({ id: "push-to-github",    name: "Push vault to GitHub",   callback: () => this.push() });
    this.addCommand({ id: "pull-from-github",  name: "Pull vault from GitHub", callback: () => this.pull() });

    // Settings tab
    this.addSettingTab(new DirectGitHubSyncSettingTab(this.app, this));

    // Lock to prevent overlapping operations
    this._isBusy = false;

    console.log("[DGS] Plugin loaded.");
  }

  onunload() {
    this._statusBar?.destroy();
    console.log("[DGS] Plugin unloaded.");
  }

  // ── Persistence ────────────────────────────────────────────────────

  async loadSettings() {
    const raw       = await this.loadData();
    this.settings   = Object.assign({}, DEFAULT_SETTINGS, raw);

    // Guard against corrupted cache
    if (!this.settings.syncCache || typeof this.settings.syncCache !== "object") {
      this.settings.syncCache = {};
    }

    // Migrate legacy lastPulledShas → syncCache (one-time migration)
    if (this.settings.lastPulledShas && Object.keys(this.settings.lastPulledShas).length > 0) {
      if (Object.keys(this.settings.syncCache).length === 0) {
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
      // A settings-save failure must not abort an in-progress operation
      console.error("[DGS] Failed to save settings:", e);
    }
  }

  // ── Validation helpers ─────────────────────────────────────────────

  _isConfigured() {
    const s = this.settings;
    return !!(s.pat && s.username && s.repo && s.branch);
  }

  /**
   * Throws a user-readable Error if required settings are missing.
   */
  _assertConfigured() {
    const s      = this.settings;
    const issues = [];
    if (!s.pat)      issues.push("Personal Access Token (PAT) is not set.");
    if (!s.username) issues.push("GitHub username is not set.");
    if (!s.repo)     issues.push("Repository name is not set.");
    if (!s.branch)   issues.push("Branch is not set.");
    if (issues.length > 0) {
      throw new Error(
        "Connection not configured — open plugin settings:\n• " + issues.join("\n• ")
      );
    }
    if (!/^(ghp_|github_pat_|gho_|ghs_|ghr_)/.test(s.pat))
      throw new Error("PAT format looks incorrect — it should start with 'ghp_' or 'github_pat_'.");
  }

  _client() {
    const s = this.settings;
    return new GitHubClient(s.pat, s.username, s.repo, s.branch);
  }

  // ── Operations ─────────────────────────────────────────────────────

  async push() {
    try { this._assertConfigured(); } catch (e) { new Notice(e.message, 8000); return; }
    if (this._isBusy) { new Notice("An operation is already in progress.", 3000); return; }

    this._isBusy = true;
    this._statusBar.set("syncing");

    try {
      await executePush({
        app:            this.app,
        client:         this._client(),
        settings:       this.settings,
        saveSettings:   () => this.saveSettings(),
        onStatusChange: (state, detail) => this._statusBar.set(state, detail),
      });
    } finally {
      this._isBusy = false;
    }
  }

  async pull() {
    try { this._assertConfigured(); } catch (e) { new Notice(e.message, 8000); return; }
    if (this._isBusy) { new Notice("An operation is already in progress.", 3000); return; }

    this._isBusy = true;
    this._statusBar.set("syncing");

    try {
      await executePull({
        app:            this.app,
        client:         this._client(),
        settings:       this.settings,
        saveSettings:   () => this.saveSettings(),
        onStatusChange: (state, detail) => this._statusBar.set(state, detail),
      });
    } finally {
      this._isBusy = false;
    }
  }
}

module.exports = { DirectGitHubSyncPlugin };
