"use strict";

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
  // filepath -> blob SHA of the last successful sync (the "base" state for conflict detection)
  syncCache: {},
  // Remote commit SHA we last synced against
  lastKnownRemoteCommit: "",
  // Timestamp (ms) of last successful push or pull
  lastSyncTime: 0,
};

const GITHUB_API       = "https://api.github.com";
const MAX_RETRIES      = 2;
const RETRY_DELAY_MS   = 2500;
const MAX_FILE_SIZE          = 50 * 1024 * 1024; // 50 MB — GitHub blob limit
const STATUS_POLL_MS         = 120_000;          // passive remote-check interval (2 min)
const RATE_LIMIT_BACKOFF_MS  = 5_000;            // wait before retrying after a rate-limit 403
const MAX_TREE_ENTRIES       = 100_000;          // GitHub tree API hard limit

module.exports = {
  DEFAULT_SETTINGS,
  GITHUB_API,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  MAX_FILE_SIZE,
  STATUS_POLL_MS,
  RATE_LIMIT_BACKOFF_MS,
  MAX_TREE_ENTRIES,
};
