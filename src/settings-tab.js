"use strict";

const { PluginSettingTab, Setting, Notice, setIcon } = require("obsidian");

// ─────────────────────────────────────────────
//  Settings Tab
// ─────────────────────────────────────────────

class DirectGitHubSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this._draft = {};
    this._validationEl = null;
    this._saveBtn = null;
    this._configureBtn = null;
    this._connectionPanelEl = null;
    this._connectionOpen = false;
  }

  _initDraft() {
    const s = this.plugin.settings;
    this._draft = { pat: s.pat, username: s.username, repo: s.repo, branch: s.branch };
  }

  _isDirty() {
    const s = this.plugin.settings;
    return (
      this._draft.pat !== s.pat ||
      this._draft.username !== s.username ||
      this._draft.repo !== s.repo ||
      this._draft.branch !== s.branch
    );
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("dgs-settings");
    this._initDraft();

    // ── Plugin Header ──────────────────────────────────────────────────
    const headerEl = containerEl.createDiv({ cls: "dgs-settings-header" });
    const headerIcon = headerEl.createSpan({ cls: "dgs-settings-header-icon" });
    try { setIcon(headerIcon, "git-branch"); } catch { headerIcon.setText("G"); }
    const headerText = headerEl.createDiv();
    headerText.createEl("h2", { text: "Direct GitHub Sync" });
    headerText.createEl("p", {
      text: "Sync your vault with GitHub — no Git CLI, no Node.js, works on mobile.",
      cls: "dgs-settings-subtitle",
    });

    // ══════════════════════════════════════════════════════════════════
    //  Section 1 — Connection  (collapsed behind a Configure button)
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "lock", "Connection");

    // Status summary — always visible
    this._renderConnectionStatus(containerEl);

    // "Configure Connection" button — toggles fields
    new Setting(containerEl).addButton((btn) => {
      this._configureBtn = btn;
      btn
        .setButtonText(this._connectionOpen ? "Close Configuration" : "Configure Connection")
        .onClick(() => this._toggleConnectionPanel());
    });

    // Collapsible panel
    this._connectionPanelEl = containerEl.createDiv({ cls: "dgs-connection-panel" });
    if (!this._connectionOpen) this._connectionPanelEl.addClass("dgs-hidden");
    this._renderConnectionFields(this._connectionPanelEl);

    // ══════════════════════════════════════════════════════════════════
    //  Section 2 — Sync Behaviour
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "settings", "Sync Behaviour");

    new Setting(containerEl)
      .setName("Ignore .obsidian directory")
      .setDesc("Prevents plugin configs and workspace state from syncing.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ignoreObsidianDir).onChange(async (v) => {
          this.plugin.settings.ignoreObsidianDir = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Ignored paths")
      .setDesc(
        "One path per line. Supports wildcards (*). Lines starting with # are comments. " +
          "Paths ending with / match directories."
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Attachments/large-videos/\n*.mp4\n# Comment lines are ignored")
          .setValue(this.plugin.settings.ignoredPaths || "")
          .onChange(async (v) => {
            this.plugin.settings.ignoredPaths = v;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
        text.inputEl.addClass("dgs-ignored-paths-textarea");
      });

    new Setting(containerEl)
      .setName("Device name (optional)")
      .setDesc('Shown in commit messages, e.g. "Vault sync from PC: 20 Apr 2026 at 14:03".')
      .addText((text) =>
        text
          .setPlaceholder("e.g. PC, Phone, Laptop")
          .setValue(this.plugin.settings.deviceName || "")
          .onChange(async (v) => {
            this.plugin.settings.deviceName = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Concurrent requests")
      .setDesc("Number of parallel API calls. Higher is faster but risks rate limits. Default: 5.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.concurrency ?? 5)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.concurrency = v;
            await this.plugin.saveSettings();
          })
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 3 — Smart Sync
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "refresh-cw", "Smart Sync");

    containerEl.createEl("p", {
      text: "When enabled, changes are automatically synced after a period of inactivity. Before running, it checks whether remote has actually changed to avoid unnecessary API traffic. Conflicts are surfaced in the status bar rather than interrupting your work.",
      cls: "setting-item-description dgs-section-note",
    });

    new Setting(containerEl)
      .setName("Enable smart sync")
      .setDesc("Sync automatically after the idle period. Conflicts appear in the status bar.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (v) => {
          this.plugin.settings.autoSyncEnabled = v;
          await this.plugin.saveSettings();
          new Notice(
            v ? "Smart sync enabled. Restart Obsidian to activate." : "Smart sync disabled.",
            4000
          );
        })
      );

    new Setting(containerEl)
      .setName("Idle interval (minutes)")
      .setDesc("Minutes of inactivity before smart sync triggers. Range: 1–30.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.autoSyncInterval ?? 5)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.autoSyncInterval = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a sync when Obsidian starts (only if smart sync is enabled).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
          this.plugin.settings.syncOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 4 — Quick Actions
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "zap", "Quick Actions");

    new Setting(containerEl)
      .setName("Sync with GitHub")
      .setDesc("Full bidirectional sync — downloads remote changes, uploads local changes, detects conflicts.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").setCta().onClick(() => this.plugin.sync())
      );

    new Setting(containerEl)
      .setName("Push to GitHub")
      .setDesc("Upload local changes only. Warns if remote has newer commits.")
      .addButton((btn) => btn.setButtonText("Push Now").onClick(() => this.plugin.push()));

    new Setting(containerEl)
      .setName("Pull from GitHub")
      .setDesc("Download remote changes only. Protects files with un-pushed local edits.")
      .addButton((btn) => btn.setButtonText("Pull Now").onClick(() => this.plugin.pull()));

    // ══════════════════════════════════════════════════════════════════
    //  Section 5 — Danger Zone
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "alert-triangle", "Danger Zone");

    new Setting(containerEl)
      .setName("Reset sync cache")
      .setDesc(
        "Clears the SHA cache and commit cursor. The next sync will be a full comparison. " +
          "Use after a manual repository reset."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset Cache")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.syncCache = {};
            this.plugin.settings.lastPulledShas = {};
            this.plugin.settings.lastKnownRemoteCommit = "";
            this.plugin.settings.lastSyncTime = 0;
            await this.plugin.saveSettings();
            new Notice("Sync cache cleared. Next sync will be a full comparison.", 5000);
          })
      );

    // ── Footer ──
    containerEl.createEl("hr", { cls: "dgs-settings-divider" });
    containerEl.createEl("p", {
      text: "Tip: Assign hotkeys to Push, Pull, and Sync via Settings → Hotkeys.",
      cls: "setting-item-description",
    });
  }

  /** Always-visible connection status line */
  _renderConnectionStatus(container) {
    const s = this.plugin.settings;
    const isConfigured = !!(s.pat && s.username && s.repo && s.branch);

    const statusEl = container.createDiv({ cls: "dgs-connection-status" });
    const iconEl = statusEl.createSpan({ cls: "dgs-connection-status-icon" });
    const textEl = statusEl.createSpan({ cls: "dgs-connection-status-text" });

    if (isConfigured) {
      statusEl.addClass("dgs-connection-status--ok");
      try { setIcon(iconEl, "check-circle-2"); } catch { iconEl.setText("ok"); }
      textEl.setText(`${s.username}/${s.repo}  •  branch: ${s.branch}`);
    } else {
      statusEl.addClass("dgs-connection-status--warn");
      try { setIcon(iconEl, "alert-circle"); } catch { iconEl.setText("!"); }
      textEl.setText("Connection not configured — click Configure Connection below.");
    }
  }

  _toggleConnectionPanel() {
    this._connectionOpen = !this._connectionOpen;
    if (this._connectionPanelEl) {
      if (this._connectionOpen) this._connectionPanelEl.removeClass("dgs-hidden");
      else this._connectionPanelEl.addClass("dgs-hidden");
    }
    if (this._configureBtn) {
      this._configureBtn.setButtonText(
        this._connectionOpen ? "Close Configuration" : "Configure Connection"
      );
    }
  }

  _renderConnectionFields(panel) {
    const authNote = panel.createEl("p", { cls: "setting-item-description dgs-section-note" });
    authNote.innerHTML =
      "Changes are applied when you click <strong>Save Connection Settings</strong>.";

    new Setting(panel)
      .setName("Personal Access Token (PAT)")
      .setDesc("GitHub → Settings → Developer settings → Personal access tokens. Needs 'repo' scope.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck = false;
        text
          .setPlaceholder("ghp_xxxxxxxxxxxxxxxxxxxx")
          .setValue(this._draft.pat)
          .onChange((v) => { this._draft.pat = v.trim(); this._updateSaveBtnState(); });
      });

    new Setting(panel)
      .setName("GitHub Username / Organisation")
      .setDesc("The account that owns the repository.")
      .addText((text) =>
        text
          .setPlaceholder("octocat")
          .setValue(this._draft.username)
          .onChange((v) => { this._draft.username = v.trim(); this._updateSaveBtnState(); })
      );

    new Setting(panel)
      .setName("Repository Name")
      .setDesc("Repository name only — not a URL.")
      .addText((text) =>
        text
          .setPlaceholder("my-obsidian-vault")
          .setValue(this._draft.repo)
          .onChange((v) => { this._draft.repo = v.trim(); this._updateSaveBtnState(); })
      );

    new Setting(panel)
      .setName("Branch")
      .setDesc("Target branch. Defaults to 'main' if left blank.")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this._draft.branch)
          .onChange((v) => { this._draft.branch = v.trim() || "main"; this._updateSaveBtnState(); })
      );

    this._validationEl = panel.createDiv({ cls: "dgs-validation-result dgs-hidden" });

    const actionSetting = new Setting(panel);
    actionSetting
      .addButton((btn) => {
        this._saveBtn = btn;
        btn
          .setButtonText("Save Connection Settings")
          .setCta()
          .onClick(() => this._saveCredentials());
      })
      .addButton((btn) =>
        btn.setButtonText("Test Connection").onClick(() => this._testConnection())
      );
  }

  _createSectionHeader(container, icon, title) {
    const header = container.createDiv({ cls: "dgs-section-header" });
    const iconEl = header.createSpan({ cls: "dgs-section-icon" });
    try { setIcon(iconEl, icon); } catch { iconEl.setText("•"); }
    header.createEl("h3", { text: title });
  }

  _updateSaveBtnState() {
    if (!this._saveBtn) return;
    this._saveBtn.setButtonText(
      this._isDirty() ? "Save Connection Settings (unsaved)" : "Save Connection Settings"
    );
  }

  async _saveCredentials() {
    const d = this._draft;
    const issues = [];
    if (!d.pat) issues.push("Personal Access Token is required.");
    if (!d.username) issues.push("GitHub username is required.");
    if (!d.repo) issues.push("Repository name is required.");
    if (!d.branch) issues.push("Branch is required.");
    if (d.pat && !/^(ghp_|github_pat_|gho_|ghs_|ghr_)/.test(d.pat))
      issues.push("PAT format looks incorrect — it should start with 'ghp_' or 'github_pat_'.");
    if (issues.length > 0) {
      this._showValidation("error", "Cannot save:\n• " + issues.join("\n• "));
      return;
    }

    this.plugin.settings.pat = d.pat;
    this.plugin.settings.username = d.username;
    this.plugin.settings.repo = d.repo;
    this.plugin.settings.branch = d.branch;
    // Reset commit cursor so next sync does a clean comparison against the new repo
    this.plugin.settings.lastKnownRemoteCommit = "";
    await this.plugin.saveSettings();

    this._updateSaveBtnState();
    this._showValidation("ok", "Connection settings saved.");
    new Notice("Connection settings saved.", 3000);
  }

  async _testConnection() {
    if (this._isDirty()) {
      this._showValidation("error", "You have unsaved changes. Save first, then test.");
      return;
    }
    if (!this.plugin._isConfigured()) {
      this._showValidation("error", "Connection is not configured. Fill in all fields and save first.");
      return;
    }
    this._showValidation("info", "Testing connection…");
    try {
      const client = this.plugin._client();
      const result = await client.validateSettings();
      this._showValidation(result.ok ? "ok" : "error", result.message);
    } catch (e) {
      this._showValidation("error", `Unexpected error: ${e.message}`);
    }
  }

  /** Show a validation result using SVG icons (no emojis). */
  _showValidation(type, message) {
    const el = this._validationEl;
    if (!el) return;
    el.className = "dgs-validation-result";
    el.removeClass("dgs-hidden");

    const svgIcons = {
      ok:    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
      error: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
      info:  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    };
    const cls = { ok: "dgs-ok", error: "dgs-err", info: "dgs-info" };
    el.addClass(cls[type] || "dgs-info");
    el.empty();

    const iconWrap = el.createSpan({ cls: "dgs-validation-icon" });
    iconWrap.innerHTML = svgIcons[type] || svgIcons.info;
    el.createSpan({ text: "\u00a0" + message, cls: "dgs-validation-text" });
  }
}

module.exports = { DirectGitHubSyncSettingTab };
