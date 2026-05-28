# Pause-other-audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When dictation arms, pause any media playing on the default audio output (Spotify, Apple Music, browser video, etc.); resume it when the pipeline ends (success, error, or cancel).

**Architecture:** Extend the existing `ptt_monitor` native addon with two CoreAudio/Cocoa helpers (`isAudioOutputRunning`, `postMediaPlayPause`). A small TS `MediaController` class with one piece of state (`pausedByUs`) gates pause/resume. Wire it into `index.ts` at the three PTT hooks (arm / stop's `finally` / cancel) plus the IPC cancel.

**Tech Stack:** Node-API (C++/Objective-C++), CoreAudio (`AudioObjectGetPropertyData`), AppKit (`NSEvent`), CoreGraphics (`CGEventPost`), TypeScript, Vitest.

**Branch:** `pause-other-audio` (already created, spec at `docs/superpowers/specs/2026-05-28-pause-other-audio-design.md`).

**Rebuild reminder:** This dev shell runs under Rosetta. Native rebuilds **must** use `./node_modules/.bin/electron-rebuild -f --arch arm64` — without `--arch arm64` you get an x86_64 `.node` that the arm64 Electron app refuses to load.

---

## Task 1: Native addon — link CoreAudio + add audio-control functions

**Files:**
- Modify: `binding.gyp` (link CoreAudio.framework on the `ptt_monitor` target)
- Modify: `native/ptt-monitor/ptt_monitor.mm` (add includes, two functions, two ModuleInit registrations)

- [ ] **Step 1: Add CoreAudio.framework to the `ptt_monitor` target in `binding.gyp`**

In `binding.gyp`, locate the `ptt_monitor` target's `link_settings.libraries` array and add the CoreAudio framework. It should look like:

```python
"link_settings": {
  "libraries": [
    "$(SDKROOT)/System/Library/Frameworks/Cocoa.framework",
    "$(SDKROOT)/System/Library/Frameworks/Foundation.framework",
    "$(SDKROOT)/System/Library/Frameworks/ApplicationServices.framework",
    "$(SDKROOT)/System/Library/Frameworks/CoreAudio.framework"
  ]
}
```

`NSEvent` (Cocoa) and `CGEventPost` (ApplicationServices) are already covered by the existing entries.

- [ ] **Step 2: Read the current `native/ptt-monitor/ptt_monitor.mm` to find the include block and the `ModuleInit` (or `Init` / `Napi::Object Init`) function**

Use the Read tool. Identify (a) the existing top-of-file includes, (b) the function that builds the `exports` object and registers Napi functions. We will add to both.

- [ ] **Step 3: Add the CoreAudio include at the top of `ptt_monitor.mm`**

Add this near the existing includes (it's a C header so it doesn't matter whether it's grouped with `#include` or `#import`):

```cpp
#include <CoreAudio/CoreAudio.h>
```

- [ ] **Step 4: Add `IsAudioOutputRunning` to `ptt_monitor.mm`**

Place it before the `ModuleInit` function, in the same namespace/file scope as the existing Napi functions:

```cpp
// Returns true iff something is actively flowing through the current default
// output device — i.e. another process is playing audio. Uses the public
// CoreAudio property kAudioDevicePropertyDeviceIsRunningSomewhere, which
// reports activity across ALL processes (not just the caller).
Napi::Value IsAudioOutputRunning(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  AudioObjectPropertyAddress defaultOutAddr = {
    kAudioHardwarePropertyDefaultOutputDevice,
    kAudioObjectPropertyScopeGlobal,
    0  // kAudioObjectPropertyElementMain on macOS 12+, value is 0 on all SDKs
  };
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  OSStatus s = AudioObjectGetPropertyData(
    kAudioObjectSystemObject, &defaultOutAddr, 0, NULL, &size, &device);
  if (s != noErr || device == kAudioObjectUnknown) {
    return Napi::Boolean::New(env, false);
  }

  AudioObjectPropertyAddress isRunningAddr = {
    kAudioDevicePropertyDeviceIsRunningSomewhere,
    kAudioObjectPropertyScopeGlobal,
    0
  };
  UInt32 isRunning = 0;
  size = sizeof(isRunning);
  s = AudioObjectGetPropertyData(device, &isRunningAddr, 0, NULL, &size, &isRunning);
  if (s != noErr) {
    return Napi::Boolean::New(env, false);
  }
  return Napi::Boolean::New(env, isRunning != 0);
}
```

- [ ] **Step 5: Add `PostMediaPlayPause` to `ptt_monitor.mm`**

Place it directly after `IsAudioOutputRunning`:

```cpp
// Posts a system Play/Pause media key (the same event the keyboard's hardware
// Play/Pause key generates). macOS routes it to the current Now Playing app,
// so it pauses Spotify / Music / Safari & Chrome video / QuickTime / Podcasts
// etc. A second invocation toggles back to playing. If no app is registered
// as Now Playing, the event is harmlessly dropped.
Napi::Value PostMediaPlayPause(const Napi::CallbackInfo& info) {
  // Constants from IOKit/hidsystem/ev_keymap.h, inlined to avoid pulling the
  // header (and a framework link) just for two numbers.
  static const int NX_KEYTYPE_PLAY = 16;
  static const int kSubtypeAuxControlButtons = 8;

  // Emit key down (0xA) then key up (0xB) — both are needed for the system
  // to register a media-key press.
  for (int state : { 0xA, 0xB }) {
    NSEvent *ev = [NSEvent otherEventWithType:NSEventTypeSystemDefined
                                     location:NSZeroPoint
                                modifierFlags:0xA00
                                    timestamp:0
                                 windowNumber:0
                                      context:nil
                                      subtype:kSubtypeAuxControlButtons
                                        data1:(NX_KEYTYPE_PLAY << 16) | (state << 8)
                                        data2:-1];
    CGEventPost(kCGHIDEventTap, [ev CGEvent]);
  }
  return info.Env().Undefined();
}
```

- [ ] **Step 6: Register both functions in `ModuleInit`**

In the function that builds `exports` (look for existing `exports.Set("...", Napi::Function::New(...))` calls), add:

```cpp
exports.Set("isAudioOutputRunning", Napi::Function::New(env, IsAudioOutputRunning));
exports.Set("postMediaPlayPause",  Napi::Function::New(env, PostMediaPlayPause));
```

- [ ] **Step 7: Rebuild the native addon for arm64**

```bash
cd /Users/dany/Developer/open-flow
./node_modules/.bin/electron-rebuild -f --arch arm64 2>&1 | tail -3
file build/Release/ptt_monitor.node
```

Expected last lines: `✔ Rebuild Complete` and `Mach-O 64-bit bundle arm64`.

- [ ] **Step 8: Smoke-test the new exports load**

Create a throwaway harness file `tmp-mc-smoke.cjs`:

```js
const fs = require("fs");
try {
  const a = require("./build/Release/ptt_monitor.node");
  const keys = Object.keys(a).sort();
  fs.writeFileSync("tmp-mc-smoke.out",
    `exports=${keys.join(",")}\n` +
    `isAudioOutputRunning=${typeof a.isAudioOutputRunning}\n` +
    `postMediaPlayPause=${typeof a.postMediaPlayPause}\n` +
    `isAudioOutputRunning() => ${a.isAudioOutputRunning()}\n`);
} catch (e) {
  fs.writeFileSync("tmp-mc-smoke.out", "FAIL " + e.message);
}
```

Run it under Electron's arm64 node (the dev shell node is x86_64):

```bash
ELEC=$(node -e "process.stdout.write(require('electron'))")
ELECTRON_RUN_AS_NODE=1 "$ELEC" tmp-mc-smoke.cjs >/dev/null 2>&1
cat tmp-mc-smoke.out
rm -f tmp-mc-smoke.cjs tmp-mc-smoke.out
```

Expected: both functions report `function`, the exports list includes `isAudioOutputRunning` and `postMediaPlayPause`, and the boolean is `true` or `false` (whichever matches the current playback state on the machine). **Do NOT** call `postMediaPlayPause()` in this smoke — it would pause whatever the user is currently listening to.

- [ ] **Step 9: Commit**

```bash
git add binding.gyp native/ptt-monitor/ptt_monitor.mm
git commit -m "feat(native): add isAudioOutputRunning + postMediaPlayPause to ptt_monitor

CoreAudio detects whether the default output device is being driven by any
process (kAudioDevicePropertyDeviceIsRunningSomewhere). The play/pause key
is posted as an NSEvent.NSEventTypeSystemDefined via CGEventPost — the same
event a hardware Play/Pause key produces.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: TDD — `MediaController` class + native loader

**Files:**
- Create: `test/unit/media-control.test.ts`
- Create: `src/main/media-control.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/media-control.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { MediaController } from "../../src/main/media-control.js";

function makeFakeNative(isRunning: boolean) {
  return {
    isAudioOutputRunning: vi.fn(() => isRunning),
    postMediaPlayPause: vi.fn(),
  };
}

describe("MediaController.pauseIfPlaying", () => {
  it("posts a media key when audio output is running", () => {
    const native = makeFakeNative(true);
    new MediaController(native).pauseIfPlaying();
    expect(native.postMediaPlayPause).toHaveBeenCalledTimes(1);
  });

  it("does nothing when nothing is playing", () => {
    const native = makeFakeNative(false);
    new MediaController(native).pauseIfPlaying();
    expect(native.postMediaPlayPause).not.toHaveBeenCalled();
  });

  it("is idempotent — never double-pauses", () => {
    const native = makeFakeNative(true);
    const m = new MediaController(native);
    m.pauseIfPlaying();
    m.pauseIfPlaying();
    expect(native.postMediaPlayPause).toHaveBeenCalledTimes(1);
  });
});

describe("MediaController.resume", () => {
  it("posts a media key after a successful pause", () => {
    const native = makeFakeNative(true);
    const m = new MediaController(native);
    m.pauseIfPlaying();
    m.resume();
    expect(native.postMediaPlayPause).toHaveBeenCalledTimes(2);
  });

  it("does nothing if we did not pause anything", () => {
    const native = makeFakeNative(true);
    new MediaController(native).resume();
    expect(native.postMediaPlayPause).not.toHaveBeenCalled();
  });

  it("does not double-resume — only the first resume after a pause fires", () => {
    const native = makeFakeNative(true);
    const m = new MediaController(native);
    m.pauseIfPlaying();
    m.resume();
    m.resume();
    expect(native.postMediaPlayPause).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail because the module doesn't exist**

```bash
cd /Users/dany/Developer/open-flow
npx vitest run test/unit/media-control.test.ts 2>&1 | tail -10
```

Expected: `Failed to load url ../../src/main/media-control.js` (or equivalent "Cannot find module" error). The exact wording can vary; what matters is that the file is missing.

- [ ] **Step 3: Implement `MediaController` + the native loader**

Create `src/main/media-control.ts`:

```ts
import { createRequire } from "node:module";
import { join } from "node:path";

export interface MediaControlNative {
  /** Returns true iff the system default output device is currently being
   *  driven by any process (i.e. some app is playing audio). */
  isAudioOutputRunning: () => boolean;
  /** Post a system Play/Pause media key event — toggles whatever the OS
   *  considers the current Now Playing app. */
  postMediaPlayPause: () => void;
}

/**
 * Loads the audio-control exports from the ptt_monitor native addon. The two
 * functions live there (rather than in their own .node) because that addon
 * already handles system event work and avoids a second native target.
 */
export function loadMediaControlNative(appRoot: string, isPackaged: boolean): MediaControlNative {
  const require_ = createRequire(import.meta.url);
  const candidates = isPackaged
    ? [
        join(appRoot, "..", "app.asar.unpacked", "build", "Release", "ptt_monitor.node"),
        join(appRoot, "build", "Release", "ptt_monitor.node"),
      ]
    : [join(appRoot, "build", "Release", "ptt_monitor.node")];
  let lastErr: unknown = null;
  for (const path of candidates) {
    try {
      const addon = require_(path) as Record<string, unknown>;
      if (typeof addon.isAudioOutputRunning !== "function" ||
          typeof addon.postMediaPlayPause !== "function") {
        throw new Error(
          "ptt_monitor.node is missing media-control exports — rebuild the native addon",
        );
      }
      return {
        isAudioOutputRunning: addon.isAudioOutputRunning as () => boolean,
        postMediaPlayPause: addon.postMediaPlayPause as () => void,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not load media-control native. Tried: ${candidates.join(", ")}. ` +
    `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/**
 * Pauses other media when dictation starts and resumes it when the pipeline
 * ends. Single piece of state (`pausedByUs`) makes both methods idempotent
 * and ensures we never resume something we did not pause.
 */
export class MediaController {
  private pausedByUs = false;

  constructor(private readonly native: MediaControlNative) {}

  pauseIfPlaying(): void {
    if (this.pausedByUs) return;
    if (!this.native.isAudioOutputRunning()) return;
    this.native.postMediaPlayPause();
    this.pausedByUs = true;
  }

  resume(): void {
    if (!this.pausedByUs) return;
    this.native.postMediaPlayPause();
    this.pausedByUs = false;
  }
}
```

- [ ] **Step 4: Run the tests — confirm they pass**

```bash
npx vitest run test/unit/media-control.test.ts 2>&1 | tail -6
```

Expected: `Test Files  1 passed (1)` / `Tests  6 passed (6)`.

- [ ] **Step 5: Run the full unit suite — confirm nothing else broke**

```bash
npx vitest run test/unit 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  16 passed (16)` / `Tests  96 passed (96)` (the previous baseline was 90 — adding 6 new tests gets to 96).

- [ ] **Step 6: Typecheck + lint scoped to the new files**

```bash
npm run typecheck 2>&1 | tail -3
npx eslint src/main/media-control.ts test/unit/media-control.test.ts 2>&1 | tail -3
```

Expected: typecheck PASS (no output after the `tsc` line); eslint silent (no output = clean).

- [ ] **Step 7: Commit**

```bash
git add src/main/media-control.ts test/unit/media-control.test.ts
git commit -m "feat(media-control): MediaController class with TDD coverage

Pause/resume with a single 'pausedByUs' flag — idempotent on both methods,
never resumes something we didn't pause. Native shim is dependency-injected
so the class tests cleanly without loading the .node.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire `MediaController` into `index.ts`

**Files:**
- Modify: `src/main/index.ts`

Hook points: PTT `arm` (pause), PTT `cancel` (resume), the stop handler's `finally` (resume after the pipeline runs — covers both success and the coordinator's internal error path), and `ipcMain.on("pipeline:cancel")` (resume on UI-driven cancel).

- [ ] **Step 1: Add the import**

In the import block at the top of `src/main/index.ts`, add:

```ts
import { MediaController, loadMediaControlNative } from "./media-control.js";
```

- [ ] **Step 2: Construct the controller after the permissions check**

Find the existing line `await logger.info("permissions", { mic, accessibility: acc });`. Immediately after it, add:

```ts
  const mediaController = new MediaController(loadMediaControlNative(APP_ROOT, app.isPackaged));
  await logger.info("media-control ready");
```

- [ ] **Step 3: Hook `ptt.on("arm")` — pause if media is playing**

Find the existing `ptt.on("arm", () => { ... })` block. Inside it, before `recorderWin.webContents.send("audio:start");`, add:

```ts
    // Pause any music/video that's playing so it doesn't bleed into the mic
    // and so the user doesn't have to hit pause manually. Resumed in the
    // stop / cancel paths below.
    mediaController.pauseIfPlaying();
```

- [ ] **Step 4: Hook the stop handler's `finally` — resume after the pipeline ends**

Find the existing `ptt.on("stop", async () => { ... })` block — specifically its `try { ... } finally { pipelineBusy = false; }` structure. Inside the `finally`, AFTER `pipelineBusy = false;`, add:

```ts
      mediaController.resume();
```

This covers both the success path (pipeline ran to `done`) and the error path (the coordinator handles its own errors internally; the `finally` always runs).

- [ ] **Step 5: Hook `ptt.on("cancel")` — resume on hardware cancel**

Find the existing `ptt.on("cancel", () => { ... })` block. Add this line inside it, alongside the other reset calls (e.g., near `coordinator.cancel();`):

```ts
    mediaController.resume();
```

- [ ] **Step 6: Hook `ipcMain.on("pipeline:cancel")` — resume on UI cancel**

Find the existing `ipcMain.on("pipeline:cancel", async () => { ... })` block. Add inside it:

```ts
    mediaController.resume();
```

- [ ] **Step 7: Typecheck + lint**

```bash
npm run typecheck >/dev/null 2>&1 && echo PASS || npm run typecheck 2>&1 | tail -6
npx eslint src/main/index.ts 2>&1 | tail -3
```

Expected: typecheck `PASS`; lint silent.

- [ ] **Step 8: Re-run the full unit suite to confirm nothing regressed**

```bash
npx vitest run test/unit 2>&1 | grep -E "Test Files|Tests "
```

Expected: still `Test Files  16 passed (16)` / `Tests  96 passed (96)`.

- [ ] **Step 9: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(media-control): pause other audio on dictation arm, resume on stop/cancel

Wired at four hook points: ptt.on('arm') → pauseIfPlaying, the stop
handler's finally block (covers both success and the coordinator's
internal error path), ptt.on('cancel'), and ipcMain pipeline:cancel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Manual runtime verification

These scenarios cannot be unit-tested (they involve the live system audio routing and the OS Now Playing infrastructure). Run them through the dev app — no packaged DMG needed unless you want one for further testing.

- [ ] **Step 1: Build + launch dev app**

```bash
cd /Users/dany/Developer/open-flow
npm run build 2>&1 | tail -3
npx electron dist/main/index.js &
APP_PID=$!
sleep 3
```

The app should be running in the background.

- [ ] **Step 2: Scenario A — music playing, dictate, expect pause + resume**

Start playing music in Spotify or Apple Music. With music playing:

1. Hold the PTT hotkey, dictate one sentence, release.
2. Observe: music should pause the instant you press PTT, and resume after the pipeline finishes.

Tail the log to confirm the resume fires:

```bash
tail -f ~/Library/Logs/open-flow/error.log
```

Expected events: `pipeline start`, `transcribed`, `pipeline done`, and the existing log lines — there is no dedicated media-control log line (intentional — it's a side effect, not a phase).

- [ ] **Step 3: Scenario B — nothing playing, dictate, expect no toggle**

Stop all media. Press and hold PTT, dictate, release. Observe: nothing starts playing. (`isAudioOutputRunning` returned false, so `postMediaPlayPause` was never sent.)

- [ ] **Step 4: Scenario C — dictate then cancel, expect resume**

Start music. Hold PTT, then press the cancel hotkey (or trigger the UI cancel) while still holding / before the pipeline finishes. Observe: music resumes.

- [ ] **Step 5: Scenario D — Zoom call audio is not paused**

Open a Zoom meeting (or any call app). Confirm call audio keeps flowing across a dictation cycle — the media key affects only Now Playing apps, not call audio.

- [ ] **Step 6: Kill the dev app**

```bash
kill $APP_PID 2>/dev/null
```

- [ ] **Step 7: If all four scenarios pass, the implementation is complete**

No commit at this step — the manual verification doesn't produce artifacts. If a scenario fails, return to the relevant task and fix.

---

## Verification summary

After all tasks pass, the working tree should contain three commits on `pause-other-audio`:

1. `feat(native): add isAudioOutputRunning + postMediaPlayPause to ptt_monitor`
2. `feat(media-control): MediaController class with TDD coverage`
3. `feat(media-control): pause other audio on dictation arm, resume on stop/cancel`

Test count: **96 / 96** (90 baseline + 6 new for `MediaController`).

The branch is ready to merge into `main` (fast-forward, same pattern as `streaming-whisper`).
