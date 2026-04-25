# Direct GitHub Sync

<p align="left">
  <img src="https://img.shields.io/badge/Obsidian-Plugin-7C3AED?style=flat&logo=obsidian&logoColor=white" />
  <img src="https://img.shields.io/badge/Platform-Desktop%20%2B%20Mobile-0EA5E9?style=flat" />
  <img src="https://img.shields.io/badge/Sync-Manual-16A34A?style=flat" />
</p>

Sync your Obsidian vault with GitHub — without Git, without a local setup, and with full control over what happens.

Direct GitHub Sync is built around a simple idea:
**synchronization should be explicit, predictable, and transparent.**

---

## Why this plugin exists

Most Git-based workflows inside Obsidian assume:

* a local Git installation
* familiarity with commits, merges, and conflicts
* a desktop-only environment

This plugin takes a different approach:

* No Git required
* Works on mobile
* Uses GitHub as a storage and transport layer
* Prioritizes clarity over automation

It is designed for users who want control over synchronization without managing a full Git workflow.

---

## Features

### Manual Push & Pull

You decide when changes move.

* Push uploads your local vault to GitHub
* Pull downloads remote changes to your vault
* No background sync or hidden operations

---

### Conflict Detection & Resolution

When the same file changes in multiple places:

* Sync pauses automatically
* A resolution dialog appears
* You choose:

  * Keep Local
  * Keep Remote
  * Keep Both (when possible)

No automatic merging is performed.

---

### Cross-Platform Support

* Desktop: Windows, macOS, Linux
* Mobile: Android and iOS

The plugin works the same way across all platforms.

---

### Status Visibility

A status indicator shows the current state of your vault:

* Synced
* Local changes pending
* Remote changes available
* Diverged state
* Errors or offline mode

---

### Ignore Rules

Exclude files or folders using simple patterns.

Useful for:

* large files
* generated content
* private notes

---

## How it works

The plugin communicates directly with the GitHub REST API.

* Files are uploaded and downloaded as blobs
* Repository state is tracked using commits and trees
* No Git CLI or Node.js environment is required

---

## Security

* Your GitHub Personal Access Token (PAT) is stored locally in Obsidian
* It is only used to communicate with GitHub’s API
* No data is sent to any third-party servers

Treat your token like a password. Do not share it.

---

## Data Safety

This plugin can modify both local and remote files.

* Always keep backups of your vault
* Review conflicts before applying changes
* Avoid forcing overwrites unless necessary

The system is designed to be safe, but incorrect usage can still lead to data loss.

---

## Installation

### From Community Plugins (recommended)

1. Open **Settings → Community Plugins**
2. Disable Safe Mode
3. Search for **Direct GitHub Sync**
4. Install and enable

---

### Manual Installation

1. Download the latest release files:

   * `main.js`
   * `manifest.json`
   * `styles.css`

2. Place them in:

   `.obsidian/plugins/direct-github-sync/`

3. Restart Obsidian and enable the plugin

---

## Configuration

### 1. Create a GitHub Personal Access Token

* Go to GitHub → Settings
* Open **Developer Settings → Personal Access Tokens (classic)**
* Generate a token
* Enable scope: `repo`

---

### 2. Configure the plugin

Enter the following in plugin settings:

* Personal Access Token
* GitHub username
* Repository name
* Branch (default: `main`)

Save and verify the connection.

---

## Usage

You can trigger actions using:

* Command palette
* Ribbon icons
* Custom hotkeys

Suggested hotkeys:

* Push: `Ctrl + ↑` or `Ctrl + Page Up`
* Pull: `Ctrl + ↓` or `Ctrl + Page Down`

---

### Push

* Uploads local changes
* Warns if remote has newer commits
* Allows controlled overwrite when confirmed

---

### Pull

* Downloads remote changes
* Preserves local modifications
* Detects conflicts before applying changes

---

## Limitations

* Files larger than 50 MB are skipped (GitHub API limit)
* Very large vaults may hit repository tree limits
* Requires a stable internet connection

---

## Planned Improvements

* Smart sync coordination
* Vault history and rollback tools
* Improved handling for large repositories

---

## Support

If this plugin is useful to you:

<p>
  <a href="https://ko-fi.com/xensenx">
    <img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support on Ko-fi" />
  </a>
</p>

---

## Final Notes

This project is being developed in stages.

The current focus is reliability and explicit control.
More advanced features will be added only after the core system is stable.
