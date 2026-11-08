# VoiceStudio x XorView — project notes

Companion to `SKILL.md` (upstream skill text, kept verbatim). XorView-specific facts only.

## What XorView uses

- Transcription via the VoiceStudio backend's OpenAI-compatible endpoint
  `POST {base}/v1/audio/transcriptions` (multipart `file` + `model` +
  optional `language` / `response_format`). Default base
  `http://localhost:3900`, default model `whisper-1`.
- Health via `GET {base}/health`, voices via `GET {base}/v1/audio/voices`.
- Local backends usually need no API key; protected deployments still send
  `Authorization: Bearer <key>`. Never invent or hardcode a key.
- XorView's chat/suggestion slot stays on its own OpenAI-compatible provider;
  VoiceStudio covers the transcription slot (and future TTS).

## Code map

- `core/voicestudio.js` — original XorView adapter (HTTP only, no
  VoiceStudio code copied). Pure Node, injectable `fetchImpl` for tests.
- `core/voicestudio.test.js` — unit tests, no network.
- Settings keys: `transcribeProvider` (`'openai'` | `'voicestudio'`),
  `voiceStudioBaseUrl`, `voiceStudioModel`.
- Backend source (if target is unreachable): installed VoiceStudio app or
  `https://github.com/debpalash/VoiceStudio/releases/latest` — never clone
  the backend into this repo.

## Agent rules in this repo

- Follow `SKILL.md` for backend discovery; follow `core/voicestudio.js`
  JSDoc for the exact endpoints XorView calls.
- Do not copy backend code, models, or voices into `xorview/`.
- Do not promise offline behavior beyond "installed models can run offline".
