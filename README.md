# XorView v1

XorView is an original-code Electron overlay assistant for interviews: live
microphone transcription plus on-screen context with AI answer suggestions,
delivered through a stealth overlay with a global hide/show hotkey and a
tray app.

Full build spec: [SPEC.md](SPEC.md).

## Features (v1)

- Frameless always-on-top overlay (`skipTaskbar`, content protection).
- Global hide/show hotkey, default `Ctrl+\` (remappable, tray fallback).
- Tray menu: Show/Hide, Start/Pause listening, Capture now, Settings, Quit.
- Mic transcription via a configurable OpenAI-compatible endpoint.
- Screen-context captures on interval plus manual "Capture now".
- AI suggestion cards with copy buttons (manual or auto-refresh).
- Settings: hotkey, autostart, mic, language, interval, providers, theme,
  opacity, buffer size, test-connection buttons.

Stealth scope is STANDARD only: content protection, hotkey, tray presence.
Out of scope: drivers, process hiding, and interference with other software.

## Prerequisites

- Node.js LTS (>= 18) and npm (>= 9).
- A display (the overlay is a GUI window).
- Optional: API key(s) for an OpenAI-compatible transcription/chat provider.

## Run

```sh
npm install
npm start
```

On first run with no API key configured, the app opens on the Settings tab
and shows which keys are missing. The overlay and tray keep working offline;
transcription and suggestions show explicit "key missing / unreachable"
states until a provider is configured.

API keys come from Settings or environment variables only (never the repo):

- `XORVIEW_TRANSCRIBE_API_KEY` / `XORVIEW_CHAT_API_KEY` (slot-specific), or
- `XORVIEW_OPENAI_API_KEY` (shared fallback).

Explicit settings values win over environment variables.

## Scripts

| Command           | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `npm start`       | Launch the Electron app                            |
| `npm run dev`     | Same as start (no-key friendly)                    |
| `npm run lint`    | Syntax-check all JS, secret scan, .gitignore check |
| `npm run build`   | Validate packaging config + required files + lint  |
| `npm test`        | Unit tests for `core/` (settings, providers, screen) |
| `npm run dist`    | Per-user Windows installer via electron-builder    |

Smoke test (launches, verifies startup, quits by itself):

```sh
npm start -- --smoke
```

## Project layout

```text
xorview/              (repo root)
  SPEC.md            build spec
  package.json       scripts + electron-builder config
  electron/main.js   window, tray, hotkey, capture, IPC
  electron/preload.js  minimal contextBridge surface
  renderer/          overlay UI (index.html, app.js, styles.css)
  core/              settings, providers, screen, audio (+ tests)
  scripts/           lint, build gate, icon generator
  assets/            generated original icons
```

## Original-code note

Reference apps installed on this machine were studied for observable
features/behavior only. No binaries, code, or assets were copied into this
repo. Never commit API keys: `.gitignore` excludes `node_modules/`, `dist/`,
`.env*`, and key files, and `npm run lint` fails on secret patterns.
