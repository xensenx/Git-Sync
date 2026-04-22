/*
 * Direct GitHub Sync — Obsidian Plugin
 * main.js  (entry point — modular structure)
 *
 * Drop this folder alongside manifest.json and styles.css into:
 *   <vault>/.obsidian/plugins/direct-github-sync/
 * then enable it in Settings → Community Plugins.
 *
 * Module layout:
 *   main.js          — entry point (this file)
 *   constants.js     — DEFAULT_SETTINGS and all compile-time constants
 *   utils.js         — pure helpers: sleep, retry, parallelBatch, encoding, path/SHA/ignore utils
 *   github-client.js — GitHubClient REST wrapper
 *   modals.js        — ConflictResolutionModal, ConflictModal
 *   sync-engine.js   — buildSyncPlan, applyConflictResolutions, executeSyncPlan
 *   settings-tab.js  — DirectGitHubSyncSettingTab
 *   plugin.js        — DirectGitHubSyncPlugin (main Plugin class)
 */

"use strict";

const { DirectGitHubSyncPlugin } = require("./plugin");

module.exports = DirectGitHubSyncPlugin;
