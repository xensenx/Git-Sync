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
  deviceName: "",          // optional — shown in commit messages
  // Max simultaneous GitHub API requests. 5 is safe and fast.
  // Lower this if you see rate-limit errors on a slow connection.
  concurrency: 5,
  // filepath -> blob SHA of the last successfully pulled/pushed state.
  // Used to skip unchanged files — never edit this manually.
  lastPulledShas: {},
};

const GITHUB_API = "https://api.github.com";

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/**
 * Run an array of async task-factory functions in a controlled concurrency pool.
 * At most `concurrency` tasks run at the same time.
 * Returns results in the same order as the input array.
 *
 * Using a pool (rather than Promise.all) avoids hammering GitHub with
 * hundreds of simultaneous requests while still being much faster than serial.
 */
async function parallelBatch(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
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

/**
 * Build the commit message.
 * Format: "Vault push from {device}: {date} at {time}"
 *         "Vault push: {date} at {time}"  (when no device name set)
 *
 * Date: DD MMM YYYY  e.g. "19 Apr 2026"
 * Time: HH:MM        e.g. "14:03"  (local time, 24-hour)
 */
function buildCommitMessage(deviceName) {
  const now = new Date();

  const months = ["Jan","Feb","Mar","Apr","May","Jun",
                  "Jul","Aug","Sep","Oct","Nov","Dec"];
  const date = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  const time = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  const from = deviceName && deviceName.trim()
    ? ` from ${deviceName.trim()}`
    : "";

  return `Vault push${from}: ${date} at ${time}`;
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

  /** Get the latest commit SHA and tree SHA for the branch — single API call. */
  async getLatestCommit() {
    // The Commits API returns the commit object directly, including tree SHA,
    // saving one serial round-trip compared to ref → commit → tree.
    const data = await this._req(
      "GET",
      `${this.base}/commits/${this.branch}`
    );
    return {
      commitSha: data.sha,
      treeSha: data.commit.tree.sha,
    };
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
   * Ensure the branch exists and is ready. Returns false if already established,
   * true if it just bootstrapped. Throws if the repo itself is inaccessible.
   *
   * We cache the "established" state in memory so repeated push/pull in the
   * same session skips all these preflight API calls entirely.
   */
  async initRepoIfNeeded() {
    if (this._established) return false;

    // Try getLatestCommit — if it works, we're done.
    try {
      await this.getLatestCommit();
      this._established = true;
      return false;
    } catch (e) {
      // 404 = repo not found or no branch yet; 409 = repo empty
      if (e.status !== 404 && e.status !== 409) throw e;
    }

    // Verify the repo itself is accessible before attempting to bootstrap
    try {
      await this._req("GET", `${this.base}`);
    } catch {
      throw new Error(
        `Repository "${this.username}/${this.repo}" not found or PAT lacks access.`
      );
    }

    // Bootstrap: Contents API is the only reliable way to seed a zero-commit repo
    await this._req("PUT", `${this.base}/contents/.gitkeep`, {
      message: "Initial commit (Direct GitHub Sync)",
      content: btoa(""),
      branch: this.branch,
    });

    this._established = true;
    return true;
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
    const concurrency = this.settings.concurrency || 5;
    const status = new Notice("Push: connecting...", 0);

    try {
      // 0. Ensure branch exists
      const initialised = await client.initRepoIfNeeded();
      if (initialised) status.setMessage("Push: initialised empty repository.");

      // 1. Fetch remote tree and scan local files IN PARALLEL
      //    — network round-trip and disk reads overlap
      status.setMessage("Push: reading local and remote state...");

      const [{ commitSha, treeSha }, allFiles] = await Promise.all([
        client.getLatestCommit(),
        Promise.resolve(this.app.vault.getFiles()),
      ]);

      const remoteTreePromise = client.getFullTree(treeSha);

      // Filter local files while remote tree is still fetching
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

      // Read all local files + compute their Git blob SHAs in parallel
      // while the remote tree fetch is also in flight
      status.setMessage(`Push: scanning ${files.length} local file(s)...`);
      const [remoteTree, localEntries] = await Promise.all([
        remoteTreePromise,
        parallelBatch(files, concurrency, async (file) => {
          const buf = await this.app.vault.readBinary(file);
          const sha = await computeGitBlobSha(buf);
          return { path: normalisePath(file.path), sha, buf };
        }),
      ]);

      // Build remote SHA map
      const remoteShaMap = {};
      for (const node of remoteTree) {
        if (node.type === "blob") remoteShaMap[node.path] = node.sha;
      }

      // 2. Diff — pure CPU, instant
      const changed = localEntries.filter((e) => remoteShaMap[e.path] !== e.sha);
      const unchanged = localEntries.filter((e) => remoteShaMap[e.path] === e.sha);

      if (changed.length === 0) {
        status.setMessage("Push: already up to date — nothing changed.");
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // 3. Upload changed blobs in parallel
      let uploaded = 0;
      status.setMessage(`Push: uploading ${changed.length} changed file(s)...`);

      const uploadedEntries = await parallelBatch(changed, concurrency, async (f) => {
        const b64 = arrayBufferToBase64(f.buf);
        let blobSha;
        try {
          blobSha = await client.createBlob(b64);
        } catch (e) {
          throw new Error(`Blob upload failed for "${f.path}": ${e.message}`);
        }
        uploaded++;
        status.setMessage(`Push: uploaded ${uploaded} / ${changed.length}...`);
        return { path: f.path, sha: blobSha };
      });

      // 4. Build tree items — reuse existing SHAs for unchanged files
      const treeItems = [
        ...unchanged.map((f) => ({
          path: f.path, mode: "100644", type: "blob", sha: remoteShaMap[f.path],
        })),
        ...uploadedEntries.map((f) => ({
          path: f.path, mode: "100644", type: "blob", sha: f.sha,
        })),
      ];

      // 5. Commit
      status.setMessage("Push: creating commit...");
      const newTreeSha = await client.createTree(treeSha, treeItems)
        .catch((e) => { throw new Error(`Tree creation failed: ${e.message}`); });

      const msg = buildCommitMessage(this.settings.deviceName);
      const newCommitSha = await client.createCommit(msg, newTreeSha, commitSha)
        .catch((e) => { throw new Error(`Commit creation failed: ${e.message}`); });

      status.setMessage("Push: updating branch ref...");
      await client.updateRef(newCommitSha)
        .catch((e) => { throw new Error(`Commit created (${newCommitSha}) but ref update failed: ${e.message}`); });

      // 6. Sync cache — prime pull cache with final SHAs so next pull is instant
      const cache = this.settings.lastPulledShas || {};
      for (const item of treeItems) cache[item.path] = item.sha;
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
    const concurrency = this.settings.concurrency || 5;
    const status = new Notice("Pull: connecting...", 0);

    try {
      // 1. Fetch remote tree
      status.setMessage("Pull: fetching repository tree...");
      const { treeSha } = await client.getLatestCommit();
      const tree = await client.getFullTree(treeSha);

      const folders = tree.filter((n) => n.type === "tree");
      const blobs = tree.filter((n) => {
        const p = normalisePath(n.path);
        if (p === ".gitkeep") return false;
        if (this.settings.ignoreObsidianDir &&
            (p.startsWith(".obsidian/") || p === ".obsidian")) return false;
        return n.type === "blob";
      });

      // 2. Delta check — only download what actually changed
      const cache = this.settings.lastPulledShas || {};
      const changed = blobs.filter((n) => cache[normalisePath(n.path)] !== n.sha);

      if (changed.length === 0) {
        status.setMessage("Pull: already up to date.");
        setTimeout(() => status.hide(), 4000);
        return;
      }

      // 3. Ensure all folders exist — serial but instant (local FS only)
      for (const folder of folders) {
        const fp = normalisePath(folder.path);
        if (this.settings.ignoreObsidianDir &&
            (fp.startsWith(".obsidian/") || fp === ".obsidian")) continue;
        if (!this.app.vault.getAbstractFileByPath(fp)) {
          try { await this.app.vault.createFolder(fp); } catch { /* already exists */ }
        }
      }

      // 4. Download changed blobs in parallel
      status.setMessage(`Pull: downloading ${changed.length} changed file(s)...`);
      let written = 0;
      const newCache = Object.assign({}, cache);

      await parallelBatch(changed, concurrency, async (node) => {
        const fp = normalisePath(node.path);
        let b64;
        try {
          b64 = await client.getBlob(node.sha);
        } catch (e) {
          console.warn(`[Direct GitHub Sync] Blob fetch failed for "${fp}": ${e.message}`);
          return; // skip this file, don't update cache — will retry next pull
        }

        const buf = base64ToArrayBuffer(b64);
        const existing = this.app.vault.getAbstractFileByPath(fp);

        try {
          if (existing) {
            await this.app.vault.adapter.writeBinary(fp, buf);
          } else {
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
          status.setMessage(`Pull: downloaded ${written} / ${changed.length}...`);
        } catch (e) {
          console.warn(`[Direct GitHub Sync] Write failed for "${fp}": ${e.message}`);
        }
      });

      // 5. Persist cache
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
      .setName("Device name (optional)")
      .setDesc(
        'Identifies this device in commit messages. E.g. "PC" → "Vault push from PC: 19 Apr 2026 at 14:03". Leave blank to omit.'
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
        "How many GitHub API requests run in parallel during push/pull. Higher is faster but may hit rate limits on slow connections. Default: 5."
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
