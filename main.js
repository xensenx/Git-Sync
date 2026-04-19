/*
 * Direct GitHub Sync — Obsidian Plugin
 * main.js (vanilla JS, no build step required)
 *
 * Drop this file alongside manifest.json and styles.css into:
 *   <vault>/.obsidian/plugins/direct-github-sync/
 * then enable it in Settings → Community Plugins.
 */

"use strict";

const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl } =
  require("obsidian");

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  pat: "",
  username: "",
  repo: "",
  branch: "main",
  ignoreObsidianDir: true,
  deviceName: "",
  concurrency: 5,
  // filepath -> blob SHA of the last successfully pulled/pushed state.
  // Never edit this manually.
  lastPulledShas: {},
  // The remote commit SHA we last successfully synced against.
  // Used for conflict detection on push.
  lastKnownRemoteCommit: "",
};

const GITHUB_API = "https://api.github.com";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2500;

// ─────────────────────────────────────────────
//  Low-level helpers
// ─────────────────────────────────────────────

/** Sleep for ms milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper. Attempts fn up to MAX_RETRIES+1 times with RETRY_DELAY_MS
 * between each attempt.  Auth/config errors (401, 403, 404, 422) are NOT
 * retried because they won't fix themselves on their own.
 */
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (
        e.status === 401 ||
        e.status === 403 ||
        e.status === 404 ||
        e.status === 422
      ) {
        throw e; // permanent — don't retry
      }
      lastErr = e;
      if (attempt <= MAX_RETRIES) {
        console.warn(
          `[Direct GitHub Sync] "${label}" failed (attempt ${attempt}/${
            MAX_RETRIES + 1
          }), retrying in ${RETRY_DELAY_MS}ms… (${e.message})`
        );
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

/**
 * Run tasks in a bounded concurrency pool.
 * Returns an array of { ok, value } | { ok: false, error, item } objects
 * in the same order as `items`.  A failure in one task never aborts others.
 */
async function parallelBatch(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e, item: items[i] };
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────
//  Encoding helpers
// ─────────────────────────────────────────────

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Ensure paths are always relative with forward slashes. */
function normalisePath(p) {
  return p.replace(/^\/+/, "").replace(/\\/g, "/");
}

/**
 * Compute the Git blob SHA for an ArrayBuffer using WebCrypto.
 * Git blob SHA = sha1("blob " + byteLength + "\0" + fileBytes)
 */
async function computeGitBlobSha(arrayBuffer) {
  const fileBytes = new Uint8Array(arrayBuffer);
  const header = `blob ${fileBytes.byteLength}\0`;
  const headerBytes = new TextEncoder().encode(header);

  const combined = new Uint8Array(
    headerBytes.byteLength + fileBytes.byteLength
  );
  combined.set(headerBytes, 0);
  combined.set(fileBytes, headerBytes.byteLength);

  const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build the commit message.
 * "Vault push from {device}: DD MMM YYYY at HH:MM"
 * "Vault push: DD MMM YYYY at HH:MM"  (when no device name)
 */
function buildCommitMessage(deviceName) {
  const now = new Date();
  const months = [
    "Jan","Feb","Mar","Apr","May","Jun",
    "Jul","Aug","Sep","Oct","Nov","Dec",
  ];
  const date = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  const from =
    deviceName && deviceName.trim() ? ` from ${deviceName.trim()}` : "";
  return `Vault push${from}: ${date} at ${time}`;
}

// ─────────────────────────────────────────────
//  Conflict confirmation modal
// ─────────────────────────────────────────────

class ConflictModal extends Modal {
  /**
   * @param {App} app
   * @param {string} remoteCommitSha  - the newer remote commit we detected
   * @param {() => void} onForce      - called if user clicks "Force Push"
   * @param {() => void} onCancel     - called if user cancels
   */
  constructor(app, remoteCommitSha, onForce, onCancel) {
    super(app);
    this.remoteCommitSha = remoteCommitSha;
    this.onForce = onForce;
    this.onCancel = onCancel;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "⚠️ Remote Has Newer Commits" });
    contentEl.createEl("p", {
      text: "The remote repository has commits that are newer than your last sync. Pushing now will overwrite those remote changes and they will be lost.",
    });
    contentEl.createEl("p", {
      text: `Remote commit: ${this.remoteCommitSha.slice(0, 12)}…`,
      cls: "dgs-mono",
    });
    contentEl.createEl("p", {
      text: "Recommended action: Pull first to bring those changes locally, then push.",
    });

    const row = contentEl.createDiv({ cls: "dgs-modal-btns" });

    const cancelBtn = row.createEl("button", {
      text: "Cancel (recommended)",
    });
    cancelBtn.addClass("mod-cta");
    cancelBtn.onclick = () => {
      this.close();
      this.onCancel();
    };

    const forceBtn = row.createEl("button", { text: "Force Push Anyway" });
    forceBtn.addClass("dgs-btn-warning");
    forceBtn.onclick = () => {
      this.close();
      this.onForce();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
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

  /**
   * Core request. Wraps requestUrl and translates HTTP errors into descriptive
   * messages. Each call is already wrapped with withRetry at call sites.
   */
  async _req(method, url, body) {
    const opts = { url, method, headers: this._headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let resp;
    try {
      resp = await requestUrl(opts);
    } catch (netErr) {
      // requestUrl throws on DNS/timeout/offline failures
      const e = new Error(
        `Network error — check your internet connection. (${netErr.message})`
      );
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

  /** Map HTTP status codes to plain-English error messages. */
  _friendlyError(status, url, ghMsg) {
    const isRepoEndpoint =
      url.includes(`/repos/${this.username}/${this.repo}`);

    switch (status) {
      case 401:
        return "Authentication failed — your PAT is invalid or has expired. Open plugin settings and update it.";
      case 403:
        if (ghMsg.toLowerCase().includes("rate limit")) {
          return "GitHub rate limit exceeded. Wait a few minutes and try again.";
        }
        return "Access forbidden — your PAT may lack the 'repo' scope, or this repository is private and inaccessible with the current PAT.";
      case 404:
        if (isRepoEndpoint && url.includes(`/commits/${this.branch}`)) {
          return `Branch "${this.branch}" not found in "${this.username}/${this.repo}". Check the branch name in settings.`;
        }
        if (isRepoEndpoint) {
          return `Repository "${this.username}/${this.repo}" not found. Verify the username and repository name in settings.`;
        }
        return `Resource not found (404): ${url}`;
      case 409:
        return `Repository "${this.username}/${this.repo}" is empty — push will initialise it automatically.`;
      case 422:
        return `GitHub rejected the request (422): ${
          ghMsg || "check your branch name and repo settings."
        }`;
      case 0:
        return "Network error — please check your internet connection and try again.";
      default:
        return `GitHub API error (${status}): ${ghMsg || "unknown error"}`;
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Latest commit SHA + tree SHA for the configured branch. */
  async getLatestCommit() {
    const data = await withRetry(
      () => this._req("GET", `${this.base}/commits/${this.branch}`),
      `getLatestCommit(${this.branch})`
    );
    return { commitSha: data.sha, treeSha: data.commit.tree.sha };
  }

  /** Full recursive tree for a given tree SHA. */
  async getFullTree(treeSha) {
    const data = await withRetry(
      () =>
        this._req(
          "GET",
          `${this.base}/git/trees/${treeSha}?recursive=1`
        ),
      `getFullTree(${treeSha.slice(0, 8)})`
    );
    if (data.truncated) {
      new Notice(
        "GitHub tree was truncated (repo >100,000 files). Some files may be missing.",
        8000
      );
    }
    return data.tree; // array of { path, type, sha, url }
  }

  /** Fetch a single blob as Base64. */
  async getBlob(sha) {
    const data = await withRetry(
      () => this._req("GET", `${this.base}/git/blobs/${sha}`),
      `getBlob(${sha.slice(0, 8)})`
    );
    return data.content.replace(/\n/g, "");
  }

  // ── Write ─────────────────────────────────────────────────────────────

  /** Create a blob. Returns its SHA. */
  async createBlob(base64Content) {
    const data = await withRetry(
      () =>
        this._req("POST", `${this.base}/git/blobs`, {
          content: base64Content,
          encoding: "base64",
        }),
      "createBlob"
    );
    return data.sha;
  }

  /**
   * Create a tree based on baseTreeSha.
   * treeItems:  normal { path, mode, type, sha } entries.
   * deletions:  paths to remove — sent as sha: null entries.
   */
  async createTree(baseTreeSha, treeItems, deletions = []) {
    const deleteEntries = deletions.map((path) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: null,
    }));
    const data = await withRetry(
      () =>
        this._req("POST", `${this.base}/git/trees`, {
          base_tree: baseTreeSha,
          tree: [...treeItems, ...deleteEntries],
        }),
      "createTree"
    );
    return data.sha;
  }

  /** Create a commit. Returns new commit SHA. */
  async createCommit(message, treeSha, parentSha) {
    const data = await withRetry(
      () =>
        this._req("POST", `${this.base}/git/commits`, {
          message,
          tree: treeSha,
          parents: [parentSha],
        }),
      "createCommit"
    );
    return data.sha;
  }

  /** Move the branch ref to commitSha. */
  async updateRef(commitSha) {
    await withRetry(
      () =>
        this._req(
          "PATCH",
          `${this.base}/git/refs/heads/${this.branch}`,
          { sha: commitSha, force: false }
        ),
      "updateRef"
    );
  }

  /**
   * Ensure the branch exists, bootstrapping an empty repo if necessary.
   * Returns true if just initialised, false if already established.
   */
  async initRepoIfNeeded() {
    if (this._established) return false;

    try {
      await this.getLatestCommit();
      this._established = true;
      return false;
    } catch (e) {
      if (e.status !== 404 && e.status !== 409) throw e;
    }

    // Confirm the repo itself exists before trying to write to it.
    // Wrapped with withRetry so transient network errors don't abort the bootstrap.
    try {
      await withRetry(
        () => this._req("GET", `${this.base}`),
        "check repo existence"
      );
    } catch (e) {
      if (e.status === 404) {
        throw new Error(
          `Repository "${this.username}/${this.repo}" not found. ` +
            `Verify the username and repo name in settings.`
        );
      }
      throw e;
    }

    // Seed the repo with a .gitkeep so there's a valid commit to build on
    await withRetry(
      () =>
        this._req("PUT", `${this.base}/contents/.gitkeep`, {
          message: "Initial commit (Direct GitHub Sync)",
          content: btoa(""),
          branch: this.branch,
        }),
      "bootstrap .gitkeep"
    );

    this._established = true;
    return true;
  }

  /**
   * Validate PAT + username + repo + branch without writing anything.
   * Returns { ok: boolean, message: string }.
   */
  async validateSettings() {
    // Step 1 — Check the PAT and confirm the username
    let userResp;
    try {
      userResp = await requestUrl({
        url: `${GITHUB_API}/user`,
        method: "GET",
        headers: this._headers,
      });
    } catch (netErr) {
      return {
        ok: false,
        message: "Network error — check your internet connection.",
      };
    }

    if (userResp.status === 401) {
      return {
        ok: false,
        message:
          "PAT is invalid or expired. Generate a new one at GitHub → Settings → Developer settings → Personal access tokens.",
      };
    }
    if (userResp.status === 403) {
      return {
        ok: false,
        message:
          "PAT lacks permissions. Ensure it has the 'repo' scope (or 'Contents: Read & Write' for fine-grained tokens).",
      };
    }

    const actualLogin = userResp.json?.login || "";
    if (actualLogin.toLowerCase() !== this.username.toLowerCase()) {
      return {
        ok: false,
        message: `Username mismatch — this PAT belongs to "${actualLogin}", but settings say "${this.username}". Update the username field.`,
      };
    }

    // Step 2 — Check repo access
    let repoResp;
    try {
      repoResp = await requestUrl({
        url: `${this.base}`,
        method: "GET",
        headers: this._headers,
      });
    } catch (netErr) {
      return {
        ok: false,
        message: `Network error while checking repository: ${netErr.message}`,
      };
    }

    if (repoResp.status === 404) {
      return {
        ok: false,
        message: `Repository "${this.username}/${this.repo}" not found. Check the name and confirm the PAT has access.`,
      };
    }
    if (repoResp.status === 403) {
      return {
        ok: false,
        message: `PAT doesn't have access to "${this.username}/${this.repo}". Check repository permissions.`,
      };
    }

    // Step 3 — Check branch (non-fatal: could be an empty repo with no branches yet)
    try {
      const branchResp = await requestUrl({
        url: `${this.base}/branches/${this.branch}`,
        method: "GET",
        headers: this._headers,
      });
      if (branchResp.status === 404) {
        return {
          ok: false,
          message: `Branch "${this.branch}" not found in "${this.username}/${this.repo}". Check the branch name — or push to create it.`,
        };
      }
    } catch {
      // Ignore — empty repo with no branches yet is fine; push will bootstrap it
    }

    return {
      ok: true,
      message: `Connected to ${this.username}/${this.repo} on branch "${this.branch}" ✓`,
    };
  }
}

// ─────────────────────────────────────────────
//  Main Plugin Class
// ─────────────────────────────────────────────

class DirectGitHubSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("upload", "Push vault to GitHub", () => this.push());
    this.addRibbonIcon("download", "Pull vault from GitHub", () =>
      this.pull()
    );

    this.addCommand({
      id: "push-to-github",
      name: "Push vault to GitHub",
      callback: () => this.push(),
    });
    this.addCommand({
      id: "pull-from-github",
      name: "Pull vault from GitHub",
      callback: () => this.pull(),
    });

    this.addSettingTab(new DirectGitHubSyncSettingTab(this.app, this));

    console.log("[Direct GitHub Sync] Plugin loaded.");
  }

  onunload() {
    console.log("[Direct GitHub Sync] Plugin unloaded.");
  }

  // ── Persistence ───────────────────────────────────────────────────────
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Validation ────────────────────────────────────────────────────────
  _validate() {
    const s = this.settings;
    const issues = [];
    if (!s.pat)      issues.push("Personal Access Token (PAT) is not set.");
    if (!s.username) issues.push("GitHub username / organisation is not set.");
    if (!s.repo)     issues.push("Repository name is not set.");
    if (!s.branch)   issues.push("Branch name is not set.");
    if (issues.length > 0) {
      throw new Error(
        "Settings incomplete — open plugin settings to fix:\n• " +
          issues.join("\n• ")
      );
    }
    if (!/^(ghp_|github_pat_|gho_|ghs_|ghr_)/.test(s.pat)) {
      throw new Error(
        "PAT format looks incorrect — it should start with 'ghp_' or 'github_pat_'. " +
          "Open plugin settings to check."
      );
    }
  }

  _client() {
    const s = this.settings;
    return new GitHubClient(s.pat, s.username, s.repo, s.branch);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PUSH  (Local → GitHub)
  // ─────────────────────────────────────────────────────────────────────
  /**
   * @param {boolean} [forcePush=false]  Skip the conflict check and push anyway.
   */
  async push(forcePush = false) {
    try {
      this._validate();
    } catch (e) {
      new Notice(e.message, 8000);
      return;
    }

    const client = this._client();
    const concurrency = this.settings.concurrency || 5;
    const status = new Notice("Push: connecting…", 0);

    try {
      // 0. Bootstrap empty repo if needed
      const initialised = await client.initRepoIfNeeded();
      if (initialised) {
        status.setMessage("Push: initialised empty repository.");
        await sleep(800);
      }

      // 1. Fetch remote commit + local file list concurrently
      status.setMessage("Push: reading local and remote state…");
      const [{ commitSha, treeSha }, allFiles] = await Promise.all([
        client.getLatestCommit(),
        Promise.resolve(this.app.vault.getFiles()),
      ]);

      // ── Conflict detection ────────────────────────────────────────────
      // If we have a remembered remote commit and it doesn't match what's
      // on the remote right now, someone else pushed while we weren't looking.
      if (
        !forcePush &&
        this.settings.lastKnownRemoteCommit &&
        this.settings.lastKnownRemoteCommit !== commitSha
      ) {
        status.hide();
        // Show the modal; push(true) is called if user forces through
        new ConflictModal(
          this.app,
          commitSha,
          () => this.push(true),
          () =>
            new Notice(
              "Push cancelled. Pull first to get the latest remote changes, then push.",
              6000
            )
        ).open();
        return;
      }

      // Start fetching the remote tree while we filter local files
      const remoteTreePromise = client.getFullTree(treeSha);

      const files = allFiles.filter((f) => {
        const p = normalisePath(f.path);
        if (p === ".gitkeep") return false;
        if (this.settings.ignoreObsidianDir) {
          return !p.startsWith(".obsidian/") && p !== ".obsidian";
        }
        return true;
      });

      if (files.length === 0) {
        status.setMessage("Push: nothing to push — vault is empty.");
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // 2. Hash local files and fetch remote tree in parallel
      status.setMessage(`Push: scanning ${files.length} local file(s)…`);
      const [remoteTree, hashResults] = await Promise.all([
        remoteTreePromise,
        parallelBatch(files, concurrency, async (file) => {
          const buf = await this.app.vault.readBinary(file);
          const sha = await computeGitBlobSha(buf);
          return { path: normalisePath(file.path), sha, buf };
        }),
      ]);

      // Report files we couldn't read
      const hashFailed = hashResults.filter((r) => !r.ok);
      const localEntries = hashResults.filter((r) => r.ok).map((r) => r.value);

      if (hashFailed.length > 0) {
        const names = hashFailed
          .map((r) => r.item?.path || "unknown")
          .join(", ");
        console.warn(
          `[Direct GitHub Sync] Skipped ${hashFailed.length} unreadable file(s): ${names}`
        );
        new Notice(
          `⚠️ ${hashFailed.length} file(s) could not be read and will be skipped:\n${names}`,
          8000
        );
      }

      // Build remote SHA lookup
      const remoteShaMap = {};
      for (const node of remoteTree) {
        if (node.type === "blob") remoteShaMap[node.path] = node.sha;
      }

      // 3. Diff — pure CPU, zero API calls
      const localPaths = new Set(localEntries.map((e) => e.path));
      const changed   = localEntries.filter((e) => remoteShaMap[e.path] !== e.sha);
      const unchanged = localEntries.filter((e) => remoteShaMap[e.path] === e.sha);

      // ── Deletion sync (push) ──────────────────────────────────────────
      // Remote files that no longer exist locally should be removed from the repo.
      const toDeleteRemotely = Object.keys(remoteShaMap).filter((rPath) => {
        if (rPath === ".gitkeep") return false;
        if (
          this.settings.ignoreObsidianDir &&
          (rPath.startsWith(".obsidian/") || rPath === ".obsidian")
        )
          return false;
        return !localPaths.has(rPath);
      });

      if (changed.length === 0 && toDeleteRemotely.length === 0) {
        status.setMessage("Push: already up to date — nothing changed.");
        // Still update the known-commit so future conflict detection is accurate
        this.settings.lastKnownRemoteCommit = commitSha;
        await this.saveSettings();
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // 4. Upload changed blobs in parallel
      let uploaded = 0;
      if (changed.length > 0) {
        status.setMessage(`Push: uploading ${changed.length} changed file(s)…`);
      }

      const uploadResults = await parallelBatch(
        changed,
        concurrency,
        async (f) => {
          const b64 = arrayBufferToBase64(f.buf);
          const blobSha = await client.createBlob(b64); // createBlob already retries
          uploaded++;
          status.setMessage(`Push: uploaded ${uploaded} / ${changed.length}…`);
          return { path: f.path, sha: blobSha };
        }
      );

      const uploadFailed  = uploadResults.filter((r) => !r.ok);
      const uploadedEntries = uploadResults.filter((r) => r.ok).map((r) => r.value);

      if (uploadFailed.length > 0) {
        const names = uploadFailed
          .map((r) => r.item?.path || "unknown")
          .join(", ");
        console.warn(
          `[Direct GitHub Sync] Upload failed for: ${names}`
        );
        new Notice(
          `⚠️ ${uploadFailed.length} file(s) failed to upload and were skipped:\n${names}`,
          8000
        );
      }

      // 5. Build the tree: unchanged files + newly uploaded files
      const treeItems = [
        ...unchanged.map((f) => ({
          path: f.path,
          mode: "100644",
          type: "blob",
          sha: remoteShaMap[f.path],
        })),
        ...uploadedEntries.map((f) => ({
          path: f.path,
          mode: "100644",
          type: "blob",
          sha: f.sha,
        })),
      ];

      // 6. Create tree (with deletions), commit, and update ref
      const deletionMsg =
        toDeleteRemotely.length > 0
          ? ` (removing ${toDeleteRemotely.length} deleted file(s))`
          : "";
      status.setMessage(`Push: creating commit${deletionMsg}…`);

      const newTreeSha = await client
        .createTree(treeSha, treeItems, toDeleteRemotely)
        .catch((e) => {
          throw new Error(`Tree creation failed: ${e.message}`);
        });

      const msg = buildCommitMessage(this.settings.deviceName);
      const newCommitSha = await client
        .createCommit(msg, newTreeSha, commitSha)
        .catch((e) => {
          throw new Error(`Commit creation failed: ${e.message}`);
        });

      status.setMessage("Push: updating branch ref…");
      await client.updateRef(newCommitSha).catch((e) => {
        throw new Error(
          `Commit created (${newCommitSha.slice(0, 8)}) but ref update failed: ${
            e.message
          }`
        );
      });

      // 7. Update cache only after the entire operation succeeds
      const newCache = {};
      for (const item of treeItems) newCache[item.path] = item.sha;
      // Strip deleted paths from the cache
      for (const dp of toDeleteRemotely) delete newCache[dp];

      this.settings.lastPulledShas = newCache;
      this.settings.lastKnownRemoteCommit = newCommitSha;
      await this.saveSettings();

      // Build summary message
      const summary = [];
      if (uploadedEntries.length > 0) summary.push(`${uploadedEntries.length} uploaded`);
      if (toDeleteRemotely.length > 0) summary.push(`${toDeleteRemotely.length} deleted remotely`);
      if (unchanged.length > 0) summary.push(`${unchanged.length} unchanged`);

      const warnings = [];
      if (uploadFailed.length > 0) warnings.push(`${uploadFailed.length} upload failed`);
      if (hashFailed.length > 0) warnings.push(`${hashFailed.length} unreadable`);
      const warnStr =
        warnings.length > 0 ? `  ⚠️ ${warnings.join(", ")}` : "";

      status.setMessage(`Push complete — ${summary.join(", ")}.${warnStr}`);
      setTimeout(() => status.hide(), 6000);
    } catch (e) {
      console.error("[Direct GitHub Sync] Push error:", e);
      status.setMessage(`Push failed: ${e.message}`);
      setTimeout(() => status.hide(), 12000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PULL  (GitHub → Local)
  // ─────────────────────────────────────────────────────────────────────
  async pull() {
    try {
      this._validate();
    } catch (e) {
      new Notice(e.message, 8000);
      return;
    }

    const client = this._client();
    const concurrency = this.settings.concurrency || 5;
    const status = new Notice("Pull: connecting…", 0);

    try {
      // 1. Fetch latest remote state
      status.setMessage("Pull: fetching repository state…");
      const { commitSha, treeSha } = await client.getLatestCommit();
      const tree = await client.getFullTree(treeSha);

      const folders = tree.filter((n) => n.type === "tree");
      const blobs = tree.filter((n) => {
        const p = normalisePath(n.path);
        if (p === ".gitkeep") return false;
        if (
          this.settings.ignoreObsidianDir &&
          (p.startsWith(".obsidian/") || p === ".obsidian")
        )
          return false;
        return n.type === "blob";
      });

      // 2. Delta check — only download what actually changed
      const cache = this.settings.lastPulledShas || {};
      const changed = blobs.filter(
        (n) => cache[normalisePath(n.path)] !== n.sha
      );

      // ── Deletion sync (pull) ──────────────────────────────────────────
      // Paths in our cache that no longer appear in the remote tree were
      // deleted remotely — remove them locally too.
      const remotePathSet = new Set(
        blobs.map((n) => normalisePath(n.path))
      );
      const toDeleteLocally = Object.keys(cache).filter((cachedPath) => {
        if (cachedPath === ".gitkeep") return false;
        if (
          this.settings.ignoreObsidianDir &&
          (cachedPath.startsWith(".obsidian/") ||
            cachedPath === ".obsidian")
        )
          return false;
        return !remotePathSet.has(cachedPath);
      });

      if (changed.length === 0 && toDeleteLocally.length === 0) {
        status.setMessage("Pull: already up to date.");
        this.settings.lastKnownRemoteCommit = commitSha;
        await this.saveSettings();
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // 3. Ensure folders exist locally
      for (const folder of folders) {
        const fp = normalisePath(folder.path);
        if (
          this.settings.ignoreObsidianDir &&
          (fp.startsWith(".obsidian/") || fp === ".obsidian")
        )
          continue;
        if (!this.app.vault.getAbstractFileByPath(fp)) {
          try {
            await this.app.vault.createFolder(fp);
          } catch {
            /* already exists — safe to ignore */
          }
        }
      }

      // 4. Download changed blobs in parallel
      if (changed.length > 0) {
        status.setMessage(
          `Pull: downloading ${changed.length} changed file(s)…`
        );
      }

      let written = 0;
      const newCache = Object.assign({}, cache);

      const downloadResults = await parallelBatch(
        changed,
        concurrency,
        async (node) => {
          const fp = normalisePath(node.path);
          // getBlob already retries internally
          const b64 = await client.getBlob(node.sha);
          const buf = base64ToArrayBuffer(b64);
          const existing = this.app.vault.getAbstractFileByPath(fp);

          if (existing) {
            await this.app.vault.adapter.writeBinary(fp, buf);
          } else {
            // Create missing parent folders on the fly
            const parts = fp.split("/");
            if (parts.length > 1) {
              const dir = parts.slice(0, -1).join("/");
              if (!this.app.vault.getAbstractFileByPath(dir)) {
                await this.app.vault.createFolder(dir);
              }
            }
            await this.app.vault.createBinary(fp, buf);
          }
          written++;
          status.setMessage(
            `Pull: downloaded ${written} / ${changed.length}…`
          );
          return { path: fp, sha: node.sha };
        }
      );

      const downloadFailed   = downloadResults.filter((r) => !r.ok);
      const downloadedEntries = downloadResults.filter((r) => r.ok).map((r) => r.value);

      // Update cache only for files we successfully wrote
      for (const entry of downloadedEntries) {
        newCache[entry.path] = entry.sha;
      }

      if (downloadFailed.length > 0) {
        const names = downloadFailed
          .map((r) => (r.item ? normalisePath(r.item.path) : "unknown"))
          .join(", ");
        console.warn(
          `[Direct GitHub Sync] Download/write failed for: ${names}`
        );
        new Notice(
          `⚠️ ${downloadFailed.length} file(s) failed to download — they will retry on the next pull:\n${names}`,
          8000
        );
      }

      // 5. Delete locally files that were removed on remote
      let deleted = 0;
      const deleteFailed = [];

      if (toDeleteLocally.length > 0) {
        status.setMessage(
          `Pull: removing ${toDeleteLocally.length} file(s) deleted remotely…`
        );
        for (const fp of toDeleteLocally) {
          try {
            const existing = this.app.vault.getAbstractFileByPath(fp);
            if (existing) {
              await this.app.vault.trash(existing, true);
            }
            delete newCache[fp];
            deleted++;
          } catch (e) {
            console.warn(
              `[Direct GitHub Sync] Could not delete local file "${fp}": ${e.message}`
            );
            deleteFailed.push(fp);
          }
        }
        if (deleteFailed.length > 0) {
          new Notice(
            `⚠️ ${deleteFailed.length} file(s) could not be deleted locally:\n${deleteFailed.join(", ")}`,
            8000
          );
        }
      }

      // 6. Persist cache after full operation
      this.settings.lastPulledShas = newCache;
      this.settings.lastKnownRemoteCommit = commitSha;
      await this.saveSettings();

      // Build summary
      const summary = [];
      if (written > 0) summary.push(`${written} downloaded`);
      if (deleted > 0) summary.push(`${deleted} deleted locally`);
      const skipped = blobs.length - changed.length;
      if (skipped > 0) summary.push(`${skipped} unchanged`);

      const warnings = [];
      if (downloadFailed.length > 0) warnings.push(`${downloadFailed.length} download failed`);
      if (deleteFailed.length > 0) warnings.push(`${deleteFailed.length} delete failed`);
      const warnStr =
        warnings.length > 0 ? `  ⚠️ ${warnings.join(", ")}` : "";

      status.setMessage(
        `Pull complete — ${summary.join(", ")}.${warnStr}`
      );
      setTimeout(() => status.hide(), 6000);
    } catch (e) {
      console.error("[Direct GitHub Sync] Pull error:", e);
      status.setMessage(`Pull failed: ${e.message}`);
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
  }

  /** Clone current saved values into the unsaved draft. */
  _initDraft() {
    const s = this.plugin.settings;
    this._draft = {
      pat:      s.pat,
      username: s.username,
      repo:     s.repo,
      branch:   s.branch,
    };
  }

  /** True if the draft differs from what's already saved. */
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
    this._initDraft();

    // ── Header ─────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Direct GitHub Sync" });
    containerEl.createEl("p", {
      text:
        "Sync your vault directly with a GitHub repository using the GitHub REST API — no Git, no Node.js, works on mobile.",
      cls: "setting-item-description",
    });

    // ══════════════════════════════════════════════════════════════════
    //  Section 1 — Authentication & Repository
    // ══════════════════════════════════════════════════════════════════
    containerEl.createEl("h3", { text: "🔑 Authentication & Repository" });

    const authNote = containerEl.createEl("p", {
      cls: "setting-item-description dgs-section-note",
    });
    authNote.innerHTML =
      "These settings are only applied when you click " +
      "<strong>Save Connection Settings</strong>. " +
      "Unsaved changes will not be used by Push or Pull.";

    // PAT
    new Setting(containerEl)
      .setName("Personal Access Token (PAT)")
      .setDesc(
        "A GitHub PAT with 'repo' scope (or 'Contents: Read & Write' for fine-grained tokens). " +
          "Generate one at GitHub → Settings → Developer settings → Personal access tokens."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text
          .setPlaceholder("ghp_xxxxxxxxxxxxxxxxxxxx")
          .setValue(this._draft.pat)
          .onChange((v) => {
            this._draft.pat = v.trim();
            this._updateSaveBtnState();
          });
      });

    // Username
    new Setting(containerEl)
      .setName("GitHub Username / Organisation")
      .setDesc(
        "The account or organisation that owns the target repository."
      )
      .addText((text) =>
        text
          .setPlaceholder("octocat")
          .setValue(this._draft.username)
          .onChange((v) => {
            this._draft.username = v.trim();
            this._updateSaveBtnState();
          })
      );

    // Repo name
    new Setting(containerEl)
      .setName("Repository Name")
      .setDesc("The repository name only — not a URL.")
      .addText((text) =>
        text
          .setPlaceholder("my-obsidian-vault")
          .setValue(this._draft.repo)
          .onChange((v) => {
            this._draft.repo = v.trim();
            this._updateSaveBtnState();
          })
      );

    // Branch
    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Target branch. Leave blank to use 'main'.")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this._draft.branch)
          .onChange((v) => {
            this._draft.branch = v.trim() || "main";
            this._updateSaveBtnState();
          })
      );

    // Validation result panel
    this._validationEl = containerEl.createDiv({
      cls: "dgs-validation-result dgs-hidden",
    });

    // Save + Test buttons
    const actionSetting = new Setting(containerEl);
    actionSetting
      .addButton((btn) => {
        this._saveBtn = btn;
        btn
          .setButtonText("Save Connection Settings")
          .setCta()
          .onClick(() => this._saveCredentials());
      })
      .addButton((btn) =>
        btn.setButtonText("Test Connection").onClick(() =>
          this._testConnection()
        )
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 2 — Behaviour
    // ══════════════════════════════════════════════════════════════════
    containerEl.createEl("h3", { text: "⚙️ Behaviour" });

    new Setting(containerEl)
      .setName("Ignore .obsidian directory")
      .setDesc(
        "Recommended. Prevents plugin configs, workspace state, and cache from being pushed to or pulled from GitHub."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ignoreObsidianDir)
          .onChange(async (v) => {
            this.plugin.settings.ignoreObsidianDir = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Device name (optional)")
      .setDesc(
        'Shown in commit messages. E.g. "PC" → "Vault push from PC: 19 Apr 2026 at 14:03". Leave blank to omit.'
      )
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
      .setDesc(
        "Number of simultaneous GitHub API calls during push/pull. Higher is faster but risks rate limits on slow connections. Default: 5."
      )
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
    containerEl.createEl("h3", { text: "⚡ Quick Actions" });

    new Setting(containerEl)
      .setName("Push to GitHub")
      .setDesc("Upload all local changes to the configured repository.")
      .addButton((btn) =>
        btn
          .setButtonText("Push Now")
          .setCta()
          .onClick(() => this.plugin.push())
      );

    new Setting(containerEl)
      .setName("Pull from GitHub")
      .setDesc(
        "Download all remote changes and update the local vault."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Pull Now")
          .setWarning()
          .onClick(() => this.plugin.pull())
      );

    // ══════════════════════════════════════════════════════════════════
    //  Section 4 — Danger Zone
    // ══════════════════════════════════════════════════════════════════
    containerEl.createEl("h3", { text: "🗑️ Danger Zone" });

    new Setting(containerEl)
      .setName("Reset sync cache")
      .setDesc(
        "Clears the local SHA cache and remembered remote commit. " +
          "The next push/pull will do a full sync. " +
          "Use this if files are being skipped unexpectedly or after a manual repo reset."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset Cache")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.lastPulledShas = {};
            this.plugin.settings.lastKnownRemoteCommit = "";
            await this.plugin.saveSettings();
            new Notice(
              "Sync cache cleared. The next sync will be a full sync.",
              5000
            );
          })
      );

    // ── Footer ─────────────────────────────────────────────────────────
    containerEl.createEl("hr");
    containerEl.createEl("p", {
      text:
        "Tip: Assign hotkeys to 'Push to GitHub' and 'Pull from GitHub' via Settings → Hotkeys.",
      cls: "setting-item-description",
    });
  }

  /** Update the Save button label to reflect unsaved state. */
  _updateSaveBtnState() {
    if (!this._saveBtn) return;
    if (this._isDirty()) {
      this._saveBtn.setButtonText("Save Connection Settings ●");
    } else {
      this._saveBtn.setButtonText("Save Connection Settings");
    }
  }

  /** Validate the draft and commit it to plugin.settings. */
  async _saveCredentials() {
    const d = this._draft;
    const issues = [];
    if (!d.pat)      issues.push("PAT is required.");
    if (!d.username) issues.push("GitHub username is required.");
    if (!d.repo)     issues.push("Repository name is required.");
    if (!d.branch)   issues.push("Branch is required.");
    if (
      d.pat &&
      !/^(ghp_|github_pat_|gho_|ghs_|ghr_)/.test(d.pat)
    ) {
      issues.push(
        "PAT format looks incorrect — should start with 'ghp_' or 'github_pat_'."
      );
    }

    if (issues.length > 0) {
      this._showValidation("error", "Cannot save:\n• " + issues.join("\n• "));
      return;
    }

    // Commit to real settings
    this.plugin.settings.pat      = d.pat;
    this.plugin.settings.username = d.username;
    this.plugin.settings.repo     = d.repo;
    this.plugin.settings.branch   = d.branch;
    // Clear conflict cache whenever connection details change
    this.plugin.settings.lastKnownRemoteCommit = "";
    await this.plugin.saveSettings();

    this._updateSaveBtnState();
    this._showValidation("ok", "Connection settings saved successfully.");
    new Notice("✅ Connection settings saved.", 3000);
  }

  /** Run a live validation against the GitHub API. */
  async _testConnection() {
    if (this._isDirty()) {
      this._showValidation(
        "error",
        "You have unsaved changes. Save first, then test."
      );
      return;
    }

    this._showValidation("info", "Testing connection…");
    try {
      const client = this.plugin._client();
      const result = await client.validateSettings();
      if (result.ok) {
        this._showValidation("ok", result.message);
      } else {
        this._showValidation("error", result.message);
      }
    } catch (e) {
      this._showValidation("error", `Unexpected error: ${e.message}`);
    }
  }

  /**
   * Show an inline result below the credential fields.
   * @param {"ok"|"error"|"info"} type
   * @param {string} message
   */
  _showValidation(type, message) {
    const el = this._validationEl;
    if (!el) return;

    el.className = "dgs-validation-result";
    el.removeClass("dgs-hidden");

    const icons = { ok: "✅", error: "❌", info: "⏳" };
    const cls   = { ok: "dgs-ok", error: "dgs-err", info: "dgs-info" };

    el.addClass(cls[type] || "dgs-info");
    el.setText(`${icons[type] || "ℹ️"} ${message}`);
  }
}

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────
module.exports = DirectGitHubSyncPlugin;
