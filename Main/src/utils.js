"use strict";

const { MAX_RETRIES, RETRY_DELAY_MS, RATE_LIMIT_BACKOFF_MS } = require("./constants");

// ─────────────────────────────────────────────
//  Low-level helpers
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry wrapper. Auth/config errors (401, 404, 422) are NOT retried.
 * Rate-limit 403s ARE retried with backoff. Other 403s are NOT retried.
 * Uses exponential back-off.
 */
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // Auth / config errors — never retry
      if (e.status === 401 || e.status === 404 || e.status === 422) throw e;

      // 403: distinguish rate-limit from permission errors
      if (e.status === 403) {
        const msg = (e.ghMessage || e.message || "").toLowerCase();
        const isRateLimit = msg.includes("rate limit") ||
                            msg.includes("abuse") ||
                            msg.includes("secondary") ||
                            msg.includes("retry");
        if (!isRateLimit) throw e; // genuine permission error — don't retry

        // Rate limit — wait and retry
        const backoff = e.retryAfterMs || RATE_LIMIT_BACKOFF_MS * attempt;
        console.warn(
          `[DGS] "${label}" hit rate limit (attempt ${attempt}), ` +
          `waiting ${backoff}ms before retry…`
        );
        await sleep(backoff);
        lastErr = e;
        continue;
      }

      lastErr = e;
      if (attempt <= MAX_RETRIES) {
        console.warn(
          `[DGS] "${label}" attempt ${attempt}/${MAX_RETRIES + 1} failed, ` +
          `retrying in ${RETRY_DELAY_MS * attempt}ms… (${e.message})`
        );
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Bounded concurrency pool.
 * Returns array of { ok: true, value } | { ok: false, error, item }.
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

  const pool = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: pool }, worker));
  return results;
}

// ─────────────────────────────────────────────
//  Encoding helpers (chunked — no main-thread freeze)
// ─────────────────────────────────────────────

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  // GitHub API wraps base64 at 60 chars with newlines — strip CR/LF only
  const clean = base64.replace(/[\r\n]/g, "");
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

/** Normalise backslashes, collapse multiple slashes, strip leading slash. */
function normalisePath(p) {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
}

/**
 * Sanitise a path from an untrusted source (e.g. remote GitHub tree).
 * Strips ".." traversals, leading slashes, and backslashes to prevent
 * writing outside the vault directory.
 * Returns null if the path is entirely invalid after sanitisation.
 */
function sanitisePath(p) {
  if (!p) return null;
  // Normalise separators
  let clean = p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
  // Remove every ".." segment
  const parts = clean.split("/").filter((seg) => seg !== ".." && seg !== ".");
  if (parts.length === 0) return null;
  clean = parts.join("/");
  // Reject if still empty or looks suspicious
  if (!clean || clean === "." || clean === "..") return null;
  return clean;
}

/**
 * Git blob SHA = sha1("blob " + byteLength + "\0" + fileBytes)
 * Uses WebCrypto — async and non-blocking.
 */
async function computeGitBlobSha(arrayBuffer) {
  const fileBytes  = new Uint8Array(arrayBuffer);
  const header     = `blob ${fileBytes.byteLength}\0`;
  const headerBytes = new TextEncoder().encode(header);
  const combined   = new Uint8Array(headerBytes.byteLength + fileBytes.byteLength);
  combined.set(headerBytes, 0);
  combined.set(fileBytes, headerBytes.byteLength);
  const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─────────────────────────────────────────────
//  Line ending normalisation (CRLF → LF)
// ─────────────────────────────────────────────

/** Known text extensions for line-ending normalisation. */
const TEXT_EXTENSIONS = new Set([
  "md", "txt", "css", "js", "ts", "jsx", "tsx", "json", "xml", "html", "htm",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "csv", "svg", "sh", "bat",
  "ps1", "py", "rb", "java", "c", "cpp", "h", "hpp", "rs", "go", "lua",
  "r", "sql", "tex", "bib", "log", "env", "gitignore", "gitattributes",
  "editorconfig", "prettierrc", "eslintrc", "dockerfile",
]);

/** Heuristic: is this path a text file based on extension? */
function isTextFile(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Convert CRLF to LF in an ArrayBuffer.
 * Returns a new ArrayBuffer with \r\n replaced by \n.
 * Only processes text files — binary files are returned unchanged.
 */
function normaliseLineEndings(arrayBuffer, path) {
  if (!isTextFile(path)) return arrayBuffer;
  const bytes = new Uint8Array(arrayBuffer);
  // Quick scan: any \r present?
  let hasCR = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0D) { hasCR = true; break; }
  }
  if (!hasCR) return arrayBuffer;
  // Build new buffer without \r before \n
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0D && i + 1 < bytes.length && bytes[i + 1] === 0x0A) {
      continue; // skip \r, the \n will be added next iteration
    }
    out.push(bytes[i]);
  }
  return new Uint8Array(out).buffer;
}

// ─────────────────────────────────────────────
//  Case-sensitivity helpers
// ─────────────────────────────────────────────

/**
 * Build a map of lowercased-path → [original paths] from an array of path strings.
 * Used to detect case-only collisions (e.g. notes.md vs Notes.md).
 */
function buildCaseMap(paths) {
  const map = new Map();
  for (const p of paths) {
    const key = p.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return map;
}

/**
 * Detect paths that would collide on a case-insensitive filesystem.
 * Returns an array of { canonical, variants } where variants.length > 1.
 */
function detectCaseCollisions(paths) {
  const map = buildCaseMap(paths);
  const collisions = [];
  for (const [canonical, variants] of map) {
    if (variants.length > 1) {
      collisions.push({ canonical, variants });
    }
  }
  return collisions;
}

/**
 * Should this path be skipped during sync?
 * Handles .obsidian, .gitkeep, and user-defined ignore rules (wildcards, directory suffixes).
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
        "^" + rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
      );
      return regex.test(path);
    }
    return path === rule || path.startsWith(rule + "/");
  });
}

/** Build a human-readable commit message with optional device name. */
function buildCommitMessage(deviceName) {
  const now    = new Date();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const date   = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  const time   = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  const from   = deviceName?.trim() ? ` from ${deviceName.trim()}` : "";
  return `Vault sync${from}: ${date} at ${time}`;
}

/** Human-relative timestamp ("just now", "5m ago", "2h ago", "3d ago"). */
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

module.exports = {
  sleep,
  withRetry,
  parallelBatch,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  normalisePath,
  sanitisePath,
  computeGitBlobSha,
  normaliseLineEndings,
  isTextFile,
  buildCaseMap,
  detectCaseCollisions,
  shouldIgnorePath,
  buildCommitMessage,
  formatRelativeTime,
};
