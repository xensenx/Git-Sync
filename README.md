# Direct GitHub Sync for Obsidian

Direct GitHub Sync is an Obsidian plugin that allows you to push and pull your entire vault to and from a GitHub repository.

It operates entirely over the GitHub REST API, meaning it does not require a local Git installation or a Node.js environment. The plugin works natively on both desktop and Obsidian Mobile.

The current version focuses on a simple goal:  
**reliable, manual synchronization with clear behavior and explicit control.**

---

## Overview

This plugin provides a manual alternative to Obsidian Sync using GitHub as the storage and transport layer.

Instead of background automation, it gives you:

- explicit push and pull actions  
- clear conflict handling  
- predictable behavior across devices  

This makes it suitable both as a backup system and as a controlled multi-device workflow.

---

## Features

- **Manual Push & Pull**  
  Upload local changes or download remote changes explicitly. No automatic background sync.

- **Conflict Detection & Resolution**  
  When the same file is modified in multiple places, the plugin detects it and prompts you to:
  - Keep Local  
  - Keep Remote  
  - Keep Both (when possible)

- **Cross-Platform Support**  
  Works on desktop (Windows, macOS, Linux) and mobile (Android, iOS).

- **No Git or Node.js Required**  
  All operations are performed through the GitHub API.

- **Status Visibility**  
  The status bar reflects current state (synced, ahead, behind, diverged, syncing, etc.).

- **Ignore Rules**  
  Exclude files or folders from syncing using patterns.

---

## Important Note

This plugin has been tested across multiple devices and typical workflows.  
As with any sync system, edge cases may occur in more complex scenarios.

It is recommended to keep backups of your vault.

If you encounter any issues, please open a GitHub issue with as much detail as possible.

---

## Installation

This plugin is currently installed manually.

1. Download the latest build files:
   - `main.js`
   - `manifest.json`
   - `styles.css`

2. Open your vault folder.

3. Navigate to:
   `.obsidian/plugins/`

4. Create a new folder:
   `direct-github-sync`

5. Place the downloaded files inside it.

6. Restart Obsidian and enable the plugin from:
   **Settings → Community Plugins**

---

## Configuration

Before use, configure the connection inside plugin settings.

### 1. Create a GitHub Personal Access Token (PAT)

- Go to GitHub Settings  
- Open **Developer Settings → Personal Access Tokens → Tokens (classic)**  
- Generate a new token  
- Select scope: `repo`  
- Copy the token  

### 2. Configure the plugin

Inside Obsidian:

- Open plugin settings  
- Enter:
  - Personal Access Token  
  - GitHub username  
  - Repository name  
  - Branch (default: `main`)  

Save settings and test the connection.

---

## Usage

You can trigger actions by setting custom hotkeys in obsidian,
we recommend:


-`ctrl + Arrow up` or `ctrl + page up` for push

And 

-`ctrl + arrow down` or `ctrl + page down` for pull


(This ensures no hotkey conflicts occurs with other shortcuts)

or use.

- Ribbon icons

---

### Push to GitHub

Uploads local changes.

- Warns if remote has newer commits  
- Allows controlled overwrite when explicitly confirmed  

---

### Pull from GitHub

Downloads remote changes.

- Protects local modifications  
- Detects conflicts before applying changes  

---

### Conflict Handling

If both local and remote have changes:

- The plugin pauses  
- A resolution dialog appears  
- You choose how to proceed  

No automatic merging is performed.

---

## Limitations

- **File Size Limit**  
  Files larger than 50MB are skipped due to GitHub API limits.

- **Very Large Vaults**  
  Extremely large repositories may encounter API limitations (e.g., truncated trees).

---

## Planned Improvements

The following features are planned but not part of the current release:

- **Smart Sync**  
  A coordination layer that can decide when push or pull is safe to execute automatically.

- **Vault History / Time Travel**  
  A user-friendly way to navigate and restore previous states using Git history.

These will be built on top of the current manual system once it is fully stabilized.

---

## Support
If this project is useful to you, you can support development:

<div align="left">
  <a href="https://ko-fi.com/xensenx" target="_blank">
    <img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support me on Ko-fi" height="36" />
  </a>
</div>

---

## Final Note

This plugin is being built in stages.

The current version focuses on reliability and control.  
More advanced features will be added later, but only after the foundation is proven stable.

Push and pull are the core of the system. Everything else will build on top of that.
