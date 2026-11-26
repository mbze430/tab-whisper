// Firefox compat: chrome.* is callback-only in Firefox, browser.* is
// promise-based. These helpers use browser.* when present, otherwise
// promisify chrome.*. This was the bug — await chrome.storage.local.get()
// returns undefined in Firefox, so settings never loaded/saved.
const _browser = (typeof browser !== 'undefined') ? browser : null;
function storageGet(keys) {
  if (_browser) return _browser.storage.local.get(keys);
  return new Promise((res) => chrome.storage.local.get(keys, res));
}
function storageSet(obj) {
  if (_browser) return _browser.storage.local.set(obj);
  return new Promise((res) => chrome.storage.local.set(obj, res));
}
function runtimeSend(msg) {
  if (_browser) return _browser.runtime.sendMessage(msg);
  return new Promise((res) => chrome.runtime.sendMessage(msg, res));
}
function sendMsg(msg) {
  const p = runtimeSend(msg);
  if (p && p.catch) p.catch(() => {});
  return p;
}
// Tab Whisper — Firefox content script (MV2)
// OVERLAY + CAPTURE in one file, because Firefox has no tabCapture
// and no offscreen document.
//
// HOW IT WORKS (Firefox-only):
//   Firefox cannot capture arbitrary tab audio — browser.tabCapture
//   does not exist. The only supported route is captureStream() on a
//   real HTMLMediaElement (<video> / <audio>) in the page.
//   - Works: xHamsterLive, YouTube, and any site that plays through
//     a <video>/<audio> element.
//   - Does NOT work: WebAudio-only pages, DRM/EME playback (Firefox
//     yields a silent stream), system audio, or pages with no media
//     element at all.
//   captureStream() does NOT mute the element, so there is no audio
//   passthrough step — you keep hearing her normally.
//
// Chunking / Whisper POST is identical to Chrome v1.0.9: 10s cycles
// (one standalone WebM per cycle), temperature 0, NO VAD (v1.0.9:
// vad_filter killed real Russian speech over music in Lady--M's room).
// Translate falls back to transcriptions once on 404/405.

(function () {
  if (window.__tabWhisperFirefoxInstalled) return;
  window.__tabWhisperFirefoxInstalled = true;

  // ---------- overlay (same UI as Chrome v1.0.9) ----------
  // FIX: only the TOP frame builds an overlay. With all_frames:true the
  // video iframe got its own copy, fixed-positioned inside a narrow
  // frame — clipped off the right edge, stuck there (the red-arrow strip
  // in Johnny's screenshot). Capture still runs in the iframe; its
  // transcript lines are relayed via the background to this top overlay.
  const IS_TOP = (window.self === window.top);
  const OVERLAY_ID = 'tab-whisper-overlay';
  let visible = true;
  let lines = [];

  function build() {
    if (!IS_TOP) return null;
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.innerHTML =
      '<div class="tw-header">' +
        '<span class="tw-title">Tab Whisper — live English (Firefox)</span>' +
        '<button type="button" class="tw-btn" id="tw-bottom" title="Jump to latest line">↓ Bottom</button>' +
        '<button type="button" class="tw-btn" id="tw-toggle" title="Hide/show transcript">Hide</button>' +
        '<button type="button" class="tw-btn" id="tw-gear" title="Sensitivity — ignore chunks quieter than (dB)">⚙</button>' +
        '<button type="button" class="tw-btn" id="tw-close" title="Remove overlay (capture keeps running)">×</button>' +
      '</div>' +
      '<div class="tw-lines" id="tw-lines"><div class="tw-line tw-empty">Listening… English transcript will appear here.</div></div>' +
      '<div class="tw-settings" id="tw-settings" style="display:none">' +
        '<label>Sensitivity — ignore chunks quieter than <span id="tw-dbval">-40</span> dB ' +
        '<input type="range" id="tw-dbslider" min="-60" max="-10" step="1" value="-40"></label> ' +
        '<span class="tw-note">Saved — applies on next Start.</span><br>' +
        '<label>Chunk (seconds) <input type="number" id="tw-chunk" min="3" max="60" step="1" value="10" style="width:52px"></label> ' +
        '<span class="tw-note">3–60s, 10s default. Shorter = faster lines, less accurate.</span>' +
      '</div>';
    document.body.appendChild(el);
    // FIX: per-button bubble-phase listeners were swallowed on cam
    // pages — the page's own click handlers stopPropagation() before
    // our buttons ever see the click. Use ONE capture-phase delegated
    // listener on the overlay itself, so it fires before the page's
    // handlers, and stopPropagation so the page never sees it.
    el.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      if (btn.id === 'tw-bottom') {
        const box = el.querySelector('#tw-lines');
        if (box) box.scrollTop = box.scrollHeight;
      } else if (btn.id === 'tw-gear') {
        const panel = el.querySelector('#tw-settings');
        const slider = el.querySelector('#tw-dbslider');
        const val = el.querySelector('#tw-dbval');
        const show = panel.style.display === 'none';
        panel.style.display = show ? '' : 'none';
        if (show) {
          storageGet('settings').then((stored) => {
            const s = stored.settings || {};
            const cur = (typeof s.minDb === 'number') ? s.minDb : -40;
            slider.value = cur; val.textContent = cur;
            const chunk = el.querySelector('#tw-chunk');
            if (chunk) chunk.value = (typeof s.chunkSeconds === 'number') ? s.chunkSeconds : 10;
          });
        }
      } else if (btn.id === 'tw-toggle') {
        visible = !visible;
        el.querySelector('#tw-lines').style.display = visible ? '' : 'none';
        btn.textContent = visible ? 'Hide' : 'Show';
        btn.title = visible ? 'Hide transcript (click Show to bring it back)' : 'Show transcript';
      } else if (btn.id === 'tw-close') {
        el.style.display = 'none';
        let pill = document.getElementById('tab-whisper-restore');
        if (pill) return;
        pill = document.createElement('button');
        pill.type = 'button';
        pill.id = 'tab-whisper-restore';
        pill.textContent = 'Tab Whisper — show transcript';
        pill.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(10,10,14,0.88);color:#f2f2f2;border:1px solid rgba(255,255,255,0.25);border-radius:8px;padding:6px 10px;cursor:pointer;font:12px system-ui,sans-serif;pointer-events:auto;';
        pill.addEventListener('click', (ev) => { ev.stopPropagation(); el.style.display = ''; pill.remove(); }, true);
        document.body.appendChild(pill);
      }
    }, true);
    const header = el.querySelector('.tw-header');
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      el.style.transform = 'none';
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      el.style.bottom = 'auto';
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      const move = (ev) => {
        el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx)) + 'px';
        el.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    // Sensitivity slider + chunk length (v1.0.14): save on change.
    const slider = el.querySelector('#tw-dbslider');
    const dbval = el.querySelector('#tw-dbval');
    if (slider) {
      slider.addEventListener('input', () => { dbval.textContent = slider.value; });
      slider.addEventListener('change', () => {
        const v = Math.max(-60, Math.min(-10, Number(slider.value) || -40));
        storageGet('settings').then((stored) => storageSet({ settings: { ...(stored.settings || {}), minDb: v } }));
      });
    }
    const chunkInput = el.querySelector('#tw-chunk');
    if (chunkInput) {
      chunkInput.addEventListener('change', () => {
        const v = Math.max(3, Math.min(60, Number(chunkInput.value) || 10));
        chunkInput.value = v;
        storageGet('settings').then((stored) => storageSet({ settings: { ...(stored.settings || {}), chunkSeconds: v } }));
      });
    }
    return el;
  }

  function render() {
    const el = document.getElementById(OVERLAY_ID) || build();
    if (!el) return;
    const box = el.querySelector('#tw-lines');
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const recent = lines.slice(-50);
    box.innerHTML = recent.map((l) => {
      const time = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const safe = String(l.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const langTag = l.languageName ? '<span class="tw-lang">[' + String(l.languageName).replace(/&/g, '&amp;').replace(/</g, '&lt;') + ']</span> ' : '';
      return '<div class="tw-line"><span class="tw-time">' + time + '</span> ' + langTag + safe + '</div>';
    }).join('') || '<div class="tw-line tw-empty">Listening…</div>';
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function showLine(line) {
    if (!IS_TOP) return; // iframe: background relays the line to the top frame
    const last = lines[lines.length - 1];
    if (last && last.chunk === line.chunk && last.text === line.text) return; // already shown
    lines.push(line);
    if (lines.length > 50) lines.shift();
    build();
    render();
  }

  // ---------- capture via captureStream() ----------
  let capturing = false;
  let settings = null;
  let mediaRecorder = null;
  let stream = null;
  let chunkTimer = null;
  let chunkBlobs = [];
  let chunkIndex = 0;
  let inFlight = 0;
  let translateFallbackTried = false;
  let stopped = true;
  // Hallucination blocklist: phrases Whisper invents on music/silence.
  // Exact-match only (case-insensitive, punctuation-insensitive).
  const HALLUCINATIONS = [
    'thanks for watching', 'thank you for watching', 'thanks for watching!',
    'thank you for watching!', 'продолжение следует', 'продолжение следует...',
    'субтитры сделал dimatorzok', 'субтитры сделал dimatorzok'
  ];
  function isHallucination(text) {
    const n = text.toLowerCase().replace(/[…\.\!\?]+$/g, '').trim();
    return HALLUCINATIONS.includes(n);
  }
// Detected-language names (v1.0.12 / v1.0.11): Whisper returns a 2-letter
// code in verbose_json; map the common ones to a readable name.
const LANGUAGE_NAMES = {
  en: 'English', ru: 'Russian', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', uk: 'Ukrainian', pl: 'Polish', ro: 'Romanian',
  nl: 'Dutch', sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian',
  cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', bg: 'Bulgarian', hr: 'Croatian',
  sr: 'Serbian', el: 'Greek', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew',
  fa: 'Persian', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay'
};
function languageName(code) {
  if (!code) return '';
  return LANGUAGE_NAMES[code.toLowerCase()] || code.toUpperCase();
}
  // dB gate state: peak dBFS in the current chunk, sampled from an
  // AnalyserNode tapped off the audio stream.
  let audioCtxGate = null;
  let analyser = null;
  let gateTimer = null;
  let chunkPeakDb = -Infinity;
  function dbOf(rms) { return rms <= 0 ? -Infinity : 20 * Math.log10(rms); }
  function startGate(audioStream) {
    try {
      audioCtxGate = new AudioContext();
      const src = audioCtxGate.createMediaStreamSource(audioStream);
      analyser = audioCtxGate.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser); // tap only — NOT connected to destination, no sound change
      const buf = new Float32Array(analyser.fftSize);
      gateTimer = setInterval(() => {
        if (!analyser || stopped) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const db = dbOf(Math.sqrt(sum / buf.length));
        if (db > chunkPeakDb) chunkPeakDb = db;
      }, 100);
    } catch (e) {
      console.log('[TabWhisper FF] dB gate unavailable:', e.message);
    }
  }
  function stopGate() {
    try { if (gateTimer) clearInterval(gateTimer); } catch (e) {}
    gateTimer = null;
    try { if (audioCtxGate) audioCtxGate.close(); } catch (e) {}
    audioCtxGate = null; analyser = null;
  }
  let currentEl = null;
  let watchTimer = null;
  let observer = null;

  function status(text) {
    console.log('[TabWhisper FF]', text);
    sendMsg({ type: 'tw-status', status: text });
    // Visible on the page too, so you can see what it is doing / stuck on
    // without opening devtools.
    try {
      if (!IS_TOP) return;
      if (settings && settings.overlayEnabled !== false) build();
      const box = document.getElementById('tw-lines');
      if (box) {
        const div = document.createElement('div');
        div.className = 'tw-line tw-empty';
        div.textContent = '» ' + text;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
      }
    } catch (e) {}
  }
  function fatal(error) {
    console.error('[TabWhisper FF] FATAL:', error);
    status('ERROR: ' + error);
    stopInternal();
    sendMsg({ type: 'tw-error', error });
  }

  function endpointFor(task, configuredUrl) {
    let base = (configuredUrl || '').trim().replace(/\/+$/, '');
    if (!base) base = 'http://localhost:8080/v1/audio/transcriptions';
    const want = task === 'translate' ? 'translations' : 'transcriptions';
    if (base.endsWith('/audio/transcriptions') || base.endsWith('/audio/translations')) {
      return base.replace(/\/audio\/(transcriptions|translations)$/, '/audio/' + want);
    }
    if (base.endsWith('/audio')) return base + '/' + want;
    if (base.endsWith('/v1') || base.endsWith('/api/v1')) return base + '/audio/' + want;
    return base + '/v1/audio/' + want;
  }

  async function postChunk(blob, index) {
    if (stopped) return;
    inFlight++;
    const url = endpointFor(settings.task, settings.whisperUrl);
    const form = new FormData();
    form.append('file', blob, 'chunk-' + index + '.webm');
    form.append('model', settings.model || 'whisper-1');
    // verbose_json (v1.0.11): 'json' returns text only — verbose_json also
    // returns the auto-detected source language. Standard OpenAI, supported
    // by fedirz faster-whisper-server.
    form.append('response_format', 'verbose_json');
    if (settings.task === 'transcribe' && settings.language) form.append('language', settings.language);
    form.append('temperature', '0');
    // NO VAD (v1.0.9) — see header.
    const headers = {};
    if (settings.apiKey) headers['Authorization'] = 'Bearer ' + settings.apiKey;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const msg = 'Whisper HTTP ' + res.status + ' on ' + url + (body ? ' — ' + body.slice(0, 300) : '');
        // Fall back to transcriptions on 404/405 (endpoint not implemented)
        // AND on 500 (server crashed on this chunk — usually language
        // detection on a silent/music-only chunk, or the model OOMing
        // against Glimmer on GPU 0). Transcriptions is the same model,
        // just without the translate step, so it usually succeeds where
        // translations 500s. You get Russian text instead of nothing.
        if ((res.status === 404 || res.status === 405 || res.status === 500) && settings.task === 'translate' && !translateFallbackTried) {
          translateFallbackTried = true;
          settings.task = 'transcribe';
          status('Translations endpoint ' + res.status + ' on this server — falling back to transcriptions (Russian text), keep capturing. Check docker logs whisper-openai for the 500 cause.');
          return;
        }
        if (res.status === 401 || res.status === 403) { fatal(msg); return; }
        status(msg);
        return;
      }
      const data = await res.json().catch(() => ({}));
      const text = (data.text || '').trim();
      const lang = (data.language || '').toLowerCase();
      if (text && isHallucination(text)) {
        console.log('[TabWhisper FF] dropped hallucination:', text);
        return;
      }
      if (text && text.toLowerCase() !== '[silence]') {
        const line = { at: new Date().toISOString(), chunk: index, text, language: lang || undefined, languageName: lang ? languageName(lang) : undefined };
        // Do NOT showLine() here: the background relays this line back
        // to the top frame, which renders it. Rendering here too =
        // every line doubled in the overlay (popup history was single
        // because the background only appends once).
        sendMsg({ type: 'tw-transcript', line });
      }
    } catch (e) {
      status('Whisper unreachable at ' + url + ': ' + e.message + '. Is your local Whisper server running?');
    } finally {
      inFlight--;
    }
  }

  function stopInternal() {
    stopped = true;
    capturing = false;
    try { if (chunkTimer) clearTimeout(chunkTimer); } catch (e) {}
    chunkTimer = null;
    try { if (watchTimer) clearInterval(watchTimer); } catch (e) {}
    watchTimer = null;
    stopGate();
    try { if (observer) observer.disconnect(); } catch (e) {}
    observer = null;
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (e) {}
    mediaRecorder = null;
    // Do NOT stop() the captureStream tracks — they belong to the page's
    // media element. Dropping our reference is enough.
    stream = null;
    currentEl = null;
  }

  function collectMedia(root, out) {
    if (!root) return;
    try {
      const els = root.querySelectorAll ? root.querySelectorAll('video,audio') : [];
      els.forEach((el) => out.push(el));
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      all.forEach((el) => {
        if (el.shadowRoot) collectMedia(el.shadowRoot, out);
      });
    } catch (e) {}
  }

  function pickBestMedia() {
    const els = [];
    collectMedia(document, els);
    if (!els.length) return null;
    els.sort((a, b) => {
      const score = (el) => {
        let s = 0;
        if (!el.paused && !el.ended && el.readyState >= 2) s += 10;
        if (el.tagName === 'VIDEO') s += 5;
        if (el.videoWidth > 0 || el.clientWidth > 200) s += 2;
        return s;
      };
      return score(b) - score(a);
    });
    return els[0];
  }

  function startRecording(capturedStream, el) {
    stream = capturedStream;
    currentEl = el;
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stopInternal();
      fatal('Media element has no audio track — this page is likely DRM-protected (Firefox yields a silent stream for DRM) or the video is muted. Try a non-DRM live stream.');
      return;
    }
    // FIX: captureStream() on a <video> returns audio AND video tracks.
    // MediaRecorder with an audio-only mime (audio/webm;codecs=opus)
    // refuses a stream containing a video track:
    // "A video track cannot be recorded ... as it is an audio type".
    // Record an audio-only MediaStream instead. Chrome never hit this
    // because tabCapture gives audio-only.
    const audioStream = new MediaStream(audioTracks);
    console.log('[TabWhisper FF] audio-only stream:', audioTracks.length, 'audio tracks, dropped', stream.getVideoTracks().length, 'video tracks');
    startGate(audioStream);
    const chunkMs = Math.max(3, Math.min(60, Number(settings.chunkSeconds) || 10)) * 1000;
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];
    const mimeType = candidates.find((m) => { try { return !m || MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) || '';
    function recordCycle() {
      if (stopped) return;
      chunkBlobs = [];
      chunkPeakDb = -Infinity; // reset dB peak for this chunk
      try {
        mediaRecorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
      } catch (e) { fatal('MediaRecorder failed: ' + e.message); return; }
      mediaRecorder.ondataavailable = (event) => { if (event.data && event.data.size) chunkBlobs.push(event.data); };
      mediaRecorder.onerror = (event) => { fatal('MediaRecorder error: ' + (event.error ? event.error.message : 'unknown')); };
      mediaRecorder.onstop = () => {
        if (stopped) return;
        const blob = new Blob(chunkBlobs, { type: mimeType || 'audio/webm' });
        if (blob.size >= 1000) {
          // dB GATE: skip this chunk entirely if nothing loud enough
          // happened in it — don't send silence to Whisper, it just
          // hallucinates "Thanks for watching!" / "Продолжение следует..."
          const minDb = (settings && typeof settings.minDb === 'number') ? settings.minDb : -40;
          if (chunkPeakDb < minDb) {
            status('Skipped quiet chunk (peak ' + (chunkPeakDb === -Infinity ? '-inf' : chunkPeakDb.toFixed(1)) + ' dB < ' + minDb + ' dB) — not sent to Whisper.');
            recordCycle();
            return;
          }
          const index = chunkIndex++;
          postChunk(blob, index);
        }
        recordCycle();
      };
      try {
        mediaRecorder.start();
        chunkTimer = setTimeout(() => {
          try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch (e) {}
        }, chunkMs);
      } catch (e) { fatal('MediaRecorder start failed: ' + e.message); return; }
    }
    recordCycle();
    if (stopped) return; // recordCycle failed fatally — don't claim we're capturing
    console.log('[TabWhisper FF] RECORDING started, mime=', mimeType);
    status('Capturing <' + el.tagName.toLowerCase() + '> audio via captureStream(), ' + (chunkMs / 1000) + 's chunks -> ' + endpointFor(settings.task, settings.whisperUrl));
  }

  function tryAttach() {
    if (stopped || stream) return false;
    const all = [];
    collectMedia(document, all);
    console.log('[TabWhisper FF] tryAttach: found', all.length, 'media elements:',
      all.map((e) => e.tagName + ' paused=' + e.paused + ' readyState=' + e.readyState + ' src=' + String(e.currentSrc || e.src || '').slice(0, 80)));
    const el = pickBestMedia();
    if (!el) { console.log('[TabWhisper FF] tryAttach: no media element yet'); return false; }
    console.log('[TabWhisper FF] tryAttach: best =', el.tagName, 'paused=' + el.paused, 'readyState=' + el.readyState);
    let captured;
    try {
      const fn = el.captureStream || el.mozCaptureStream;
      if (!fn) { fatal('This browser build has no captureStream() on media elements.'); return false; }
      captured = fn.call(el);
    } catch (e) {
      status('captureStream() failed on this element: ' + e.message);
      return false;
    }
    console.log('[TabWhisper FF] captureStream() returned', captured ? captured.getAudioTracks().length + ' audio tracks, ' + captured.getVideoTracks().length + ' video tracks' : 'null');
    if (!captured || !captured.getAudioTracks().length) {
      // Element exists but is not producing audio yet (paused / not
      // loaded / DRM-silent). Keep watching — it may start playing.
      status('Found <' + el.tagName.toLowerCase() + '> but it has 0 audio tracks (paused / not loaded / DRM-silent) — waiting…');
      return false;
    }
    startRecording(captured, el);
    return true;
  }

  function startWatching() {
    // Live pages load their <video> late. Watch for up to 60s.
    let waited = 0;
    try {
      observer = new MutationObserver(() => { tryAttach(); });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch (e) {}
    watchTimer = setInterval(() => {
      waited += 1;
      if (tryAttach()) { clearInterval(watchTimer); watchTimer = null; }
      else if (waited >= 60) {
        clearInterval(watchTimer); watchTimer = null;
        if (observer) observer.disconnect();
        stopInternal();
        fatal('No playable <video>/<audio> element found in this tab after 60s. Firefox cannot capture tab audio without one — open a page that is actually playing video/audio and try again.');
      }
    }, 1000);
  }

  async function start(newSettings) {
    console.log('[TabWhisper FF] tw-start received, settings:', newSettings);
    if (capturing) return { ok: false, error: 'Already capturing. Stop first.' };
    settings = newSettings;
    stopped = false;
    capturing = true;
    chunkIndex = 0;
    translateFallbackTried = false;
    if (settings.overlayEnabled !== false) build();
    if (!tryAttach()) {
      status('No <video>/<audio> playing yet — watching for one (up to 60s). Start the stream/video if it is paused.');
      startWatching();
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'tw-start') { console.log('[TabWhisper FF] runtime tw-start'); return sendResponse(await start(msg.settings)); }
      if (msg.type === 'tw-stop') { stopInternal(); return sendResponse({ ok: true }); }
      if (msg.type === 'transcript' && msg.line) { showLine(msg.line); return sendResponse({ ok: true }); }
      return sendResponse({ ok: false, error: 'Unknown message: ' + msg.type });
    })();
    return true;
  });

  // v1.0.13: NO unconditional build on load. The old code built the
  // overlay on EVERY top frame as soon as the content script was
  // injected, so every tab got an empty "Listening…" box. The overlay
  // is now built on demand only: start() builds it when capture starts
  // on THIS tab, and showLine()/status() build it on the first line.
})();
