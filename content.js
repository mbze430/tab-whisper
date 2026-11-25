// Tab Whisper — content script / live overlay
// Shows the latest English transcript lines at the bottom of the page.
// Toggleable, dismissible, and purely presentational: it never
// touches the page's audio, video, or chat.

(function () {
  if (window.__tabWhisperOverlayInstalled) return;
  window.__tabWhisperOverlayInstalled = true;

  const OVERLAY_ID = 'tab-whisper-overlay';
  let visible = true;
  let lines = [];

  function build() {
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.innerHTML =
      '<div class="tw-header">' +
        '<span class="tw-title">Tab Whisper — live English</span>' +
        '<button type="button" class="tw-btn" id="tw-bottom" title="Jump to latest line">↓ Bottom</button>' +
        '<button type="button" class="tw-btn" id="tw-toggle" title="Hide/show transcript">Hide</button>' +
        '<button type="button" class="tw-btn" id="tw-close" title="Remove overlay (capture keeps running)">×</button>' +
      '</div>' +
      '<div class="tw-lines" id="tw-lines"><div class="tw-line tw-empty">Listening… English transcript will appear here.</div></div>';
    document.body.appendChild(el);
    // Firefox parity: per-button bubble-phase listeners were swallowed
    // on cam pages — the page's own click handlers stopPropagation()
    // before our buttons ever see the click. Use ONE capture-phase
    // delegated listener on the overlay itself, so it fires before the
    // page's handlers, and stopPropagation so the page never sees it.
    el.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      if (btn.id === 'tw-bottom') {
        const box = el.querySelector('#tw-lines');
        if (box) box.scrollTop = box.scrollHeight;
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
    // Drag by the header to move the overlay anywhere on the page.
    // Buttons don't start a drag — only the header bar itself.
    const header = el.querySelector('.tw-header');
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Drop the centering transform once, so left/top are absolute.
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
    return el;
  }

  function render() {
    const el = document.getElementById(OVERLAY_ID) || build();
    const box = el.querySelector('#tw-lines');
    if (!box) return;
    // Only auto-scroll if the user was already at the bottom — if they
    // scrolled up to read, don't yank them back down on every new line.
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const recent = lines.slice(-50);
    box.innerHTML = recent.map((l) => {
      const time = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const safe = String(l.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return '<div class="tw-line"><span class="tw-time">' + time + '</span> ' + safe + '</div>';
    }).join('') || '<div class="tw-line tw-empty">Listening…</div>';
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function showLine(line) {
    const last = lines[lines.length - 1];
    if (last && last.chunk === line.chunk && last.text === line.text) return; // already shown — dedup
    lines.push(line);
    if (lines.length > 50) lines.shift();
    build();
    render();
  }

  function showStatus(text) {
    const el = build();
    if (!el) return;
    const box = el.querySelector('#tw-lines');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'tw-line tw-empty';
    div.textContent = '» ' + text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'transcript' && msg.line) {
      showLine(msg.line);
    }
    if (msg.type === 'status' && msg.text) {
      showStatus(msg.text);
    }
  });

  // Show the overlay as soon as the script is injected, so the user
  // sees it is armed even before the first chunk comes back.
  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build, { once: true });
})();
