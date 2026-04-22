# Direct GitHub Sync for Obsidian

Direct GitHub Sync is a zero-dependency Obsidian plugin that allows you to push, pull, and sync your entire vault with a GitHub repository. It operates entirely over the GitHub REST API, meaning it requires no local Git installation, no Node.js environment, and works flawlessly natively on both desktop and Obsidian Mobile (Android/iOS).

## Features

* **Cross-Platform Compatibility:** Works natively on Windows, macOS, Linux, Android, and iOS.
* **True Three-Way Sync:** Compares local file states, remote repository states, and a local cache to perform accurate bidirectional synchronization.
* **Conflict Resolution:** Built-in UI to handle merge conflicts. When a file is modified on both devices, a modal allows you to "Keep Local", "Keep Remote", or "Keep Both".
* **Smart Auto-Sync:** Automatically tracks vault activity and triggers a sync only after a configurable period of inactivity, saving battery and API calls.
* **Ignore Rules:** Supports wildcards and directory exclusions to prevent specific files (or the `.obsidian` configuration folder) from being uploaded to GitHub.
* **Status Indicators:** A comprehensive status bar element provides real-time feedback on sync state (e.g., local ahead, remote ahead, diverged, offline, syncing).
* **High Performance:** Utilizes the native WebCrypto API for fast, non-blocking local file hashing (SHA-1) to quickly determine file modifications.

## Installation

As this plugin is currently in development, it must be installed manually.

1.  Download the latest production build files: `main.js`, `manifest.json`, and `styles.css`.
2.  Navigate to your Obsidian vault directory.
3.  Open the hidden `.obsidian/plugins/` folder.
4.  Create a new folder named `direct-github-sync`.
5.  Place the three downloaded files into this new folder.
6.  Restart Obsidian, open **Settings > Community Plugins**, and enable "Direct GitHub Sync".

## Configuration

Before using the plugin, you must configure your connection settings in the plugin options.

### 1. Generating a GitHub Personal Access Token (PAT)
The plugin requires a GitHub PAT to authenticate and modify your repository.
1.  Log in to GitHub and navigate to **Settings > Developer settings > Personal access tokens > Tokens (classic)**.
2.  Click **Generate new token (classic)**.
3.  Give the token a descriptive name (e.g., "Obsidian Vault Sync").
4.  Under the "Scopes" section, check the box next to **repo** (Full control of private repositories).
5.  Generate the token and copy it immediately.

### 2. Plugin Setup
Open the Direct GitHub Sync settings inside Obsidian and click **Configure Connection**.
* **Personal Access Token:** Paste your generated token here.
* **GitHub Username:** The account that owns the repository.
* **Repository Name:** The name of the repository (e.g., `my-obsidian-vault`). If the repository is empty, the plugin will initialize it automatically.
* **Branch:** The target branch (defaults to `main`).

Click **Save Connection Settings** and then **Test Connection** to ensure everything is routed correctly.

## Usage

You can trigger actions using the Obsidian Command Palette (Ctrl+P / Cmd+P) or the ribbon icons on the left sidebar.

* **Sync Vault:** Performs a full bidirectional sync. Downloads remote changes, uploads local changes, and prompts you to resolve any conflicts.
* **Push to GitHub:** Uploads local changes only. If the remote repository has newer commits, the plugin will warn you before allowing a force-push.
* **Pull from GitHub:** Downloads remote changes only. The plugin will protect any files that have unpushed local edits from being overwritten.

### Smart Sync
If enabled in the settings, Smart Sync will monitor your vault for changes. After a specified period of inactivity (e.g., 5 minutes), it will silently check if a sync is necessary and execute it in the background. If a conflict is detected during a background sync, it will pause and notify you via the status bar to manually resolve it.

## Limitations

* **File Size Limit:** Due to GitHub REST API limitations, individual files larger than 50MB cannot be synced and will be automatically skipped.
* **Large Repositories:** While the plugin can handle standard vaults easily, repositories with over 100,000 files may experience tree truncation from the GitHub API.

## Development

If you wish to modify the source code, the project is structured modularly and bundled using `esbuild`.

### Setup
1.  Clone the repository to a local development folder.
2.  Run `npm install` to install development dependencies.

### Build Commands
* `npm run dev`: Starts `esbuild` in watch mode. Any changes saved to the `src/` directory will automatically recompile into the root `main.js` file.
* `npm run build`: Compiles a minified, production-ready `main.js` file for distribution.

## Support this Project by donating

<p align="center">
  <a href="https://ko-fi.com/xensenx">
    <img src="https://ko-fi.com" height="36" style="border:0px;height:36px;" alt="Support me on Ko-fi" />
  </a>
</p>


