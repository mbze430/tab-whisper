# Tab Whisper — Firefox (v1.0.9)

Firefox version of Tab Whisper. Same idea as the Chrome version in the
repo root — capture audio, send chunks to your own local Whisper server,
live translation/transcription in an on-page overlay — but built around
what Firefox can actually do.

## Why it's not a 1:1 port

Firefox has **no `tabCapture` API and no offscreen API**. The only
supported route is `captureStream()` on a real HTML5 media element
(`<video>` / `<audio>`) in the page.

- **Works:** YouTube and any site that plays through a `<video>` /
  `<audio>` element.
- **Does NOT work:** WebAudio-only pages, DRM/EME playback (Firefox
  yields a silent stream), system audio, or pages with no media element.

`captureStream()` does not mute the element, so you keep hearing the
page normally — there is no audio-passthrough step like Chrome needs.

## Install (temporary add-on)

Firefox does not allow permanent install of an unsigned extension
from a folder. This is a temporary add-on — it is wiped when Firefox
restarts, and its saved settings reset to the defaults on reload.

1. Open Firefox → `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select this folder's `manifest.json`
4. Open the popup, set your Whisper URL (default is
   `http://localhost:8080/v1/audio/transcriptions`), Save, then Start
   on the tab that is playing.

## v1.0.14 — Overlay ⚙ settings (Nov 25, 2026)

New: a ⚙ button in the overlay header opens a settings panel right on the page — sensitivity (dB gate) slider, -60 to -10, and chunk length, 3–60s. Both save to the same settings the popup uses, and both apply on the next Start.

## v1.0.13 — Overlay only on the capturing tab (Nov 25, 2026)

Bug fix: the overlay was built on EVERY tab on page load. Now it builds on demand only — when capture starts on that tab, or the first transcript/status line arrives for it.

## v1.0.12 — Copy all keeps the language tag (Nov 25, 2026)

Bug fix: Copy all was dropping the `[Language]` tag. Now copied lines match the display: `3:51:02 PM [English] 🎵`.

## v1.0.11 — Auto-detect language (Nov 25, 2026)

Whisper requests now use `response_format=verbose_json`, which returns the auto-detected source language. Every overlay line is tagged, e.g. **[Russian] Hello**. Whisper guesses from the first seconds of a chunk, so a short/noisy chunk can mis-detect.

## Keyboard shortcut

**Ctrl+Shift+Y** (Mac: Cmd+Shift+Y) starts/stops capture on the active tab. Change it in Firefox: about:addons → gear → Manage Extension Shortcuts, or click **Change shortcut…** in the popup — pick any combination you want, or remove it entirely.

## Features (same as Chrome v1.0.10, except where noted)

- 10s chunks (configurable 3–60s), temperature 0, no VAD
- Translate → English / Transcribe in original language
- **dB gate:** popup "Ignore chunks quieter than (dB)", default -40,
  range -60 to -10. Quiet chunks are never sent to Whisper.
- **Hallucination blocklist:** drops "thanks for watching",
  "thank you for watching", "продолжение следует",
  "субтитры сделал dimatorzok"
- Translate falls back to transcriptions once on HTTP 404/405/500
- Overlay: top-frame only, capture-phase Hide/X buttons, dedup,
  `» status` lines

The dB setting takes effect on the next Start, not mid-capture.
