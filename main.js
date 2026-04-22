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
  autoSyncInterval: 5,     // minutes of idle before smart-sync fires
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
const MAX_SYNC_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const PASSIVE_POLL_INTERVAL_MS = 120_000;     // 2 minutes

// ─────────────────────────────────────────────
//  Low-level helpers
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry wrapper.  Auth/config errors (401, 403, 404, 422) are NOT retried.
 * Uses exponential back-off.
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
        console.warn(`[DGS] "${label}" attempt ${attempt}/${MAX_RETRIES + 1} failed, retrying in ${RETRY_DELAY_MS * attempt}ms… (${e.message})`);
        await sleep(RETRY_DELAY_MS * attempt);
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
  const pool = Math.max(1, Math.min(concurrency, items.length));
  const workers = [];
  for (let w = 0; w < pool; w++) workers.push(worker());
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
  // GitHub API wraps base64 at 60 chars with newlines — strip all whitespace
  const clean = base64.replace(/[\s]/g, "");
  const binary = atob(clean);
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
  // Normalise backslashes, collapse multiple slashes, strip leading slash
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
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
 */
function shouldIgnorePath(path, settings) {
  if (!path || path === ".gitkeep") return true;
  if (settings.ignoreObsidianDir && (path.startsWith(".obsidian/") || path === ".obsidian")) return true;
  const rules = (settings.ignoredPaths || "")
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith("#"));
  return rules.some((rule) => {
    if (rule.endsWith("/")) return path.startsWith(rule) || path + "/" === rule;
    if (rule.includes("*")) {
      const regex = new RegExp(
        "^" + rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
      );
      return regex.test(path);
    }
    return path === rule || path.startsWith(rule + "/");
  });
}

/** Build the commit message. */
function buildCommitMessage(deviceName) {
  const now = new Date();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const date = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  const time = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
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
        if (ghMsg.toLowerCase().includes("rate limit"))
          return "GitHub rate limit exceeded. Wait a few minutes and try again.";
        return "Access forbidden — PAT may lack 'repo' scope.";
      case 404:
        if (isRepo && url.includes(`/commits/${this.branch}`))
          return `Branch "${this.branch}" not found in "${this.username}/${this.repo}".`;
        if (isRepo) return `Repository "${this.username}/${this.repo}" not found.`;
        return `Resource not found (404): ${url}`;
      case 409:
        return `Repository "${this.username}/${this.repo}" is empty — will be initialised automatically.`;
      case 422:
        return `GitHub rejected the request (422): ${ghMsg || "check settings."}`;
      default:
        return `GitHub API error (${status}): ${ghMsg || "unknown"}`;
    }
  }

  // ── Read ──────────────────────────────────────

  async getLatestCommit() {
    const data = await withRetry(
      () => this._req("GET", `${this.base}/commits/${this.branch}`),
      "getLatestCommit"
    );
    if (!data || !data.sha || !data.commit?.tree?.sha)
      throw new Error("Unexpected response from GitHub when fetching latest commit.");
    return { commitSha: data.sha, treeSha: data.commit.tree.sha };
  }

  async getFullTree(treeSha) {
    const data = await withRetry(
      () => this._req("GET", `${this.base}/git/trees/${treeSha}?recursive=1`),
      "getFullTree"
    );
    if (!data || !Array.isArray(data.tree))
      throw new Error("Unexpected response from GitHub when fetching repository tree.");
    if (data.truncated)
      new Notice("GitHub tree truncated (repo >100k files). Some files may be missing.", 8000);
    return data.tree;
  }

  async getBlob(sha) {
    const data = await withRetry(
      () => this._req("GET", `${this.base}/git/blobs/${sha}`),
      "getBlob"
    );
    if (!data || !data.content) throw new Error(`Empty blob response for SHA ${sha}`);
    return data.content.replace(/[\s]/g, "");
  }

  // ── Write ─────────────────────────────────────

  async createBlob(base64Content) {
    const data = await withRetry(
      () => this._req("POST", `${this.base}/git/blobs`, { content: base64Content, encoding: "base64" }),
      "createBlob"
    );
    if (!data?.sha) throw new Error("GitHub did not return a SHA for created blob.");
    return data.sha;
  }

  async createTree(baseTreeSha, treeItems, deletions = []) {
    const deleteEntries = deletions.map((path) => ({
      path, mode: "100644", type: "blob", sha: null,
    }));
    const data = await withRetry(
      () => this._req("POST", `${this.base}/git/trees`, {
        base_tree: baseTreeSha,
        tree: [...treeItems, ...deleteEntries],
      }),
      "createTree"
    );
    if (!data?.sha) throw new Error("GitHub did not return a SHA for created tree.");
    return data.sha;
  }

  async createCommit(message, treeSha, parentSha) {
    const data = await withRetry(
      () => this._req("POST", `${this.base}/git/commits`, {
        message, tree: treeSha, parents: [parentSha],
      }),
      "createCommit"
    );
    if (!data?.sha) throw new Error("GitHub did not return a SHA for created commit.");
    return data.sha;
  }

  async updateRef(commitSha) {
    await withRetry(
      () => this._req("PATCH", `${this.base}/git/refs/heads/${this.branch}`, {
        sha: commitSha, force: false,
      }),
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
      // 404 = branch missing, 409 = empty repo — both are bootstrappable
      if (e.status !== 404 && e.status !== 409) throw e;
    }
    // Verify the repo itself exists before writing to it
    try {
      await withRetry(() => this._req("GET", `${this.base}`), "check repo existence");
    } catch (e) {
      if (e.status === 404)
        throw new Error(`Repository "${this.username}/${this.repo}" not found. Verify your username and repository name.`);
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
      return {
        ok: false,
        message: `Username mismatch — PAT belongs to "${actualLogin}", settings say "${this.username}".`,
      };

    let repoResp;
    try {
      repoResp = await requestUrl({ url: `${this.base}`, method: "GET", headers: this._headers });
    } catch { return { ok: false, message: "Network error while checking repository." }; }

    if (repoResp.status === 404)
      return { ok: false, message: `Repository "${this.username}/${this.repo}" not found.` };
    if (repoResp.status === 403)
      return { ok: false, message: `PAT does not have access to "${this.username}/${this.repo}".` };

    try {
      const branchResp = await requestUrl({
        url: `${this.base}/branches/${this.branch}`,
        method: "GET",
        headers: this._headers,
      });
      if (branchResp.status === 404)
        return { ok: false, message: `Branch "${this.branch}" not found in the repository.` };
    } catch { /* empty repo or transient error — treat as OK */ }

    return {
      ok: true,
      message: `Connected to ${this.username}/${this.repo} on branch "${this.branch}". Connection verified.`,
    };
  }
}

// ─────────────────────────────────────────────
//  Conflict Resolution Modal  (three-way)
// ─────────────────────────────────────────────

class ConflictResolutionModal extends Modal {
  constructor(app, conflicts, onResolve, onDismiss) {
    super(app);
    this.conflicts = conflicts;
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
    try { setIcon(iconEl, "git-merge"); } catch { iconEl.setText("!"); }
    header.createEl("h2", { text: "Sync Conflicts Detected" });

    contentEl.createEl("p", {
      text: `${this.conflicts.length} file${this.conflicts.length === 1 ? "" : "s"} changed on both this device and remotely. Choose how to resolve each conflict.`,
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

      const pathRow = item.createDiv({ cls: "dgs-conflict-path-row" });
      const fIcon = pathRow.createSpan({ cls: "dgs-conflict-file-icon" });
      try { setIcon(fIcon, "file-text"); } catch { fIcon.setText("F"); }
      pathRow.createSpan({ text: conflict.path, cls: "dgs-conflict-path" });

      let desc = "Modified on both devices";
      if (!conflict.localSha && conflict.remoteSha) desc = "Deleted locally, modified remotely";
      else if (conflict.localSha && !conflict.remoteSha) desc = "Modified locally, deleted remotely";
      else if (!conflict.baseSha) desc = "Created on both devices with different content";
      item.createDiv({ text: desc, cls: "dgs-conflict-desc" });

      const btns = item.createDiv({ cls: "dgs-conflict-btns" });
      const localBtn = btns.createEl("button", { text: "Keep Local" });
      localBtn.addClass("dgs-conflict-btn");
      const remoteBtn = btns.createEl("button", { text: "Keep Remote" });
      remoteBtn.addClass("dgs-conflict-btn");
      const bothBtn = btns.createEl("button", { text: "Keep Both" });
      bothBtn.addClass("dgs-conflict-btn");

      // Disable irrelevant options
      if (!conflict.localSha) localBtn.disabled = true;
      if (!conflict.remoteSha) remoteBtn.disabled = true;
      if (!conflict.localSha || !conflict.remoteSha) bothBtn.disabled = true;

      const buttons = { localBtn, remoteBtn, bothBtn };
      localBtn.onclick = () => this._setResolution(conflict.path, "keep-local", item, buttons);
      remoteBtn.onclick = () => this._setResolution(conflict.path, "keep-remote", item, buttons);
      bothBtn.onclick = () => this._setResolution(conflict.path, "keep-both", item, buttons);

      item._buttons = buttons;
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
      if (item._buttons) this._setResolution(path, resolution, item, item._buttons);
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
//  Force-Push Conflict Modal  (remote ahead warning)
// ─────────────────────────────────────────────

class ConflictModal extends Modal {
  constructor(app, remoteCommitSha, onForce, onCancel) {
    super(app);
    this.remoteCommitSha = remoteCommitSha;
    this.onForce = onForce;
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
      text: "The remote repository has commits newer than your last sync. Pushing now will overwrite those remote changes.",
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
    cancelBtn.onclick = () => { this._decided = true; this.close(); this.onCancel(); };
    const forceBtn = row.createEl("button", { text: "Force Push Anyway" });
    forceBtn.addClass("dgs-btn-warning");
    forceBtn.onclick = () => { this._decided = true; this.close(); this.onForce(); };
  }

  onClose() {
    // Clicking outside / pressing Esc → treat as cancel
    if (!this._decided) this.onCancel();
    this.contentEl.empty();
  }
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
  //  Improvements over the old auto-sync:
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
      await this._applyConflictResolutions(plan, resolutions, localBuffers);
      await this._executeSyncPlan(
        plan, client, concurrency, commitSha, treeSha,
        remoteTree, localEntries, cache, () => {}, false
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
  //  THREE-WAY SYNC ENGINE
  // ─────────────────────────────────────────────────────────────────────

  _buildSyncPlan(localEntries, remoteBlobs, cache) {
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
      if (shouldIgnorePath(path, this.settings)) continue;

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

  async _applyConflictResolutions(plan, resolutions, localBuffers) {
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

            const file = this.app.vault.getAbstractFileByPath(conflict.path);
            if (file) {
              try {
                await this.app.vault.rename(file, newPath);
                const renamedBuf = await this.app.vault.adapter.readBinary(newPath);
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
      const plan = this._buildSyncPlan(localEntries, remoteBlobs, cache);

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

        await this._applyConflictResolutions(plan, resolutions, localBuffers);
      }

      // 5. Execute
      await this._executeSyncPlan(
        plan, client, concurrency, commitSha, treeSha,
        remoteTree, localEntries, cache, setMsg, silent
      );

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

  async _executeSyncPlan(plan, client, concurrency, commitSha, treeSha, remoteTree, localEntries, cache, setMsg, silent) {
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
      const msg = buildCommitMessage(this.settings.deviceName);
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
    this.settings.syncCache = newCache;
    this.settings.lastKnownRemoteCommit = newCommitSha;
    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();

    // Summary
    const parts = [];
    if (downloaded > 0) parts.push(`${downloaded} downloaded`);
    if (uploaded > 0) parts.push(`${uploaded} uploaded`);
    if (deletedLocal > 0) parts.push(`${deletedLocal} deleted locally`);
    if (deletedRemote > 0) parts.push(`${deletedRemote} deleted remotely`);
    const summary = parts.length > 0 ? parts.join(", ") : "already up to date";
    setMsg(`Sync complete — ${summary}.`);
    this._updateStatusBar("synced");
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

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────
module.exports = DirectGitHubSyncPlugin;
