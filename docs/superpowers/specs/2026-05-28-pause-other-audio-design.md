# Pause other audio when dictation starts — design

**Date:** 2026-05-28
**Branch:** `pause-other-audio`
**Status:** approved (verbal), ready for implementation plan

## Problem

When the user starts a dictation, music or other playing media (Spotify, Apple
Music, YouTube/video in the browser, Podcasts, etc.) keeps going. It bleeds
into the microphone (hurting transcription) and the user has to manually
pause it every time. Wispr Flow and similar apps pause it automatically on
PTT and resume when the dictation ends.

## Scope

In:
- Detect whether something is actively playing on the default audio output.
- Pause it automatically when dictation arms (PTT down).
- Resume it automatically when the dictation pipeline ends — including the
  cancel path.

Out (deferred unless explicitly requested):
- User preference toggle (always-on in v1).
- Resume policy beyond "send the same media key again." No volume ducking, no
  per-app control, no Now Playing inspection.

## Design

### Mechanism (public APIs only)

Two new native functions in the existing `ptt_monitor` addon — same process
already does NSEvent monitoring, so this is a natural home for system event
work and avoids a new addon target:

- `isAudioOutputRunning(): boolean` — CoreAudio
  `AudioObjectGetPropertyData(kAudioObjectSystemObject,
  kAudioHardwarePropertyDefaultOutputDevice)` to get the current default
  output device, then `kAudioDevicePropertyDeviceIsRunning` on it.
  Returns true iff something is actively flowing through the speakers right
  now. Public API; works without extra entitlements.

- `postMediaPlayPause(): void` —
  `CGEventCreateKeyboardEvent` is for normal keys; for the media key we build
  a system-defined event with `[NSEvent otherEventWithType: NSEventTypeSystemDefined ...]`
  (subtype `8`, key code `NX_KEYTYPE_PLAY` = 16, down then up) and post it
  via `CGEventPost(kCGHIDEventTap, [event CGEvent])`. This is the same event
  a hardware Play/Pause key generates — macOS routes it to the current Now
  Playing app (Spotify, Music, Safari/YouTube, QuickTime, Podcasts, ...).
  Public API; requires no extra permission beyond Accessibility (already
  granted for PTT). The `NX_KEYTYPE_PLAY` / subtype constants are inlined
  rather than pulled from IOKit headers — they're stable well-known values.

### TypeScript layer (`src/main/media-control.ts`)

```ts
interface MediaControlNative {
  isAudioOutputRunning: () => boolean;
  postMediaPlayPause: () => void;
}

export class MediaController {
  private pausedByUs = false;
  constructor(private readonly native: MediaControlNative) {}

  pauseIfPlaying(): void {
    if (this.pausedByUs) return;             // already paused — no-op
    if (!this.native.isAudioOutputRunning()) return;
    this.native.postMediaPlayPause();
    this.pausedByUs = true;
  }

  resume(): void {
    if (!this.pausedByUs) return;            // we didn't pause anything
    this.native.postMediaPlayPause();
    this.pausedByUs = false;
  }
}
```

Single responsibility, one piece of state. Native is injected so the unit
tests don't need to load the .node.

### Wiring (`src/main/index.ts`)

- Construct `MediaController` once, with the native shim from `ptt_monitor`.
- `ptt.on("arm")` → call `mediaController.pauseIfPlaying()` in parallel with
  the existing `streamingWhisper.start()` and the recorder spin-up — must not
  block recording start.
- After pipeline `done` and on the `error` recovery, call
  `mediaController.resume()`.
- `ptt.on("cancel")` → also call `mediaController.resume()` — if we paused
  the user's music, leaving it paused after a cancel is rude.

### Behavior decisions

- **Always-on** for v1 (no preference). It's a low-friction feature; the
  "I don't want this" case can be added as a preference later if it shows up.
- **Resume on cancel** (not just on a successful dictation).
- **Idempotent**: `pausedByUs` makes both methods safe to call twice. If
  internal state drifts from reality (e.g., the user resumes manually before
  our `resume()` fires), the worst case is one stray toggle — not a crash,
  not a loop.

## Risks and edge cases

- **Transient system sounds** (mail notification, etc.) can briefly flip
  `isAudioOutputRunning` to true. If `arm` happens to fire during one,
  we send a media-key toggle. macOS routes it to whatever the current Now
  Playing app is — likely nothing — so it's a no-op. Acceptable.
- **Zoom / Meet calls** use a separate audio channel and do not respond to
  the media play/pause key. Confirmed safe — calls keep going.
- **Race "user starts a song between pipeline-done and resume"**: the resume
  toggle would pause the just-started song. Rare (requires the user to start
  music in the sub-second window between done and resume). Accepted.
- **No way to know which app was paused** — that's a limitation of the media
  key approach. The trade-off is broad coverage with public APIs vs.
  per-app reliability with limited reach (AppleScript Music/Spotify only).
  Broad coverage wins here.

## Alternatives considered

- **AppleScript per app (`tell application "Music" to pause`)**: deterministic
  but misses browser media, Podcasts, QuickTime, etc. Too narrow.
- **`MRMediaRemoteSendCommand` (private MediaRemote framework)**: cleaner API
  (can query Now Playing app + state), but private and reportedly restricted
  on recent macOS — fragile.
- **System mute / volume to zero**: too aggressive — also kills Zoom audio,
  system sounds, and the user comes back to music still playing (just
  muted). Doesn't pause; just mutes.

## Test plan (TDD)

Unit tests in `test/unit/media-control.test.ts` against the `MediaController`
with a fake native:

1. `pauseIfPlaying` posts the media key and sets `pausedByUs=true` when audio
   output is running.
2. `pauseIfPlaying` does **nothing** (no key posted, flag stays false) when
   the output is silent.
3. `pauseIfPlaying` is a no-op when already paused (no double pause).
4. `resume` posts the media key and clears `pausedByUs` only when we
   previously paused.
5. `resume` is a no-op when we didn't pause.

No native tests — the native functions are thin wrappers over single Apple
APIs and are covered by manual runtime verification.

## Files touched

- `native/ptt-monitor/ptt_monitor.mm` — +2 functions (isAudioOutputRunning,
  postMediaPlayPause), +1 ModuleInit registration.
- `binding.gyp` — link `CoreAudio.framework` (for `AudioObjectGetPropertyData`)
  on the `ptt_monitor` target. (`NSEvent`/`CGEventPost` are covered by Cocoa /
  ApplicationServices, both already linked.)
- `src/main/media-control.ts` — new file (the controller class + native
  loader).
- `src/main/index.ts` — construct controller, wire the three PTT hooks and
  the pipeline-done resume.
- `test/unit/media-control.test.ts` — new file (TDD).
