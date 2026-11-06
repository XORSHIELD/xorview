'use strict';

/* renderer/app.js — XorView overlay UI. Talks to main only via window.xorview. */

(function () {
  const bridge = window.xorview;
  const binaryMimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

  const state = {
    settings: null,
    transcript: [],
    contexts: [],
    listening: false,
    stream: null,
    recorder: null,
    transcribing: false,
    clickThrough: false,
    autoTimer: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return c;
      }
    });
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString();
    } catch {
      return '';
    }
  }

  function showTab(name) {
    document.querySelectorAll('#tabs button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === name);
    });
    document.querySelectorAll('.pane').forEach((pane) => {
      pane.classList.toggle('active', pane.id === `tab-${name}`);
    });
  }

  function setStatus(mode) {
    $('status-dot').className = mode;
  }

  // ---------- transcript ----------

  function renderTranscript() {
    const list = $('transcript-list');
    list.innerHTML = state.transcript
      .map((seg) => `<li><span class="ts">${esc(fmtTime(seg.t))}</span>${esc(seg.text)}</li>`)
      .join('');
    list.scrollTop = list.scrollHeight;
  }

  function appendTranscript(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    state.transcript.push({ t: new Date().toISOString(), text: clean });
    const limit = (state.settings && state.settings.bufferSize) || 100;
    while (state.transcript.length > limit) state.transcript.shift();
    renderTranscript();
  }

  function transcriptExcerpt(maxChars) {
    const lines = state.transcript.map((seg) => `[${fmtTime(seg.t)}] ${seg.text}`);
    let out = lines.join('\n');
    if (out.length > maxChars) out = out.slice(out.length - maxChars);
    return out;
  }

  // ---------- listening (mic clips -> main transcription) ----------

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const c of binaryMimeCandidates) {
      try {
        if (MediaRecorder.isTypeSupported(c)) return c;
      } catch {
        // try next
      }
    }
    return '';
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error('blob read failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function transcribeClip(base64, mimeType) {
    if (!base64) return;
    if (state.transcribing) return; // skip while busy; next clip follows
    state.transcribing = true;
    try {
      const res = await bridge.transcribeAudio({ audioBase64: base64, mimeType });
      if (res && res.ok && res.text) {
        appendTranscript(res.text);
        setStatus('live');
      } else if (res && !res.ok) {
        $('listen-state').textContent = `Transcription error: ${(res.error && res.error.code) || 'unknown'}`;
        setStatus('error');
      }
    } catch (err) {
      $('listen-state').textContent = `Transcription error: ${(err && err.message) || err}`;
      setStatus('error');
    } finally {
      state.transcribing = false;
    }
  }

  async function startListening() {
    if (state.listening) return;
    try {
      const constraints = { audio: true };
      const deviceId = state.settings && state.settings.micDeviceId;
      if (deviceId && deviceId !== 'default') {
        constraints.audio = { deviceId: { exact: deviceId } };
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const mimeType = pickMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = async (event) => {
        if (!event.data || event.data.size === 0) return;
        try {
          const base64 = await blobToBase64(event.data);
          await transcribeClip(base64, recorder.mimeType || mimeType);
        } catch {
          // Drop undecodable clips.
        }
      };
      recorder.start(10000); // 10 s clips
      state.stream = stream;
      state.recorder = recorder;
      state.listening = true;
      $('btn-listen').textContent = 'Pause listening';
      $('listen-state').textContent = 'Listening…';
      setStatus('live');
      await bridge.setListening(true);
    } catch (err) {
      $('listen-state').textContent = `Mic error: ${(err && err.message) || err}`;
      setStatus('error');
      state.listening = false;
    }
  }

  async function stopListening() {
    if (state.recorder) {
      try {
        state.recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    if (state.stream) {
      state.stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
    }
    state.recorder = null;
    state.stream = null;
    state.listening = false;
    $('btn-listen').textContent = 'Start listening';
    $('listen-state').textContent = 'Paused';
    setStatus('idle');
    try {
      await bridge.setListening(false);
    } catch {
      // main may be unreachable; UI state is already correct
    }
  }

  // ---------- screen context ----------

  function renderContexts() {
    const latest = state.contexts[state.contexts.length - 1];
    const img = $('context-img');
    if (latest && latest.pngDataUrl) {
      img.src = latest.pngDataUrl;
      img.hidden = false;
      $('context-note').textContent =
        `Latest capture ${fmtTime(latest.t)} from ${latest.sourceName}. ` +
        'Review the image for on-screen details.';
      $('capture-state').textContent = `${state.contexts.length} capture(s)`;
    }
    const list = $('context-list');
    list.innerHTML = state.contexts
      .slice(-10)
      .reverse()
      .map((c) => `<li><span class="ts">${esc(fmtTime(c.t))}</span>${esc(c.sourceName || 'screen')}</li>`)
      .join('');
  }

  function onContextEntry(entry) {
    if (!entry) return;
    state.contexts.push({ t: entry.timestamp, sourceName: entry.sourceName, pngDataUrl: entry.pngDataUrl });
    while (state.contexts.length > 20) state.contexts.shift();
    renderContexts();
  }

  // ---------- suggestions ----------

  function renderSuggestions(text) {
    const host = $('suggestions');
    const lines = String(text || '')
      .split('\n')
      .map((l) => l.replace(/^[\d\-*.)\s]+/, '').trim())
      .filter(Boolean);
    if (lines.length === 0) {
      host.innerHTML = '<p class="muted">No suggestions returned.</p>';
      return;
    }
    host.innerHTML = '';
    lines.forEach((line) => {
      const card = document.createElement('div');
      card.className = 'suggestion-card';
      const p = document.createElement('p');
      p.textContent = line;
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(line);
          btn.textContent = 'Copied';
        } catch {
          btn.textContent = 'Copy failed';
        }
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1500);
      });
      card.appendChild(p);
      card.appendChild(btn);
      host.appendChild(card);
    });
  }

  async function requestSuggestions() {
    const transcript = transcriptExcerpt(4000);
    const latest = state.contexts[state.contexts.length - 1];
    const contextNote = latest
      ? `Capture at ${fmtTime(latest.t)} from ${latest.sourceName} (${state.contexts.length} total).`
      : 'No screen captures yet.';
    $('suggest-state').textContent = 'Asking provider…';
    try {
      const res = await bridge.suggest({ transcript, contextNote });
      if (res && res.ok) {
        $('suggest-state').textContent = 'Suggestions updated.';
        renderSuggestions(res.text);
      } else {
        $('suggest-state').textContent =
          `Suggestion error: ${(res.error && res.error.code) || 'unknown'} — ${(res.error && res.error.message) || ''}`;
      }
    } catch (err) {
      $('suggest-state').textContent = `Suggestion error: ${(err && err.message) || err}`;
    }
  }

  function applyAutoMode() {
    if (state.autoTimer) {
      clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
    const wantAuto =
      $('auto-suggest').checked || (state.settings && state.settings.suggestionMode === 'auto');
    if (wantAuto) {
      state.autoTimer = setInterval(() => {
        if (state.transcript.length > 0) void requestSuggestions();
      }, 60000);
    }
  }

  // ---------- settings ----------

  function fillSettingsForm(s) {
    $('set-hotkey').value = s.hotkey || '';
    $('set-autostart').checked = !!s.autostart;
    $('set-theme').value = s.theme || 'dark';
    $('set-opacity').value = s.opacity;
    $('set-mic').value = s.micDeviceId || 'default';
    $('set-language').value = s.language || '';
    $('set-interval').value = s.screenIntervalSec;
    $('set-screen-paused').checked = !!s.screenPaused;
    $('set-tbase').value = s.transcribeBaseUrl || '';
    $('set-tmodel').value = s.transcribeModel || '';
    $('set-tkey').value = '';
    $('set-cbase').value = s.chatBaseUrl || '';
    $('set-cmodel').value = s.chatModel || '';
    $('set-ckey').value = '';
    $('set-suggest-mode').value = s.suggestionMode || 'manual';
    $('set-buffer').value = s.bufferSize;
    $('tkey-state').textContent = s.hasTranscribeKey ? '(configured)' : '(missing)';
    $('ckey-state').textContent = s.hasChatKey ? '(configured)' : '(missing)';
  }

  function readSettingsForm() {
    return {
      hotkey: $('set-hotkey').value.trim(),
      autostart: $('set-autostart').checked,
      theme: $('set-theme').value,
      opacity: Number($('set-opacity').value),
      micDeviceId: $('set-mic').value,
      language: $('set-language').value.trim(),
      screenIntervalSec: Number($('set-interval').value),
      screenPaused: $('set-screen-paused').checked,
      transcribeBaseUrl: $('set-tbase').value.trim(),
      transcribeModel: $('set-tmodel').value.trim(),
      transcribeApiKey: $('set-tkey').value,
      chatBaseUrl: $('set-cbase').value.trim(),
      chatModel: $('set-cmodel').value.trim(),
      chatApiKey: $('set-ckey').value,
      suggestionMode: $('set-suggest-mode').value,
      bufferSize: Number($('set-buffer').value)
    };
  }

  function applyTheme(theme) {
    document.body.dataset.theme = theme === 'light' ? 'light' : 'dark';
  }

  async function refreshMicDevices() {
    const select = $('set-mic');
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      select.innerHTML = '<option value="default">Default microphone</option>';
      mics.forEach((mic, i) => {
        const opt = document.createElement('option');
        opt.value = mic.deviceId;
        opt.textContent = mic.label || `Microphone ${i + 1}`;
        select.appendChild(opt);
      });
      if (state.settings && state.settings.micDeviceId) {
        select.value = state.settings.micDeviceId;
      }
    } catch {
      // Keep the default option only.
    }
  }

  async function loadSettings() {
    const s = await bridge.getSettings();
    state.settings = s;
    fillSettingsForm(s);
    applyTheme(s.theme);
    $('auto-suggest').checked = s.suggestionMode === 'auto';
    const missing = !s.hasTranscribeKey || !s.hasChatKey;
    $('key-banner').hidden = !missing;
    if (missing) showTab('settings'); // first-run: show settings with key state
    applyAutoMode();
  }

  // ---------- wiring ----------

  function wire() {
    document.querySelectorAll('#tabs button').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
    $('btn-banner-settings').addEventListener('click', () => showTab('settings'));
    $('btn-hide').addEventListener('click', () => void bridge.toggle());
    $('btn-click').addEventListener('click', async () => {
      state.clickThrough = !state.clickThrough;
      $('btn-click').textContent = state.clickThrough ? 'Click-through: ON' : 'Click-through';
      try {
        await bridge.setClickThrough(state.clickThrough);
      } catch {
        // ignore
      }
    });

    $('btn-listen').addEventListener('click', () => {
      if (state.listening) void stopListening();
      else void startListening();
    });
    $('btn-clear-transcript').addEventListener('click', () => {
      state.transcript = [];
      renderTranscript();
    });

    $('btn-capture').addEventListener('click', async () => {
      $('capture-state').textContent = 'Capturing…';
      try {
        const res = await bridge.captureNow();
        if (!res || !res.ok) {
          $('capture-state').textContent = `Capture failed: ${(res.error && res.error.message) || 'unknown'}`;
        }
      } catch (err) {
        $('capture-state').textContent = `Capture failed: ${(err && err.message) || err}`;
      }
    });

    $('btn-suggest').addEventListener('click', () => void requestSuggestions());
    $('auto-suggest').addEventListener('change', applyAutoMode);

    $('settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('settings-state').textContent = 'Saving…';
      try {
        const res = await bridge.saveSettings(readSettingsForm());
        if (res && res.ok) {
          state.settings = res.settings;
          fillSettingsForm(res.settings);
          applyTheme(res.settings.theme);
          $('settings-state').textContent = 'Saved.';
          const missing = !res.settings.hasTranscribeKey || !res.settings.hasChatKey;
          $('key-banner').hidden = !missing;
          applyAutoMode();
        } else {
          const errs = res && res.errors ? Object.values(res.errors).join(' ') : 'Unknown error.';
          $('settings-state').textContent = `Save failed: ${errs}`;
        }
      } catch (err) {
        $('settings-state').textContent = `Save failed: ${(err && err.message) || err}`;
      }
    });

    $('btn-test-t').addEventListener('click', async () => {
      $('settings-state').textContent = 'Testing transcription endpoint…';
      try {
        const res = await bridge.testConnection('transcribe');
        $('settings-state').textContent =
          res && res.ok ? 'Transcription endpoint OK.' : `Transcription test failed: ${(res.error && res.error.message) || ''}`;
      } catch (err) {
        $('settings-state').textContent = `Transcription test failed: ${(err && err.message) || err}`;
      }
    });
    $('btn-test-c').addEventListener('click', async () => {
      $('settings-state').textContent = 'Testing chat endpoint…';
      try {
        const res = await bridge.testConnection('chat');
        $('settings-state').textContent =
          res && res.ok ? 'Chat endpoint OK.' : `Chat test failed: ${(res.error && res.error.message) || ''}`;
      } catch (err) {
        $('settings-state').textContent = `Chat test failed: ${(err && err.message) || err}`;
      }
    });
    $('btn-clear-data').addEventListener('click', () => {
      state.transcript = [];
      state.contexts = [];
      renderTranscript();
      renderContexts();
      $('suggestions').innerHTML = '';
      $('settings-state').textContent = 'Local transcript, context, and suggestions cleared.';
    });

    // Main-process events.
    bridge.on('xorview:context', onContextEntry);
    bridge.on('xorview:open-settings', () => showTab('settings'));
    bridge.on('xorview:listening-change', (on) => {
      if (on && !state.listening) void startListening();
      if (!on && state.listening) void stopListening();
    });
    bridge.on('xorview:hotkey-error', (info) => {
      const el = $('hotkey-error');
      el.textContent = `Hotkey "${(info && info.hotkey) || ''}" failed: ${(info && info.message) || 'unknown error'}. Use the tray menu to show/hide.`;
      el.hidden = false;
      showTab('settings');
    });
  }

  async function boot() {
    if (!bridge) {
      document.body.innerHTML = '<p style="padding:16px">XorView must run inside Electron.</p>';
      return;
    }
    wire();
    renderTranscript();
    renderContexts();
    try {
      await loadSettings();
    } catch (err) {
      $('settings-state').textContent = `Failed to load settings: ${(err && err.message) || err}`;
    }
    await refreshMicDevices();
  }

  document.addEventListener('DOMContentLoaded', () => void boot());
})();
