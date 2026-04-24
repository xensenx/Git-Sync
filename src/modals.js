"use strict";

const { Modal, Notice, setIcon } = require("obsidian");

// ─────────────────────────────────────────────
//  Conflict Resolution Modal  (three-way)
// ─────────────────────────────────────────────

class ConflictResolutionModal extends Modal {
  constructor(app, conflicts, onResolve, onDismiss) {
    super(app);
    this.conflicts   = conflicts;
    this.onResolve   = onResolve;
    this.onDismiss   = onDismiss;
    this.resolutions = {};
    for (const c of conflicts) this.resolutions[c.path] = null;
    this._applied = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dgs-conflict-modal");

    // Header
    const header  = contentEl.createDiv({ cls: "dgs-conflict-header" });
    const iconEl  = header.createSpan({ cls: "dgs-conflict-header-icon" });
    try { setIcon(iconEl, "git-merge"); } catch { iconEl.setText("!"); }
    header.createEl("h2", { text: "Sync Conflicts Detected" });

    contentEl.createEl("p", {
      text: `${this.conflicts.length} file${this.conflicts.length === 1 ? "" : "s"} changed on both ` +
            `this device and remotely. Choose how to resolve each conflict.`,
      cls: "dgs-conflict-subtitle",
    });

    // Bulk actions
    const bulkBar         = contentEl.createDiv({ cls: "dgs-conflict-bulk" });
    const keepAllLocal    = bulkBar.createEl("button", { text: "Keep All Local" });
    const keepAllRemote   = bulkBar.createEl("button", { text: "Keep All Remote" });
    keepAllLocal.addClass("dgs-btn-bulk");
    keepAllRemote.addClass("dgs-btn-bulk");
    keepAllLocal.onclick  = () => this._bulkResolve("keep-local");
    keepAllRemote.onclick = () => this._bulkResolve("keep-remote");

    // Individual conflicts — store references on the data model, not the DOM
    this._conflictItems = [];
    this._listEl = contentEl.createDiv({ cls: "dgs-conflict-list" });

    for (const conflict of this.conflicts) {
      const item       = this._listEl.createDiv({ cls: "dgs-conflict-item" });
      item.dataset.path = conflict.path;

      const pathRow  = item.createDiv({ cls: "dgs-conflict-path-row" });
      const fIcon    = pathRow.createSpan({ cls: "dgs-conflict-file-icon" });
      try { setIcon(fIcon, "file-text"); } catch { fIcon.setText("F"); }
      pathRow.createSpan({ text: conflict.path, cls: "dgs-conflict-path" });

      // Accurate conflict descriptions using baseSha
      let desc = "Modified on both devices";
      if (!conflict.localSha && conflict.remoteSha) {
        desc = conflict.baseSha
          ? "Deleted locally, modified remotely"
          : "Created remotely, also created locally with no content match";
      } else if (conflict.localSha && !conflict.remoteSha) {
        desc = conflict.baseSha
          ? "Modified locally, deleted remotely"
          : "Created locally, deleted remotely (unusual)";
      } else if (!conflict.baseSha && conflict.localSha && conflict.remoteSha) {
        desc = "Created on both devices with different content";
      }
      item.createDiv({ text: desc, cls: "dgs-conflict-desc" });

      const btns      = item.createDiv({ cls: "dgs-conflict-btns" });
      const localBtn  = btns.createEl("button", { text: "Keep Local" });
      const remoteBtn = btns.createEl("button", { text: "Keep Remote" });
      const bothBtn   = btns.createEl("button", { text: "Keep Both" });
      localBtn.addClass("dgs-conflict-btn");
      remoteBtn.addClass("dgs-conflict-btn");
      bothBtn.addClass("dgs-conflict-btn");

      // Disable options that make no sense for this conflict type
      if (!conflict.localSha)  localBtn.disabled  = true;
      if (!conflict.remoteSha) remoteBtn.disabled = true;
      if (!conflict.localSha || !conflict.remoteSha) bothBtn.disabled = true;

      const buttons = { localBtn, remoteBtn, bothBtn };
      localBtn.onclick  = () => this._setResolution(conflict.path, "keep-local",  itemRecord);
      remoteBtn.onclick = () => this._setResolution(conflict.path, "keep-remote", itemRecord);
      bothBtn.onclick   = () => this._setResolution(conflict.path, "keep-both",   itemRecord);

      const itemRecord = { conflict, el: item, buttons };
      this._conflictItems.push(itemRecord);
    }

    // Footer
    const footer      = contentEl.createDiv({ cls: "dgs-conflict-footer" });
    this._applyBtn    = footer.createEl("button", { text: "Apply Resolutions" });
    this._applyBtn.addClass("mod-cta");
    this._applyBtn.addClass("dgs-conflict-apply");
    this._applyBtn.disabled = true;
    this._applyBtn.onclick  = () => this._apply();
  }

  _setResolution(path, resolution, itemRecord) {
    this.resolutions[path] = resolution;
    const { buttons, el } = itemRecord;
    Object.values(buttons).forEach((btn) => btn.removeClass("dgs-selected"));
    if (resolution === "keep-local")  buttons.localBtn.addClass("dgs-selected");
    if (resolution === "keep-remote") buttons.remoteBtn.addClass("dgs-selected");
    if (resolution === "keep-both")   buttons.bothBtn.addClass("dgs-selected");
    el.addClass("dgs-resolved");
    this._applyBtn.disabled = !Object.values(this.resolutions).every((r) => r !== null);
  }

  _bulkResolve(resolution) {
    // Data-driven: iterate the conflict model, not the DOM
    for (const itemRecord of this._conflictItems) {
      const { conflict } = itemRecord;

      // Respect disabled states — don't set a resolution that's invalid
      if (resolution === "keep-local" && !conflict.localSha) continue;
      if (resolution === "keep-remote" && !conflict.remoteSha) continue;
      if (resolution === "keep-both" && (!conflict.localSha || !conflict.remoteSha)) continue;

      this._setResolution(conflict.path, resolution, itemRecord);
    }
  }

  _apply() {
    if (!Object.values(this.resolutions).every((r) => r !== null)) {
      new Notice("Resolve all conflicts before applying.", 4000);
      return;
    }
    this._applied = true;
    this.close();
    this.onResolve(this.resolutions);
  }

  onClose() {
    if (!this._applied) this.onDismiss();
    this.contentEl.empty();
  }
}

// ─────────────────────────────────────────────
//  Force-Push Confirmation Modal
// ─────────────────────────────────────────────

class ForcePushModal extends Modal {
  constructor(app, remoteCommitSha, onForce, onCancel) {
    super(app);
    this.remoteCommitSha = remoteCommitSha;
    this.onForce  = onForce;
    this.onCancel = onCancel;
    this._decided = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dgs-force-modal");

    const header = contentEl.createDiv({ cls: "dgs-force-header" });
    const iconEl = header.createSpan({ cls: "dgs-force-header-icon" });
    try { setIcon(iconEl, "alert-triangle"); } catch { iconEl.setText("!"); }
    header.createEl("h2", { text: "Remote Has Newer Commits" });

    contentEl.createEl("p", {
      text: "The remote repository has commits newer than your last sync. " +
            "Pushing now will overwrite those remote changes.",
    });
    contentEl.createEl("p", {
      text:  `Remote commit: ${this.remoteCommitSha.slice(0, 12)}…`,
      cls:   "dgs-mono",
    });
    contentEl.createEl("p", {
      text: "Recommended: Pull first to bring remote changes locally, then push.",
      cls:  "dgs-force-recommend",
    });

    const row      = contentEl.createDiv({ cls: "dgs-modal-btns" });
    const cancelBtn = row.createEl("button", { text: "Cancel (recommended)" });
    cancelBtn.addClass("mod-cta");
    cancelBtn.onclick = () => { this._decided = true; this.close(); this.onCancel(); };
    const forceBtn  = row.createEl("button", { text: "Force Push Anyway" });
    forceBtn.addClass("dgs-btn-warning");
    forceBtn.onclick  = () => { this._decided = true; this.close(); this.onForce(); };
  }

  onClose() {
    // Clicking outside / pressing Esc → treat as cancel
    if (!this._decided) this.onCancel();
    this.contentEl.empty();
  }
}

module.exports = { ConflictResolutionModal, ForcePushModal };
