# XorView v2

XorView is an original-code Electron overlay assistant for interviews: live
microphone transcription plus on-screen context with AI answer suggestions,
delivered through a standard-stealth overlay with a global hide/show hotkey
and a tray app.

Full build spec: [SPEC.md](SPEC.md).

## Features (v2)

- Frameless always-on-top overlay: content protection, no taskbar entry,
  Alt+Tab tool-window exclusion, discreet window title, focus-safe
  `showInactive` show, optional start-hidden.
- Global hide/show hotkey, default `Ctrl+\` (remappable, tray fallback,
  inline errors that never yank tabs).
- Tray menu: Show/Hide, Start/Pause listening, Capture now, Click-through
  on/off (escape hatch), Settings, Quit. Capture failures raise a tray
  balloon plus a gap marker — never silent. Showing the overlay always
  turns click-through back off, and a Quit button in the titlebar exits
  fully.
- Mic transcription via a configurable OpenAI-compatible endpoint: upload
  queue with visible depth (no silent drops), voice-activity gate that
  skips silent clips, configurable clip length, mime-matched upload
  filenames, single-sourced listening state with generation tokens (no mic
  leaks), coded errors with next actions, optional local transcript log.
- Local transcription via VoiceStudio (optional): point the transcription
  provider at a user-run VoiceStudio backend (default
  `http://localhost:3900`, model `whisper-1`) for fully-local speech to
  text with no API key. Health-checked via "Test transcription"; the chat
  slot stays on its hosted provider.
- Screen context on interval plus manual "Capture now": aspect-correct
  thumbnails, extracted-text notes, per-item delete, memory cap with
  oldest-first eviction — and the latest screenshot image is actually sent
  to the AI.
- AI suggestion cards with copy buttons: fusion of rolling transcript
  (bounded buffer + rolling summary, no truncation cliff) with screen
  context (image + text), interviewer-question detection, manual trigger
  by default with question-gated auto mode (debounced, in-flight-guarded),
  interview-type awareness, language matching, short history, MMR
  rank/dedup, per-slot missing-key/offline states, and optional grounding
  in your confirmed candidate profile (name, headline, résumé facts,
  skills, STAR stories, target job description) with "From your profile"
  / "General" card labels. A PDF CV upload fills name, facts, and
  skills automatically (parsed locally, page-capped).
- Settings: hotkey, autostart, start-hidden, mic, language, clip length,
  VAD gate, capture interval, provider endpoints/models, suggestion mode,
  interview type, theme, opacity, buffer size, transcript log, and an
  explicit remember-keys opt-in (keys are session-only by default).
  Corrupt settings back up and notify instead of silently resetting.

Stealth scope is STANDARD only: capture exclusion, hotkey, tray with no
taskbar presence, taskbar and Alt+Tab exclusion, focus behavior.
Out of scope: kernel/driver code, hiding from process lists or task
managers, and interfering with or evading any other software.

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
transcription and suggestions show explicit per-slot "key missing /
unreachable" states until a provider is configured.

API keys come from Settings or environment variables only (never the repo):

- `XORVIEW_TRANSCRIBE_API_KEY` / `XORVIEW_CHAT_API_KEY` (slot-specific), or
- `XORVIEW_OPENAI_API_KEY` (shared fallback).

Explicit settings values win over environment variables. Unless "Remember
keys on this device" is checked, keys stay in memory for the session and
are never written to disk.

### Local transcription with VoiceStudio (optional)

Install and start VoiceStudio separately (see the
[VoiceStudio releases](https://github.com/debpalash/VoiceStudio/releases/latest)
or run it from source), then in XorView Settings set the transcription
provider to "Local VoiceStudio". Defaults target `http://localhost:3900`
with model `whisper-1`; no API key is needed for a local backend
(protected deployments still use the transcription key). "Test
transcription" checks the backend health endpoint. No VoiceStudio code is
bundled with XorView — the app talks to your backend over HTTP only
(`core/voicestudio.js`).

## Scripts

| Command           | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `npm start`       | Launch the Electron app                                              |
| `npm run dev`     | Same as start (no-key friendly)                                      |
| `npm run lint`    | Syntax-check all JS, secret scan, .gitignore check                  |
| `npm run build`   | Validate packaging config + required files + lint                    |
| `npm test`        | Unit tests (core, scripts) + main stub harness + renderer harness    |
| `npm run smoke`   | Launch, assert the renderer loaded, quit (needs a display)           |
| `npm run dist`    | Per-user Windows installer via electron-builder                      |
| `npm run make-icon` | Regenerate the original tray/installer icons                       |

Smoke test (launches, verifies startup, quits by itself):

```sh
npm start -- --smoke
```

In sandboxes without a display, Chromium cannot launch, so behavior is
proven with `npm test` (node unit tests plus stub/DOM harnesses) and
`npx electron-builder --dir` for packaging.

## Project layout

```text
xorview/              (repo root)
  SPEC.md            v2 build spec
  package.json       scripts + electron-builder config
  electron/main.js   window, tray, hotkey, capture, IPC
  electron/preload.js  minimal contextBridge surface (live channels only)
  renderer/          overlay UI (index.html, app.js, styles.css)
  core/              settings, providers, screen, audio, suggest, voicestudio, profile, cv (+ tests)
  scripts/           lint, build gate, icon generator, smoke (+ tests)
  test/              main-process stub harness, renderer DOM harness
  assets/            generated original icons (tray.png, icon.png, icon.ico)
  .agents/skills/voicestudio/  VoiceStudio agent skill (upstream text) + XorView notes
```

## Original-code note

Reference apps installed on this machine were studied for observable
features/behavior only. No binaries, code, or assets were copied into this
repo. Never commit API keys: `.gitignore` excludes `node_modules/`, `dist/`,
`.env*`, and key files, and `npm run lint` fails on secret patterns.
