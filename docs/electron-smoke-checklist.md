# Open Flow — Electron Smoke Checklist

Manual verification list for the dev-mode Electron shell. Run after any
non-trivial change to main process wiring, hotkey, audio, or overlay.

## Pre-flight

- Run `npm run fetch-binaries` and `npm run fetch-test-models` once if missing.
- macOS: System Settings → Privacy & Security → Microphone — open the panel so
  Electron can request access on first run.
- macOS: System Settings → Privacy & Security → Accessibility — same.

## Launch

1. `npm run dev`
2. Verify a tray icon appears in the menubar (microphone-shaped, dark/light theme aware).
3. Click the tray icon — context menu shows "open-flow — Idle", "Disable hotkey", "Quit open-flow".
4. Dock icon should NOT be visible (menubar-only app).

## First dictation

5. Focus a text field somewhere (TextEdit, Notes.app, browser address bar).
6. Press `Option+Space` (Alt+Space). Overlay window appears at bottom-center with red pulsing dot and "Recording…".
7. Speak for ~3 seconds: *"Hello, this is a test of the open flow dictation system."*
8. Press `Option+Space` again. Overlay updates through "Transcribing…" (yellow) → "Cleaning…" (green) → "Pasting…" (blue) → fades out.
9. The cleaned text should appear pasted into the focused text field.

## Edge cases

10. **Cancel via overlay:** Start recording, click the ✕ button on the overlay. Recording stops and pipeline does not run.
11. **Empty audio:** Press hotkey, immediately press again. Pipeline runs but transcript should be empty or near-empty; no paste occurs.
12. **Disable + re-enable:** Tray menu → "Disable hotkey". Hotkey now does nothing. Re-enable, dictation works again.
13. **Quit:** Tray menu → "Quit open-flow". App exits cleanly; no orphan processes (`ps -ef | grep -E "(open-flow|electron|whisper-cli|llama-cli)"` should show none).

## Known limitations (Plan 2 scope)

- Hotkey is tap-to-toggle, not push-to-talk. PTT requires `uiohook-napi` (Plan 2b).
- Models hard-coded to fixture paths (`test/fixtures/models/...`). Real model manager comes in Plan 3.
- No permission prompts UI; failures are logged only.
- Tray icon is a generated placeholder.

## If something fails

Logs live in `~/Library/Logs/open-flow/error.log`. Set `OPEN_FLOW_DEBUG=1` to also write `debug.log`.
