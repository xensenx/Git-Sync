"use strict";

const { requestUrl, Notice } = require("obsidian");
const { GITHUB_API, MAX_TREE_ENTRIES } = require("./constants");
const { withRetry }          = require("./utils");

// ─────────────────────────────────────────────
//  GitHub REST client
// ─────────────────────────────────────────────

class GitHubClient {
  constructor(pat, username, repo, branch) {
    this.pat      = pat;
    this.username = username;
    this.repo     = repo;
    this.branch   = branch;
    this.base     = `${GITHUB_API}/repos/${username}/${repo}`;
    this._established = false;
  }

  get _headers() {
    return {
      Authorization:        `Bearer ${this.pat}`,
      Accept:               "application/vnd.github+json",
      "Content-Type":       "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async _req(method, url, body) {
    const opts = { url, method, headers: this._headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let resp;
    try {
      resp = await requestUrl(opts);
    } catch (netErr) {
      const e = new Error(`Network error — check your internet connection. (${netErr.message})`);
      e.status = 0;
      throw e;
    }

    if (resp.status >= 400) {
      const ghMsg = resp.json?.message || resp.text || "";
      const e = new Error(this._friendlyError(resp.status, url, ghMsg));
      e.status    = resp.status;
      e.ghMessage = ghMsg;

      // Surface Retry-After header for rate-limit handling in withRetry
      const retryAfter = resp.headers?.["retry-after"] || resp.headers?.["Retry-After"];
      if (retryAfter) {
        const secs = parseInt(retryAfter, 10);
        if (!isNaN(secs) && secs > 0) e.retryAfterMs = secs * 1000;
      }

      throw e;
    }

    return resp.json;
  }

  _friendlyError(status, url, ghMsg) {
    const isRepo = url.includes(`/repos/${this.username}/${this.repo}`);
    const msgLower = (ghMsg || "").toLowerCase();
    switch (status) {
      case 401:
        return "Authentication failed — your PAT is invalid or expired.";
      case 403:
        // Distinguish rate-limit from permission errors
        if (msgLower.includes("rate limit") || msgLower.includes("abuse") || msgLower.includes("secondary"))
          return `GitHub rate limit exceeded. Wait a few minutes and try again. (${ghMsg})`;
        return "Access forbidden — PAT may lack 'repo' scope.";
      case 404:
        if (isRepo && url.includes(`/commits/${this.branch}`))
          return `Branch "${this.branch}" not found in "${this.username}/${this.repo}".`;
        if (isRepo)
          return `Repository "${this.username}/${this.repo}" not found.`;
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
    if (!data?.sha || !data.commit?.tree?.sha)
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

    // Hard abort on truncated trees — proceeding would cause data loss
    if (data.truncated) {
      throw new Error(
        `Repository tree is truncated (>${MAX_TREE_ENTRIES} files). ` +
        `Sync cannot proceed safely. Use ignored paths in plugin settings ` +
        `to reduce the number of synced files.`
      );
    }

    return data.tree;
  }

  async getBlob(sha) {
    const data = await withRetry(
      () => this._req("GET", `${this.base}/git/blobs/${sha}`),
      "getBlob"
    );
    // content is "" for 0-byte files — that is valid. Only reject if absent.
    if (!data || data.content === undefined || data.content === null)
      throw new Error(`Empty blob response for SHA ${sha}`);
    return data.content.replace(/[\r\n]/g, "");
  }

  // ── Write ─────────────────────────────────────

  async createBlob(base64Content) {
    const data = await withRetry(
      () => this._req("POST", `${this.base}/git/blobs`, {
        content: base64Content, encoding: "base64",
      }),
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

  /**
   * Update the branch ref to point to a new commit.
   * @param {string}  commitSha — the commit to point to
   * @param {boolean} [force=false] — if true, force-update even if remote has diverged
   */
  async updateRef(commitSha, force = false) {
    await withRetry(
      () => this._req("PATCH", `${this.base}/git/refs/heads/${this.branch}`, {
        sha: commitSha, force,
      }),
      "updateRef"
    );
  }

  /**
   * Bootstrap an empty or branch-less repo by creating a .gitkeep commit.
   * Returns true if the repo was just initialised.
   */
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
      await withRetry(() => this._req("GET", this.base), "check repo existence");
    } catch (e) {
      if (e.status === 404)
        throw new Error(
          `Repository "${this.username}/${this.repo}" not found. ` +
          `Verify your username and repository name.`
        );
      throw e;
    }

    await withRetry(
      () => this._req("PUT", `${this.base}/contents/.gitkeep`, {
        message: "Initial commit (Direct GitHub Sync)",
        content:  btoa(""),
        branch:   this.branch,
      }),
      "bootstrap .gitkeep"
    );

    this._established = true;
    return true;
  }

  /**
   * Full connection validation: PAT identity, repo access, branch existence.
   * Returns { ok: boolean, message: string }.
   */
  async validateSettings() {
    let userResp;
    try {
      userResp = await requestUrl({ url: `${GITHUB_API}/user`, method: "GET", headers: this._headers });
    } catch {
      return { ok: false, message: "Network error — check your internet connection." };
    }

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
      repoResp = await requestUrl({ url: this.base, method: "GET", headers: this._headers });
    } catch {
      return { ok: false, message: "Network error while checking repository." };
    }

    if (repoResp.status === 404)
      return { ok: false, message: `Repository "${this.username}/${this.repo}" not found.` };
    if (repoResp.status === 403)
      return { ok: false, message: `PAT does not have access to "${this.username}/${this.repo}".` };

    try {
      const branchResp = await requestUrl({
        url:     `${this.base}/branches/${this.branch}`,
        method:  "GET",
        headers: this._headers,
      });
      if (branchResp.status === 404)
        return { ok: false, message: `Branch "${this.branch}" not found in the repository.` };
    } catch { /* empty repo or transient error — treat as OK */ }

    return {
      ok:      true,
      message: `Connected to ${this.username}/${this.repo} on branch "${this.branch}". Connection verified.`,
    };
  }
}

module.exports = { GitHubClient };
