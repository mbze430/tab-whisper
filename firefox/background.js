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
// Tab Whisper — Firefox background page (MV2, persistent)
// Thin hub only: the capture + MediaRecorder + Whisper POST all live
// in content.js, because Firefox has NO tabCapture and NO offscreen
// API. The content script taps the page's <video>/<audio> element
// with captureStream() and does the work there.
// No audio ever leaves the machine except to the Whisper URL the
// user configured in the popup (default: ai-i:10300).

const MAX_HISTORY = 200;

const DEFAULT_SETTINGS = {
  whisperUrl: 'http://10.0.253.30:10300/v1/audio/transcriptions', // IP, not FQDN: Firefox proxy can't resolve .adhome.home, and temp add-on storage is wiped on reload so the default is what you get
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
  const stored = await storageGet('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setState(patch) {
  await storageSet({ state: { capturing, tabId: capturingTabId, ...(patch || {}) } });
}

async function startCapture(tabId) {
  if (capturing) return { ok: false, error: 'Already capturing. Stop first.' };
  const settings = await getSettings();
  capturing = true;
  capturingTabId = tabId;
  await setState({ startedAt: Date.now(), error: '' });
  // FIX: content scripts are NOT injected into tabs that were already
  // open when the temporary add-on was loaded. Inject it now, on demand,
  // before messaging it — otherwise tw-start has no receiver and Start
  // does literally nothing, with no error.
  try {
    if (_browser && _browser.tabs.executeScript) {
      await _browser.tabs.executeScript(tabId, { file: 'content.js' });
      await _browser.tabs.insertCSS(tabId, { file: 'content.css' });
    } else {
      await new Promise((res) => chrome.tabs.executeScript(tabId, { file: 'content.js' }, () => res()));
      await new Promise((res) => chrome.tabs.insertCSS(tabId, { file: 'content.css' }, () => res()));
    }
  } catch (e) {
    // Non-fatal: the script may already be injected, or this is a
    // chrome:// / about: page where injection is forbidden.
    console.log('[TabWhisper FF] on-demand inject failed (may already be injected):', e.message);
  }
  // The content script in the frame that actually has a <video>/<audio>
  // element will attach to it. Frames with no media element watch for
  // one for ~30s and then stay quiet — no error spam.
  try {
    await ( _browser ? _browser.tabs.sendMessage(tabId, { type: 'tw-start', settings }) : new Promise((res, rej) => chrome.tabs.sendMessage(tabId, { type: 'tw-start', settings }, () => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())) );
  } catch (e) {
    capturing = false;
    capturingTabId = null;
    await setState({ error: e.message });
    return { ok: false, error: 'Could not reach the tab content script: ' + e.message + '. Reload the page and try again.' };
  }
  return { ok: true };
}

async function stopCapture() {
  if (!capturing) return { ok: true };
  const tabId = capturingTabId;
  capturing = false;
  capturingTabId = null;
  await setState({ stoppedAt: Date.now(), error: '' });
  if (tabId !== null) {
    try { await ( _browser ? _browser.tabs.sendMessage(tabId, { type: 'tw-stop' }) : new Promise((res) => chrome.tabs.sendMessage(tabId, { type: 'tw-stop' }, () => res())) ); } catch (e) { /* tab gone */ }
  }
  return { ok: true };
}

async function appendTranscript(line) {
  const stored = await storageGet('transcript');
  const history = stored.transcript || [];
  history.push(line);
  while (history.length > MAX_HISTORY) history.shift();
  await storageSet({ transcript: history });
  // Relay live to the top-frame overlay in the captured tab. The
  // capturing frame may be an iframe (video), whose content script no
  // longer builds an overlay — the top frame renders it instead.
  if (capturingTabId !== null) {
    try {
      if (_browser) await _browser.tabs.sendMessage(capturingTabId, { type: 'transcript', line });
      else chrome.tabs.sendMessage(capturingTabId, { type: 'transcript', line });
    } catch (e) { /* overlay not present */ }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'popup-start') {
      const [tab] = _browser ? await _browser.tabs.query({ active: true, currentWindow: true }) : await new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, res));
      if (!tab || tab.id === undefined) return sendResponse({ ok: false, error: 'No active tab found.' });
      return sendResponse(await startCapture(tab.id));
    }
    if (msg.type === 'popup-stop') {
      return sendResponse(await stopCapture());
    }
    if (msg.type === 'popup-status') {
      return sendResponse({ ok: true, capturing, tabId: capturingTabId, settings: await getSettings() });
    }
    if (msg.type === 'tw-transcript') {
      await appendTranscript(msg.line);
      return sendResponse({ ok: true });
    }
    if (msg.type === 'tw-error') {
      capturing = false;
      capturingTabId = null;
      await setState({ error: msg.error || 'Capture error.' });
      return sendResponse({ ok: true });
    }
    if (msg.type === 'tw-status') {
      await setState({ offscreen: msg.status || '' });
      return sendResponse({ ok: true });
    }
    return sendResponse({ ok: false, error: 'Unknown message: ' + msg.type });
  })();
  return true; // async sendResponse
});

// Keyboard shortcut (v1.0.10): Ctrl+Shift+Y (Cmd+Shift+Y on Mac) toggles
// capture on the active tab. Change it in Firefox: about:addons → gear →
// Manage Extension Shortcuts.
const _commands = (_browser && _browser.commands) ? _browser.commands : chrome.commands;
if (_commands && _commands.onCommand) {
  _commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-capture') return;
    if (capturing) { await stopCapture(); return; }
    const [tab] = _browser ? await _browser.tabs.query({ active: true, currentWindow: true }) : await new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, res));
    if (!tab || tab.id === undefined) return;
    await startCapture(tab.id);
  });
}

// If the captured tab is closed / navigated away, stop cleanly.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturingTabId) stopCapture();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === capturingTabId && changeInfo.url) stopCapture();
});

chrome.runtime.onStartup.addListener(async () => {
  capturing = false;
  capturingTabId = null;
  await setState({ error: '' });
});
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await storageGet('settings');
  if (!stored.settings) await storageSet({ settings: DEFAULT_SETTINGS });
  await setState({ error: '' });
});
