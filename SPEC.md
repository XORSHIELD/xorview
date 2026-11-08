# XorView v2 Build Spec (full rebuild)

## 1. Goal

Rebuild XorView v2 from scratch as original-code Electron overlay assistant for interviews: live microphone audio transcription plus on-screen context with AI answer suggestions, delivered through a hardened standard-stealth overlay with a global hide/show hotkey and a tray app.

v2 is a full rebuild, not a patch of v1. It fixes every confirmed v1 defect (Section 3), makes context fusion and suggestions smarter (Section 5), hardens standard stealth (Section 7), and ships with a real test plan (Section 9).

Standing rules:

- ORIGINAL CODE ONLY. Installed reference apps were studied for observable features/behavior only. Never copy their binaries, code, or assets into this repo. Never extract or dump their `app.asar` files.
- Never `git commit` or `push` — the user handles git.
- Never put API keys or secrets in the repo. Keys come from user settings or environment variables only.
- Stealth STANDARD ONLY: capture exclusion, hide hotkey, tray with no taskbar presence, taskbar and Alt+Tab exclusion, focus behavior. Out of scope: kernel or driver code, hiding from process lists or task manager, interfering with or evading any other software.
- Work entirely inside the workspace. Sandbox limits: Chromium cannot launch, so prove behavior with node unit tests plus stub and jsdom harnesses plus packaging; npm needs a workspace-local cache.

## 2. Research summary (installed apps, metadata only) — kept from v1

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
- Version: 0.8.0 (`Klevi.exe` FileVersion 0.8.0; shortcut description "Your professional edge, right when you need it.").
- Electron evidence (metadata only): `resources/app.asar` (~13.4 MB, never extracted), `LICENSE.electron.txt`, `LICENSES.chromium.html`, `chrome_100/200_percent.pak`, `resources.pak`, `icudtl.dat`, `locales/`, `ffmpeg.dll`, `snapshot_blob.bin`, `v8_context_snapshot.bin`.
- Sizes: `Klevi.exe` ~246 MB; `Uninstall Klevi.exe` ~208 KB.
- Config dirs: `%APPDATA%\Klevi` and `%APPDATA%\klevi`, Chromium-profile layout (Cache, Code Cache, GPUCache, Local Storage, Network, etc.) plus `settings.json` (668 B), `Preferences` (57 B), `Local State` (490 B), `.updaterId` (36 B). Contents not read.
- Updater: `resources/app-update.yml` (87 B) + `%LOCALAPPDATA%\klevi-updater\installer.exe` (~113 MB).
- No Klevi process running at check time. No autostart (absent from HKCU/HKLM Run, both Startup folders, scheduled tasks by name match). No `HKCU/HKLM\Software` app key matching `klevi`.
- Shortcut: empty Arguments, WorkingDirectory = install dir, no assigned hotkey.
- Static grep over Roaming Klevi `*.json/*.ini/*.config` (<200 KB) for hotkey/shortcut/globalShortcut terms returned zero matches. Hotkeys and overlay/tray behavior need a supervised launch or vendor docs.

### Design takeaways for XorView (carried into v2)

- Framework: Electron, per-user install, Chromium-profile config under `%APPDATA%`.
- Distribution: installer + auto-updater layout (`app-update.yml` + updater cache) is the proven pattern; v2 ships installer first, auto-update later.
- Autostart is a user setting (Cluely enables Run-key autostart; Klevi has none).
- Default hide/show hotkey: `Ctrl+\` (user-reported Cluely behavior; adopt as default, make it user-remappable).

### v2 technique research (public sources only, original code)

- Capture exclusion: `win.setContentProtection(true)` maps to `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`; Win10 2004+ removes the window from capture entirely, older builds render it black; takes effect at next composition ([Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window), [SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)).
- Taskbar exclusion: `skipTaskbar` option + `win.setSkipTaskbar(skip)`; `focusable:false` implies `skipTaskbar:true` on Windows ([BaseWindow](https://www.electronjs.org/docs/latest/api/base-window)).
- Focus control: `focusable` option + `win.setFocusable()`; `showInactive()` shows without stealing focus ([BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)).
- Click-through: `win.setIgnoreMouseEvents(ignore, {forward:true})` passes mouse to the window below; keyboard still received if focused ([BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)).
- Overlay: `frame:false` + `transparent:true` (frameless required for transparency on Windows), `setAlwaysOnTop(flag, 'floating')` default level sits below taskbar ([BaseWindow](https://www.electronjs.org/docs/latest/api/base-window)).
- Tray: `new Tray(icon)` + `Menu.buildFromTemplate` + `tray.setContextMenu`; keep app alive on window-all-closed ([tray tutorial](https://www.electronjs.org/docs/latest/tutorial/tray), [Tray](https://www.electronjs.org/docs/latest/api/tray)).
- Hide hotkey: `globalShortcut.register(accelerator, cb)` works without focus, silently fails if taken; verify with `isRegistered`; unregister on quit ([global-shortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)).
- Discreet naming: electron-builder `productName` (display/installer name) and `executableName` (binary name) ([electron.build configuration](https://www.electron.build/docs/configuration/)).
- Context fusion: merge realtime transcript + screen state into one prompt via a trigger detector + context builder pipeline; detect interviewer questions/keywords/objections as suggestion cards; manual-trigger answers by default with optional auto mode; two-stage rank (cheap candidates, small-model rerank ~top 50), MMR dedup, conditional retrieval only when external facts are needed.
- Latency vs cost: streaming STT carries a 3x-5x infra premium over batch; VAD + dense batching is ~10x cheaper; voice UX budget is sub-second time-to-first-audio, >1.5-2s feels broken; prefer raw snippets over composed answers to trim latency and cost. Vendor figures are date-sensitive — re-measure at build time.

## 3. Confirmed v1 defects (must all be fixed in v2)

Source: static audit of the v1 tree. Severity-ordered.

### P0 — core feature gaps

1. Screenshot content never reached the AI: the suggest prompt received only capture timestamp/source/count, and `note` was always `''` (no OCR, no text extraction). Screen context did not inform suggestions at all.
2. API keys persisted in plaintext JSON always, contradicting the opt-in safe-storage rule.
3. Transcription silently dropped clips while a request was in flight (no queue) — with 10s clips and slow requests most audio was lost without indication.
4. Tray/renderer listening state desynced on mic failure (renderer set `listening=false` locally, never notified main; tray still showed Pause).
5. Stop-during-start raced: `getUserMedia` resolving after stop started an orphaned recorder and leaked the mic until the next toggle.
6. Show stole focus from the interview app (`show()` + `focus()` on every hotkey show).

### P1 — real bugs / UX traps

7. `core/audio.js` was entirely dead code; the renderer reimplemented recorder logic inline with different mime candidates, untested.
8. Click-through ON made the overlay unclickable with no tray/menu escape (hotkey only hides; trap if hotkey forgotten).
9. Clear local data left the old screenshot visible (pane only re-rendered when a latest entry existed).
10. `loadSettings` never validated — corrupt values used as-is (e.g. negative `bufferSize` dropped the entire transcript).
11. Transcription filename hardcoded `clip.webm` even when mimeType was `audio/mp4` (OpenAI uses the extension for format detection).
12. Secret scan covered only private keys and `AKIA` — no `sk-`/OpenAI or generic api-key patterns despite the app handling those keys.
13. Windows target had no icon configured; installer got the default Electron icon.

### P2 — hardening / robustness

14. `withRetry` retried immediately with no delay/backoff on 429/5xx/timeout.
15. Auto-suggest refired every 60s fixed even with no new transcript (duplicated cost); no in-flight guard, so slow requests overlapped.
16. `requestSuggestions` had no concurrency guard — double-clicking Suggest overlapped requests, last-write-wins render.
17. Scheduled capture failures swallowed silently (no log) — silent gaps in context history.
18. Transcription errors showed only the code, no message/action — user could not distinguish missing-key from network failure.
19. Settings merge honored `__proto__`/`constructor` keys — in-memory prototype pollution.
20. Smoke mode quit with "smoke OK" unconditionally — never checked `did-fail-load`, so it always passed.
21. No tool-window type for Alt+Tab exclusion — `skipTaskbar` alone left Alt+Tab presence unverified/unhandled.
22. Window title was `XorView` — visible in Alt+Tab/task listings; no discreet-title consideration.
23. `webPreferences` omitted `sandbox:true` despite no Node need in the renderer.
24. Tray "Capture screen now" discarded failures — no user feedback.
25. `transcribe-audio` IPC `Buffer.from` had no size cap — unbounded renderer payload.
26. `test-connection` treated any slot value other than `transcribe` as chat — no slot validation.
27. `registerHotkey` with a non-string accelerator returned false silently without notifying the renderer.
28. Corrupt settings JSON fell back to defaults silently — user never told, next save destroyed the file.
29. Explicit key returned untrimmed — pasted key with trailing newline caused avoidable auth failures.
30. Success-path `res.json()` SyntaxError uncoded — non-JSON 200 surfaced as a raw provider error.
31. Thumbnail assumed 16:9 — distorted on portrait/ultrawide displays.
32. Fixed 10s transcription clips — up to 10s+ latency, silence transcribed wastefully, no voice-activity awareness.
33. `transcriptExcerpt` hard-capped at 4000 chars with front truncation — long interviews lost early context, no rolling summary.
34. Single fixed suggest system prompt — no conversation history, interview-type awareness, or language matching.
35. Null-response branches accessed `res.error` (TypeError masked by outer catch).
36. Suggestion line regex stripped meaningful leading numbers (e.g. "3 tips" became "tips").
37. Key banner wording claimed both features need keys even when only one key was missing.
38. Hotkey error yanked the user to the settings tab — disruptive mid-interview.
39. Contexts capped at 20 full PNG data URLs with no per-item delete — tens of MB retained, no purge except clear-all.
40. `xorview:transcript` / `xorview:suggestion` preload channels exposed but never emitted by main — dead surface.
41. Build script `JSON.parse` of package.json unguarded — corrupt file crashed with a stack trace instead of clean FAIL.
42. `make-icon.js` ran on require (no `require.main` guard) — importing it wrote files as a side effect.
43. Test script covered only settings/providers/screen — no audio, renderer, main/preload, prompt, or script tests.
44. `build.files` shipped `*.test.js` inside the packaged app.
45. SPEC referenced TypeScript (`.ts`) and `npm run typecheck` but the implementation was plain JS — doc drift.
46. Optional local transcript log file unimplemented — restart or Clear lost all transcript.
47. No `.idle` rule and no focus-visible styles — minor a11y/polish gap.
48. Overlay always showed on ready-to-show — no start-hidden option for stealth startup.

Not verifiable without launching Electron (Chromium cannot launch in this sandbox; must be verified on a real Windows target): actual Alt+Tab visibility, `setContentProtection` effectiveness, hotkey conflict handling, mic permission flows, `desktopCapturer` source names on localized Windows, tray icon DPI rendering, installer output.

## 4. Architecture v2 (Electron main + renderer, plain JS)

Implementation language is plain JavaScript with JSDoc types (no TypeScript, no `typecheck` script — fixes defect 45). Suggested layout:

```text
xorview/
  SPEC.md
  package.json
  electron/
    main.js        # BrowserWindow, tray, globalShortcut, capture exclusion, IPC
    preload.js     # contextBridge: minimal safe IPC surface only
  renderer/
    index.html
    app.js         # overlay UI: transcript, context, suggestions, settings
    styles.css
  core/
    audio.js       # SINGLE recorder implementation used by the renderer (fixes defect 7)
    screen.js      # screen-context capture + aspect-correct thumbnails + OCR/text hook
    providers.js   # OpenAI-compatible chat/transcription client
    settings.js    # settings load/save, env fallback, validation, safe storage
    suggest.js     # NEW: fusion, question detection, prompt build, rank/dedup
    profile.js     # candidate-profile parsing + confirmed-facts prompt block
  scripts/
    build.js       # guarded packaging checks (fixes defect 41)
    lint.js        # secret scan incl. sk-/OpenAI patterns (fixes defect 12)
    make-icon.js   # require.main-guarded icon generation (fixes defect 42)
    smoke.js       # asserts did-fail-load (fixes defect 20)
```

### Main process responsibilities

- Create one frameless, always-on-top overlay `BrowserWindow`:
  - `frame:false`, `transparent:true`, `alwaysOnTop` level `floating`.
  - Standard stealth: `setContentProtection(true)`; `skipTaskbar:true`; `focusable:false` default (implies skipTaskbar on Windows, enables click-through-friendly overlay); tool-window type for Alt+Tab exclusion; discreet window title (not the product name); `showInactive()` on toggle-show so focus stays in the interview app (fixes defects 6, 21, 22).
  - Start-hidden option: when enabled, do not show on `ready-to-show` (fixes defect 48).
  - `webPreferences`: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true` (fixes defect 23).
- Tray app: `Tray` with context menu (Show/Hide, Start/Pause listening, Capture screen now, click-through toggle escape, Settings, Quit). No taskbar presence. Tray is the escape hatch when click-through hides overlay controls (fixes defect 8). Capture failures surface a tray balloon/dialog, never silent (fixes defect 24).
- Global hotkey: `globalShortcut.register(hotkey, toggleOverlay)` default `CommandOrControl+\`; re-register on settings change; unregister on quit; verify with `isRegistered`; non-string accelerator notifies the renderer with an inline, non-disruptive error (fixes defects 27, 38). Registration failure keeps the tray toggle working and shows a message in settings.
- Mic and screen capture orchestration via normal Electron/Chromium flows only; no kernel/driver tricks.
- IPC: narrow, explicit channels only. Every preload-exposed channel must have a main-side handler or emitter — no dead surface (fixes defect 40). `Buffer` payloads size-capped (e.g. 15 MB; fixes defect 25). Slot arguments validated against `transcribe|chat` (fixes defect 26). Settings merge uses an allowlist of known keys — never `in`-merge of `__proto__`/`constructor` (fixes defect 19).
- Settings persistence: JSON under `app.getPath('userData')`, validated on load (clamp/reject corrupt values, e.g. `bufferSize`; fixes defect 10). Corrupt JSON backs up the file (`settings.json.corrupt-<ts>`) and notifies the user instead of silently resetting (fixes defect 28). Secrets persisted only when the user opts in via OS-safe storage; otherwise session-only + env fallback (fixes defect 2).
- Scheduled capture failures logged and surfaced in the Context pane as gap markers, never swallowed (fixes defect 17).

### Renderer process responsibilities

- Overlay UI: compact panel with Transcript, Context, Suggestions, Settings.
  - Transcript: live segments, scrolling, bounded buffer + rolling summary for overflow (fixes defect 33), persisted to an optional local log file (fixes defect 46).
  - Context: latest screenshot thumbnail (aspect-correct, fixes defect 31) + extracted salient text; per-item delete + memory cap (fixes defect 39); Clear removes the visible screenshot too (fixes defect 9).
  - Suggestions: AI cards with copy-to-clipboard; concurrency-guarded request (fixes defect 16); per-key missing states (fixes defect 37); numbered-list parsing preserves leading numbers (fixes defect 36); null-safe response handling (fixes defect 35).
  - Settings entry point with validation, inline errors, test-connection.
- Single recorder implementation imported from `core/audio.js` — no inline duplication (fixes defect 7). Listening state is single-sourced: renderer notifies main on every transition including failures (fixes defect 4); stop-during-start uses a generation token so a late `getUserMedia` resolution is closed immediately instead of leaking (fixes defect 5). Transcription upload queue: clips queue while a request is in flight, with visible queue depth — never silently dropped (fixes defect 3). Errors show code + message + action (fixes defect 18).
- Draggable overlay, resizable within limits, click-through toggle with tray escape. Hotkey errors render inline without switching tabs (fixes defect 38).
- Focus-visible styles and idle state styling (fixes defect 47).
- No Node access; talks to main only through the preload bridge.

## 5. v2 Features (smarter)

1. Stealth overlay window.
   - Frameless, always-on-top (`floating`), `skipTaskbar`, content-protection enabled, tool-window Alt+Tab exclusion, discreet title, `showInactive` show, optional start-hidden.
   - Show/hide instantly; state survives toggle (no data loss).
2. Global hide/show hotkey, default `Ctrl+\` (`CommandOrControl+\`).
   - User-remappable in settings; persisted and validated.
   - Tray menu Show/Hide always works as a fallback.
3. Tray app.
   - Tray icon + menu: Show/Hide, Start/Pause, Capture now, Click-through on/off, Settings, Quit.
   - No taskbar presence for the overlay window.
4. Mic transcription (smarter).
   - Capture default (or selected) microphone; bounded in-memory buffer + optional local log file.
   - Upload queue with visible depth; no silent drops.
   - Voice-activity awareness: skip silent clips (energy/VAD gate) instead of transcribing wastefully; clip length configurable (default shorter than v1's fixed 10s where quality allows) to cut latency (fixes defect 32).
   - Correct upload filename per mime type (`clip.webm` vs `clip.mp4`/`clip.wav`; fixes defect 11).
   - Start/Pause control in tray menu and overlay, single-sourced state.
5. Screen context (actually wired to the AI).
   - Periodic + manual capture through public Electron/Chromium APIs; user-configurable interval; pause control.
   - Salient-text extraction hook (OCR/text path) populates the Context note — the `note:''` stub is gone (fixes defect 1).
   - Suggestion requests include the latest screenshot image content (multimodal message part) plus extracted text — not just timestamp/source metadata.
   - Aspect-correct thumbnails; per-item delete; total memory cap with oldest-first eviction.
6. AI suggestions (fusion + question detection).
   - `core/suggest.js` fuses rolling transcript (bounded buffer + rolling summary, no hard front-truncation cliff) with screen context (image + extracted text).
   - Question/keyword detector emits suggestion triggers: interviewer-question detection on new transcript segments; manual "Suggest" button is the default trigger; optional auto mode fires only on new question-bearing transcript (debounced, in-flight-guarded), never on a fixed timer with unchanged input (fixes defects 15, 16).
   - Prompt carries interview-type awareness, language matching, and short conversation history — not a single fixed prompt (fixes defect 34).
   - Two-stage rank: cheap candidate generation, small-model rerank over top ~50, MMR dedup; pinned answers supported; conditional retrieval only when external facts are needed.
   - Render suggestion cards; copy-to-clipboard per suggestion.
   - Explicit missing-key/offline states per provider slot.
   - Optional candidate-profile grounding: when enabled, the confirmed profile (name, headline, résumé facts, skills, STAR stories, target job description) is fused into the prompt with an anti-hallucination instruction, and each card is labeled "From your profile" or "General".
7. Settings.
   - Hotkey remap, autostart toggle, mic device select, transcription language, clip length + VAD sensitivity, screen-capture interval, provider endpoints + model names, suggestion mode (manual/auto), interview type, candidate profile (name, headline, résumé facts, skills, STAR stories, job description), theme/opacity, data retention (buffer size, log file, clear buttons), start-hidden.
   - Validation with inline errors; test-connection button per slot with coded errors; keys trimmed on save (fixes defect 29); masked inputs; never logged.

## 6. Provider design (configurable OpenAI-compatible endpoints)

- Two provider slots: `transcription` and `chat`. Each slot configures `baseUrl` (user-editable, OpenAI-compatible), `model` (user-editable string), `apiKey` with precedence: explicit settings value (trimmed) > `XORVIEW_OPENAI_API_KEY` (or slot-specific `XORVIEW_TRANSCRIBE_API_KEY` / `XORVIEW_CHAT_API_KEY`) > none.
- No keys in the repo, logs, or committed fixtures. Mask keys in UI (password input) and never log them. Secret scan covers private keys, `AKIA`, `sk-`/OpenAI, and generic `api[_-]?key` patterns (fixes defect 12).
- HTTP client: `fetch` from the main process with timeout + bounded retries with exponential backoff + jitter on 429/5xx/timeout (fixes defect 14). All error paths coded, including non-JSON 200 bodies (fixes defect 30). Slot arguments validated (fixes defect 26). Upload filenames match mime type (fixes defect 11).
- Offline behavior: transcription and suggestions show explicit per-slot "provider unreachable / key missing" states with the failing slot named and a next action; overlay and tray keep working.

## 7. Stealth scope (STANDARD techniques only, hardened)

In scope:

- Overlay excluded from screen capture via public Electron content-protection APIs (`setContentProtection(true)`).
- Global hide/show hotkey (default `Ctrl+\`), verified with `isRegistered`.
- Tray-based presence with no taskbar entry for the overlay (`skipTaskbar`, tool-window type, Alt+Tab exclusion verified on target Windows build).
- Focus behavior: `focusable:false` by default, `showInactive()` on show, optional start-hidden.
- Discreet window title and neutral `productName`/`executableName` (installer gets a real icon, not the Electron default — fixes defect 13).
- Click-through toggle with a tray escape hatch.

Explicitly out of scope (do not implement):

- Kernel or driver tricks.
- Hiding from process lists / task managers.
- Interfering with any other software (input injection into other apps, hooking, disabling capture in other processes, tampering with conferencing/anti-cheat/proctoring tools).

## 8. Key v2 decisions

- D1 Full rebuild in plain JavaScript with JSDoc (no TypeScript): matches what v1 actually shipped and kills the SPEC/code drift; no `typecheck` script.
- D2 Single recorder implementation in `core/audio.js`, shared by the renderer: kills dead code and mime-candidate drift.
- D3 Listening state single-sourced with generation tokens: renderer notifies main on every transition; late `getUserMedia` resolutions are closed, never orphaned.
- D4 Transcription upload queue with visible depth: backpressure is shown, never silent.
- D5 Screenshots go to the AI as image content plus extracted text: screen context finally informs suggestions.
- D6 Manual-trigger suggestions by default; auto mode fires only on new question-bearing transcript, debounced and in-flight-guarded: controls cost and overlap.
- D7 Rolling transcript summary instead of front truncation: long interviews keep early context.
- D8 Secrets session-only by default; disk persistence only via explicit opt-in to OS-safe storage.
- D9 Overlay never steals focus: `focusable:false` + `showInactive()` + optional start-hidden.
- D10 Every preload channel has a live main-side counterpart; IPC payloads capped; settings merges allowlisted.
- D11 Smoke test asserts `did-fail-load` and fails loudly; packaging excludes `*.test.js`; icons configured for installer and tray.

## 9. Test plan (proves behavior without launching Chromium)

Sandbox constraint: Chromium cannot launch here, so Electron windows cannot be exercised directly. Prove behavior with:

- Node unit tests (`npm test`, covers every module — fixes defect 43):
  - `core/settings.js`: validation/clamping, allowlisted merge (incl. `__proto__` rejection), corrupt-JSON backup path, key precedence + trimming, session-only vs opt-in persistence.
  - `core/providers.js`: retry with backoff timing (mocked clock/fetch), filename-per-mime mapping, coded errors incl. non-JSON 200, slot validation, timeout handling.
  - `core/screen.js`: context entry shape with extracted-text note, aspect-correct thumbnails (16:9, portrait, ultrawide fixtures), eviction + memory cap, per-item delete.
  - `core/audio.js`: mime picking, queue behavior (no drops, depth reporting), VAD/silence gate, generation-token stop-during-start.
  - `core/suggest.js`: fusion prompt assembly (transcript + summary + image + note), question detection (positive/negative fixtures), debounce + in-flight guard, number-preserving line parsing, null-safe responses.
  - `scripts/`: guarded `JSON.parse` failure paths, secret-scan fixtures (incl. `sk-` positives and clean negatives), `require.main` guard behavior.
- Stub harness for `electron/main.js`: stub `app/BrowserWindow/Tray/globalShortcut/desktopCapturer` and assert window options (`skipTaskbar`, `focusable`, `showInactive` path, content protection call, start-hidden branch), hotkey registration + `isRegistered` + failure notification, tray menu contents incl. click-through escape, IPC slot validation + payload caps, scheduled-capture failure logging, smoke `did-fail-load` assertion.
- jsdom harness for `renderer/app.js`: assert queue-depth display, per-slot error rendering, Clear removing the screenshot, no tab yank on hotkey error, per-key banner wording, number-preserving suggestion render, listening-state IPC notifications on success and failure paths.
- Packaging checks: `build.files` excludes `*.test.js` (fixes defect 44); Windows icon configured; installer carries neutral product/executable names; no secrets in output (lint gate).
- Lint gate (`scripts/lint.js`): secret scan must pass on the tree; `npm run dist` runs it first.
- Runtime verification on a real Windows target (not in sandbox): Alt+Tab exclusion, `setContentProtection` effectiveness, hotkey conflicts, mic permission flows, localized `desktopCapturer` names, tray DPI rendering, installer output.

## 10. Run and build instructions

Prerequisites: Node.js LTS + npm (pin versions in `package.json` `engines`). npm needs a workspace-local cache in this sandbox.

```sh
cd xorview
npm install
npm run dev        # Electron + renderer with hot reload
npm run test       # unit tests for core/, scripts/, renderer and main harnesses
npm run lint       # secret scan + static checks
npm run smoke      # packaged smoke with did-fail-load assertion
npm run dist       # packaged per-user installer (electron-builder or equivalent)
```

- `npm run dev` must start with no API key configured and show the settings screen with provider errors clearly indicated.
- `npm run dist` output: per-user Windows installer + uninstaller with a real icon; no secrets bundled; no `*.test.js` shipped.
- Future: add `app-update.yml` + published releases for auto-update (same layout observed in both reference apps).

## 11. Acceptance criteria (v2)

- Overlay shows/hides via `Ctrl+\` by default and via tray menu, without stealing focus.
- Overlay has no taskbar entry, requests content protection, and excludes Alt+Tab (verified on target Windows).
- Mic transcription appends live segments with no silent drops; Start/Pause works; tray and renderer states never desync; no mic leaks.
- Screen context captures on demand and on interval; Context pane updates with thumbnail + extracted text; latest image reaches the AI.
- AI suggestions fuse transcript + screen context; copy works; missing-key/offline states are explicit per slot; no overlapping requests.
- Settings persist across restarts (except intentionally session-only secrets); corrupt settings back up and notify instead of silently resetting.
- All 48 v1 defects in Section 3 are fixed; `npm test` + `npm run lint` + `npm run smoke` pass.
- No secrets in the repo; no reference-app code, binaries, or assets present.
