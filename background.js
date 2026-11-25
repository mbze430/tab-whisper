// Tab Whisper — background service worker (MV3)
// Owns state, creates/closes the offscreen document that does the
// actual tabCapture + MediaRecorder work (a service worker has no
// MediaRecorder / AudioContext, an offscreen document does).
// No audio ever leaves the machine except to the Whisper URL the
// user configured in the popup (default: localhost).

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASON = 'USER_MEDIA';
const MAX_HISTORY = 200;

const DEFAULT_SETTINGS = {
  whisperUrl: 'http://localhost:8080/v1/audio/transcriptions',
  apiKey: '',
  model: 'whisper-1',
  language: 'ru',
  task: 'translate', // 'translate' = Russian speech -> English text; 'transcribe' = Russian text
  chunkSeconds: 10,
  overlayEnabled: true,
  minDb: -40
};

let capturing = false;
let capturingTabId = null;

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setState(patch) {
  await chrome.storage.local.set({ state: { capturing, tabId: capturingTabId, ...(patch || {}) } });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [OFFSCREEN_REASON],
    justification: 'Capture tab audio with tabCapture + MediaRecorder and POST chunks to the user-configured local Whisper server.'
  });
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch (e) { /* already closed */ }
}

async function startCapture(tabId) {
  if (capturing) return { ok: false, error: 'Already capturing. Stop first.' };
  const settings = await getSettings();
  await ensureOffscreen();
  capturing = true;
  capturingTabId = tabId;
  await setState({ startedAt: Date.now(), error: '' });

  // Inject the overlay into the tab (best-effort; chrome:// pages etc. will fail).
  if (settings.overlayEnabled) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    } catch (e) {
      // Non-fatal: overlay is optional, capture still works.
      console.warn('Tab Whisper: overlay inject failed:', e.message);
    }
  }

  // MV3 fix (v1.0.2): chrome.tabCapture is UNDEFINED in an offscreen
  // document — that was the "Cannot read properties of undefined
  // (reading 'capture')" crash at offscreen.js:120. The service worker
  // is the only place that can call tabCapture.getMediaStreamId().
  // It hands the stream ID to the offscreen doc, which then opens
  // the tab audio via getUserMedia({ chromeMediaSource: 'tab' }).
  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError || !id) reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'getMediaStreamId returned no stream ID.'));
        else resolve(id);
      });
    });
  } catch (e) {
    capturing = false;
    capturingTabId = null;
    await setState({ error: e.message });
    await closeOffscreen();
    return { ok: false, error: e.message };
  }

  // Hand the capture job to the offscreen document with the stream ID.
  const reply = await chrome.runtime.sendMessage({
    type: 'offscreen-start',
    tabId,
    streamId,
    settings
  });
  if (!reply || !reply.ok) {
    capturing = false;
    capturingTabId = null;
    await setState({ error: (reply && reply.error) || 'Offscreen capture failed to start.' });
    await closeOffscreen();
    return { ok: false, error: (reply && reply.error) || 'Offscreen capture failed to start.' };
  }
  await setState({});
  return { ok: true };
}

async function stopCapture() {
  if (!capturing) return { ok: true };
  try {
    await chrome.runtime.sendMessage({ type: 'offscreen-stop' });
  } catch (e) { /* offscreen may already be gone */ }
  await closeOffscreen();
  capturing = false;
  capturingTabId = null;
  await setState({ stoppedAt: Date.now(), error: '' });
  return { ok: true };
}

async function appendTranscript(line) {
  const stored = await chrome.storage.local.get('transcript');
  const history = stored.transcript || [];
  history.push(line);
  while (history.length > MAX_HISTORY) history.shift();
  await chrome.storage.local.set({ transcript: history });
  // Push live to the overlay in the captured tab.
  if (capturingTabId !== null) {
    chrome.tabs.sendMessage(capturingTabId, { type: 'transcript', line }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'popup-start') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id === undefined) return sendResponse({ ok: false, error: 'No active tab found.' });
      return sendResponse(await startCapture(tab.id));
    }
    if (msg.type === 'popup-stop') {
      return sendResponse(await stopCapture());
    }
    if (msg.type === 'popup-status') {
      return sendResponse({ ok: true, capturing, tabId: capturingTabId, settings: await getSettings() });
    }
    if (msg.type === 'offscreen-transcript') {
      await appendTranscript(msg.line);
      return sendResponse({ ok: true });
    }
    if (msg.type === 'offscreen-error') {
      // A fatal capture error (e.g. tab already captured, no audio).
      // Keep the state visible in the popup; do not silently restart.
      capturing = false;
      capturingTabId = null;
      await setState({ error: msg.error || 'Capture error.' });
      await closeOffscreen();
      return sendResponse({ ok: true });
    }
    if (msg.type === 'offscreen-status') {
      await setState({ offscreen: msg.status || '' });
      // Relay to the overlay too, as a » status line (Firefox parity):
      // popup state alone doesn't show on the page, and the skip/fallback
      // messages are the ones you actually need to see while watching.
      if (capturingTabId !== null && msg.status) {
        chrome.tabs.sendMessage(capturingTabId, { type: 'status', text: msg.status }).catch(() => {});
      }
      return sendResponse({ ok: true });
    }
    return sendResponse({ ok: false, error: 'Unknown message: ' + msg.type });
  })();
  return true; // async sendResponse
});

// If the captured tab is closed / navigated away, stop cleanly.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturingTabId) stopCapture();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === capturingTabId && changeInfo.url) stopCapture();
});

// Reset stale "capturing" state on extension reload / browser restart.
chrome.runtime.onStartup.addListener(async () => {
  capturing = false;
  capturingTabId = null;
  await setState({ error: '' });
});
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await setState({ error: '' });
});
