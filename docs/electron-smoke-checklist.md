# Open Flow — Electron Smoke Checklist

Manual verification list for the Electron shell. Run after any non-trivial
change to main process wiring, hotkey, audio, overlay, setup or Settings.

Two ways to run it:

- **Dev (`npm run dev`)** for the daily loop. macOS attributes permissions to the
  terminal or Electron binary, not to an installed open-flow.
- **Packaged (`npm run package`, then reinstall from the DMG)** for anything about
  first launch, permissions, login item or Gatekeeper. Changes under `src/` and
  `dist/` do not reach an installed app until it is repackaged and reinstalled.

The renderer pages can also be previewed without launching Electron:
`npx tsx tools/renderer-preview/build.ts` prints the Chrome commands (setup and
Settings, light and dark, with mocked data). That checks layout only, not behavior.

## Pre-flight

- `npm run fetch-binaries` and `npm run fetch-test-models` once if missing (dev runs).
- To test setup from scratch: quit open-flow, delete
  `~/Library/Application Support/open-flow/preferences.json` (and the models in
  `~/Library/Application Support/open-flow/models` if you want the download too).
  To test permissions from scratch, remove open-flow from Microphone, Accessibility
  and Automation in System Settings › Privacy & Security.

## Setup assistant (first launch)

The window is 640×620 and opens without a white flash. The step list reads
Welcome · Permissions · Quality · Download · Ready.

1. **Welcome:** headline "Dictate anywhere on your Mac. Nothing leaves it." and three bullets. Click **Continue**.
2. **Permissions:** three cards, Microphone, Accessibility and Automation, each with its own status badge ("Not asked yet" / "Granted" / "Denied — fix in System Settings"). **Continue** stays disabled until all three are granted.
   - Microphone: **Allow microphone** shows the macOS prompt; after a denial the button becomes **Open System Settings**.
   - Accessibility: **Open System Settings** lists open-flow under Privacy & Security › Accessibility. Turn it on and **come back without clicking anything**: within about a second the badge turns green by itself.
   - Automation: **Allow automation** shows the macOS prompt "open-flow wants to control System Events" with the open-flow wording. After a denial the button becomes **Open System Settings**.
3. **Quality:** three cards (Fast, Balanced, Maximum quality). Balanced is preselected and tagged "Recommended". Each card shows the download size, RAM and a time estimate. Maximum quality also shows "The 3B cleanup model is licensed for non-commercial use only." A card reads "Already on this Mac" when both models are installed. "Free space on this Mac" turns red when the chosen level will not fit.
4. **Download:** progress with bytes, speed and time left ("220 MB of 490 MB · 12 MB/s · about 25 s left"), Whisper first then the cleanup model ("1 of 2", "2 of 2").
   - **Cancel download** stops it and shows "Download paused." with **Resume** and **Choose a smaller quality level**. **Resume** continues from the bytes already on disk (the `.partial` file in the models folder is kept, the progress bar does not restart from 0).
   - Turn Wi-Fi off mid-download: the error reads "No internet connection" with **Try again**; no URL or hash appears anywhere.
5. **Quit and resume:** close the window mid-setup. A dialog asks "Quit setup?" with **Quit Setup** and **Keep Going**. Quit Setup, relaunch: setup reopens on the step you left (never past Download, and on Quality if you had not chosen a level).
6. **Ready:** the window stays open. "Starting up… loading the models you just downloaded (about 10 s)." changes to "Switch to Notes or any text field, hold ⌥ Option, speak, then release." once the app is ready. The toggle "Open open-flow at login" is visible and **on** by default.
7. Dictate into another app (not the setup window, which cannot receive dictation). The live line goes Listening… → Transcribing… → Cleaning up… → Pasting… → "Pasted — nice." **Finish** closes the window without a confirmation.

## Launch (normal)

8. `npm run dev`, or open the installed app.
9. The menubar icon appears **right away**, before the models load. Its menu's first line reads "open-flow <version> — Loading models…", then "Starting cleanup model…", then "Ready — hold ⌥ to dictate".
10. Click the icon. The menu shows, in order: the status line, "Pause dictation", "Settings…", "Check permissions…", "Open Logs", "Relaunch open-flow", "Quit open-flow".
11. The Dock icon is NOT visible (menubar-only app).

## Accessibility missing (auto-arming)

Remove open-flow from Accessibility (or start from a fresh install) and launch it with setup already complete.

12. macOS shows its standard Accessibility prompt once. There is **no blocking dialog** and the app does not quit. The menu status reads "Needs Accessibility permission", with a disabled hint line "Open System Settings › Privacy & Security › Accessibility and turn on open-flow".
13. Turn open-flow on in System Settings. Within a few seconds, without relaunching, the status becomes "Ready — hold ⌥ to dictate" (or "Ready — if Option doesn't respond, choose Relaunch open-flow") and the hint disappears. Hold Option: it must record. If it does not, choose **Relaunch open-flow**; if the status reads "Permission granted — relaunch to activate", also relaunch. Note which one happened: it decides whether the "if Option doesn't respond" wording can go.

## First dictation

14. Focus a text field somewhere (TextEdit, Notes.app, browser address bar).
15. Hold either **Option** key (for at least ~150 ms). Overlay window appears at bottom-center with red pulsing dot and "Recording…" and a live transcript.
16. Speak for ~3 seconds: *"Hello, this is a test of the open flow dictation system."*
17. Release Option. Overlay updates through "Transcribing…" (yellow) → "Cleaning…" (green) → "Pasting…" (blue) → fades out.
18. The cleaned text appears pasted into the focused text field.

## Settings

Open it from the tray menu: **Settings…**. The window is 640×600, resizable down to 560×480, follows the system light/dark appearance, and has four tabs: General, Dictation, Models, Advanced. Arrow keys move between tabs; the last tab you used is remembered. There is no Save button: every control applies as soon as you change it, and the panel shows a short confirmation ("Saved").

19. **General:** "Open open-flow at login" (check System Settings › General › Login Items follows it), Language, the Dictation key line "Hold ⌥ Option (left or right)", and a Permissions list with Microphone, Accessibility and Automation. Not-granted rows have **Open System Settings**. After changing a permission in System Settings and returning, the list refreshes; **Check again** also re-runs the Automation check. Tray › **Check permissions…** opens Settings on this tab.
20. **Dictation:** "Clean up with the local model", "Spoken punctuation commands" and the Dictionary (placeholder "e.g. Kubernetes"; Enter or **Add**; × removes a term). Add a term, then dictate it: it applies without a restart.
21. **Models:** two groups, Speech recognition and Text cleanup. Each card shows name, description, size and RAM, and a badge: Active / Installed / Not downloaded. The Qwen 2.5 3B card shows the non-commercial license line.
    - **Download** shows progress in % with **Cancel**. Cancel, then **Download** again: it resumes. Click Download, then click other cards or **Delete** another model while it runs: every button keeps working.
    - **Use** on an installed model makes it Active at once and shows a "Restart required" badge on that group plus the banner "Restart open-flow to apply your model changes." Switch back to the original model: the badge and banner disappear on their own. **Restart now** relaunches the app.
    - **Delete** on the Active model is refused with "Can't delete the active model. Choose another model first." (no "Error invoking remote method" text).
    - "Models on disk: …" and **Show in Finder** open the models folder. Sizes use decimal units, so Whisper Small reads "490 MB".
    - Turning "Clean up with the local model" on or off (Dictation tab) also shows "Restart required" and the banner.
22. **Advanced:** "Debug logging" applies immediately (a `debug.log` appears next to `error.log` in the logs folder, and stops growing when turned off); **Open Logs**; **Run setup again** asks for confirmation ("This will reopen the setup assistant and restart open-flow. Your models stay on disk.") and, if confirmed, restarts into setup with the models kept; the version line "open-flow <version>" and the GitHub link.

## Edge cases

23. **Cancel via overlay:** Start recording, click the ✕ button on the overlay. Recording stops and pipeline does not run.
24. **Short tap:** Tap Option for less than ~150 ms. Nothing happens: no overlay, no paste. Holding Option and pressing another key (e.g. Option+arrow) must not dictate or must cancel a recording in progress.
25. **Pause + resume:** Tray menu → "Pause dictation" (the first line reads "Paused"). Holding Option now does nothing. Choose "Resume dictation", dictation works again.
26. **Quit:** Tray menu → "Quit open-flow". App exits cleanly; no orphan processes (`ps -ef | grep -E "(open-flow|electron|whisper-server|llama-server)"` should show none).

## If something fails

Logs live in `~/Library/Logs/open-flow/error.log`. Turn on "Debug logging" in Settings › Advanced (it takes effect immediately) to also write `debug.log`. "Open Logs" in the tray menu or in Settings › Advanced opens the folder.
