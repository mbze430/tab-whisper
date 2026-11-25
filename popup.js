// Tab Whisper — popup: Start/Stop, settings, transcript history.
// Settings are stored in chrome.storage.local and read by the
// background / offscreen document. No defaults point at any real
// server of Johnny's — the default is localhost, he fills in his own.

const DEFAULT_SETTINGS = {
  whisperUrl: 'http://10.0.253.30:10300/v1/audio/transcriptions',
  apiKey: '',
  model: 'whisper-1',
  language: 'ru',
  task: 'translate',
  chunkSeconds: 10,
  overlayEnabled: true,
  minDb: -40
};

const $ = (id) => document.getElementById(id);

function readForm() {
  return {
    whisperUrl: $('whisperUrl').value.trim() || DEFAULT_SETTINGS.whisperUrl,
    apiKey: $('apiKey').value,
    model: $('model').value.trim() || 'whisper-1',
    language: $('language').value.trim() || 'ru',
    task: $('task').value,
    chunkSeconds: Math.max(3, Math.min(60, Number($('chunkSeconds').value) || 10)),
    minDb: Math.max(-60, Math.min(-10, Number($('minDb').value) || -40)),
    overlayEnabled: $('overlayEnabled').checked
  };
}

function fillForm(s) {
  $('whisperUrl').value = s.whisperUrl;
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model;
  $('language').value = s.language;
  $('task').value = s.task;
  $('chunkSeconds').value = s.chunkSeconds;
  $('minDb').value = (s.minDb === undefined || s.minDb === null) ? -40 : s.minDb;
  $('overlayEnabled').checked = s.overlayEnabled !== false;
}

async function saveSettings(silent) {
  const settings = readForm();
  await chrome.storage.local.set({ settings });
  if (!silent) {
    $('saveMsg').textContent = 'Saved. Takes effect on the next Start (stop first if capturing).';
    setTimeout(() => { $('saveMsg').textContent = ''; }, 4000);
  }
  return settings;
}

function renderHistory(history) {
  const box = $('history');
  if (!history || !history.length) {
    box.innerHTML = '<div class="empty">No transcript yet. Start capture on a tab with Russian speech.</div>';
    return;
  }
  box.innerHTML = history.slice(-100).map((l) => {
    const time = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const safe = String(l.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langTag = l.languageName ? '[' + String(l.languageName).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '] ' : '';
    return '<div class="line"><span class="time">' + time + '</span>' + langTag + safe + '</div>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function refresh() {
  const stored = await chrome.storage.local.get(['settings', 'transcript', 'state']);
  fillForm({ ...DEFAULT_SETTINGS, ...(stored.settings || {}) });
  renderHistory(stored.transcript || []);
  const state = stored.state || {};
  const capturing = !!state.capturing;
  $('startBtn').disabled = capturing;
  $('stopBtn').disabled = !capturing;
  const status = $('status');
  if (state.error) {
    status.className = 'status error';
    status.textContent = 'Error: ' + state.error;
  } else if (capturing) {
    status.className = 'status live';
    status.textContent = '● Capturing tab audio — English transcript is being generated. Latency is roughly one chunk + Whisper inference time.';
  } else {
    status.className = 'status idle';
    status.textContent = 'Idle — not capturing.';
  }
}

$('startBtn').addEventListener('click', async () => {
  await saveSettings(true);
  $('status').className = 'status idle';
  $('status').textContent = 'Starting capture…';
  const reply = await chrome.runtime.sendMessage({ type: 'popup-start' });
  if (!reply || !reply.ok) {
    $('status').className = 'status error';
    $('status').textContent = 'Error: ' + ((reply && reply.error) || 'Failed to start capture.');
  }
  await refresh();
});

$('stopBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'popup-stop' });
  await refresh();
});

$('saveBtn').addEventListener('click', () => saveSettings(false));

// User-choosable shortcut: Chrome extensions can't rebind a command
// from inside the extension — the browser owns the binding. This button
// just opens the browser's shortcut settings, where any combination
// can be picked (or the shortcut removed entirely).
const changeBtn = $('changeShortcutBtn');
if (changeBtn) changeBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

$('clearBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ transcript: [] });
  renderHistory([]);
});

$('copyBtn').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get('transcript');
  // v1.0.13 / v1.0.12 fix: Copy all was dropping the language tag —
  // renderHistory shows [Language] but this built text from l.text only.
  const text = (stored.transcript || []).map((l) => new Date(l.at).toLocaleTimeString() + ' ' + (l.languageName ? '[' + l.languageName + '] ' : '') + l.text).join('\n');
  try { await navigator.clipboard.writeText(text); $('copyBtn').textContent = 'Copied'; } catch (e) { $('copyBtn').textContent = 'Copy failed'; }
  setTimeout(() => { $('copyBtn').textContent = 'Copy all'; }, 2000);
});

// Live updates while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.transcript) renderHistory(changes.transcript.newValue || []);
  if (changes.state) refresh();
});

refresh();
