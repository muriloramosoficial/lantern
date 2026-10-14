<div align="center">

# 🏮 Lantern

**A desktop workbench for the AI models you already use.**

Bring your own endpoint. Keep your keys on your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-f5a623.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4f8cff.svg)](#installation)
[![No telemetry](https://img.shields.io/badge/telemetry-none-52c98b.svg)](#privacy)

[English](README.en.md) · [Português](README.md)

</div>

---

## What it is

Lantern is an open-source desktop app for talking to language models with your own project files as
context — **no account, no license server, no telemetry**.

You point Lantern at whatever endpoint you want: a hosted API, a company gateway, a proxy or a local
server. Nothing is preconfigured, nothing is imported from other AI tools installed on the machine,
and the app makes no request of its own beyond the ones you trigger.

```text
┌──────────────────────────────────────────────┐
│  Lantern                                     │
│                                              │
│  provider  ──►  your endpoint  ──►  model    │
│  keys      ──►  OS keychain (DPAPI/Keychain) │
│  files     ──►  explicit, ticked context     │
└──────────────────────────────────────────────┘
```

## Features

| | |
|---|---|
| **Any endpoint** | Everything that speaks the OpenAI *chat completions* shape, plus the Anthropic Messages API and local servers (Ollama, LM Studio, llama.cpp, vLLM, …) |
| **Keys stay home** | Stored in the app's own settings file and sealed with the OS keychain when available; they never leave the machine and are never shown again once saved |
| **Context you control** | Pick a working folder and tick exactly which files are sent with the next message; large files are trimmed with a visible note |
| **Streaming** | Replies render as they arrive, with a stop button and timing |
| **Zero tracking** | No login, no license check, no telemetry, no phone home. Disconnect the network and keep chatting with a local model |
| **No build step** | Plain JavaScript UI, no bundler: `npm start` runs the source directly |

## Installation

### Windows — one line in PowerShell

```powershell
irm https://raw.githubusercontent.com/muriloramosoficial/lantern/main/scripts/install.ps1 | iex
```

Installs for the current user (no admin prompt), adds a Start Menu shortcut and puts the folder on
your `PATH`. Add `-Portable` for the portable build.

### Windows — `.exe` installer

Download `Lantern-Setup-x.y.z.exe` from [Releases](https://github.com/muriloramosoficial/lantern/releases).
Pick your install folder, or use the `Portable` build if you would rather not install anything.

### npm — cross-platform CLI

```bash
npm install -g lantern-desktop
lantern install     # download the latest release
lantern             # open the app
lantern status      # show the current installation
lantern open ./my-project   # launch with a workspace folder
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/muriloramosoficial/lantern/main/scripts/install.sh | bash
```

### From source

```bash
git clone https://github.com/muriloramosoficial/lantern.git
cd lantern
npm install
npm start          # open the app
npm test           # 27 core tests
npm run verify     # syntax check + tests
npm run dist       # build the .exe / AppImage / dmg
```

## Getting started

1. Open **Settings** (it opens by itself on first run) and click **New provider**.
2. Choose the endpoint type, or click a shortcut (OpenAI, OpenRouter, Groq, DeepSeek, Anthropic,
   Ollama, LM Studio, llama.cpp, vLLM…) and adjust the base URL.
3. Type the model name and, if the service needs one, your API key.
4. Click **Test connection**. If it answers, save it.
5. Choose a **workspace folder**, tick the files that matter and start talking.

Per-provider setup notes live in [docs/providers.md](docs/providers.md).

## Privacy

- No request is made to any third party other than the endpoint **you** registered.
- There is no license check, no sign-in, no usage counter and no telemetry.
- API keys live in the app's own settings file (`%APPDATA%\Lantern\settings.json` on Windows,
  `~/.config/Lantern/settings.json` on Linux, `~/Library/Application Support/Lantern/settings.json`
  on macOS). When the OS keychain is available they are encrypted with it, and the UI tells you
  which mode is active.
- The app never scans the machine for credentials or configuration belonging to other AI tools.
  A provider exists only after you create one.

## Architecture

```text
src/main/       Electron main process: window, IPC, persistence
  providers.js    HTTP adapters (OpenAI-compatible, Anthropic, Ollama, custom)
  settings.js     atomic JSON store, validation, redacted provider views
  secrets.js      local key store via safeStorage, explicit plain-text fallback
  workspace.js    file listing, safe reads, context assembly
src/preload/    contextBridge — the only surface exposed to the UI
src/renderer/   plain JavaScript UI (no framework, no bundler)
bin/            npm CLI (installs and launches the app)
scripts/        install.ps1, install.sh, icon generator, syntax check
test/           provider, settings and workspace tests (node --test)
```

Security model: the renderer runs with `contextIsolation`, `sandbox` and `nodeIntegration` off,
a restrictive CSP, and no network access of its own. Keys never cross the IPC bridge — the renderer
only ever receives `hasKey: true/false`.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first: tests
must pass (`npm run verify`) and new behaviour needs new tests.

Good first directions: new endpoint adapters, file search by name, locally saved conversation
history, applicable diffs from model responses.

## License

MIT © 2026 MuriloRP — see [LICENSE](LICENSE).
