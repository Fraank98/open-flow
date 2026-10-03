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
3. Click the tray icon — context menu shows "open-flow <version> — Ready — hold ⌥ to dictate" (it reads "Loading models…" while starting), "Pause dictation", "Settings…", "Check permissions…", "Open Logs", "Relaunch open-flow", "Quit open-flow".
4. Dock icon should NOT be visible (menubar-only app).

## First dictation

5. Focus a text field somewhere (TextEdit, Notes.app, browser address bar).
6. Hold either **Option** key (for at least ~150 ms). Overlay window appears at bottom-center with red pulsing dot and "Recording…" and a live transcript.
7. Speak for ~3 seconds: *"Hello, this is a test of the open flow dictation system."*
8. Release Option. Overlay updates through "Transcribing…" (yellow) → "Cleaning…" (green) → "Pasting…" (blue) → fades out.
9. The cleaned text should appear pasted into the focused text field.

## Edge cases

10. **Cancel via overlay:** Start recording, click the ✕ button on the overlay. Recording stops and pipeline does not run.
11. **Short tap:** Tap Option for less than ~150 ms. Nothing happens: no overlay, no paste. Holding Option and pressing another key (e.g. Option+arrow) must not dictate or must cancel a recording in progress.
12. **Pause + resume:** Tray menu → "Pause dictation" (the first line reads "Paused"). Holding Option now does nothing. Choose "Resume dictation", dictation works again.
13. **Quit:** Tray menu → "Quit open-flow". App exits cleanly; no orphan processes (`ps -ef | grep -E "(open-flow|electron|whisper-server|llama-server)"` should show none).

## If something fails

Logs live in `~/Library/Logs/open-flow/error.log`. Turn on "Debug logging" in Settings (it takes effect immediately) to also write `debug.log`. "Open Logs" in the tray menu opens the folder.
