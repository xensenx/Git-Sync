/*
 * Direct GitHub Sync — Obsidian Plugin
 * main.js (vanilla JS, no build step required)
 *
 * Drop this file alongside manifest.json and styles.css into:
 *   <vault>/.obsidian/plugins/direct-github-sync/
 * then enable it in Settings → Community Plugins.
 */

"use strict";

const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl, setIcon } =
  require("obsidian");

// ─────────────────────────────────────────────
//  Constants & Default Settings
// ─────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  pat: "",
  username: "",
  repo: "",
  branch: "main",
  ignoreObsidianDir: true,
  ignoredPaths: "",
  deviceName: "",
  concurrency: 5,
  autoSyncEnabled: false,
  autoSyncInterval: 5,    // minutes of idle before auto-sync fires
  syncOnStartup: true,
  // filepath -> blob SHA of last successful sync (the "base" state)
  syncCache: {},
  // DEPRECATED — migrated to syncCache on first load
  lastPulledShas: {},
  // Remote commit SHA we last synced against
  lastKnownRemoteCommit: "",
  // Timestamp (ms) of last successful sync
  lastSyncTime: 0,
};

const GITHUB_API = "https://api.github.com";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2500;
const MAX_SYNC_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (Base64 inflates ~33% → stays under GitHub's 100 MB blob limit)
const PASSIVE_POLL_INTERVAL_MS = 120_000;     // 2 minutes

// ─────────────────────────────────────────────
//  Low-level helpers
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry wrapper.  Auth/config errors (401, 403, 404, 422) are NOT retried.
 */
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 422) throw e;
      lastErr = e;
      if (attempt <= MAX_RETRIES) {
        console.warn(`[DGS] "${label}" attempt ${attempt}/${MAX_RETRIES + 1} failed, retrying… (${e.message})`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

/**
 * Bounded concurrency pool.  Returns { ok, value } | { ok:false, error, item }
 */
async function parallelBatch(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      try { results[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (e) { results[i] = { ok: false, error: e, item: items[i] }; }
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────
//  Encoding helpers  (chunked — no main-thread freeze)
// ─────────────────────────────────────────────

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const end = Math.min(i + chunkSize, len);
    for (let j = i; j < end; j++) bytes[j] = binary.charCodeAt(j);
  }
  return bytes.buffer;
}

// ─────────────────────────────────────────────
//  Path, SHA & ignore helpers
// ─────────────────────────────────────────────

function normalisePath(p) {
  return p.replace(/^\/+/, "").replace(/\\/g, "/");
}

/**
 * Git blob SHA = sha1("blob " + byteLength + "\0" + fileBytes)
 * Uses WebCrypto — async and non-blocking.
 */
async function computeGitBlobSha(arrayBuffer) {
  const fileBytes = new Uint8Array(arrayBuffer);
  const header = `blob ${fileBytes.byteLength}\0`;
  const headerBytes = new TextEncoder().encode(header);
  const combined = new Uint8Array(headerBytes.byteLength + fileBytes.byteLength);
  combined.set(headerBytes, 0);
  combined.set(fileBytes, headerBytes.byteLength);
  const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Should this path be ignored during sync?
 * Checks .gitkeep, .obsidian toggle, and user-defined ignoredPaths.
 */
function shouldIgnorePath(path, settings) {
  if (path === ".gitkeep") return true;
  if (settings.ignoreObsidianDir && (path.startsWith(".obsidian/") || path === ".obsidian")) return true;
  const rules = (settings.ignoredPaths || "")
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith("#"));
  return rules.some((rule) => {
    if (rule.endsWith("/")) return path.startsWith(rule) || path + "/" === rule;
    if (rule.includes("*")) {
      const regex = new RegExp("^" + rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(path);
    }
    return path === rule || path.startsWith(rule + "/");
  });
}

/**
 * Build the commit message.
 */
function buildCommitMessage(deviceName) {
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const from = deviceName && deviceName.trim() ? ` from ${deviceName.trim()}` : "";
  return `Vault sync${from}: ${date} at ${time}`;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ─────────────────────────────────────────────
//  GitHub REST client
// ─────────────────────────────────────────────

class GitHubClient {
  constructor(pat, username, repo, branch) {
    this.pat = pat;
    this.username = username;
    this.repo = repo;
    this.branch = branch;
    this.base = `${GITHUB_API}/repos/${username}/${repo}`;
    this._established = false;
  }

  get _headers() {
    return {
      Authorization: `Bearer ${this.pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async _req(method, url, body) {
    const opts = { url, method, headers: this._headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    let resp;
    try { resp = await requestUrl(opts); }
    catch (netErr) {
      const e = new Error(`Network error — check your internet connection. (${netErr.message})`);
      e.status = 0;
      throw e;
    }
    if (resp.status >= 400) {
      const ghMsg = resp.json?.message || resp.text || "";
      const e = new Error(this._friendlyError(resp.status, url, ghMsg));
      e.status = resp.status;
      e.ghMessage = ghMsg;
      throw e;
    }
    return resp.json;
  }

  _friendlyError(status, url, ghMsg) {
    const isRepo = url.includes(`/repos/${this.username}/${this.repo}`);
    switch (status) {
      case 401: return "Authentication failed — your PAT is invalid or expired.";
      case 403:
        if (ghMsg.toLowerCase().includes("rate limit")) return "GitHub rate limit exceeded. Wait a few minutes.";
        return "Access forbidden — PAT may lack 'repo' scope.";
      case 404:
        if (isRepo && url.includes(`/commits/${this.branch}`))
          return `Branch "${this.branch}" not found in "${this.username}/${this.repo}".`;
        if (isRepo) return `Repository "${this.username}/${this.repo}" not found.`;
        return `Resource not found (404): ${url}`;
      case 409: return `Repository "${this.username}/${this.repo}" is empty — will be initialised automatically.`;
      case 422: return `GitHub rejected the request (422): ${ghMsg || "check settings."}`;
      default: return `GitHub API error (${status}): ${ghMsg || "unknown"}`;
    }
  }

  // ── Read ──────────────────────────────────────

  async getLatestCommit() {
    const data = await withRetry(() => this._req("GET", `${this.base}/commits/${this.branch}`), "getLatestCommit");
    return { commitSha: data.sha, treeSha: data.commit.tree.sha };
  }

  async getFullTree(treeSha) {
    const data = await withRetry(
      () => this._req("GET", `${this.base}/git/trees/${treeSha}?recursive=1`),
      "getFullTree"
    );
    if (data.truncated) new Notice("GitHub tree truncated (repo >100k files). Some files may be missing.", 8000);
    return data.tree;
  }

  async getBlob(sha) {
    const data = await withRetry(() => this._req("GET", `${this.base}/git/blobs/${sha}`), "getBlob");
    return data.content.replace(/\n/g, "");
  }

  // ── Write ─────────────────────────────────────

  async createBlob(base64Content) {
    const data = await withRetry(
      () => this._req("POST", `${this.base}/git/blobs`, { content: base64Content, encoding: "base64" }),
      "createBlob"
    );
    return data.sha;
  }

  async createTree(baseTreeSha, treeItems, deletions = []) {
    const deleteEntries = deletions.map((path) => ({ path, mode: "100644", type: "blob", sha: null }));
    const data = await withRetry(
      () => this._req("POST", `${this.base}/git/trees`, { base_tree: baseTreeSha, tree: [...treeItems, ...deleteEntries] }),
      "createTree"
    );
    return data.sha;
  }

  async createCommit(message, treeSha, parentSha) {
    const data = await withRetry(
      () => this._req("POST", `${this.base}/git/commits`, { message, tree: treeSha, parents: [parentSha] }),
      "createCommit"
    );
    return data.sha;
  }

  async updateRef(commitSha) {
    await withRetry(
      () => this._req("PATCH", `${this.base}/git/refs/heads/${this.branch}`, { sha: commitSha, force: false }),
      "updateRef"
    );
  }

  async initRepoIfNeeded() {
    if (this._established) return false;
    try {
      await this.getLatestCommit();
      this._established = true;
      return false;
    } catch (e) {
      if (e.status !== 404 && e.status !== 409) throw e;
    }
    try {
      await withRetry(() => this._req("GET", `${this.base}`), "check repo existence");
    } catch (e) {
      if (e.status === 404) throw new Error(`Repository "${this.username}/${this.repo}" not found.`);
      throw e;
    }
    await withRetry(
      () => this._req("PUT", `${this.base}/contents/.gitkeep`, {
        message: "Initial commit (Direct GitHub Sync)",
        content: btoa(""),
        branch: this.branch,
      }),
      "bootstrap .gitkeep"
    );
    this._established = true;
    return true;
  }

  async validateSettings() {
    let userResp;
    try {
      userResp = await requestUrl({ url: `${GITHUB_API}/user`, method: "GET", headers: this._headers });
    } catch { return { ok: false, message: "Network error — check your internet connection." }; }

    if (userResp.status === 401) return { ok: false, message: "PAT is invalid or expired." };
    if (userResp.status === 403) return { ok: false, message: "PAT lacks permissions. Ensure it has 'repo' scope." };

    const actualLogin = userResp.json?.login || "";
    if (actualLogin.toLowerCase() !== this.username.toLowerCase())
      return { ok: false, message: `Username mismatch — PAT belongs to "${actualLogin}", settings say "${this.username}".` };

    let repoResp;
    try {
      repoResp = await requestUrl({ url: `${this.base}`, method: "GET", headers: this._headers });
    } catch { return { ok: false, message: "Network error while checking repository." }; }

    if (repoResp.status === 404) return { ok: false, message: `Repository "${this.username}/${this.repo}" not found.` };
    if (repoResp.status === 403) return { ok: false, message: `PAT doesn't have access to "${this.username}/${this.repo}".` };

    try {
      const branchResp = await requestUrl({ url: `${this.base}/branches/${this.branch}`, method: "GET", headers: this._headers });
      if (branchResp.status === 404) return { ok: false, message: `Branch "${this.branch}" not found.` };
    } catch { /* empty repo — fine */ }

    return { ok: true, message: `Connected to ${this.username}/${this.repo} on branch "${this.branch}" ✓` };
  }
}

// ─────────────────────────────────────────────
//  Conflict Resolution Modal  (three-way)
// ─────────────────────────────────────────────

class ConflictResolutionModal extends Modal {
  constructor(app, conflicts, onResolve, onDismiss) {
    super(app);
    this.conflicts = conflicts;   // [{ path, localSha, remoteSha, baseSha }]
    this.onResolve = onResolve;
    this.onDismiss = onDismiss;
    this.resolutions = {};
    for (const c of conflicts) this.resolutions[c.path] = null;
    this._applied = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dgs-conflict-modal");

    // Header
    const header = contentEl.createDiv({ cls: "dgs-conflict-header" });
    const iconEl = header.createSpan({ cls: "dgs-conflict-header-icon" });
    setIcon(iconEl, "zap");
    header.createEl("h2", { text: "Sync Conflicts Detected" });

    contentEl.createEl("p", {
      text: `${this.conflicts.length} file(s) were changed on both this device and remotely. Choose how to resolve each conflict.`,
      cls: "dgs-conflict-subtitle",
    });

    // Bulk actions
    const bulkBar = contentEl.createDiv({ cls: "dgs-conflict-bulk" });
    const keepAllLocal = bulkBar.createEl("button", { text: "Keep All Local" });
    keepAllLocal.addClass("dgs-btn-bulk");
    keepAllLocal.onclick = () => this._bulkResolve("keep-local");
    const keepAllRemote = bulkBar.createEl("button", { text: "Keep All Remote" });
    keepAllRemote.addClass("dgs-btn-bulk");
    keepAllRemote.onclick = () => this._bulkResolve("keep-remote");

    // Individual conflicts
    this._listEl = contentEl.createDiv({ cls: "dgs-conflict-list" });

    for (const conflict of this.conflicts) {
      const item = this._listEl.createDiv({ cls: "dgs-conflict-item" });
      item.dataset.path = conflict.path;

      // Icon + path
      const pathRow = item.createDiv({ cls: "dgs-conflict-path-row" });
      const fIcon = pathRow.createSpan({ cls: "dgs-conflict-file-icon" });
      setIcon(fIcon, "file-text");
      pathRow.createSpan({ text: conflict.path, cls: "dgs-conflict-path" });

      // Description
      let desc = "Modified on both devices";
      if (!conflict.localSha && conflict.remoteSha) desc = "Deleted locally, modified remotely";
      else if (conflict.localSha && !conflict.remoteSha) desc = "Modified locally, deleted remotely";
      else if (!conflict.baseSha) desc = "Created on both devices with different content";
      item.createDiv({ text: desc, cls: "dgs-conflict-desc" });

      // Action buttons
      const btns = item.createDiv({ cls: "dgs-conflict-btns" });
      const localBtn = btns.createEl("button", { text: "← Keep Local" });
      localBtn.addClass("dgs-conflict-btn");
      const remoteBtn = btns.createEl("button", { text: "Keep Remote →" });
      remoteBtn.addClass("dgs-conflict-btn");
      const bothBtn = btns.createEl("button", { text: "Keep Both" });
      bothBtn.addClass("dgs-conflict-btn");

      localBtn.onclick = () => this._setResolution(conflict.path, "keep-local", item, { localBtn, remoteBtn, bothBtn });
      remoteBtn.onclick = () => this._setResolution(conflict.path, "keep-remote", item, { localBtn, remoteBtn, bothBtn });
      bothBtn.onclick = () => this._setResolution(conflict.path, "keep-both", item, { localBtn, remoteBtn, bothBtn });

      item._buttons = { localBtn, remoteBtn, bothBtn };
    }

    // Footer
    const footer = contentEl.createDiv({ cls: "dgs-conflict-footer" });
    this._applyBtn = footer.createEl("button", { text: "Apply Resolutions" });
    this._applyBtn.addClass("mod-cta");
    this._applyBtn.addClass("dgs-conflict-apply");
    this._applyBtn.disabled = true;
    this._applyBtn.onclick = () => this._apply();
  }

  _setResolution(path, resolution, itemEl, buttons) {
    this.resolutions[path] = resolution;
    Object.values(buttons).forEach((btn) => btn.removeClass("dgs-selected"));
    if (resolution === "keep-local") buttons.localBtn.addClass("dgs-selected");
    if (resolution === "keep-remote") buttons.remoteBtn.addClass("dgs-selected");
    if (resolution === "keep-both") buttons.bothBtn.addClass("dgs-selected");
    itemEl.addClass("dgs-resolved");
    this._applyBtn.disabled = !Object.values(this.resolutions).every((r) => r !== null);
  }

  _bulkResolve(resolution) {
    const items = this._listEl.querySelectorAll(".dgs-conflict-item");
    for (const item of items) {
      const path = item.dataset.path;
      this._setResolution(path, resolution, item, item._buttons);
    }
  }

  _apply() {
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
//  Force-Push Conflict Modal  (remote ahead warning)
// ─────────────────────────────────────────────

class ConflictModal extends Modal {
  constructor(app, remoteCommitSha, onForce, onCancel) {
    super(app);
    this.remoteCommitSha = remoteCommitSha;
    this.onForce = onForce;
    this.onCancel = onCancel;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dgs-force-modal");

    const header = contentEl.createDiv({ cls: "dgs-force-header" });
    const iconEl = header.createSpan({ cls: "dgs-force-header-icon" });
    setIcon(iconEl, "alert-triangle");
    header.createEl("h2", { text: "Remote Has Newer Commits" });

    contentEl.createEl("p", {
      text: "The remote repository has commits newer than your last sync. Pushing now will overwrite those changes.",
    });
    contentEl.createEl("p", {
      text: `Remote commit: ${this.remoteCommitSha.slice(0, 12)}…`,
      cls: "dgs-mono",
    });
    contentEl.createEl("p", {
      text: "Recommended: Pull or Sync first to bring remote changes locally.",
      cls: "dgs-force-recommend",
    });

    const row = contentEl.createDiv({ cls: "dgs-modal-btns" });
    const cancelBtn = row.createEl("button", { text: "Cancel (recommended)" });
    cancelBtn.addClass("mod-cta");
    cancelBtn.onclick = () => { this.close(); this.onCancel(); };
    const forceBtn = row.createEl("button", { text: "Force Push Anyway" });
    forceBtn.addClass("dgs-btn-warning");
    forceBtn.onclick = () => { this.close(); this.onForce(); };
  }

  onClose() { this.contentEl.empty(); }
}

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
    this._initStatusBar();

    // ── Passive monitor ──
    this._passiveTimer = null;
    this._startPassiveMonitor();

    // ── Auto-sync ──
    this._autoSyncTimeout = null;
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.syncOnStartup && this.settings.autoSyncEnabled) {
        setTimeout(() => this.sync({ silent: true }), 5000);
      }
      this._initAutoSync();
    });

    console.log("[DGS] Plugin loaded.");
  }

  onunload() {
    if (this._passiveTimer) clearInterval(this._passiveTimer);
    if (this._autoSyncTimeout) clearTimeout(this._autoSyncTimeout);
    if (this._relativeTimeTimer) clearInterval(this._relativeTimeTimer);
    console.log("[DGS] Plugin unloaded.");
  }

  // ── Persistence ───────────────────────────────────────────────────────

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
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
    await this.saveData(this.settings);
  }

  // ── Validation ────────────────────────────────────────────────────────

  _validate() {
    const s = this.settings;
    const issues = [];
    if (!s.pat) issues.push("PAT is not set.");
    if (!s.username) issues.push("Username is not set.");
    if (!s.repo) issues.push("Repository is not set.");
    if (!s.branch) issues.push("Branch is not set.");
    if (issues.length > 0) throw new Error("Settings incomplete — open plugin settings:\n• " + issues.join("\n• "));
    if (!/^(ghp_|github_pat_|gho_|ghs_|ghr_)/.test(s.pat))
      throw new Error("PAT format looks incorrect — should start with 'ghp_' or 'github_pat_'.");
  }

  _isConfigured() {
    const s = this.settings;
    return s.pat && s.username && s.repo && s.branch;
  }

  _client() {
    const s = this.settings;
    return new GitHubClient(s.pat, s.username, s.repo, s.branch);
  }

  // ── Status Bar ────────────────────────────────────────────────────────

  _initStatusBar() {
    this._statusBarEl = this.addStatusBarItem();
    this._statusBarEl.addClass("dgs-statusbar-item");
    this._statusBarIconEl = this._statusBarEl.createSpan({ cls: "dgs-statusbar-icon" });
    this._statusBarTextEl = this._statusBarEl.createSpan({ cls: "dgs-statusbar-text" });
    this._statusBarEl.addEventListener("click", () => this._onStatusBarClick());
    this._updateStatusBar("idle");

    // Update relative time every 30s
    this._relativeTimeTimer = window.setInterval(() => {
      if (this._statusBarState === "synced") this._updateStatusBar("synced");
    }, 30000);
  }

  _updateStatusBar(state, detail) {
    this._statusBarState = state;
    if (detail) this._statusBarDetail = detail;

    // Clear all state classes
    const el = this._statusBarEl;
    el.className = "dgs-statusbar-item";

    const icon = this._statusBarIconEl;
    const text = this._statusBarTextEl;
    icon.empty();

    const states = {
      idle: { icon: "cloud", text: "DGS", cls: "dgs-sb-idle" },
      unconfigured: { icon: "cloud-off", text: "Not configured", cls: "dgs-sb-unconfigured" },
      syncing: { icon: "refresh-cw", text: "Syncing…", cls: "dgs-sb-syncing" },
      synced: { icon: "check-circle-2", text: `Synced · ${formatRelativeTime(this.settings.lastSyncTime)}`, cls: "dgs-sb-synced" },
      "local-ahead": { icon: "upload-cloud", text: detail?.count ? `↑ ${detail.count} to push` : "↑ Local changes", cls: "dgs-sb-local-ahead" },
      "remote-ahead": { icon: "download-cloud", text: "↓ Remote changes", cls: "dgs-sb-remote-ahead" },
      diverged: { icon: "git-compare", text: `↑${detail?.localAhead || "?"} ↓ remote`, cls: "dgs-sb-diverged" },
      conflicts: { icon: "zap", text: detail || "Conflicts", cls: "dgs-sb-conflicts" },
      error: { icon: "alert-triangle", text: "Sync error", cls: "dgs-sb-error" },
      offline: { icon: "wifi-off", text: "Offline", cls: "dgs-sb-offline" },
    };

    const s = states[state] || states.idle;
    try { setIcon(icon, s.icon); } catch { icon.setText("●"); }
    text.setText(s.text);
    el.addClass(s.cls);
  }

  _onStatusBarClick() {
    if (this._statusBarState === "syncing") return;
    if (this._statusBarState === "unconfigured") {
      new Notice("Configure GitHub settings first.", 4000);
      return;
    }
    if (this._statusBarState === "error") {
      new Notice(`Last error: ${this._statusBarDetail || "Unknown"}`, 8000);
      return;
    }
    this.sync();
  }

  // ── Passive Monitor ───────────────────────────────────────────────────

  _startPassiveMonitor() {
    // Delay first check
    setTimeout(() => this._checkSyncStatus(), 8000);
    this._passiveTimer = window.setInterval(() => this._checkSyncStatus(), PASSIVE_POLL_INTERVAL_MS);
  }

  async _checkSyncStatus() {
    if (this._isSyncing) return;
    if (!this._isConfigured()) { this._updateStatusBar("unconfigured"); return; }

    try {
      const client = this._client();
      const { commitSha } = await client.getLatestCommit();

      const remoteAhead = this.settings.lastKnownRemoteCommit &&
        commitSha !== this.settings.lastKnownRemoteCommit;

      // Quick local check via mtimes
      const lastSync = this.settings.lastSyncTime || 0;
      const localFiles = this.app.vault.getFiles()
        .filter((f) => !shouldIgnorePath(normalisePath(f.path), this.settings));
      const cache = this.settings.syncCache || {};

      let localAhead = 0;
      const localPaths = new Set();
      for (const f of localFiles) {
        const p = normalisePath(f.path);
        localPaths.add(p);
        if (!cache[p]) { localAhead++; continue; }
        if (f.stat.mtime > lastSync) localAhead++;
      }
      // Locally deleted files
      for (const cp of Object.keys(cache)) {
        if (!localPaths.has(cp) && !shouldIgnorePath(cp, this.settings)) localAhead++;
      }

      if (localAhead > 0 && remoteAhead) {
        this._updateStatusBar("diverged", { localAhead, remoteAhead: true });
      } else if (localAhead > 0) {
        this._updateStatusBar("local-ahead", { count: localAhead });
      } else if (remoteAhead) {
        this._updateStatusBar("remote-ahead");
      } else {
        this._updateStatusBar("synced");
      }
    } catch (e) {
      if (e.status === 0) this._updateStatusBar("offline");
      else this._updateStatusBar("error", e.message);
    }
  }

  // ── Auto-Sync ─────────────────────────────────────────────────────────

  _initAutoSync() {
    if (!this.settings.autoSyncEnabled) return;

    const resetTimer = () => {
      if (this._autoSyncTimeout) clearTimeout(this._autoSyncTimeout);
      this._autoSyncTimeout = setTimeout(
        () => this.sync({ silent: true }),
        this.settings.autoSyncInterval * 60 * 1000
      );
    };

    this.registerEvent(this.app.vault.on("modify", resetTimer));
    this.registerEvent(this.app.vault.on("create", resetTimer));
    this.registerEvent(this.app.vault.on("delete", resetTimer));
    this.registerEvent(this.app.vault.on("rename", resetTimer));
  }

  // ─────────────────────────────────────────────────────────────────────
  //  THREE-WAY SYNC ENGINE
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Build the three-way sync plan.
   * Compares Base (cache) vs Local vs Remote for every known path.
   */
  _buildSyncPlan(localEntries, remoteBlobs, cache) {
    const plan = {
      toUpload: [],        // { path, sha, buf }
      toDownload: [],      // { path, sha }     (remote blob SHA)
      toDeleteRemote: [],  // [ path ]
      toDeleteLocal: [],   // [ path ]
      conflicts: [],       // { path, localSha, remoteSha, baseSha }
      upToDate: [],        // [ path ]
      toCleanCache: [],    // [ path ]  (stale cache entries)
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
      if (shouldIgnorePath(path, this.settings)) continue;

      const base = cache[path] || null;
      const local = localMap.get(path);
      const localSha = local ? local.sha : null;
      const remoteSha = remoteMap.get(path) || null;

      // ── Case 1: All identical ──
      if (localSha === remoteSha && localSha === base) {
        if (localSha) plan.upToDate.push(path);
        continue;
      }

      // ── Case 2: No base (new files) ──
      if (!base) {
        if (localSha && !remoteSha) {
          plan.toUpload.push(local);
        } else if (!localSha && remoteSha) {
          plan.toDownload.push({ path, sha: remoteSha });
        } else if (localSha && remoteSha) {
          if (localSha === remoteSha) plan.upToDate.push(path);
          else plan.conflicts.push({ path, localSha, remoteSha, baseSha: null });
        }
        continue;
      }

      // ── Case 3: Base exists ──
      const localUnchanged = localSha === base;
      const remoteUnchanged = remoteSha === base;

      if (localUnchanged && remoteUnchanged) {
        plan.upToDate.push(path);
      } else if (!localUnchanged && remoteUnchanged) {
        // Local changed, remote didn't
        if (localSha) plan.toUpload.push(local);
        else plan.toDeleteRemote.push(path);   // local deleted
      } else if (localUnchanged && !remoteUnchanged) {
        // Remote changed, local didn't
        if (remoteSha) plan.toDownload.push({ path, sha: remoteSha });
        else plan.toDeleteLocal.push(path);   // remote deleted
      } else {
        // Both changed
        if (localSha === remoteSha) {
          // Same edit on both sides (or both deleted)
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
   * Apply user's conflict resolutions to the plan.
   */
  async _applyConflictResolutions(plan, resolutions, localBuffers) {
    for (const conflict of [...plan.conflicts]) {
      const resolution = resolutions[conflict.path];
      if (!resolution) continue;

      switch (resolution) {
        case "keep-local":
          if (conflict.localSha) {
            const buf = localBuffers.get(conflict.path);
            if (buf) plan.toUpload.push({ path: conflict.path, sha: conflict.localSha, buf });
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
            // Rename local file, download remote to original path
            const ext = conflict.path.includes(".") ? "." + conflict.path.split(".").pop() : "";
            const baseName = conflict.path.includes(".")
              ? conflict.path.slice(0, conflict.path.lastIndexOf("."))
              : conflict.path;
            const dateStr = new Date().toISOString().slice(0, 10);
            const newPath = `${baseName} (Local Conflict - ${dateStr})${ext}`;

            const file = this.app.vault.getAbstractFileByPath(conflict.path);
            if (file) {
              await this.app.vault.rename(file, newPath);
              const renamedBuf = await this.app.vault.adapter.readBinary(newPath);
              const renamedSha = await computeGitBlobSha(renamedBuf);
              plan.toUpload.push({ path: newPath, sha: renamedSha, buf: renamedBuf });
            }
            plan.toDownload.push({ path: conflict.path, sha: conflict.remoteSha });
          } else if (conflict.localSha) {
            // Remote deleted, keep local → upload
            const buf = localBuffers.get(conflict.path);
            if (buf) plan.toUpload.push({ path: conflict.path, sha: conflict.localSha, buf });
          } else if (conflict.remoteSha) {
            // Local deleted, keep remote → download
            plan.toDownload.push({ path: conflict.path, sha: conflict.remoteSha });
          }
          break;
        }
      }
    }
    plan.conflicts = [];
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
    const concurrency = this.settings.concurrency || 5;
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
      const allFiles = this.app.vault.getFiles().filter(
        (f) => !shouldIgnorePath(normalisePath(f.path), this.settings)
      );

      // File size filter
      const oversized = allFiles.filter((f) => f.stat.size > MAX_SYNC_FILE_SIZE);
      const files = allFiles.filter((f) => f.stat.size <= MAX_SYNC_FILE_SIZE);
      if (oversized.length > 0) {
        const names = oversized.map((f) => f.path).join(", ");
        console.warn(`[DGS] Skipping ${oversized.length} file(s) > 50MB: ${names}`);
        if (!silent) new Notice(`⚠️ ${oversized.length} file(s) > 50MB skipped (GitHub limit):\n${names}`, 8000);
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
      if (hashFailed.length > 0 && !silent) {
        new Notice(`⚠️ ${hashFailed.length} file(s) unreadable, skipped.`, 6000);
      }

      // 3. Build three-way sync plan
      setMsg("Sync: analyzing changes…");
      const cache = this.settings.syncCache || {};
      const plan = this._buildSyncPlan(localEntries, remoteBlobs, cache);

      // Store buffers for conflict resolution
      const localBuffers = new Map();
      for (const e of localEntries) localBuffers.set(e.path, e.buf);

      // 4. Handle conflicts
      if (plan.conflicts.length > 0) {
        if (notice) notice.hide();

        if (silent) {
          // Auto-sync: show status bar indicator, don't show modal
          this._updateStatusBar("conflicts", `${plan.conflicts.length} conflict(s) — click to resolve`);
          this._pendingConflicts = { plan, localBuffers, client, concurrency, commitSha, treeSha, remoteTree, localEntries, remoteBlobs, cache };
          this._isSyncing = false;
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
          this._updateStatusBar("conflicts", `${plan.conflicts.length} unresolved`);
          this._isSyncing = false;
          return;
        }

        await this._applyConflictResolutions(plan, resolutions, localBuffers);
      }

      // 5. Execute sync plan
      await this._executeSyncPlan(plan, client, concurrency, commitSha, treeSha, remoteTree, localEntries, cache, setMsg, silent);

      if (notice) setTimeout(() => notice.hide(), 6000);

    } catch (e) {
      console.error("[DGS] Sync error:", e);
      if (notice) { notice.setMessage(`Sync failed: ${e.message}`); setTimeout(() => notice.hide(), 12000); }
      if (e.status === 0) this._updateStatusBar("offline");
      else this._updateStatusBar("error", e.message);
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Execute a sync plan: downloads, local deletions, uploads, remote deletions, commit.
   */
  async _executeSyncPlan(plan, client, concurrency, commitSha, treeSha, remoteTree, localEntries, cache, setMsg, silent) {
    const newCache = { ...cache };
    let downloaded = 0, uploaded = 0, deletedLocal = 0, deletedRemote = 0;

    // Nothing to do?
    if (plan.toUpload.length === 0 && plan.toDownload.length === 0 &&
      plan.toDeleteRemote.length === 0 && plan.toDeleteLocal.length === 0) {
      setMsg("Sync: already up to date.");
      // Still update cache for upToDate entries and commit cursor
      for (const e of localEntries) newCache[e.path] = e.sha;
      for (const p of plan.toCleanCache) delete newCache[p];
      this.settings.syncCache = newCache;
      this.settings.lastKnownRemoteCommit = commitSha;
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();
      this._updateStatusBar("synced");
      return;
    }

    // ── Downloads ──
    if (plan.toDownload.length > 0) {
      setMsg(`Sync: downloading ${plan.toDownload.length} file(s)…`);
      // Ensure remote folders exist locally
      const folders = remoteTree.filter((n) => n.type === "tree");
      for (const folder of folders) {
        const fp = normalisePath(folder.path);
        if (shouldIgnorePath(fp, this.settings)) continue;
        if (!this.app.vault.getAbstractFileByPath(fp)) {
          try { await this.app.vault.createFolder(fp); } catch { /* exists */ }
        }
      }
      const dlResults = await parallelBatch(plan.toDownload, concurrency, async (item) => {
        const fp = item.path;
        const b64 = await client.getBlob(item.sha);
        const buf = base64ToArrayBuffer(b64);
        const existing = this.app.vault.getAbstractFileByPath(fp);
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
        downloaded++;
        setMsg(`Sync: downloaded ${downloaded}/${plan.toDownload.length}…`);
        return { path: fp, sha: item.sha };
      });
      for (const r of dlResults) { if (r.ok) newCache[r.value.path] = r.value.sha; }
      const dlFailed = dlResults.filter((r) => !r.ok);
      if (dlFailed.length > 0 && !silent) {
        new Notice(`⚠️ ${dlFailed.length} file(s) failed to download.`, 8000);
      }
    }

    // ── Local deletions ──
    if (plan.toDeleteLocal.length > 0) {
      setMsg(`Sync: deleting ${plan.toDeleteLocal.length} local file(s)…`);
      for (const fp of plan.toDeleteLocal) {
        try {
          const existing = this.app.vault.getAbstractFileByPath(fp);
          if (existing) await this.app.vault.trash(existing, true);
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
        setMsg(`Sync: uploaded ${uploaded}/${plan.toUpload.length}…`);
        return { path: item.path, sha: blobSha };
      });
      uploadedEntries = ulResults.filter((r) => r.ok).map((r) => r.value);
      for (const e of uploadedEntries) newCache[e.path] = e.sha;
      const ulFailed = ulResults.filter((r) => !r.ok);
      if (ulFailed.length > 0 && !silent) {
        new Notice(`⚠️ ${ulFailed.length} file(s) failed to upload.`, 8000);
      }
    }

    // ── Commit (if there were uploads or remote deletions) ──
    let newCommitSha = commitSha;
    if (uploadedEntries.length > 0 || plan.toDeleteRemote.length > 0) {
      setMsg("Sync: creating commit…");
      const treeItems = uploadedEntries.map((f) => ({
        path: f.path, mode: "100644", type: "blob", sha: f.sha,
      }));
      const newTreeSha = await client.createTree(treeSha, treeItems, plan.toDeleteRemote);
      const msg = buildCommitMessage(this.settings.deviceName);
      newCommitSha = await client.createCommit(msg, newTreeSha, commitSha);
      setMsg("Sync: updating branch…");
      await client.updateRef(newCommitSha);
      for (const dp of plan.toDeleteRemote) delete newCache[dp];
      deletedRemote = plan.toDeleteRemote.length;
    }

    // ── Update upToDate entries in cache ──
    for (const path of plan.upToDate) {
      const localEntry = localEntries.find((e) => e.path === path);
      if (localEntry) newCache[path] = localEntry.sha;
    }
    for (const p of plan.toCleanCache) delete newCache[p];

    // ── Persist ──
    this.settings.syncCache = newCache;
    this.settings.lastKnownRemoteCommit = newCommitSha;
    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();

    // ── Summary ──
    const parts = [];
    if (downloaded > 0) parts.push(`${downloaded} downloaded`);
    if (uploaded > 0) parts.push(`${uploaded} uploaded`);
    if (deletedLocal > 0) parts.push(`${deletedLocal} deleted locally`);
    if (deletedRemote > 0) parts.push(`${deletedRemote} deleted remotely`);
    const summary = parts.length > 0 ? parts.join(", ") : "up to date";
    setMsg(`Sync complete — ${summary}.`);
    this._updateStatusBar("synced");
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PUSH  (Local → GitHub)  — one-directional with safety checks
  // ─────────────────────────────────────────────────────────────────────

  async push(forcePush = false) {
    try { this._validate(); } catch (e) { new Notice(e.message, 8000); return; }

    const client = this._client();
    const concurrency = this.settings.concurrency || 5;
    const status = new Notice("Push: connecting…", 0);

    try {
      // 0. Bootstrap
      const initialised = await client.initRepoIfNeeded();
      if (initialised) { status.setMessage("Push: initialised empty repository."); await sleep(800); }

      // 1. Fetch remote + local
      status.setMessage("Push: reading local and remote state…");
      const [{ commitSha, treeSha }, allFiles] = await Promise.all([
        client.getLatestCommit(),
        Promise.resolve(this.app.vault.getFiles()),
      ]);

      // ── Conflict detection (remote ahead) ──
      if (!forcePush && this.settings.lastKnownRemoteCommit &&
        this.settings.lastKnownRemoteCommit !== commitSha) {
        status.hide();
        new ConflictModal(this.app, commitSha,
          () => this.push(true),
          () => new Notice("Push cancelled. Pull or Sync first.", 6000)
        ).open();
        return;
      }

      const remoteTreePromise = client.getFullTree(treeSha);

      // Filter files
      const files = allFiles.filter((f) => {
        const p = normalisePath(f.path);
        return !shouldIgnorePath(p, this.settings) && f.stat.size <= MAX_SYNC_FILE_SIZE;
      });

      // Warn about oversized files
      const oversized = allFiles.filter((f) => f.stat.size > MAX_SYNC_FILE_SIZE && !shouldIgnorePath(normalisePath(f.path), this.settings));
      if (oversized.length > 0) {
        new Notice(`⚠️ ${oversized.length} file(s) > 50MB skipped.`, 6000);
      }

      if (files.length === 0) {
        status.setMessage("Push: nothing to push — vault is empty.");
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // 2. Hash + remote tree
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
      if (hashFailed.length > 0) {
        new Notice(`⚠️ ${hashFailed.length} file(s) unreadable, skipped.`, 8000);
      }

      const remoteShaMap = {};
      for (const node of remoteTree) { if (node.type === "blob") remoteShaMap[node.path] = node.sha; }

      // 3. Diff
      const localPaths = new Set(localEntries.map((e) => e.path));
      const changed = localEntries.filter((e) => remoteShaMap[e.path] !== e.sha);
      const unchanged = localEntries.filter((e) => remoteShaMap[e.path] === e.sha);
      const toDeleteRemotely = Object.keys(remoteShaMap).filter((rPath) => {
        if (shouldIgnorePath(rPath, this.settings)) return false;
        return !localPaths.has(rPath);
      });

      if (changed.length === 0 && toDeleteRemotely.length === 0) {
        // ── FIX: Don't blindly update commit cursor if remote moved ──
        if (this.settings.lastKnownRemoteCommit && commitSha !== this.settings.lastKnownRemoteCommit) {
          status.setMessage("No local changes, but remote has new commits. Pull or Sync first.");
        } else {
          status.setMessage("Push: already up to date — nothing changed.");
          this.settings.lastKnownRemoteCommit = commitSha;
          await this.saveSettings();
        }
        setTimeout(() => status.hide(), 5000);
        return;
      }

      // 4. Upload blobs
      let uploadCount = 0;
      if (changed.length > 0) status.setMessage(`Push: uploading ${changed.length} file(s)…`);
      const uploadResults = await parallelBatch(changed, concurrency, async (f) => {
        const b64 = arrayBufferToBase64(f.buf);
        const blobSha = await client.createBlob(b64);
        uploadCount++;
        status.setMessage(`Push: uploaded ${uploadCount}/${changed.length}…`);
        return { path: f.path, sha: blobSha };
      });
      const uploadFailed = uploadResults.filter((r) => !r.ok);
      const uploadedEntries = uploadResults.filter((r) => r.ok).map((r) => r.value);
      if (uploadFailed.length > 0) {
        new Notice(`⚠️ ${uploadFailed.length} file(s) failed to upload.`, 8000);
      }

      // 5. Build tree
      const treeItems = [
        ...unchanged.map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: remoteShaMap[f.path] })),
        ...uploadedEntries.map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: f.sha })),
      ];

      // 6. Commit
      const deletionMsg = toDeleteRemotely.length > 0 ? ` (removing ${toDeleteRemotely.length} file(s))` : "";
      status.setMessage(`Push: creating commit${deletionMsg}…`);
      const newTreeSha = await client.createTree(treeSha, treeItems, toDeleteRemotely);
      const msg = buildCommitMessage(this.settings.deviceName);
      const newCommitSha = await client.createCommit(msg, newTreeSha, commitSha);
      status.setMessage("Push: updating branch…");
      await client.updateRef(newCommitSha);

      // 7. Cache
      const newCache = {};
      for (const item of treeItems) newCache[item.path] = item.sha;
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
      this._updateStatusBar("error", e.message);
      setTimeout(() => status.hide(), 12000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PULL  (GitHub → Local)  — with local SHA protection
  // ─────────────────────────────────────────────────────────────────────

  async pull() {
    try { this._validate(); } catch (e) { new Notice(e.message, 8000); return; }

    const client = this._client();
    const concurrency = this.settings.concurrency || 5;
    const status = new Notice("Pull: connecting…", 0);

    try {
      // 0. Bootstrap empty repo
      await client.initRepoIfNeeded();

      // 1. Fetch remote
      status.setMessage("Pull: fetching repository state…");
      const { commitSha, treeSha } = await client.getLatestCommit();
      const tree = await client.getFullTree(treeSha);

      const folders = tree.filter((n) => n.type === "tree");
      const blobs = tree.filter((n) => {
        const p = normalisePath(n.path);
        return n.type === "blob" && !shouldIgnorePath(p, this.settings);
      });

      // 2. Delta check
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

      // 3. Ensure folders
      for (const folder of folders) {
        const fp = normalisePath(folder.path);
        if (shouldIgnorePath(fp, this.settings)) continue;
        if (!this.app.vault.getAbstractFileByPath(fp)) {
          try { await this.app.vault.createFolder(fp); } catch { /* exists */ }
        }
      }

      // 4. Download — with local SHA protection
      const skippedConflicts = [];
      if (changed.length > 0) status.setMessage(`Pull: downloading ${changed.length} file(s)…`);

      let written = 0;
      const newCache = Object.assign({}, cache);

      const downloadResults = await parallelBatch(changed, concurrency, async (node) => {
        const fp = normalisePath(node.path);
        const existing = this.app.vault.getAbstractFileByPath(fp);

        // ── FIX: Check local SHA before overwriting ──
        if (existing && cache[fp]) {
          try {
            const localBuf = await this.app.vault.readBinary(existing);
            const localSha = await computeGitBlobSha(localBuf);
            if (localSha !== cache[fp]) {
              // Local has un-pushed edits — do NOT overwrite
              skippedConflicts.push(fp);
              return { path: fp, skipped: true };
            }
          } catch { /* couldn't read — allow overwrite */ }
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
        status.setMessage(`Pull: downloaded ${written}/${changed.length}…`);
        return { path: fp, sha: node.sha };
      });

      const downloadFailed = downloadResults.filter((r) => !r.ok);
      const downloadedEntries = downloadResults.filter((r) => r.ok && !r.value.skipped).map((r) => r.value);
      for (const entry of downloadedEntries) newCache[entry.path] = entry.sha;

      if (skippedConflicts.length > 0) {
        new Notice(
          `⚡ ${skippedConflicts.length} file(s) have local edits and were NOT overwritten:\n${skippedConflicts.join(", ")}\n\nUse Sync to resolve conflicts.`,
          12000
        );
      }

      if (downloadFailed.length > 0) {
        new Notice(`⚠️ ${downloadFailed.length} file(s) failed to download.`, 8000);
      }

      // 5. Delete — with local SHA protection
      let deleted = 0;
      const deleteSkipped = [];

      if (toDeleteLocally.length > 0) {
        status.setMessage(`Pull: removing ${toDeleteLocally.length} file(s) deleted remotely…`);
        for (const fp of toDeleteLocally) {
          try {
            const existing = this.app.vault.getAbstractFileByPath(fp);
            if (existing) {
              // ── FIX: Check local SHA before deleting ──
              if (cache[fp]) {
                try {
                  const localBuf = await this.app.vault.readBinary(existing);
                  const localSha = await computeGitBlobSha(localBuf);
                  if (localSha !== cache[fp]) {
                    deleteSkipped.push(fp);
                    continue; // local has edits — don't delete
                  }
                } catch { /* couldn't read — allow delete */ }
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
            `⚡ ${deleteSkipped.length} file(s) were NOT deleted because they have local edits:\n${deleteSkipped.join(", ")}`,
            10000
          );
        }
      }

      // 6. Persist
      this.settings.syncCache = newCache;
      this.settings.lastKnownRemoteCommit = commitSha;
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();

      // Summary
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
      this._updateStatusBar("error", e.message);
      setTimeout(() => status.hide(), 12000);
    }
  }
}

// ─────────────────────────────────────────────
//  Settings Tab  (redesigned)
// ─────────────────────────────────────────────

class DirectGitHubSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this._draft = {};
    this._validationEl = null;
    this._saveBtn = null;
  }

  _initDraft() {
    const s = this.plugin.settings;
    this._draft = { pat: s.pat, username: s.username, repo: s.repo, branch: s.branch };
  }

  _isDirty() {
    const s = this.plugin.settings;
    return this._draft.pat !== s.pat || this._draft.username !== s.username ||
      this._draft.repo !== s.repo || this._draft.branch !== s.branch;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("dgs-settings");
    this._initDraft();

    // ── Plugin Header ──────────────────────────────────────────────────
    const headerEl = containerEl.createDiv({ cls: "dgs-settings-header" });
    const headerIcon = headerEl.createSpan({ cls: "dgs-settings-header-icon" });
    setIcon(headerIcon, "git-branch");
    const headerText = headerEl.createDiv();
    headerText.createEl("h2", { text: "Direct GitHub Sync" });
    headerText.createEl("p", {
      text: "Sync your vault with GitHub — no Git CLI, no Node.js, works on mobile.",
      cls: "dgs-settings-subtitle",
    });

    // ══════════════════════════════════════════════════════════════════
    //  Section 1 — Connection
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "lock", "Connection");

    const authNote = containerEl.createEl("p", { cls: "setting-item-description dgs-section-note" });
    authNote.innerHTML = "These settings are applied when you click <strong>Save Connection Settings</strong>.";

    // PAT
    new Setting(containerEl)
      .setName("Personal Access Token (PAT)")
      .setDesc("GitHub → Settings → Developer settings → Personal access tokens. Needs 'repo' scope.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.setPlaceholder("ghp_xxxxxxxxxxxxxxxxxxxx")
          .setValue(this._draft.pat)
          .onChange((v) => { this._draft.pat = v.trim(); this._updateSaveBtnState(); });
      });

    // Username
    new Setting(containerEl)
      .setName("GitHub Username / Organisation")
      .setDesc("The account that owns the repository.")
      .addText((text) =>
        text.setPlaceholder("octocat").setValue(this._draft.username)
          .onChange((v) => { this._draft.username = v.trim(); this._updateSaveBtnState(); })
      );

    // Repo
    new Setting(containerEl)
      .setName("Repository Name")
      .setDesc("Repository name only — not a URL.")
      .addText((text) =>
        text.setPlaceholder("my-obsidian-vault").setValue(this._draft.repo)
          .onChange((v) => { this._draft.repo = v.trim(); this._updateSaveBtnState(); })
      );

    // Branch
    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Target branch. Leave blank for 'main'.")
      .addText((text) =>
        text.setPlaceholder("main").setValue(this._draft.branch)
          .onChange((v) => { this._draft.branch = v.trim() || "main"; this._updateSaveBtnState(); })
      );

    // Validation panel
    this._validationEl = containerEl.createDiv({ cls: "dgs-validation-result dgs-hidden" });

    // Save + Test
    const actionSetting = new Setting(containerEl);
    actionSetting
      .addButton((btn) => {
        this._saveBtn = btn;
        btn.setButtonText("Save Connection Settings").setCta()
          .onClick(() => this._saveCredentials());
      })
      .addButton((btn) =>
        btn.setButtonText("Test Connection").onClick(() => this._testConnection())
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 2 — Sync Behaviour
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "settings", "Sync Behaviour");

    new Setting(containerEl)
      .setName("Ignore .obsidian directory")
      .setDesc("Prevents plugin configs and workspace state from syncing.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ignoreObsidianDir)
          .onChange(async (v) => { this.plugin.settings.ignoreObsidianDir = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Ignored paths")
      .setDesc("One path per line. Supports wildcards (*). Lines starting with # are comments. Paths ending with / match directories.")
      .addTextArea((text) => {
        text.setPlaceholder("Attachments/large-videos/\n*.mp4\n# Comment lines are ignored")
          .setValue(this.plugin.settings.ignoredPaths || "")
          .onChange(async (v) => { this.plugin.settings.ignoredPaths = v; await this.plugin.saveSettings(); });
        text.inputEl.rows = 5;
        text.inputEl.addClass("dgs-ignored-paths-textarea");
      });

    new Setting(containerEl)
      .setName("Device name (optional)")
      .setDesc("Shown in commit messages, e.g. \"Vault sync from PC: 20 Apr 2026 at 14:03\".")
      .addText((text) =>
        text.setPlaceholder("e.g. PC, Phone, Laptop").setValue(this.plugin.settings.deviceName || "")
          .onChange(async (v) => { this.plugin.settings.deviceName = v.trim(); await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Concurrent requests")
      .setDesc("Number of parallel API calls. Higher = faster but risks rate limits. Default: 5.")
      .addSlider((slider) =>
        slider.setLimits(1, 10, 1).setValue(this.plugin.settings.concurrency ?? 5)
          .setDynamicTooltip()
          .onChange(async (v) => { this.plugin.settings.concurrency = v; await this.plugin.saveSettings(); })
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 3 — Auto-Sync
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "refresh-cw", "Auto-Sync");

    containerEl.createEl("p", {
      text: "When enabled, changes are automatically synced after a period of inactivity. Uses the three-way sync engine with conflict detection.",
      cls: "setting-item-description dgs-section-note",
    });

    new Setting(containerEl)
      .setName("Enable auto-sync")
      .setDesc("Automatically sync after idle time. Conflicts will be shown for resolution.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSyncEnabled)
          .onChange(async (v) => {
            this.plugin.settings.autoSyncEnabled = v;
            await this.plugin.saveSettings();
            new Notice(v ? "Auto-sync enabled. Restart Obsidian to activate." : "Auto-sync disabled.", 4000);
          })
      );

    new Setting(containerEl)
      .setName("Auto-sync interval (minutes)")
      .setDesc("Minutes of inactivity before auto-sync triggers. Range: 1–30.")
      .addSlider((slider) =>
        slider.setLimits(1, 30, 1).setValue(this.plugin.settings.autoSyncInterval ?? 5)
          .setDynamicTooltip()
          .onChange(async (v) => { this.plugin.settings.autoSyncInterval = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a sync when Obsidian starts (only if auto-sync is enabled).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (v) => { this.plugin.settings.syncOnStartup = v; await this.plugin.saveSettings(); })
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 4 — Quick Actions
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "zap", "Quick Actions");

    new Setting(containerEl)
      .setName("Sync with GitHub")
      .setDesc("Full bidirectional sync — downloads remote changes, uploads local changes, detects conflicts.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").setCta()
          .onClick(() => this.plugin.sync())
      );

    new Setting(containerEl)
      .setName("Push to GitHub")
      .setDesc("Upload local changes only. Warns if remote has newer commits.")
      .addButton((btn) =>
        btn.setButtonText("Push Now")
          .onClick(() => this.plugin.push())
      );

    new Setting(containerEl)
      .setName("Pull from GitHub")
      .setDesc("Download remote changes only. Protects files with un-pushed local edits.")
      .addButton((btn) =>
        btn.setButtonText("Pull Now")
          .onClick(() => this.plugin.pull())
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 5 — Danger Zone
    // ══════════════════════════════════════════════════════════════════
    this._createSectionHeader(containerEl, "alert-triangle", "Danger Zone");

    new Setting(containerEl)
      .setName("Reset sync cache")
      .setDesc("Clears the SHA cache and commit cursor. The next sync will do a full comparison. Use after a manual repo reset.")
      .addButton((btn) =>
        btn.setButtonText("Reset Cache").setWarning()
          .onClick(async () => {
            this.plugin.settings.syncCache = {};
            this.plugin.settings.lastPulledShas = {};
            this.plugin.settings.lastKnownRemoteCommit = "";
            this.plugin.settings.lastSyncTime = 0;
            await this.plugin.saveSettings();
            new Notice("Sync cache cleared. Next sync will be a full sync.", 5000);
          })
      );

    // ── Footer ──
    containerEl.createEl("hr", { cls: "dgs-settings-divider" });
    containerEl.createEl("p", {
      text: "Tip: Assign hotkeys to Push, Pull, and Sync via Settings → Hotkeys.",
      cls: "setting-item-description",
    });
  }

  /** Create a styled section header with an icon */
  _createSectionHeader(container, icon, title) {
    const header = container.createDiv({ cls: "dgs-section-header" });
    const iconEl = header.createSpan({ cls: "dgs-section-icon" });
    try { setIcon(iconEl, icon); } catch { iconEl.setText("●"); }
    header.createEl("h3", { text: title });
  }

  _updateSaveBtnState() {
    if (!this._saveBtn) return;
    this._saveBtn.setButtonText(this._isDirty() ? "Save Connection Settings ●" : "Save Connection Settings");
  }

  async _saveCredentials() {
    const d = this._draft;
    const issues = [];
    if (!d.pat) issues.push("PAT is required.");
    if (!d.username) issues.push("Username is required.");
    if (!d.repo) issues.push("Repository is required.");
    if (!d.branch) issues.push("Branch is required.");
    if (d.pat && !/^(ghp_|github_pat_|gho_|ghs_|ghr_)/.test(d.pat))
      issues.push("PAT format looks incorrect.");
    if (issues.length > 0) {
      this._showValidation("error", "Cannot save:\n• " + issues.join("\n• "));
      return;
    }

    this.plugin.settings.pat = d.pat;
    this.plugin.settings.username = d.username;
    this.plugin.settings.repo = d.repo;
    this.plugin.settings.branch = d.branch;
    this.plugin.settings.lastKnownRemoteCommit = "";
    await this.plugin.saveSettings();

    this._updateSaveBtnState();
    this._showValidation("ok", "Connection settings saved successfully.");
    new Notice("✅ Connection settings saved.", 3000);
  }

  async _testConnection() {
    if (this._isDirty()) {
      this._showValidation("error", "You have unsaved changes. Save first, then test.");
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

  _showValidation(type, message) {
    const el = this._validationEl;
    if (!el) return;
    el.className = "dgs-validation-result";
    el.removeClass("dgs-hidden");
    const icons = { ok: "✅", error: "❌", info: "⏳" };
    const cls = { ok: "dgs-ok", error: "dgs-err", info: "dgs-info" };
    el.addClass(cls[type] || "dgs-info");
    el.setText(`${icons[type] || "ℹ️"} ${message}`);
  }
}

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────
module.exports = DirectGitHubSyncPlugin;
