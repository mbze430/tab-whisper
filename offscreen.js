// Tab Whisper — offscreen document
// Runs in an offscreen document (has DOM / MediaRecorder, unlike the
// MV3 service worker). Gets tab audio via getUserMedia with the
// chromeMediaSource:'tab' stream ID supplied by the background
// service worker (chrome.tabCapture is undefined in offscreen docs),
// chunks it with MediaRecorder, and POSTs each chunk to the user's
// own local Whisper server.
// Nothing is sent anywhere else. No third-party service is used.

let mediaRecorder = null;
let stream = null;
let audioCtx = null;
let audioSource = null;
let audioDelay = null;
let chunkTimer = null;
let chunkBlobs = [];
let translateFallbackTried = false;
let settings = null;
let stopped = false;
let chunkIndex = 0;
let inFlight = 0;

// Hallucination blocklist (Firefox parity, Nov 25): phrases Whisper
// invents on music/silence. Exact-match only (case-insensitive,
// punctuation-insensitive).
const HALLUCINATIONS = [
  'thanks for watching', 'thank you for watching', 'thanks for watching!',
  'thank you for watching!', 'продолжение следует', 'продолжение следует...',
  'субтитры сделал dimatorzok', 'субтитры сделал dimatorzok'
];
function isHallucination(text) {
  const n = text.toLowerCase().replace(/[…\.\!\?]+$/g, '').trim();
  return HALLUCINATIONS.includes(n);
}

// dB gate (Firefox parity, Nov 25): peak dBFS in the current chunk,
// sampled from an AnalyserNode tapped off the tab audio. A chunk whose
// peak is below settings.minDb (default -40) is never sent to Whisper.
// NOTE: this is the ONLY gate — do NOT re-add vad_filter server-side,
// it killed real Russian speech over music in v1.0.9. Double-VAD can
// silently discard pre-gated speech.
let analyser = null;
let gateTimer = null;
let chunkPeakDb = -Infinity;
function dbOf(rms) { return rms <= 0 ? -Infinity : 20 * Math.log10(rms); }
function startGate() {
  try {
    if (!audioCtx || !audioSource) return;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    audioSource.connect(analyser); // tap only — parallel to the passthrough delay, NOT in series, no sound change
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
    console.log('[TabWhisper] dB gate unavailable:', e.message);
  }
}
function stopGate() {
  try { if (gateTimer) clearInterval(gateTimer); } catch (e) {}
  gateTimer = null;
  try { if (analyser) analyser.disconnect(); } catch (e) {}
  analyser = null;
}

function status(text) {
  chrome.runtime.sendMessage({ type: 'offscreen-status', status: text }).catch(() => {});
}

function fatal(error) {
  stopInternal();
  chrome.runtime.sendMessage({ type: 'offscreen-error', error }).catch(() => {});
}

// Derive the correct OpenAI-compatible endpoint from the configured URL.
// - task=translate -> .../v1/audio/translations (no language param; output is English)
// - task=transcribe -> .../v1/audio/transcriptions (language param is honoured)
// Accepts a full transcriptions URL, a translations URL, or a bare
// base URL such as http://localhost:8080/v1  or  http://localhost:8080/api/v1
function endpointFor(task, configuredUrl) {
  let base = (configuredUrl || '').trim().replace(/\/+$/, '');
  if (!base) base = 'http://localhost:8080/v1/audio/transcriptions';
  const want = task === 'translate' ? 'translations' : 'transcriptions';
  if (base.endsWith('/audio/transcriptions') || base.endsWith('/audio/translations')) {
    return base.replace(/\/audio\/(transcriptions|translations)$/, '/audio/' + want);
  }
  if (base.endsWith('/audio')) return base + '/' + want;
  if (base.endsWith('/v1') || base.endsWith('/api/v1')) return base + '/audio/' + want;
  // Bare host, e.g. http://localhost:8080 — assume OpenAI-compatible /v1 layout.
  return base + '/v1/audio/' + want;
}

async function postChunk(blob, index) {
  if (stopped) return;
  inFlight++;
  const url = endpointFor(settings.task, settings.whisperUrl);
  const form = new FormData();
  // Whisper servers key off the filename extension for format sniffing.
  form.append('file', blob, 'chunk-' + index + '.webm');
  form.append('model', settings.model || 'whisper-1');
  form.append('response_format', 'json');
  if (settings.task === 'transcribe' && settings.language) {
    form.append('language', settings.language);
  }
  // temperature left at server default; low temp = less hallucination on short chunks.
  form.append('temperature', '0');
  // VAD REMOVED (v1.0.9): vad_filter=true killed all real translation
  // in testing — Russian speech over background music was
  // classified as non-speech and dropped. Back to no VAD; hallucinated
  // music lines are the lesser evil vs. losing her actual speech.

  const headers = {};
  if (settings.apiKey) headers['Authorization'] = 'Bearer ' + settings.apiKey;

  try {
    const res = await fetch(url, { method: 'POST', headers, body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = 'Whisper HTTP ' + res.status + ' on ' + url + (body ? ' — ' + body.slice(0, 300) : '') +
        '. Check the Whisper URL in the popup (OpenWebUI uses /api/v1/audio/transcriptions, plain whisper.cpp / faster-whisper servers use /v1/audio/transcriptions).';
      // fedirz faster-whisper-server may not implement /v1/audio/translations:
      // fall back to /v1/audio/transcriptions once and keep capturing.
      // 500 too (Firefox parity): the server crashes on a silent/music
      // chunk — usually language detection, or the model OOMing on the GPU. Transcriptions usually succeeds where
      // translations 500s; you get Russian text instead of nothing.
      if ((res.status === 404 || res.status === 405 || res.status === 500) && settings.task === 'translate' && !translateFallbackTried) {
        translateFallbackTried = true;
        settings.task = 'transcribe';
        status('Translations endpoint ' + res.status + ' on this server — falling back to transcriptions (Russian text), keep capturing. Check docker logs whisper-openai for the 500 cause.');
        return;
      }
      if (res.status === 401 || res.status === 403) {
        fatal(msg);
        return;
      }
      status(msg);
      return;
    }
    const data = await res.json().catch(() => ({}));
    const text = (data.text || '').trim();
    if (text && isHallucination(text)) {
      console.log('[TabWhisper] dropped hallucination:', text);
      return;
    }
    if (text && text.toLowerCase() !== '[silence]') {
      const line = {
        at: new Date().toISOString(),
        chunk: index,
        text
      };
      chrome.runtime.sendMessage({ type: 'offscreen-transcript', line }).catch(() => {});
    }
  } catch (e) {
    // Network error = Whisper server not reachable. This is the most
    // common first-run failure (server not started / wrong port).
    status('Whisper unreachable at ' + url + ': ' + e.message +
      '. Is your local Whisper / OpenWebUI server running?');
  } finally {
    inFlight--;
  }
}

function stopInternal() {
  stopped = true;
  stopGate();
  try { if (chunkTimer) clearTimeout(chunkTimer); } catch (e) {}
  chunkTimer = null;
  try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (e) {}
  try { if (audioSource) audioSource.disconnect(); } catch (e) {}
  try { if (audioDelay) audioDelay.disconnect(); } catch (e) {}
  try { if (audioCtx) audioCtx.close(); } catch (e) {}
  audioCtx = null;
  audioSource = null;
  audioDelay = null;
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  mediaRecorder = null;
  stream = null;
}

async function start(tabId, newSettings, streamId) {
  settings = newSettings;
  stopped = false;
  chunkIndex = 0;

  const chunkMs = Math.max(3, Math.min(60, Number(settings.chunkSeconds) || 10)) * 1000;

  // Pick a recorder MIME type the browser actually supports.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    ''
  ];
  const mimeType = candidates.find((m) => { try { return !m || MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) || '';

  if (!streamId) {
    return { ok: false, error: 'No tab stream ID from background. Reload the extension and try again.' };
  }

  // Open the tab's audio stream. This is the MV3-correct way:
  // getUserMedia with chromeMediaSource:'tab' + the stream ID from
  // chrome.tabCapture.getMediaStreamId() in the service worker.
  let capturedStream;
  try {
    capturedStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
  } catch (e) {
    return { ok: false, error: 'getUserMedia(tab) failed: ' + e.message + '. Make sure the tab is actually playing sound and try again.' };
  }

  stream = capturedStream;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stopInternal();
    return { ok: false, error: 'Tab has no audio track. Make sure the tab is actually playing sound (unmute the tab / video) and try again.' };
  }
  // AUDIO PASSTHROUGH (v1.0.4): tab capture mutes the tab in your
  // speakers — the audio only goes to the stream. Route it back
  // through an AudioContext so you can still hear her while recording.
  try {
    // Buffered passthrough (v1.0.8): 'playback' latency hint + a 300ms
    // DelayNode buffer smooths out the choppy/breaking-up audio you
    // hear. Costs ~300ms of extra listen delay, worth it for stability.
    audioCtx = new AudioContext({ latencyHint: 'playback' });
    audioSource = audioCtx.createMediaStreamSource(stream);
    audioDelay = audioCtx.createDelay(1.0);
    audioDelay.delayTime.value = 0.3;
    audioSource.connect(audioDelay);
    audioDelay.connect(audioCtx.destination);
    await audioCtx.resume();
    startGate();
  } catch (e) {
    status('Audio passthrough failed (capture still running): ' + e.message);
  }

  const cycleMs = chunkMs;
  function recordCycle() {
    if (stopped) return;
    chunkBlobs = [];
    chunkPeakDb = -Infinity; // reset dB peak for this chunk
    try {
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      fatal('MediaRecorder failed: ' + e.message);
      return;
    }
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunkBlobs.push(event.data);
    };
    mediaRecorder.onerror = (event) => {
      fatal('MediaRecorder error: ' + (event.error ? event.error.message : 'unknown'));
    };
    mediaRecorder.onstop = () => {
      if (stopped) return;
      // One complete, standalone WebM per cycle — timeslice blobs after
      // the first lack a header and Whisper could not decode them, which
      // is why only the first line ever translated.
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
      }, cycleMs);
    } catch (e) {
      fatal('MediaRecorder start failed: ' + e.message);
      return;
    }
  }
  recordCycle();
  status('Capturing tab audio, ' + (chunkMs / 1000) + 's chunks -> ' + endpointFor(settings.task, settings.whisperUrl));
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'offscreen-start') {
      return sendResponse(await start(msg.tabId, msg.settings, msg.streamId));
    }
    if (msg.type === 'offscreen-stop') {
      stopInternal();
      return sendResponse({ ok: true });
    }
    return sendResponse({ ok: false, error: 'Unknown message: ' + msg.type });
  })();
  return true;
});
