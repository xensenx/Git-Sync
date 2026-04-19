/*
 * Direct GitHub Sync — Obsidian Plugin
 * main.js (vanilla JS, no build step required)
 *
 * Drop this file alongside manifest.json into:
 *   <vault>/.obsidian/plugins/direct-github-sync/
 * then enable it in Settings → Community Plugins.
 */

"use strict";

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } =
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
  commitMessage: "Manual Push from Obsidian",
  blobDelayMs: 75,
  // filepath -> blob SHA of the last successfully pulled state.
  // Used to skip unchanged files on subsequent pulls.
  lastPulledShas: {},
};

const GITHUB_API = "https://api.github.com";

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Sleep for `ms` milliseconds. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convert an ArrayBuffer to a Base64 string.
 * Works in both browser (Obsidian desktop) and mobile WebView.
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert a Base64 string back to an ArrayBuffer.
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Sanitise a path so it is always relative and forward-slash separated.
 * Obsidian may return paths with a leading slash on some platforms.
 */
function normalisePath(p) {
  return p.replace(/^\/+/, "").replace(/\\/g, "/");
}

/**
 * Compute the Git blob SHA for an ArrayBuffer.
 *
 * Git's blob SHA is:  sha1("blob " + byteLength + "\0" + fileBytes)
 *
 * We use the WebCrypto API (available in both Obsidian desktop and mobile)
 * to produce this without any Node.js dependency.
 *
 * Returns a lowercase hex string identical to what GitHub stores in its tree,
 * allowing us to diff local files against the remote tree without any API calls.
 */
async function computeGitBlobSha(arrayBuffer) {
  const fileBytes = new Uint8Array(arrayBuffer);
  const header = `blob ${fileBytes.byteLength}\0`;
  const headerBytes = new TextEncoder().encode(header);

  // Concatenate header + file content into one buffer
  const combined = new Uint8Array(headerBytes.byteLength + fileBytes.byteLength);
  combined.set(headerBytes, 0);
  combined.set(fileBytes, headerBytes.byteLength);

  const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─────────────────────────────────────────────
//  GitHub REST helpers (all use requestUrl)
// ─────────────────────────────────────────────

class GitHubClient {
  constructor(pat, username, repo, branch) {
    this.pat = pat;
    this.username = username;
    this.repo = repo;
    this.branch = branch;
    this.base = `${GITHUB_API}/repos/${username}/${repo}`;
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
    const resp = await requestUrl(opts);
    if (resp.status >= 400) {
      const msg =
        resp.json?.message || resp.text || `HTTP ${resp.status}`;
      const err = new Error(`GitHub API error (${resp.status}): ${msg}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json;
  }

  // ── READ ──────────────────────────────────

  /** Get the latest commit SHA and tree SHA for the branch. */
  async getLatestCommit() {
    const data = await this._req(
      "GET",
      `${this.base}/git/ref/heads/${this.branch}`
    );
    const commitSha = data.object.sha;
    const commit = await this._req(
      "GET",
      `${this.base}/git/commits/${commitSha}`
    );
    return { commitSha, treeSha: commit.tree.sha };
  }

  /** Get the full recursive tree for a given tree SHA. */
  async getFullTree(treeSha) {
    const data = await this._req(
      "GET",
      `${this.base}/git/trees/${treeSha}?recursive=1`
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
    const data = await this._req(
      "GET",
      `${this.base}/git/blobs/${sha}`
    );
    return data.content.replace(/\n/g, ""); // strip newlines added by GitHub
  }

  // ── WRITE ─────────────────────────────────

  /** Create a blob. Returns its SHA. */
  async createBlob(base64Content) {
    const data = await this._req("POST", `${this.base}/git/blobs`, {
      content: base64Content,
      encoding: "base64",
    });
    return data.sha;
  }

  /** Create a new tree on top of a base tree. Returns new tree SHA. */
  async createTree(baseTreeSha, treeItems) {
    const data = await this._req("POST", `${this.base}/git/trees`, {
      base_tree: baseTreeSha,
      tree: treeItems,
    });
    return data.sha;
  }

  /** Create a commit. Returns new commit SHA. */
  async createCommit(message, treeSha, parentSha) {
    const data = await this._req("POST", `${this.base}/git/commits`, {
      message,
      tree: treeSha,
      parents: [parentSha],
    });
    return data.sha;
  }

  /** Update the branch ref to point to a new commit SHA. */
  async updateRef(commitSha) {
    await this._req(
      "PATCH",
      `${this.base}/git/refs/heads/${this.branch}`,
      { sha: commitSha, force: false }
    );
  }

  /**
   * Check whether the repo is accessible. Throws a clear error if not.
   */
  async checkRepoAccess() {
    try {
      await this._req("GET", `${this.base}`);
    } catch {
      throw new Error(
        `Repository "${this.username}/${this.repo}" not found or PAT lacks access.`
      );
    }
  }

  /**
   * Returns true if the branch has at least one commit, false if it is
   * completely empty (no refs at all — freshly created repo).
   */
  async branchExists() {
    try {
      // Use the Commits API — safer than the Git Database ref endpoint
      // on repos that have never had a commit.
      const resp = await requestUrl({
        url: `${this.base}/commits?sha=${this.branch}&per_page=1`,
        method: "GET",
        headers: this._headers,
      });
      // 409 = repo exists but has no commits yet
      if (resp.status === 409) return false;
      if (resp.status === 404) return false;
      if (resp.status >= 400) return false;
      return Array.isArray(resp.json) && resp.json.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Bootstrap a completely empty repo by pushing a placeholder file via
   * the Contents API — the only reliable way to initialise a repo with
   * zero commits through the REST API.
   */
  async bootstrapEmptyRepo() {
    await this._req(
      "PUT",
      `${this.base}/contents/.gitkeep`,
      {
        message: "Initial commit (Direct GitHub Sync)",
        content: btoa(""), // empty file, base64
        branch: this.branch,
      }
    );
  }

  /**
   * Initialise the repository if the branch does not yet exist.
   */
  async initRepoIfNeeded() {
    await this.checkRepoAccess();
    const exists = await this.branchExists();
    if (exists) return false;
    await this.bootstrapEmptyRepo();
    return true; // bootstrapped
  }
}

// ─────────────────────────────────────────────
//  Main Plugin Class
// ─────────────────────────────────────────────

class DirectGitHubSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // ── Ribbon icons ──────────────────────────
    this.addRibbonIcon("upload", "Push vault to GitHub", () =>
      this.push()
    );
    this.addRibbonIcon("download", "Pull vault from GitHub", () =>
      this.pull()
    );

    // ── Command palette ───────────────────────
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

    // ── Settings tab ──────────────────────────
    this.addSettingTab(new DirectGitHubSyncSettingTab(this.app, this));

    console.log("[Direct GitHub Sync] Plugin loaded.");
  }

  onunload() {
    console.log("[Direct GitHub Sync] Plugin unloaded.");
  }

  // ── Persistence ───────────────────────────
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Validation ───────────────────────────
  _validate() {
    const s = this.settings;
    if (!s.pat) throw new Error("No GitHub PAT configured. Check plugin settings.");
    if (!s.username) throw new Error("No GitHub username configured.");
    if (!s.repo) throw new Error("No repository name configured.");
    if (!s.branch) throw new Error("No branch configured.");
  }

  _client() {
    const s = this.settings;
    return new GitHubClient(s.pat, s.username, s.repo, s.branch);
  }

  // ─────────────────────────────────────────
  //  PUSH  (Local → GitHub)
  // ─────────────────────────────────────────
  async push() {
    try {
      this._validate();
    } catch (e) {
      new Notice(e.message, 6000);
      return;
    }

    const client = this._client();
    const status = new Notice("Push: connecting...", 0);

    try {
      // 0. Ensure branch exists
      const initialised = await client.initRepoIfNeeded();
      if (initialised) {
        status.setMessage("Push: initialised empty repository.");
      }

      // 1. Fetch remote tree — one API call gives us every file's blob SHA
      status.setMessage("Push: reading remote state...");
      const { commitSha, treeSha } = await client.getLatestCommit();
      const remoteTree = await client.getFullTree(treeSha);

      // Build a map of remotePath -> remoteBlobSha for O(1) lookup
      const remoteShaMap = {};
      for (const node of remoteTree) {
        if (node.type === "blob") remoteShaMap[node.path] = node.sha;
      }

      // 2. Gather local files
      const allFiles = this.app.vault.getFiles();
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

      // 3. Compute local SHAs and diff against remote — no API calls yet
      status.setMessage("Push: scanning for changes...");
      const changed = [];
      const unchanged = [];

      for (const file of files) {
        const filePath = normalisePath(file.path);
        const buf = await this.app.vault.readBinary(file);
        const localSha = await computeGitBlobSha(buf);

        if (remoteShaMap[filePath] === localSha) {
          // File is byte-for-byte identical to remote — reuse remote SHA
          unchanged.push({ path: filePath, sha: localSha, buf: null });
        } else {
          changed.push({ path: filePath, sha: null, buf });
        }
      }

      if (changed.length === 0) {
        status.setMessage("Push: already up to date — nothing changed.");
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // 4. Upload blobs only for changed files
      const treeItems = [];

      // Unchanged files: reference their existing remote SHA directly —
      // no upload needed, GitHub reuses the blob
      for (const f of unchanged) {
        treeItems.push({ path: f.path, mode: "100644", type: "blob", sha: remoteShaMap[f.path] });
      }

      // Changed files: upload new blobs
      for (let i = 0; i < changed.length; i++) {
        const f = changed[i];
        status.setMessage(`Push: uploading ${i + 1} / ${changed.length} changed file(s) — ${f.path}`);

        let blobSha;
        try {
          const b64 = arrayBufferToBase64(f.buf);
          blobSha = await client.createBlob(b64);
        } catch (e) {
          throw new Error(`Blob upload failed for "${f.path}": ${e.message}`);
        }

        treeItems.push({ path: f.path, mode: "100644", type: "blob", sha: blobSha });

        if (i < changed.length - 1) {
          await sleep(this.settings.blobDelayMs);
        }
      }

      // 5. New tree, commit, ref update
      status.setMessage("Push: creating commit...");
      let newTreeSha;
      try {
        newTreeSha = await client.createTree(treeSha, treeItems);
      } catch (e) {
        throw new Error(`Tree creation failed: ${e.message}`);
      }

      let newCommitSha;
      try {
        const msg = this.settings.commitMessage || DEFAULT_SETTINGS.commitMessage;
        newCommitSha = await client.createCommit(msg, newTreeSha, commitSha);
      } catch (e) {
        throw new Error(`Commit creation failed: ${e.message}`);
      }

      status.setMessage("Push: updating branch ref...");
      try {
        await client.updateRef(newCommitSha);
      } catch (e) {
        throw new Error(`Commit created (${newCommitSha}) but ref update failed: ${e.message}`);
      }

      // 6. Update the pull cache so a subsequent pull on this device
      //    correctly sees these files as already up to date
      const cache = this.settings.lastPulledShas || {};
      for (const item of treeItems) {
        cache[item.path] = item.sha;
      }
      this.settings.lastPulledShas = cache;
      await this.saveSettings();

      const skippedMsg = unchanged.length > 0 ? ` (${unchanged.length} unchanged, skipped)` : "";
      status.setMessage(`Push complete — ${changed.length} file(s) uploaded.${skippedMsg}`);
      setTimeout(() => status.hide(), 5000);
    } catch (e) {
      console.error("[Direct GitHub Sync] Push error:", e);
      status.setMessage(`Push failed: ${e.message}`);
      setTimeout(() => status.hide(), 10000);
    }
  }

  // ─────────────────────────────────────────
  //  PULL  (GitHub → Local)
  // ─────────────────────────────────────────
  async pull() {
    try {
      this._validate();
    } catch (e) {
      new Notice(e.message, 6000);
      return;
    }

    const client = this._client();
    const status = new Notice("Pull: connecting...", 0);

    try {
      // 1. Latest commit & recursive tree
      status.setMessage("Pull: fetching repository tree...");
      const { treeSha } = await client.getLatestCommit();
      const tree = await client.getFullTree(treeSha);

      const folders = tree.filter((n) => n.type === "tree");
      const blobs  = tree.filter((n) => n.type === "blob").filter((n) => {
        const p = normalisePath(n.path);
        // Skip bootstrap artefact and .obsidian if configured
        if (p === ".gitkeep") return false;
        if (this.settings.ignoreObsidianDir &&
            (p.startsWith(".obsidian/") || p === ".obsidian")) return false;
        return true;
      });

      // 2. Delta: compare remote SHAs against our cached record
      const cache = this.settings.lastPulledShas || {};
      const changed = blobs.filter((n) => cache[n.path] !== n.sha);

      if (changed.length === 0) {
        status.setMessage("Pull: already up to date.");
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // 3. Ensure all needed folders exist locally
      for (const folder of folders) {
        const fp = normalisePath(folder.path);
        if (this.settings.ignoreObsidianDir &&
            (fp.startsWith(".obsidian/") || fp === ".obsidian")) continue;
        if (!this.app.vault.getAbstractFileByPath(fp)) {
          try { await this.app.vault.createFolder(fp); } catch { /* already exists */ }
        }
      }

      // 4. Download only changed files
      let written = 0;
      const newCache = Object.assign({}, cache);

      for (let i = 0; i < changed.length; i++) {
        const node = changed[i];
        const fp = normalisePath(node.path);
        status.setMessage(`Pull: downloading ${i + 1} / ${changed.length} — ${fp}`);

        let b64;
        try {
          b64 = await client.getBlob(node.sha);
        } catch (e) {
          console.warn(`[Direct GitHub Sync] Could not fetch blob for "${fp}": ${e.message}`);
          // Don't update cache for this file — will retry next pull
          continue;
        }

        const buf = base64ToArrayBuffer(b64);
        const existing = this.app.vault.getAbstractFileByPath(fp);

        try {
          if (existing) {
            await this.app.vault.adapter.writeBinary(fp, buf);
          } else {
            // Ensure parent dir exists
            const parts = fp.split("/");
            if (parts.length > 1) {
              const dir = parts.slice(0, -1).join("/");
              if (!this.app.vault.getAbstractFileByPath(dir)) {
                await this.app.vault.createFolder(dir);
              }
            }
            await this.app.vault.createBinary(fp, buf);
          }
          newCache[fp] = node.sha;
          written++;
        } catch (e) {
          console.warn(`[Direct GitHub Sync] Could not write "${fp}": ${e.message}`);
        }
      }

      // 5. Persist updated cache
      this.settings.lastPulledShas = newCache;
      await this.saveSettings();

      const skipped = blobs.length - changed.length;
      const skippedMsg = skipped > 0 ? ` (${skipped} unchanged, skipped)` : "";
      status.setMessage(`Pull complete — ${written} file(s) updated.${skippedMsg}`);
      setTimeout(() => status.hide(), 5000);
    } catch (e) {
      console.error("[Direct GitHub Sync] Pull error:", e);
      status.setMessage(`Pull failed: ${e.message}`);
      setTimeout(() => status.hide(), 10000);
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
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // ── Header ───────────────────────────────
    containerEl.createEl("h2", { text: "Direct GitHub Sync" });
    containerEl.createEl("p", {
      text: "Sync your vault directly with a GitHub repository using the GitHub REST API — no Git, no Node.js, works on mobile.",
      cls: "setting-item-description",
    });

    // ── Section: Authentication ───────────────
    containerEl.createEl("h3", { text: "Authentication" });

    new Setting(containerEl)
      .setName("Personal Access Token (PAT)")
      .setDesc(
        "A GitHub PAT with 'repo' scope. Generate one at GitHub → Settings → Developer settings → Personal access tokens."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("ghp_xxxxxxxxxxxxxxxxxxxx")
          .setValue(this.plugin.settings.pat)
          .onChange(async (v) => {
            this.plugin.settings.pat = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // ── Section: Repository ───────────────────
    containerEl.createEl("h3", { text: "Repository" });

    new Setting(containerEl)
      .setName("GitHub Username / Org")
      .setDesc("The owner of the target repository.")
      .addText((text) =>
        text
          .setPlaceholder("octocat")
          .setValue(this.plugin.settings.username)
          .onChange(async (v) => {
            this.plugin.settings.username = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Repository Name")
      .setDesc("The name of the repository (not the full URL).")
      .addText((text) =>
        text
          .setPlaceholder("my-obsidian-vault")
          .setValue(this.plugin.settings.repo)
          .onChange(async (v) => {
            this.plugin.settings.repo = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Target branch. Defaults to 'main'.")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.branch)
          .onChange(async (v) => {
            this.plugin.settings.branch = v.trim() || "main";
            await this.plugin.saveSettings();
          })
      );

    // ── Section: Behaviour ────────────────────
    containerEl.createEl("h3", { text: "Behaviour" });

    new Setting(containerEl)
      .setName("Ignore .obsidian directory")
      .setDesc(
        "Recommended. Prevents plugin configs, workspace state, and cache files from being pushed to or overwritten by GitHub."
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
      .setName("Commit message")
      .setDesc("The commit message used for every push.")
      .addText((text) =>
        text
          .setPlaceholder("Manual Push from Obsidian")
          .setValue(this.plugin.settings.commitMessage)
          .onChange(async (v) => {
            this.plugin.settings.commitMessage =
              v.trim() || DEFAULT_SETTINGS.commitMessage;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Blob upload delay (ms)")
      .setDesc(
        "Delay between individual blob upload requests during Push. Prevents GitHub secondary rate limit errors. Range: 50–500 ms."
      )
      .addSlider((slider) =>
        slider
          .setLimits(50, 500, 25)
          .setValue(this.plugin.settings.blobDelayMs)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.blobDelayMs = v;
            await this.plugin.saveSettings();
          })
      );

    // ── Section: Actions ─────────────────────
    containerEl.createEl("h3", { text: "Quick Actions" });

    new Setting(containerEl)
      .setName("Push to GitHub")
      .setDesc("Upload all local vault files to the configured repository.")
      .addButton((btn) =>
        btn
          .setButtonText("Push Now")
          .setCta()
          .onClick(() => this.plugin.push())
      );

    new Setting(containerEl)
      .setName("Pull from GitHub")
      .setDesc(
        "Download all files from GitHub and overwrite local vault contents."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Pull Now")
          .setWarning()
          .onClick(() => this.plugin.pull())
      );

    // ── Footer ────────────────────────────────
    containerEl.createEl("hr");
    containerEl.createEl("p", {
      text: "Tip: Assign hotkeys to 'Push to GitHub' and 'Pull from GitHub' via Settings → Hotkeys.",
      cls: "setting-item-description",
    });
  }
}

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────
module.exports = DirectGitHubSyncPlugin;
