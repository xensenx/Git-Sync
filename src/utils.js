"use strict";

const { MAX_RETRIES, RETRY_DELAY_MS } = require("./constants");

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

module.exports = {
  sleep,
  withRetry,
  parallelBatch,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  normalisePath,
  computeGitBlobSha,
  shouldIgnorePath,
  buildCommitMessage,
  formatRelativeTime,
};
