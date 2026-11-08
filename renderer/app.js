'use strict';

/* renderer/app.js — XorView v2 overlay UI. Talks to main only via window.xorview.
 * Recorder, queue, VAD, context store, and suggestion helpers come from the
 * SINGLE shared implementations in core/*.js (loaded via <script> tags) —
 * nothing is reimplemented here. */

(function () {
  const bridge = window.xorview;
  const AudioLib = window.XorViewAudio;
  const ScreenLib = window.XorViewScreen;
  const SuggestLib = window.XorViewSuggest;

  const state = {
    settings: null,
    transcript: [],
    evicted: [],
    summary: '',
    contexts: null,
    gaps: [],
    history: [],
    listening: false,
    stream: null,
    recorder: null,
    analyser: null,
    audioCtx: null,
    session: null,
    queue: null,
    gate: null,
    clickThrough: false,
    autoWanted: false
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
    // Typing in settings needs a focusable window; viewing tabs does not.
    if (name === 'settings' && bridge && typeof bridge.setFocusable === 'function') {
      void bridge.setFocusable(true).catch(() => {});
    }
  }

  function setStatus(mode) {
    const dot = $('status-dot');
    if (dot) dot.className = mode || 'idle';
  }

  /** Human-readable error with a next action per code. */
  function formatProviderError(context, code, message) {
    const actions = {
      'missing-key': 'Add the key in Settings or set the env var.',
      auth: 'Check the key in Settings, then Test the endpoint.',
      'bad-request': 'Check the endpoint URL and model name in Settings.',
      network: 'Check your connection, then try again.',
      timeout: 'The provider timed out — try again.',
      'too-large': 'Clip too large — shorten the clip length in Settings.',
      'capture-failed': 'Use Capture now to retry.',
      busy: 'Please wait for the running request.'
    };
    const action = actions[code] || 'See Settings for details.';
    const detail = message ? ` ${message}` : '';
    return `${context} error (${code || 'unknown'}):${detail} ${action}`;
  }

  // ---------- transcript ----------

  function renderTranscript() {
    const list = $('transcript-list');
    if (!list) return;
    list.innerHTML = state.transcript
      .map((seg) => `<li><span class="ts">${esc(fmtTime(seg.t))}</span>${esc(seg.text)}</li>`)
      .join('');
    list.scrollTop = list.scrollHeight;
  }

  function appendTranscript(text) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const seg = { t: new Date().toISOString(), text: clean };
    state.transcript.push(seg);
    const limit = (state.settings && state.settings.bufferSize) || 100;
    const droppedNow = [];
    while (state.transcript.length > limit) {
      const shifted = state.transcript.shift();
      if (shifted) droppedNow.push(shifted);
    }
    if (droppedNow.length > 0) {
      state.evicted.push(...droppedNow);
      while (state.evicted.length > 200) state.evicted.shift();
      if (SuggestLib) state.summary = SuggestLib.summarizeSegments(state.evicted);
    }
    renderTranscript();
    if (state.settings && state.settings.transcriptLogEnabled && bridge) {
      void bridge.appendTranscript(clean).catch(() => {});
    }
    maybeAutoSuggest();
    return seg;
  }

  function currentTranscriptPayload() {
    if (SuggestLib) {
      const split = SuggestLib.splitTranscript(state.transcript, SuggestLib.DEFAULT_EXCERPT_CHARS);
      const summary = [state.summary, split.summary].filter(Boolean).join('\n');
      return { transcript: split.excerpt, summary };
    }
    const lines = state.transcript.map((seg) => `[${fmtTime(seg.t)}] ${seg.text}`);
    return { transcript: lines.join('\n').slice(-4000), summary: state.summary };
  }

  // ---------- listening (mic clips -> queued transcription) ----------

  function ensureSession() {
    if (!state.session && AudioLib) state.session = new AudioLib.ListenSession();
    return state.session;
  }

  function ensureQueue() {
    if (!state.queue && AudioLib) {
      state.queue = new AudioLib.UploadQueue({
        handler: (clip) => transcribeClip(clip),
        onDepth: (depth) => {
          const el = $('queue-depth');
          if (el) el.textContent = depth > 1 ? `${depth - 1} queued` : '';
        }
      });
    }
    return state.queue;
  }

  function ensureGate() {
    if (!state.gate && SuggestLib) {
      state.gate = new SuggestLib.SuggestionGate({ minIntervalMs: 8000 });
    }
    return state.gate;
  }

  function closeStream(stream) {
    if (!stream) return;
    try {
      const tracks = stream.getTracks ? stream.getTracks() : [];
      tracks.forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }

  function teardownAudioGraph() {
    if (state.analyser) {
      try {
        state.analyser.disconnect();
      } catch {
        // ignore
      }
      state.analyser = null;
    }
    if (state.audioCtx) {
      try {
        void state.audioCtx.close();
      } catch {
        // ignore
      }
      state.audioCtx = null;
    }
  }

  /** Build an RMS energy source from the mic stream (null when unavailable). */
  function buildEnergySource(stream) {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor || !AudioLib) return null;
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      state.audioCtx = ctx;
      state.analyser = analyser;
      const buf = new Float32Array(analyser.fftSize);
      return () => {
        try {
          analyser.getFloatTimeDomainData(buf);
          return AudioLib.computeRms(buf);
        } catch {
          return undefined;
        }
      };
    } catch {
      return null;
    }
  }

  async function transcribeClip(clip) {
    if (!clip || !clip.base64) return;
    const el = $('listen-state');
    try {
      const res = await bridge.transcribeAudio({ audioBase64: clip.base64, mimeType: clip.mimeType });
      const safe = SuggestLib
        ? SuggestLib.safeResponse(res)
        : { ok: !!(res && res.ok), text: (res && res.text) || '', code: '', message: '' };
      if (safe.ok && safe.text) {
        appendTranscript(safe.text);
        if (el) el.textContent = 'Listening…';
        setStatus('live');
      } else if (safe.ok) {
        if (el) el.textContent = 'Listening… (silence)';
      } else {
        if (el) el.textContent = formatProviderError('Transcription', safe.code, safe.message);
        setStatus('error');
      }
    } catch (err) {
      if (el) el.textContent = `Transcription error: ${(err && err.message) || err}`;
      setStatus('error');
    }
  }

  function onRecorderClip(clip) {
    const queue = ensureQueue();
    if (!queue) return;
    const decision = AudioLib.shouldSkipClip(
      { size: clip.size, energy: clip.energy },
      {
        vadEnabled: !!(state.settings && state.settings.vadEnabled),
        vadThreshold: state.settings ? state.settings.vadThreshold : 0.02
      }
    );
    if (decision.skip) return; // VAD/empty gate — intentional, not a silent drop.
    queue.enqueue(clip);
  }

  async function startListening() {
    if (state.listening) return;
    if (!AudioLib) {
      $('listen-state').textContent = 'Audio module missing — reload the overlay.';
      setStatus('error');
      return;
    }
    const session = ensureSession();
    const token = session ? session.beginStart() : 0;
    try {
      const constraints = { audio: true };
      const deviceId = state.settings && state.settings.micDeviceId;
      if (deviceId && deviceId !== 'default') {
        constraints.audio = { deviceId: { exact: deviceId } };
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // Stop-during-start: a stale token means stopListening() already ran.
      if (session && !session.isCurrent(token)) {
        closeStream(stream);
        return;
      }
      const candidates = AudioLib.DEFAULT_MIME_CANDIDATES || [];
      const mimeType = typeof MediaRecorder !== 'undefined'
        ? AudioLib.pickMimeType(candidates, (c) => MediaRecorder.isTypeSupported(c))
        : '';
      const clipSec = state.settings && state.settings.clipLengthSec
        ? Math.min(30, Math.max(2, Number(state.settings.clipLengthSec) || 5))
        : 5;
      const recorder = new AudioLib.AudioClipRecorder({
        clipMs: clipSec * 1000,
        mimeType,
        onClip: onRecorderClip,
        energySource: buildEnergySource(stream)
      });
      recorder.start(stream);
      state.stream = stream;
      state.recorder = recorder;
      state.listening = true;
      ensureQueue();
      $('btn-listen').textContent = 'Pause listening';
      $('listen-state').textContent = 'Listening…';
      setStatus('live');
      await bridge.setListening(true);
    } catch (err) {
      if (session && !session.isCurrent(token)) return; // stopped mid-start
      $('listen-state').textContent = `Mic error: ${(err && err.message) || err}`;
      setStatus('error');
      state.listening = false;
      // Stay in sync with the tray even on failure.
      try {
        await bridge.setListening(false);
      } catch {
        // main may be unreachable; UI state is already correct
      }
    }
  }

  async function stopListening() {
    if (state.session) state.session.stop(); // invalidate any pending start
    if (state.recorder) {
      try {
        state.recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    closeStream(state.stream);
    teardownAudioGraph();
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

  function ensureContexts() {
    if (!state.contexts && ScreenLib) state.contexts = new ScreenLib.ContextStore({});
    if (!state.contexts) {
      // Degraded fallback if the shared module failed to load.
      state.contexts = { entries: [], add(e) { this.entries.push(e); }, latest() { return this.entries[this.entries.length - 1] || null; }, list() { return [...this.entries]; }, remove(id) { this.entries = this.entries.filter((e) => e.id !== id); }, clear() { this.entries = []; } };
    }
    return state.contexts;
  }

  function renderContexts() {
    const store = ensureContexts();
    const entries = store.list();
    const latest = store.latest();
    const img = $('context-img');
    if (latest && latest.pngDataUrl) {
      img.src = latest.pngDataUrl;
      img.hidden = false;
      $('context-note').textContent = latest.note
        || `Latest capture ${fmtTime(latest.timestamp || latest.t)} from ${latest.sourceName}.`;
      $('capture-state').textContent = `${entries.length} capture(s)`;
    } else {
      // Clear must remove the visible screenshot too.
      img.removeAttribute('src');
      img.hidden = true;
      $('context-note').textContent = 'Screen captures appear here on your interval.';
      $('capture-state').textContent = state.gaps.length > 0
        ? `${state.gaps.length} gap(s), no captures`
        : 'No captures yet';
    }
    const list = $('context-list');
    const items = entries.slice(-10).reverse().map((c) =>
      `<li data-context-id="${c.id}"><span class="ts">${esc(fmtTime(c.timestamp || c.t))}</span>` +
      `${esc(c.sourceName || 'screen')}` +
      `<button class="ghost context-del" data-del="${c.id}" title="Delete this capture">Delete</button></li>`
    );
    const gaps = state.gaps.slice(-5).reverse().map((g) =>
      `<li class="gap"><span class="ts">${esc(fmtTime(g.timestamp))}</span>capture gap: ${esc(g.message || 'failed')}</li>`
    );
    list.innerHTML = gaps.join('') + items.join('');
    list.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-del'));
        store.remove(id);
        renderContexts();
      });
    });
  }

  function onContextEntry(entry) {
    if (!entry) return;
    ensureContexts().add({
      id: entry.id,
      timestamp: entry.timestamp,
      sourceName: entry.sourceName,
      pngDataUrl: entry.pngDataUrl,
      note: entry.note
    });
    renderContexts();
  }

  function onCaptureGap(gap) {
    state.gaps.push({ timestamp: (gap && gap.timestamp) || new Date().toISOString(), message: (gap && gap.message) || 'failed' });
    while (state.gaps.length > 10) state.gaps.shift();
    $('capture-state').textContent = `Capture failed — gap recorded (${state.gaps.length})`;
    renderContexts();
  }

  // ---------- suggestions ----------

  function renderSuggestions(text) {
    const host = $('suggestions');
    const cards = SuggestLib && SuggestLib.parseLabeledCards
      ? SuggestLib.parseLabeledCards(text)
      : String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
        .map((line) => ({ label: 'none', text: line }));
    if (cards.length === 0) {
      host.innerHTML = '<p class="muted">No suggestions returned.</p>';
      return;
    }
    host.innerHTML = '';
    cards.forEach((card) => {
      const wrap = document.createElement('div');
      wrap.className = 'suggestion-card';
      const p = document.createElement('p');
      p.textContent = card.text;
      wrap.appendChild(p);
      if (card.label === 'you' || card.label === 'general') {
        const badge = document.createElement('span');
        badge.className = `card-badge ${card.label}`;
        badge.textContent = card.label === 'you' ? 'From your profile' : 'General';
        wrap.appendChild(badge);
      }
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(card.text);
          btn.textContent = 'Copied';
        } catch {
          btn.textContent = 'Copy failed';
        }
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1500);
      });
      wrap.appendChild(btn);
      host.appendChild(wrap);
    });
  }

  async function runSuggestionRequest() {
    const payload = currentTranscriptPayload();
    const latest = ensureContexts().latest();
    const settings = state.settings || {};
    const res = await bridge.suggest({
      transcript: payload.transcript,
      summary: payload.summary,
      contextNote: latest ? (latest.note || '') : 'No screen captures yet.',
      imageDataUrl: latest ? (latest.pngDataUrl || '') : '',
      interviewType: settings.interviewType || 'general',
      language: settings.language || '',
      history: state.history.slice(-3)
    });
    const safe = SuggestLib
      ? SuggestLib.safeResponse(res)
      : { ok: !!(res && res.ok), text: (res && res.text) || '', code: '', message: '' };
    if (safe.ok) {
      $('suggest-state').textContent = 'Suggestions updated.';
      renderSuggestions(safe.text);
      if (safe.text) {
        state.history.push({ role: 'assistant', content: safe.text.slice(0, 2000) });
        while (state.history.length > 3) state.history.shift();
      }
    } else {
      $('suggest-state').textContent = formatProviderError('Suggestion', safe.code, safe.message);
    }
    return safe;
  }

  async function requestSuggestions() {
    const gate = ensureGate();
    const btn = $('btn-suggest');
    const run = async () => {
      btn.disabled = true;
      $('suggest-state').textContent = 'Asking provider…';
      try {
        await runSuggestionRequest();
      } catch (err) {
        $('suggest-state').textContent = `Suggestion error: ${(err && err.message) || err}`;
      } finally {
        btn.disabled = false;
      }
    };
    if (!gate) {
      await run();
      return;
    }
    const outcome = await gate.request(run, state.transcript.length);
    if (outcome && outcome.ok === false && outcome.code === 'busy') {
      $('suggest-state').textContent = 'Already asking the provider — please wait.';
    }
  }

  /** Auto mode: fire only on NEW question-bearing transcript, debounced + guarded. */
  function maybeAutoSuggest() {
    if (!state.autoWanted || !SuggestLib) return;
    const gate = ensureGate();
    if (!gate || gate.inFlight) return;
    const last = state.transcript[state.transcript.length - 1];
    if (!last) return;
    const detected = SuggestLib.detectQuestions(last.text);
    if (!gate.shouldAutoFire(state.transcript.length, detected.isQuestion)) return;
    void gate.request(async () => {
      $('suggest-state').textContent = 'Auto-asking provider…';
      try {
        await runSuggestionRequest();
      } catch (err) {
        $('suggest-state').textContent = `Suggestion error: ${(err && err.message) || err}`;
      }
    }, state.transcript.length);
  }

  function applyAutoMode() {
    state.autoWanted =
      ($('auto-suggest') && $('auto-suggest').checked) ||
      (state.settings && state.settings.suggestionMode === 'auto');
    if (state.gate) {
      state.gate.lastTranscriptLength = state.transcript.length;
    }
  }

  // ---------- settings ----------

  /** Local VoiceStudio backends need no API key, so no banner for them. */
  function transcribeKeyMissing(s) {
    return !s.hasTranscribeKey && s.transcribeProvider !== 'voicestudio';
  }

  function updateKeyBanner() {
    const s = state.settings;
    const banner = $('key-banner');
    const text = $('key-banner-text');
    if (!s || !banner || !text) return;
    const missingT = transcribeKeyMissing(s);
    const missingC = !s.hasChatKey;
    banner.hidden = !missingT && !missingC;
    if (missingT && missingC) {
      text.textContent = 'No API keys configured. Transcription and suggestions need keys.';
    } else if (missingT) {
      text.textContent = 'Transcription key missing — live captions are off. Chat suggestions still work.';
    } else if (missingC) {
      text.textContent = 'Chat key missing — suggestions are off. Transcription still works.';
    }
  }

  function fillSettingsForm(s) {
    $('set-hotkey').value = s.hotkey || '';
    $('set-autostart').checked = !!s.autostart;
    $('set-start-hidden').checked = !!s.startHidden;
    $('set-theme').value = s.theme || 'dark';
    $('set-opacity').value = s.opacity;
    $('set-mic').value = s.micDeviceId || 'default';
    $('set-language').value = s.language || '';
    $('set-clip').value = s.clipLengthSec;
    $('set-vad').checked = s.vadEnabled !== false;
    $('set-vad-threshold').value = s.vadThreshold;
    $('set-interval').value = s.screenIntervalSec;
    $('set-screen-paused').checked = !!s.screenPaused;
    $('set-tbase').value = s.transcribeBaseUrl || '';
    $('set-tmodel').value = s.transcribeModel || '';
    $('set-tkey').value = '';
    $('set-tprovider').value = s.transcribeProvider || 'openai';
    $('set-vs-base').value = s.voiceStudioBaseUrl || '';
    $('set-vs-model').value = s.voiceStudioModel || '';
    $('set-cbase').value = s.chatBaseUrl || '';
    $('set-cmodel').value = s.chatModel || '';
    $('set-ckey').value = '';
    $('set-persist-keys').checked = !!s.persistKeys;
    $('set-suggest-mode').value = s.suggestionMode || 'manual';
    $('set-interview-type').value = s.interviewType || 'general';
    $('set-buffer').value = s.bufferSize;
    $('set-transcript-log').checked = !!s.transcriptLogEnabled;
    $('set-profile-enabled').checked = !!s.profileEnabled;
    $('set-profile-name').value = s.candidateName || '';
    $('set-profile-headline').value = s.candidateHeadline || '';
    $('set-profile-facts').value = s.resumeFacts || '';
    $('set-profile-skills').value = s.keySkills || '';
    $('set-profile-stories').value = s.starStories || '';
    $('set-profile-jd').value = s.jobDescription || '';
    $('set-cv-name').value = s.cvFileName || '';
    $('cv-state').textContent = s.cvFileName
      ? `Uploaded: ${s.cvFileName}`
      : 'No CV uploaded — fields fill from manual entry.';
    $('tkey-state').textContent = s.transcribeProvider === 'voicestudio'
      ? '(not needed for local VoiceStudio)'
      : (s.hasTranscribeKey ? '(configured)' : '(missing)');
    $('ckey-state').textContent = s.hasChatKey ? '(configured)' : '(missing)';
  }

  function readSettingsForm() {
    return {
      hotkey: $('set-hotkey').value.trim(),
      autostart: $('set-autostart').checked,
      startHidden: $('set-start-hidden').checked,
      theme: $('set-theme').value,
      opacity: Number($('set-opacity').value),
      micDeviceId: $('set-mic').value,
      language: $('set-language').value.trim(),
      clipLengthSec: Number($('set-clip').value),
      vadEnabled: $('set-vad').checked,
      vadThreshold: Number($('set-vad-threshold').value),
      screenIntervalSec: Number($('set-interval').value),
      screenPaused: $('set-screen-paused').checked,
      transcribeBaseUrl: $('set-tbase').value.trim(),
      transcribeModel: $('set-tmodel').value.trim(),
      transcribeApiKey: $('set-tkey').value,
      transcribeProvider: $('set-tprovider').value,
      voiceStudioBaseUrl: $('set-vs-base').value.trim(),
      voiceStudioModel: $('set-vs-model').value.trim(),
      chatBaseUrl: $('set-cbase').value.trim(),
      chatModel: $('set-cmodel').value.trim(),
      chatApiKey: $('set-ckey').value,
      persistKeys: $('set-persist-keys').checked,
      suggestionMode: $('set-suggest-mode').value,
      interviewType: $('set-interview-type').value.trim() || 'general',
      bufferSize: Number($('set-buffer').value),
      transcriptLogEnabled: $('set-transcript-log').checked,
      profileEnabled: $('set-profile-enabled').checked,
      candidateName: $('set-profile-name').value.trim(),
      candidateHeadline: $('set-profile-headline').value.trim(),
      resumeFacts: $('set-profile-facts').value.trim(),
      keySkills: $('set-profile-skills').value.trim(),
      starStories: $('set-profile-stories').value.trim(),
      jobDescription: $('set-profile-jd').value.trim(),
      cvFileName: $('set-cv-name').value
    };
  }

  /** CV upload: read the PDF here, parse it in main, overwrite filled fields. */
  function handleCvFile() {
    const input = $('set-cv-file');
    const file = input && input.files && input.files[0];
    if (!file) return;
    const state = $('cv-state');
    state.textContent = `Reading ${file.name}…`;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result || '');
        const dataBase64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
        const res = await bridge.uploadCv({ fileName: file.name, dataBase64 });
        const safe = SuggestLib
          ? SuggestLib.safeResponse(res)
          : { ok: !!(res && res.ok), code: '', message: '' };
        if (!safe.ok) {
          state.textContent = formatProviderError('CV upload', safe.code, safe.message);
          return;
        }
        const fill = (res && res.fill) || {};
        if (fill.candidateName) $('set-profile-name').value = fill.candidateName;
        if (fill.resumeFacts) $('set-profile-facts').value = fill.resumeFacts;
        if (fill.keySkills) $('set-profile-skills').value = fill.keySkills;
        $('set-cv-name').value = (res && res.fileName) || file.name;
        const pages = res && res.numpages ? ` (${res.numpages} page${res.numpages === 1 ? '' : 's'})` : '';
        state.textContent = `Uploaded: ${$('set-cv-name').value}${pages} — review the fields, then Save settings.`;
      } catch (err) {
        state.textContent = `CV upload failed: ${(err && err.message) || err}`;
      } finally {
        input.value = '';
      }
    };
    reader.onerror = () => {
      state.textContent = 'CV upload failed: could not read that file.';
      input.value = '';
    };
    reader.readAsDataURL(file);
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

  async function restoreTranscriptLog() {
    if (!state.settings || !state.settings.transcriptLogEnabled) return;
    try {
      const res = await bridge.loadTranscript(100);
      if (res && res.ok && Array.isArray(res.segments) && state.transcript.length === 0) {
        state.transcript = res.segments.filter((s) => s && s.text).map((s) => ({ t: s.t || '', text: s.text }));
        renderTranscript();
      }
    } catch {
      // Log restore is best-effort.
    }
  }

  async function loadSettings() {
    const s = await bridge.getSettings();
    state.settings = s;
    fillSettingsForm(s);
    applyTheme(s.theme);
    $('auto-suggest').checked = s.suggestionMode === 'auto';
    updateKeyBanner();
    if (s.settingsNotice) {
      $('settings-state').textContent = s.settingsNotice;
    }
    const missing = transcribeKeyMissing(s) || !s.hasChatKey;
    if (missing) showTab('settings'); // first-run: show settings with key state
    applyAutoMode();
  }

  // ---------- wiring ----------

  function setClickThroughUI(on) {
    state.clickThrough = !!on;
    $('btn-click').textContent = state.clickThrough ? 'Click-through: ON (tray to undo)' : 'Click-through';
  }

  function wire() {
    document.querySelectorAll('#tabs button').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
    $('btn-banner-settings').addEventListener('click', () => showTab('settings'));
    $('btn-hide').addEventListener('click', async () => {
      try {
        if (typeof bridge.setFocusable === 'function') await bridge.setFocusable(false);
      } catch {
        // ignore
      }
      void bridge.toggle();
    });
    $('btn-quit').addEventListener('click', () => {
      if (bridge && typeof bridge.quit === 'function') void bridge.quit();
    });
    $('btn-click').addEventListener('click', async () => {
      const next = !state.clickThrough;
      setClickThroughUI(next);
      try {
        await bridge.setClickThrough(next);
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
      state.evicted = [];
      state.summary = '';
      renderTranscript();
    });

    $('btn-capture').addEventListener('click', async () => {
      $('capture-state').textContent = 'Capturing…';
      try {
        const res = await bridge.captureNow();
        if (!res || !res.ok) {
          const safe = SuggestLib ? SuggestLib.safeResponse(res) : { code: 'unknown', message: '' };
          $('capture-state').textContent = formatProviderError('Capture', safe.code, safe.message);
        }
      } catch (err) {
        $('capture-state').textContent = `Capture failed: ${(err && err.message) || err}`;
      }
    });

    $('btn-suggest').addEventListener('click', () => void requestSuggestions());
    $('set-cv-file').addEventListener('change', () => void handleCvFile());
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
          updateKeyBanner();
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
        const safe = SuggestLib ? SuggestLib.safeResponse(res) : { ok: !!(res && res.ok), message: '' };
        $('settings-state').textContent = safe.ok
          ? 'Transcription endpoint OK.'
          : formatProviderError('Transcription test', safe.code, safe.message);
      } catch (err) {
        $('settings-state').textContent = `Transcription test failed: ${(err && err.message) || err}`;
      }
    });
    $('btn-test-c').addEventListener('click', async () => {
      $('settings-state').textContent = 'Testing chat endpoint…';
      try {
        const res = await bridge.testConnection('chat');
        const safe = SuggestLib ? SuggestLib.safeResponse(res) : { ok: !!(res && res.ok), message: '' };
        $('settings-state').textContent = safe.ok
          ? 'Chat endpoint OK.'
          : formatProviderError('Chat test', safe.code, safe.message);
      } catch (err) {
        $('settings-state').textContent = `Chat test failed: ${(err && err.message) || err}`;
      }
    });
    $('btn-clear-data').addEventListener('click', () => {
      state.transcript = [];
      state.evicted = [];
      state.summary = '';
      ensureContexts().clear();
      state.gaps = [];
      state.history = [];
      if (state.queue) state.queue.clear();
      renderTranscript();
      renderContexts();
      $('suggestions').innerHTML = '';
      $('settings-state').textContent = 'Local transcript, context, and suggestions cleared.';
    });

    // Main-process events.
    bridge.on('xorview:context', onContextEntry);
    bridge.on('xorview:capture-gap', onCaptureGap);
    bridge.on('xorview:open-settings', () => showTab('settings'));
    bridge.on('xorview:click-through-change', (on) => setClickThroughUI(on));
    bridge.on('xorview:listening-change', (on) => {
      if (on && !state.listening) void startListening();
      if (!on && state.listening) void stopListening();
    });
    bridge.on('xorview:hotkey-error', (info) => {
      // Inline banner only — never yank the user out of their current tab.
      const el = $('hotkey-error');
      el.textContent = `Hotkey "${(info && info.hotkey) || ''}" failed: ${(info && info.message) || 'unknown error'}. Use the tray menu to show/hide.`;
      el.hidden = false;
    });
  }

  async function boot() {
    if (!bridge) {
      document.body.innerHTML = '<p style="padding:16px">XorView must run inside Electron.</p>';
      return;
    }
    wire();
    ensureContexts();
    ensureQueue();
    ensureGate();
    renderTranscript();
    renderContexts();
    try {
      await loadSettings();
    } catch (err) {
      $('settings-state').textContent = `Failed to load settings: ${(err && err.message) || err}`;
    }
    await restoreTranscriptLog();
    await refreshMicDevices();
  }

  document.addEventListener('DOMContentLoaded', () => void boot());
})();
