# Tab Whisper — Local Tab Audio to Whisper

> **Firefox version:** see the [`firefox/`](firefox/) folder — same features (dB gate, hallucination blocklist, 500 fallback), but built on `captureStream()` instead of `tabCapture`, so it only works on pages with a real `<video>`/`<audio>` element. Install as a temporary add-on via `about:debugging`.

A Chrome MV3 extension that captures the **active tab's audio** and feeds it,
in chunks, to **your own local Whisper server**. No cloud transcription,
no account, no 20-minutes-a-month freemium timer.

Built for: watching a Russian-speaking live stream in desktop Chrome and
reading the English translation live, using a local Whisper (via OpenWebUI /
whisper.cpp / faster-whisper) that you already run.

## What it does

1. Click **Start capturing this tab** in the popup, or press **Ctrl+Shift+Y** (Mac: Cmd+Shift+Y) — the shortcut toggles capture on the active tab. The extension calls
   `chrome.tabCapture.capture()` on the active tab.
2. An offscreen document records the tab audio with `MediaRecorder`
   (WebM/Opus, default 10-second chunks — configurable 3–60 s).
3. Each chunk is POSTed as multipart/form-data to your configured
   Whisper endpoint, OpenAI-compatible:
   - Task **Translate** → `…/v1/audio/translations` (Russian speech → English text)
   - Task **Transcribe** → `…/v1/audio/transcriptions` + `language=ru`
     (Russian speech → Russian text)
4. The returned text appears live in:
   - a bottom overlay on the page (toggleable / dismissible), and
   - the popup's Transcript history (kept in `chrome.storage.local`, max 200 lines, Copy all / Clear).

## Install (Load unpacked)

1. Open Chrome (desktop only — Chrome on Android does not support extensions).
2. Go to `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`tab-whisper-extension/`).
4. Pin the extension (puzzle icon → pin “Tab Whisper”).

No build step, no npm, no remote code. The only network traffic is the
POST to the Whisper URL you configure.

## Point it at your Whisper

Open the extension popup → **Whisper server** section. Nothing here is
pre-filled with a real server — the defaults are localhost placeholders.
Fill in yours:

| Setting | What to put |
|---|---|
| Endpoint URL | Your OpenAI-compatible transcriptions URL. Default: `http://localhost:8080/v1/audio/transcriptions` |
| API key | Blank for a local, no-auth server. If your server requires auth, paste the key (OpenWebUI: your OpenWebUI API key). |
| Model | The model name your server expects, e.g. `whisper-1`, or your local model name. |
| Language | `ru` (source language, used for Transcribe; Translate ignores it and outputs English). |
| Task | **Translate** (default, Russian → English) or **Transcribe**. |
| Chunk (seconds) | 10 by default. Shorter = lower latency, more Whisper calls, worse context. Longer = better sentences, more lag. |
| Overlay | Show/hide the on-page live transcript. |

### OpenWebUI

OpenWebUI's native STT endpoint is usually:

```
http://localhost:8080/api/v1/audio/transcriptions
```

— note the `/api/` segment. If you set the plain `/v1/…` URL and get
HTTP 404, switch to the `/api/v1/…` form (or vice versa for a plain
whisper.cpp / faster-whisper server, which uses `/v1/audio/transcriptions`).
The extension derives the `/translations` endpoint from whichever base
you enter, so you only need to get the transcriptions URL right.

If your OpenWebUI is on a different host/port (e.g. another machine on
your LAN, `http://192.168.x.x:8080`), put that host/port in the URL.
The manifest allows `localhost` and `127.0.0.1`. If your server is on a
different LAN host, add that host to `host_permissions` in `manifest.json`
and reload the extension.
scheme/host, add it to `host_permissions` in `manifest.json` and reload
the extension.

### whisper.cpp / faster-whisper server

Point the URL at your server's OpenAI-compatible endpoint, e.g.:

```
http://localhost:8080/v1/audio/transcriptions
```

Set **Model** to whatever your server expects (some local servers ignore
the model field entirely; some require an exact local model name).

## Test it — in this order

1. **YouTube first (controlled test).** Open a Russian-language YouTube
   video in Chrome, make sure you can hear it, click the extension →
   **Start capturing this tab**. Within ~10 s + Whisper inference time
   you should see English lines in the overlay and in the popup history.
   If nothing appears, check the popup status line — it reports the
   Whisper HTTP error verbatim (404 = wrong URL, connection refused =
   server not running).
2. **Live stream next.** Open the live stream tab, start capture on
   *that* tab. Live speech is messier than a recorded video (music,
   overlapping talk, BRB screens) — expect occasional empty chunks
   (skipped automatically if < 1 KB) and imperfect sentences.
3. **Then the real room.** Same steps. Keep the captured tab active:
   tabCapture only works on the active tab in its window.

## v1.0.14 — Overlay only on the capturing tab (Nov 25, 2026)

- Bug fix: the overlay was built on EVERY tab on page load, because the content script (injected into `<all_urls>`) built it unconditionally. Now it builds on demand only — when capture starts on that tab, or the first transcript/status line arrives for it. Other tabs get no overlay at all.

## v1.0.13 — Copy all keeps the language tag (Nov 25, 2026)

- Bug fix: Copy all was dropping the `[Language]` tag — the popup display showed it, but the copied text was built from `l.text` only. Now copied lines match the display: `3:51:02 PM [English] 🎵`.

## v1.0.12 — Auto-detect language (Nov 25, 2026)

- Whisper requests now use `response_format=verbose_json` (was `json`), which returns the auto-detected source language. Every overlay/popup line is tagged, e.g. **[Russian] Hello**, and the overlay shows `» Detected language: Russian (ru)` when it changes. Caveat: Whisper guesses from the first seconds of a chunk, so a short/noisy chunk can mis-detect — treat it as "possibly", not certain.

## v1.0.11 — Keyboard shortcut (Nov 25, 2026)

- **Ctrl+Shift+Y** (Mac: Cmd+Shift+Y) starts/stops capture on the active tab, no popup needed. Change it at `chrome://extensions/shortcuts`, or click **Change shortcut…** in the popup — pick any combination you want, or remove it entirely.

## v1.0.10 — Firefox parity (Nov 25, 2026)

Ported back from the Firefox fork (which diverged Nov 25):
- **dB gate (user-settable):** popup "Ignore chunks quieter than (dB)", default -40, range -60 to -10. Implemented in `offscreen.js` with an AnalyserNode tapped parallel to the audio passthrough (no sound change). Quiet chunks are skipped, overlay shows `» Skipped quiet chunk (peak X dB < -40 dB) — not sent to Whisper.` Music is loud and still passes — the blocklist below is what catches those.
- **Hallucination blocklist:** exact-match drop of "thanks for watching", "thank you for watching", "продолжение следует", "субтитры сделал dimatorzok".
- **Translate fallback on 500 too:** was 404/405 only; now also falls back to transcriptions once on a 500 (server language-detection crash / GPU OOM).
- **Overlay buttons:** capture-phase delegated listener + `type="button"` + `pointer-events:auto` — cam pages were swallowing Hide/X clicks. Plus dedup guard (chunk + text) and `» status` lines relayed to the overlay.
- **Default URL is localhost** `http://localhost:8080/v1/audio/transcriptions` — point it at your own Whisper server in the popup.
- **Not ported (Firefox-only, N/A on Chrome):** `captureStream()` media-element capture, storage `browser.*` shim, audio-only MediaStream fix (tabCapture is audio-only already), top-frame-only overlay (Chrome manifest already has no `all_frames`).

## Known limits

- **Desktop Chrome only.** No Android, no Firefox (MV3 + tabCapture differ).
- **Active tab only.** Switching tabs stops the audio feed for the
  captured tab; navigating the captured tab or closing it stops capture
  cleanly (the extension stops and reports it in the popup).
- **Latency ≈ chunk length + Whisper inference.** At 10 s chunks, expect
  roughly 12–20 s behind live speech on a local GPU box, longer on CPU.
  This is a live *translation* feed, not a real-time conversation — you
  will always be a chunk behind the speaker.
- **One capture at a time.** If another app/extension is already
  capturing the tab, `tabCapture` fails with a plain error in the popup
  (“tab already captured” / “no audio”). Close the other capturer,
  reload the tab, and try again.
- **No audio = no transcript.** A muted tab, a BRB/away screen, or a
  tab with no audio track produces no chunks. Unmute the tab/video first.
- **Whisper quality depends on your model.** Small/fast local models
  mistranslate slang, names, and music-over-speech. Larger models are
  slower. If output is garbage on a clean YouTube test, the problem is
  the model/settings, not the extension.
- **Privacy:** audio chunks are sent to the Whisper URL you configured
  and nowhere else. If that URL is a cloud service, that service hears
  the audio — keep it pointed at localhost / your LAN if you want it
  fully local.

## Troubleshooting (popup status line tells you the truth)

| Symptom | Likely cause / fix |
|---|---|
| `Whisper unreachable … connection refused` | Local Whisper / OpenWebUI isn't running, or host/port is wrong. Start it, check the URL. |
| `Whisper HTTP 404` | Wrong endpoint path. OpenWebUI needs `/api/v1/audio/transcriptions`; plain servers need `/v1/audio/transcriptions`. |
| `Whisper HTTP 401 / 403` | Server requires an API key. Paste it in the popup (OpenWebUI API key). |
| `tabCapture returned no stream` / `already captured` | Another extension/app is capturing, or the tab was just reloaded. Reload the tab, stop other capturers, retry. |
| `Tab has no audio track` | Tab isn't playing sound. Unmute the tab / start the video first. |
| Transcript appears but is empty / `[silence]` | Chunk was silence/music only. Normal on BRB screens; the extension skips tiny chunks automatically. |
| Overlay doesn't appear | The page blocks content-script injection (e.g. `chrome://` pages, some store pages). Capture still works — read the transcript in the popup. |

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: `tabCapture`, `activeTab`, `storage`, `scripting`, `offscreen` permissions; host permissions for localhost / LAN Whisper hosts. |
| `background.js` | Service worker: state, start/stop, offscreen lifecycle, transcript history (max 200), overlay injection, tab-close/navigation cleanup. |
| `offscreen.html` / `offscreen.js` | Offscreen document: `tabCapture.capture()` + `MediaRecorder` chunking + POST to Whisper. This is where audio is actually captured — a service worker cannot do MediaRecorder. |
| `popup.html` / `popup.js` / `popup.css` | Popup: Start/Stop, Whisper settings (URL, key, model, language, task, chunk seconds, overlay toggle), live status, transcript history with Copy all / Clear. |
| `content.js` / `content.css` | On-page overlay: bottom bar with the latest 3 English lines + timestamps, Hide/Show and close buttons. |
| `icon16.png` / `icon48.png` / `icon128.png` | Extension icons. |
| `README.md` | This file. |

## What was deliberately NOT built

- No cloud transcription fallback, no API key for any third-party service.
- No stream-URL scraping (`.m3u8` / HLS) — tabCapture makes that unnecessary.
- No auto-start on page load, no background capture of tabs you didn't choose.
