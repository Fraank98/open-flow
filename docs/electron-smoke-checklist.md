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

## Reply suggestions (optional feature)

This feature is off by default. The two `lsof` checks below (14 and 21/22)
are the discriminating checks for the RAM guarantee: **while the feature is
off, no second `llama-server` process may exist, ever.** Do not run these
against `/Applications/open-flow.app` — that copy is already running and in
use. Build and launch a throwaway dev copy instead:

```bash
npm run build && npx electron dist/main/index.js
```

### Turning it on and off

Feature **off** (this is the state on a fresh install, and the state you
should return to before closing this section):

14. `lsof -iTCP:18082 -sTCP:LISTEN` in a terminal. **Expected: empty output**
    (the command prints nothing and exits). If a `llama-server` line prints,
    a reply-suggestions process is running despite the feature being off —
    that is the RAM regression this checklist exists to catch; stop and
    report it, do not continue to the next steps.
15. Press `Command+Control+R` over any window. Nothing should happen on
    screen — and there is nothing to check in the log for this state: while
    the feature is off, the accelerator is never registered with macOS in
    the first place (`applyReplyHotkey` only registers it once the server
    reports `ready`), so the keypress never reaches the app at all — no
    `reply ignored` or any other reply-related line is written anywhere. If
    a pill, a flash, or **any** line mentioning `reply` appears in either
    `~/Library/Logs/open-flow/error.log` or `debug.log`, the hotkey reacted
    while off — report it, quoting the line.
16. Dictation still works as before: hold **Option** over a text field,
    speak, release — the transcript pastes normally. This confirms the
    reply wiring did not disturb the existing pipeline.

Open Preferences (menubar icon → Preferences) and look at the "Reply
suggestions" section:

17. The **checkbox is disabled** (grayed out, cannot be checked) as long as
    either the name field is empty or the selected tier's model is not
    downloaded, and the shared status line at the bottom of the window
    names what is missing (e.g. "inserisci il tuo nome" or "scarica
    Standard") — this should already read that way on a fresh install,
    before you touch anything. If the checkbox can be ticked with the name
    empty and no model installed, or the status line stays blank, report it.
18. Type your name, then in the tier list click **Download** on the
    Standard tier (2.49 GB — this will take a while on a real connection).
    When it finishes, click the Standard row to select it. **Expected:**
    the checkbox is no longer disabled and no impediment message remains.
    Tick it now, but **do not click Save yet** — the next step exercises
    the hotkey field first, and needs the checkbox already ticked to do so.
19. With the checkbox now ticked, click into the hotkey field and type
    `Alt+R`. **Expected:** the message below the field changes to "Option è
    riservata alla dettatura…" and the **Save button becomes disabled**.
    Clear it and type `Command+1`. **Expected:** the message becomes "1, 2,
    3 ed Esc sono le scorciatoie della pill…". Clear it and type
    `Command+Control+R` (the default). **Expected:** the message returns to
    the neutral "Non può contenere Option…" text and **Save is enabled
    again**. If Save stays enabled on the invalid values, or stays disabled
    on the valid one, report which. (This blocking is deliberately gated on
    the checkbox being ticked: type `Alt+R` again, then untick the
    checkbox — Save should become enabled despite the still-invalid hotkey
    text, because an invalid value left over in an *off* feature must not
    block saving an unrelated change, like the dictionary or a model. Tick
    the checkbox and restore `Command+Control+R` before continuing.) Now
    click **Save**. **Expected:** the button reads **"Save"**, not "Save &
    Restart" — none of these fields are restart-required. If the app
    restarts or the button says "Save & Restart", report it.
20. Watch the status line under the checkbox (it refreshes every ~2s).
    **Expected sequence:** `stato: downloading` (only if the model wasn't
    already resident) → `stato: starting` → `stato: ready`, with no app
    restart anywhere in the sequence.
21. Once the status line reads `ready`:
    ```bash
    lsof -iTCP:18082 -sTCP:LISTEN
    ```
    **Expected:** exactly one `llama-server` line. Open Activity Monitor,
    find that process, and note its resident memory (RSS) — report the
    number here, and compare it with what you noted at step 14 (which
    should have been "no such process").
22. Untick the checkbox and click **Save**. Within a few seconds:
    ```bash
    lsof -iTCP:18082 -sTCP:LISTEN
    ```
    **Expected: empty again**, same as step 14. Recheck Activity Monitor:
    resident memory should drop back to roughly what it was before step 19
    (the `llama-server` process is gone; the OS reclaims its RAM). Report
    the before/after numbers from steps 14/21/22 together.

### Once it's ready — exercising the pill

Prerequisites: the tier's model downloaded, `userDisplayName` set, the
feature switched on and the state line showing `ready` (i.e. steps 17-21
above, completed and left in the "on" state for this sub-section — turn the
feature back off per step 22 once you're done here).

23. **Slack, conversation where the other person wrote last.** Mouse over the
    messages, `Command+Control+R`. The pill shows "Preparo le risposte…" then
    the gist row and two or three proposals with `⌘1 ⌘2 ⌘3`.
24. **`⌘2`** pastes the second proposal into Slack's input field. Nothing is sent.
25. **Click on a row** pastes the same way, even though the click may activate
    the overlay: the app is re-activated first.
26. **`Esc`** closes the pill; `⌘1/2/3` then reach the app underneath again.
27. **Timeout:** raise the pill and wait 20 s without touching it — it closes.
    Move the mouse over it and wait: the timer restarts.
28. **Mail** on a received message with the reply window open, and **Brave** on
    a web conversation: same as 23.
29. **Out of scope:** hotkey on a document, on an empty field, on a thread where
    you wrote last, on a question asking for information ("a che ora arrivi?").
    The pill flashes "Nessuna proposta" for a second. The reason is never shown.
30. **App not allowed:** hotkey over an app that is not in the list → "App non
    abilitata — aggiungila nelle preferenze". The preferences now offer
    "Aggiungi <bundle id>".
31. **Two monitors:** cursor on the secondary → the pill appears on the
    secondary. With the target app NOT frontmost → "Nessuna proposta".
32. **Dictation wins:** raise the pill, then hold Option → the pill closes and
    the dictation starts; `⌘1/2/3` reach the app underneath again.
33. **Feature off:** switch it off, save, then `lsof -iTCP:18082 -sTCP:LISTEN`
    → empty. Check the resident memory in Activity Monitor before and after,
    on a 16 GB Mac.
34. **Privacy:** `grep -iE "review|preventivo|INTERLOCUTORE" ~/Library/Logs/open-flow/*.log`
    → no matches, with `debugLogging` on too.

### Two-monitor overlay positioning

This checks `overlay-bounds.ts`, shared by the dictation pill and the reply
pill — item 31 above already covers the cursor-follow case, so it is not
repeated here. Requires two monitors connected.

35. **No clipping.** On each of the two monitors, check that the pill is
    fully visible — no edges cut off on the right, left or bottom, and the
    pill's shadow (the faint dark halo underneath it) renders in full, not
    truncated by the window edge.
36. **Dock moved to a side.** In System Settings → Desktop & Dock, move the
    Dock to the left or right edge on one of the two monitors. Raise the
    pill on that monitor again (mouse over it, trigger a dictation or a
    reply suggestion). **Expected:** the pill stays centered on the free
    space *between* the Dock and the opposite screen edge, not on the full
    physical width of the monitor — the positioning centers on the work
    area (usable space, excluding Dock and menu bar), not on the screen's
    physical bounds, and this is the one check in this list where that
    choice is visible to the eye. Put the Dock back on the bottom when done.
37. **Disconnect and reconnect a monitor with the app open.** With the app
    already running and the pill already shown at least once, disconnect
    the secondary monitor and trigger the pill again (with only one screen
    left): it must appear on the remaining screen, not freeze or disappear.
    Reconnect the secondary monitor and trigger the pill again with the
    mouse over it: it must reappear there. This confirms the display list is
    re-read on every appearance of the pill, not just at app startup.
38. **Secondary monitor on the left, negative coordinates.** In System
    Settings → Displays, arrange the secondary monitor to the **left** of
    the primary (so macOS assigns it negative x coordinates). Trigger the
    pill with the cursor on that monitor: it must appear correctly there,
    not off-screen or in the wrong position.

## Known limitations (Plan 2 scope)

- Hotkey is tap-to-toggle, not push-to-talk. PTT requires `uiohook-napi` (Plan 2b).
- Models hard-coded to fixture paths (`test/fixtures/models/...`). Real model manager comes in Plan 3.
- No permission prompts UI; failures are logged only.
- Tray icon is a generated placeholder.

## If something fails

Logs live in `~/Library/Logs/open-flow/error.log`. Set `OPEN_FLOW_DEBUG=1` to also write `debug.log`.
