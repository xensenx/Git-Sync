/*
 * Direct GitHub Sync — Obsidian Plugin
 * main.js  (entry point)
 *
 * Drop the entire folder into:
 *   <vault>/.obsidian/plugins/direct-github-sync/
 * then enable it in Settings → Community Plugins.
 *
 * Module layout:
 *   main.js              — entry point (this file)
 *   constants.js         — DEFAULT_SETTINGS and compile-time constants
 *   utils.js             — pure helpers: retry, parallelBatch, SHA, path, encoding
 *   github-client.js     — GitHubClient REST wrapper
 *   conflict-resolver.js — buildDiffPlan(), applyResolutions() (three-way logic)
 *   modals.js            — ConflictResolutionModal, ForcePushModal
 *   push.js              — executePush() — full push operation
 *   pull.js              — executePull() — full pull operation
 *   status-bar.js        — StatusBar — passive remote poll + status bar UI
 *   settings-tab.js      — DirectGitHubSyncSettingTab
 *   plugin.js            — DirectGitHubSyncPlugin (main Plugin class)
 */

"use strict";

const { DirectGitHubSyncPlugin } = require("./plugin");

module.exports = DirectGitHubSyncPlugin;
