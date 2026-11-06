# XorView v1 Build Spec

## 1. Goal

Build XorView v1: an original-code Electron overlay assistant for interviews.

v1 features: live microphone audio transcription plus on-screen context with AI answer suggestions, delivered through a stealth overlay with a global hide/show hotkey and a tray app.

Standing rules:

- ORIGINAL CODE ONLY. Installed reference apps were studied for observable features/behavior only. Never copy their binaries, code, or assets into this repo. Never extract or dump their `app.asar` files.
- Never `git commit` or `push` without explicit user authorization.
- Never put API keys or secrets in the repo. Keys come from user settings or environment variables only.

## 2. Research summary (installed apps, metadata only)

Both reference apps are per-user Electron installs. No app was launched for research except where already running; no code or assets were copied.

### Cluely v2.0.199

- Path: `%LOCALAPPDATA%\Programs\cluely-v2\Cluely.exe`
- Version: 2.0.199 (exe metadata, ProductName/Company `Cluely`).
- Electron evidence (metadata only): `LICENSE.electron.txt`, `LICENSES.chromium.html`, `resources/app.asar` (~29 MB), `app.asar.unpacked/`, `chrome_100/200_percent.pak`, `locales/`, `resources.pak`, `snapshot_blob.bin`, `ffmpeg.dll`, `libEGL/libGLESv2.dll`.
- Uninstall entry: HKCU `Cluely 2.0.199`; `Uninstall Cluely.exe` (~338 KB) in install dir.
- Start Menu shortcut: `Cluely.lnk` -> `Cluely.exe`, no shortcut hotkey, no CLI args.
- Autostart: enabled via `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `electron.app.Cluely`. No Startup-folder entry.
- Runtime: observed already running as ~10 processes (multi-process Electron); no launch performed.
- Updater: `resources/app-update.yml` (168 B) + `%LOCALAPPDATA%\cluely-v2-updater\installer.exe` (~229 MB) — Squirrel/electron auto-updater layout.
- Not verified: overlay window titles, tray behavior, in-app transcription/context/suggestion details. `Ctrl+\` hide hotkey is user-reported only, not independently verified.

### Klevi 0.8.0

- Path: `%LOCALAPPDATA%\Programs\Klevi\Klevi.exe` (shortcut target of `Klevi.lnk`, description "Your professional edge, right when you need it.").
- Version: 0.8.0 (`Klevi.exe` FileVersion 0.8.0; uninstall entry `Klevi 0.8.0`).
- Electron evidence (metadata only): `resources/app.asar` (~13.4 MB, never extracted), `LICENSE.electron.txt`, `LICENSES.chromium.html`, `chrome_100/200_percent.pak`, `resources.pak`, `icudtl.dat`, `locales/`, `ffmpeg.dll`, `snapshot_blob.bin`, `v8_context_snapshot.bin`.
- Sizes: `Klevi.exe` ~246 MB; `Uninstall Klevi.exe` ~208 KB.
- Config dirs: `%APPDATA%\Klevi` and `%APPDATA%\klevi`, Chromium-profile layout (Cache, Code Cache, GPUCache, Local Storage, Network, etc.) plus `settings.json` (668 B), `Preferences` (57 B), `Local State` (490 B), `.updaterId` (36 B). Contents not read.
- Updater: `resources/app-update.yml` (87 B) + `%LOCALAPPDATA%\klevi-updater\installer.exe` (~113 MB).
- No Klevi process running at check time. No autostart (absent from HKCU/HKLM Run, both Startup folders, scheduled tasks by name match). No `HKCU/HKLM\Software` app key matching `klevi`.
- Shortcut: empty Arguments, WorkingDirectory = install dir, no assigned hotkey.
- Static grep over Roaming Klevi `*.json/*.ini/*.config` (<200 KB) for hotkey/shortcut/globalShortcut terms returned zero matches. Hotkeys and overlay/tray behavior need a supervised launch or vendor docs.

### Design takeaways for XorView v1

- Framework: Electron, per-user install, Chromium-profile config under `%APPDATA%`.
- Distribution: installer + auto-updater layout (`app-update.yml` + updater cache) is the proven pattern; v1 can ship installer first and add auto-update later.
- Autostart should be a user setting (Cluely enables Run-key autostart; Klevi has none).
- Default hide/show hotkey: `Ctrl+\` (user-reported Cluely behavior; adopt as default, make it user-remappable).

## 3. Architecture (Electron main + renderer)

Original code. Suggested layout:

```text
xorview/
  SPEC.md
  package.json
  electron/
    main.ts        # BrowserWindow, tray, globalShortcut, capture exclusion, IPC
    preload.ts     # contextBridge: minimal safe IPC surface only
  renderer/
    index.html
    app.ts         # overlay UI: transcript, context, suggestions, settings
    styles.css
  core/
    audio.ts       # mic capture + transcription pipeline interface
    screen.ts      # screen-context capture interface
    providers.ts   # OpenAI-compatible chat/transcription client
    settings.ts    # settings load/save, env fallback, validation
```

### Main process responsibilities

- Create one frameless, always-on-top overlay `BrowserWindow`:
  - `frame: false`, `transparent: true` (or subtly opaque per theme), `alwaysOnTop: true`.
  - Standard stealth only: `setContentProtection(true)` / content-protection on (excluded from screen capture where the platform supports it).
  - No taskbar presence for the overlay: `skipTaskbar: true`.
- Tray app: `Tray` with context menu (Show/Hide, Start/Pause listening, Settings, Quit). No dock/taskbar icon beyond the tray.
- Global hotkey: `globalShortcut.register('CommandOrControl+\\', toggleOverlay)` by default; re-register on settings change; unregister on quit. Must handle registration failure gracefully (show message in settings, keep tray toggle working).
- Mic and screen capture orchestration: request OS permissions via normal Electron/Chromium flows; never use kernel/driver tricks.
- IPC: narrow, explicit channels only (e.g. `xorview:toggle`, `xorview:transcript-append`, `xorview:suggestion`, `xorview:settings-get/set`). No raw `ipcRenderer.send` passthrough; `contextIsolation: true`, `nodeIntegration: false`.
- Settings persistence: JSON under `app.getPath('userData')`. Secrets stored only if the user opts in, via OS-safe storage; otherwise session-only + env fallback.

### Renderer process responsibilities

- Overlay UI: compact panel with tabs or stacked sections:
  1. Transcript (live mic transcription, scrolling).
  2. Context (latest on-screen context summary / captured text).
  3. Suggestions (AI answer suggestions list).
  4. Settings entry point.
- Draggable overlay, resizable within limits, click-through toggle optional.
- No Node access; talks to main only through the preload bridge.

## 4. v1 Features

1. Stealth overlay window.
   - Frameless, always-on-top, `skipTaskbar`, content-protection enabled.
   - Show/hide instantly; state survives toggle (no data loss).
2. Global hide/show hotkey, default `Ctrl+\` (`CommandOrControl+\`).
   - User-remappable in settings; persisted.
   - Tray menu Show/Hide always works as a fallback.
3. Tray app.
   - Tray icon + menu: Show/Hide, Start/Pause, Settings, Quit.
   - No taskbar presence for the overlay window.
4. Mic transcription.
   - Capture default microphone, stream to the configured transcription provider.
   - Append timestamped segments to the transcript view; keep a bounded in-memory buffer (e.g. last N segments) plus optional local log file.
   - Start/Pause control in tray menu and overlay.
5. Screen context.
   - Periodically capture on-screen context (screenshot and/or accessible window text where available through public Electron/Chromium APIs).
   - Summarize or extract salient text for the Context pane; never interfere with other software.
   - User-configurable interval + manual "Capture now" button; pause control.
6. AI suggestions.
   - Combine recent transcript + screen context into a prompt; request suggestions from the configured chat provider.
   - Render suggestion cards; allow copy-to-clipboard per suggestion.
   - Manual "Suggest" button + optional auto-refresh (default off or low frequency to control cost).
7. Settings.
   - Hotkey remap, autostart toggle, mic device select, transcription language (if supported), screen-capture interval, provider endpoints + model names, suggestion mode (manual/auto), theme/opacity, data retention (buffer size, clear buttons).
   - Validation with inline errors; test-connection button for providers.

## 5. Provider design (configurable OpenAI-compatible endpoints)

- Two provider slots: `transcription` and `chat`. Each slot configures:
  - `baseUrl` (OpenAI-compatible endpoint, user-editable; defaults to the public OpenAI-compatible base).
  - `model` (user-editable string).
  - `apiKey`: from user settings input or environment variable only. Setting key precedence: explicit settings value > `XORVIEW_OPENAI_API_KEY` (or slot-specific `XORVIEW_TRANSCRIBE_API_KEY` / `XORVIEW_CHAT_API_KEY`) > none.
- No keys in the repo, logs, or committed fixtures. Mask keys in UI (password input) and never log them.
- HTTP client: `fetch` from the main process with timeout + retry (bounded, e.g. 2 retries) and clear error surfacing (auth failure, network failure, bad model/endpoint).
- Offline behavior: transcription and suggestions show explicit "provider unreachable / key missing" states; overlay and tray keep working.

## 6. Stealth scope (STANDARD techniques only)

In scope:

- Overlay excluded from screen capture via public Electron content-protection APIs.
- Global hide/show hotkey (default `Ctrl+\`).
- Tray-based presence with no taskbar entry for the overlay.

Explicitly out of scope (do not implement):

- Kernel or driver tricks.
- Hiding from process lists / task managers.
- Interfering with any other software (input injection into other apps, hooking, disabling capture in other processes, tampering with conferencing/anti-cheat/proctoring tools).

## 7. Run and build instructions outline

Prerequisites: Node.js LTS + npm (pin versions in `package.json` `engines`).

```sh
cd xorview
npm install
npm run dev        # Electron + renderer with hot reload
npm run typecheck  # static checks
npm run test       # unit tests for core/ (providers, settings)
npm run dist       # packaged per-user installer (electron-builder or equivalent)
```

- `npm run dev` must start with no API key configured and show the settings screen with provider errors clearly indicated.
- `npm run dist` output: per-user Windows installer + uninstaller; no secrets bundled.
- Future: add `app-update.yml` + published releases for auto-update (same layout observed in both reference apps).

## 8. Acceptance criteria (v1)

- Overlay shows/hides via `Ctrl+\` by default and via tray menu.
- Overlay has no taskbar entry and requests content protection.
- Mic transcription appends live segments; Start/Pause works.
- Screen context captures on demand and on interval; Context pane updates.
- AI suggestions render from transcript + context; copy works; missing-key/offline states are explicit.
- Settings persist across restarts (except intentionally session-only secrets).
- No secrets in the repo; no reference-app code, binaries, or assets present.
