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

module.exports = {
  DEFAULT_SETTINGS,
  GITHUB_API,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  MAX_SYNC_FILE_SIZE,
  PASSIVE_POLL_INTERVAL_MS,
};
