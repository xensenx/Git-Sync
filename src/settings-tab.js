"use strict";

const { PluginSettingTab, Setting, Notice, setIcon } = require("obsidian");

// ─────────────────────────────────────────────
//  Inline SVG icons for the About section
//  (avoids dependency on Obsidian icon registry)
// ─────────────────────────────────────────────
const ICONS = {
  github: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>`,
  code: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  book: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  kofi: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M23.881 8.948c-.773-4.085-4.859-4.593-4.859-4.593H.723c-.604 0-.679.798-.679.798s-.082 7.324-.022 11.822c.164 2.424 2.586 2.672 2.586 2.672s8.267-.023 11.966-.049c2.438-.426 2.683-2.566 2.658-3.734 4.352.24 7.422-2.831 6.649-6.916zm-11.062 3.511c-1.246 1.453-4.011 3.976-4.011 3.976s-.121.119-.31.023c-.076-.057-.108-.09-.108-.09-.443-.441-3.368-3.049-4.034-3.954-.709-.965-1.041-2.7-.091-3.71.951-1.01 3.005-1.086 4.363.407 0 0 1.565-1.782 3.468-.963 1.904.82 1.832 3.011.723 4.311zm6.173.478c-.928.116-1.682.028-1.682.028V7.284h1.77s1.971.551 1.971 2.638c0 1.913-.985 2.667-2.059 3.015z"/></svg>`,
};

// ─────────────────────────────────────────────
//  Settings Tab
// ─────────────────────────────────────────────

class DirectGitHubSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this._draft          = {};
    this._validationEl   = null;
    this._saveBtn        = null;
    this._configureBtn   = null;
    this._connectionPanel = null;
    this._connectionOpen  = false;
  }

  _initDraft() {
    const s = this.plugin.settings;
    this._draft = { pat: s.pat, username: s.username, repo: s.repo, branch: s.branch };
  }

  _isDirty() {
    const s = this.plugin.settings;
    return (
      this._draft.pat      !== s.pat      ||
      this._draft.username !== s.username ||
      this._draft.repo     !== s.repo     ||
      this._draft.branch   !== s.branch
    );
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("dgs-settings");
    this._initDraft();

    // ── Header ────────────────────────────────────────────────────────
    const headerEl   = containerEl.createDiv({ cls: "dgs-settings-header" });
    const headerIcon = headerEl.createSpan({ cls: "dgs-settings-header-icon" });
    try { setIcon(headerIcon, "git-branch"); } catch { headerIcon.setText("G"); }
    const headerText = headerEl.createDiv();
    headerText.createEl("h2", { text: "Direct GitHub Sync" });
    headerText.createEl("p", {
      text: "Sync your vault with GitHub — no Git CLI, no Node.js, works on mobile.",
      cls:  "dgs-settings-subtitle",
    });

    // ══════════════════════════════════════════════════════════════════
    //  Section 1 — Connection
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "lock", "Connection");
    this._renderConnectionStatus(containerEl);

    new Setting(containerEl).addButton((btn) => {
      this._configureBtn = btn;
      btn
        .setButtonText(this._connectionOpen ? "Close Configuration" : "Configure Connection")
        .onClick(() => this._toggleConnectionPanel());
    });

    this._connectionPanel = containerEl.createDiv({ cls: "dgs-connection-panel" });
    if (!this._connectionOpen) this._connectionPanel.addClass("dgs-hidden");
    this._renderConnectionFields(this._connectionPanel);

    // ══════════════════════════════════════════════════════════════════
    //  Section 2 — Sync Behaviour
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "settings", "Sync Behaviour");

    new Setting(containerEl)
      .setName("Ignore .obsidian directory")
      .setDesc(
        "Prevents plugin configs and workspace state from syncing. " +
        "Disabling this will sync workspace.json, which changes on every app launch and " +
        "will generate conflicts on nearly every sync when using multiple devices."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ignoreObsidianDir).onChange(async (v) => {
          this.plugin.settings.ignoreObsidianDir = v;
          await this.plugin.saveSettings();
          if (!v) {
            new Notice(
              "⚠️ Warning: Syncing .obsidian/ will include workspace.json, " +
              "which changes on every app launch. This will cause frequent " +
              "conflicts when syncing across multiple devices. Consider adding " +
              "'.obsidian/workspace.json' to your ignored paths instead.",
              15000
            );
          }
        })
      );

    new Setting(containerEl)
      .setName("Ignored paths")
      .setDesc(
        "One path per line. Supports wildcards (*). " +
        "Lines starting with # are comments. Paths ending with / match directories."
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
      .setDesc('Appears in commit messages, e.g. "Vault sync from Phone: 20 Apr 2026 at 14:03".')
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
      .setDesc("Number of parallel API calls. Higher = faster but risks rate limits. Default: 5.")
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
    //  Section 3 — Quick Actions
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "zap", "Quick Actions");

    new Setting(containerEl)
      .setName("Push to GitHub")
      .setDesc(
        "Upload local changes. Detects conflicts with remote changes and asks how to resolve them. " +
        "Warns if remote has commits newer than your last sync."
      )
      .addButton((btn) => btn.setButtonText("Push Now").setCta().onClick(() => this.plugin.push()));

    new Setting(containerEl)
      .setName("Pull from GitHub")
      .setDesc(
        "Download remote changes. Detects conflicts with local edits and asks how to resolve them."
      )
      .addButton((btn) => btn.setButtonText("Pull Now").onClick(() => this.plugin.pull()));

    // ══════════════════════════════════════════════════════════════════
    //  Section 4 — Maintenance
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "wrench", "Maintenance");

    new Setting(containerEl)
      .setName("Reset sync cache")
      .setDesc(
        "Clears the local record of what was last synced. " +
        "The next push or pull will do a full comparison against the remote. " +
        "Use this if the status bar seems wrong or after manually editing files in the repo."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset Cache")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.syncCache             = {};
            this.plugin.settings.lastKnownRemoteCommit = "";
            this.plugin.settings.lastSyncTime          = 0;
            await this.plugin.saveSettings();
            new Notice("Sync cache cleared. Next push/pull will do a full comparison.", 5000);
          })
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 5 — About
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "info", "About");

    const aboutCard = containerEl.createDiv({ cls: "dgs-about-card" });

    // --- Author ---
    const authorRow = aboutCard.createDiv({ cls: "dgs-about-row" });
    authorRow.innerHTML = `<span class="dgs-about-icon">${ICONS.github}</span>`;
    const authorText = authorRow.createDiv({ cls: "dgs-about-text" });
    authorText.createEl("span", { text: "Author", cls: "dgs-about-label" });
    authorText.createEl("span", { text: "Sen (@xensenx)", cls: "dgs-about-value" });
    const authorBtn = authorRow.createEl("button", { text: "GitHub Profile", cls: "dgs-about-btn" });
    authorBtn.onclick = () => window.open("https://github.com/xensenx", "_blank");

    // --- Source Code ---
    const repoRow = aboutCard.createDiv({ cls: "dgs-about-row" });
    repoRow.innerHTML = `<span class="dgs-about-icon">${ICONS.code}</span>`;
    const repoText = repoRow.createDiv({ cls: "dgs-about-text" });
    repoText.createEl("span", { text: "Source Code", cls: "dgs-about-label" });
    repoText.createEl("span", { text: "Open-source on GitHub", cls: "dgs-about-value" });
    const repoBtn = repoRow.createEl("button", { text: "View Repository", cls: "dgs-about-btn" });
    repoBtn.onclick = () => window.open("https://github.com/xensenx/Direct-GitHub-Sync", "_blank");

    // --- Documentation ---
    const docsRow = aboutCard.createDiv({ cls: "dgs-about-row" });
    docsRow.innerHTML = `<span class="dgs-about-icon">${ICONS.book}</span>`;
    const docsText = docsRow.createDiv({ cls: "dgs-about-text" });
    docsText.createEl("span", { text: "Documentation", cls: "dgs-about-label" });
    docsText.createEl("span", { text: "Setup guides, FAQ & troubleshooting", cls: "dgs-about-value" });
    const docsBtn = docsRow.createEl("button", { text: "Open Docs", cls: "dgs-about-btn" });
    docsBtn.onclick = () => window.open("https://xensenx.github.io/Direct-GitHub-Sync/", "_blank");

    // --- Ko-fi Support ---
    const kofiRow = aboutCard.createDiv({ cls: "dgs-about-row dgs-about-row--kofi" });
    kofiRow.innerHTML = `<span class="dgs-about-icon dgs-about-icon--kofi">${ICONS.kofi}</span>`;
    const kofiText = kofiRow.createDiv({ cls: "dgs-about-text" });
    kofiText.createEl("span", { text: "Support Development", cls: "dgs-about-label" });
    kofiText.createEl("span", { text: "Buy the developer a coffee ☕", cls: "dgs-about-value" });
    const kofiBtn = kofiRow.createEl("button", { text: "Support on Ko-fi", cls: "dgs-about-btn dgs-about-btn--kofi" });
    kofiBtn.onclick = () => window.open("https://ko-fi.com/xensenx", "_blank");

    // ── Footer ────────────────────────────────────────────────────────
    containerEl.createEl("hr", { cls: "dgs-settings-divider" });
    containerEl.createEl("p", {
      text: "Tip: Assign hotkeys to Push and Pull via Settings → Hotkeys.",
      cls:  "setting-item-description",
    });
  }

  // ── Connection helpers ────────────────────────────────────────────

  _renderConnectionStatus(container) {
    const s            = this.plugin.settings;
    const isConfigured = !!(s.pat && s.username && s.repo && s.branch);
    const statusEl     = container.createDiv({ cls: "dgs-connection-status" });
    const iconEl       = statusEl.createSpan({ cls: "dgs-connection-status-icon" });
    const textEl       = statusEl.createSpan({ cls: "dgs-connection-status-text" });

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
    if (this._connectionPanel) {
      this._connectionPanel.toggleClass("dgs-hidden", !this._connectionOpen);
    }
    if (this._configureBtn) {
      this._configureBtn.setButtonText(
        this._connectionOpen ? "Close Configuration" : "Configure Connection"
      );
    }
  }

  _renderConnectionFields(panel) {
    panel.createEl("p", {
      cls:  "setting-item-description dgs-section-note",
      text: "Changes are applied when you click Save Connection Settings.",
    });

    new Setting(panel)
      .setName("Personal Access Token (PAT)")
      .setDesc("GitHub → Settings → Developer settings → Personal access tokens. Needs 'repo' scope.")
      .addText((text) => {
        text.inputEl.type         = "password";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck   = false;
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

    new Setting(panel)
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
    const header  = container.createDiv({ cls: "dgs-section-header" });
    const iconEl  = header.createSpan({ cls: "dgs-section-icon" });
    try { setIcon(iconEl, icon); } catch { iconEl.setText("•"); }
    header.createEl("h3", { text: title });
  }

  _updateSaveBtnState() {
    if (!this._saveBtn) return;
    this._saveBtn.setButtonText(
      this._isDirty() ? "Save Connection Settings (unsaved changes)" : "Save Connection Settings"
    );
  }

  async _saveCredentials() {
    const d      = this._draft;
    const issues = [];
    if (!d.pat)      issues.push("Personal Access Token is required.");
    if (!d.username) issues.push("GitHub username is required.");
    if (!d.repo)     issues.push("Repository name is required.");
    if (!d.branch)   issues.push("Branch is required.");
    if (d.pat && !/^(ghp_|github_pat_|gho_|ghs_|ghr_)/.test(d.pat))
      issues.push("PAT format looks incorrect — it should start with 'ghp_' or 'github_pat_'.");

    if (issues.length > 0) {
      this._showValidation("error", issues.join(" "));
      return;
    }

    this.plugin.settings.pat      = d.pat;
    this.plugin.settings.username = d.username;
    this.plugin.settings.repo     = d.repo;
    this.plugin.settings.branch   = d.branch;
    // Reset commit cursor so next op does a clean comparison
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
      this._showValidation("error", "Fill in all fields and save before testing.");
      return;
    }
    this._showValidation("info", "Testing connection…");
    try {
      const result = await this.plugin._client().validateSettings();
      this._showValidation(result.ok ? "ok" : "error", result.message);
    } catch (e) {
      this._showValidation("error", `Unexpected error: ${e.message}`);
    }
  }

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
    el.createSpan({ cls: "dgs-validation-icon" }).innerHTML = svgIcons[type] || svgIcons.info;
    el.createSpan({ text: "\u00a0" + message, cls: "dgs-validation-text" });
  }
}

module.exports = { DirectGitHubSyncSettingTab };
