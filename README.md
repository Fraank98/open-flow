<p align="center">
  <img src="resources/icons/app-icon.png" width="96" alt="open-flow icon">
</p>

<h1 align="center">open-flow</h1>

<p align="center">
  Hold Option, speak, release — your words land in whatever text field has focus.<br>
  Fully local dictation for macOS: Whisper for speech-to-text, a small LLM to tidy the transcript, nothing leaves your Mac.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://github.com/Fraank98/open-flow/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Fraank98/open-flow"></a>
  <a href="https://github.com/Fraank98/open-flow/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Fraank98/open-flow/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Platform: macOS Apple Silicon" src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey">
</p>

<!-- TODO: docs/media/hero.gif — 6-8 s: cursor in a Notes field, hold Option, overlay shows live transcript, release, text pasted -->

## Features
- **Push-to-talk on the Option key.** Hold either Option key anywhere, talk, release. No window to focus, no toggle to forget.
- **Streaming transcription.** Whisper runs *while* you speak (in-process, via a native whisper.cpp addon with Metal acceleration), so most of the work is done by the time you let go. A small overlay shows the live transcript.
- **Optional cleanup by a local LLM.** A Qwen2.5 model served by llama.cpp removes "uh", "ehm", false starts and adds punctuation. It is removal-only by design (an output sanitizer rejects anything the model invents) and is skipped entirely when the transcript has nothing to clean.
- **Spoken punctuation.** "comma", "new paragraph", "virgola", "point d'interrogation"… become symbols — in English, Italian, Spanish, French and German.
- **Custom dictionary.** Preferred spellings for names, products and jargon: applied to every transcript and fed to Whisper as a hint.
- **Language auto-detect**, or pin one of en / it / es / fr / de.
- **Stays out of the way.** Menubar-only, pauses Spotify / Apple Music while you dictate and resumes them afterwards, restores your clipboard after pasting.
- **Three quality tiers** from ~1 GB to ~3.7 GB of models, switchable in Preferences.

## Privacy
Everything runs on your Mac. The only network traffic open-flow generates is the one-time download of the models you pick, from Hugging Face. There is no telemetry, no crash reporting, no account, no update check. Speech-to-text and cleanup talk to local processes on `127.0.0.1` only — you can confirm it in the sources: the only `fetch()` targets are `huggingface.co` and `127.0.0.1`.

Logs (`~/Library/Logs/open-flow/`) can contain transcript text; they never leave your machine and you can delete them at any time.

## Requirements
- A Mac with **Apple Silicon** (M1 or later). Intel Macs are not supported: the DMG and the engines are arm64-only.
- **macOS 11 or later.** Developed and tested on macOS 26 Tahoe.
- Disk: ~1 GB (Fast) to ~3.7 GB (Max) for models, plus the ~250 MB app.
- Memory: both models stay resident while the app runs, so budget roughly their combined size on top of the app.

## Install
1. Download `open-flow-<version>-arm64.dmg` from the [latest release](https://github.com/Fraank98/open-flow/releases/latest).
2. Open the DMG and drag **open-flow** to **Applications**.
3. **First launch — Gatekeeper.** The build is not signed with an Apple Developer ID, so macOS blocks it the first time ("Apple could not verify "open-flow" is free of malware"). Pick one:
   - **System Settings:** double-click the app once (it gets blocked), then open **System Settings → Privacy & Security**, scroll to *Security* and click **Open Anyway** next to the open-flow message, then confirm. This is the only GUI route on macOS 15 and later; on older versions **Control-click → Open → Open** also works.
   - **Terminal:** remove the quarantine flag, then launch normally:
     ```bash
     xattr -dr com.apple.quarantine /Applications/open-flow.app
     ```
   It's a one-time step per install. If you'd rather not trust a downloaded binary, build it yourself (see below).

## First launch
A short setup window walks you through three things:

1. **Permissions.** Two are needed, and both are granted in macOS System Settings (the window re-checks when you come back to it):
   - **Microphone**, to record your voice.
   - **Accessibility**, so the app can press <kbd>⌘V</kbd> to paste into the focused field.

   If you grant Accessibility after the app has already started, quit and relaunch open-flow: macOS applies the grant to new processes only. open-flow tells you with a dialog.
2. **Quality tier.** Pick one of the tiers below; you can change it later in Preferences.
3. **Download.** The models for the chosen tier are downloaded from Hugging Face into the models folder (see [Where things live](#where-things-live)), each one verified against its SHA-256 checksum. This happens once; a failed download can be retried or you can pick a different tier.

When it finishes, a microphone icon appears in the menubar and you can start dictating.

| Tier | Speech-to-text | Cleanup LLM | Download | Notes |
|---|---|---|---|---|
| Fast | Whisper small (488 MB) | Qwen2.5 0.5B (491 MB) | ~1.0 GB | Lightest |
| Balanced *(default)* | Whisper small (488 MB) | Qwen2.5 1.5B (1.1 GB) | ~1.6 GB | Best trade-off |
| Max | Whisper large-v3-turbo (1.6 GB) | Qwen2.5 3B (2.1 GB) | ~3.7 GB | Most accurate. **The 3B model is licensed for non-commercial use only** — see [Models](#models). |

<!-- TODO: docs/media/setup-wizard.png -->

## Using it
- **Dictate:** hold either **Option** key (at least ~150 ms), speak, release. The overlay shows *Recording…* with the live transcript, then *Transcribing… → Cleaning… → Pasting…*, and the text is pasted into the focused field.
- **Cancel:** click the **✕** on the overlay, or press any other key while holding Option — Option used as a modifier (Option+arrow, Option+letter for accents) never triggers dictation. A tap shorter than ~150 ms is ignored.
- **Length:** there is no fixed limit on how long you can dictate. The streaming transcript is built from the whole recording. (A separate 60-second audio window exists only for the fallback batch transcriber, which is used if the streaming engine fails to start.)
- **Spoken punctuation:** off by default. With it on, *comma*, *period*, *question mark*, *new line*, *new paragraph*, *open/close quote* (and it/es/fr/de equivalents) always become symbols — so "my period" becomes "my ." too. Without it, the LLM still punctuates from context.
- **Dictionary:** Preferences → Dictionary. Each term is normalised in every transcript (case-insensitive) and passed to Whisper as a spelling hint.
- **Language:** *Auto-detect* by default; pin a language if detection flips on short phrases.
- **LLM cleanup:** can be turned off in Preferences. Toggling it, or changing a model, needs a restart — the Save button becomes *Save & Restart*.
- **Tray menu:** status, *Disable hotkey*, *Preferences…*, *Quit*.
- **Launch at login** is on by default; turn it off in Preferences.

## Models
All models are downloaded from Hugging Face on demand and are not bundled in the app.

| Model | License |
|---|---|
| Whisper `small`, `large-v3-turbo` (ggml, [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)) | MIT |
| Qwen2.5-0.5B-Instruct, Qwen2.5-1.5B-Instruct (GGUF Q4_K_M) | Apache-2.0 |
| Qwen2.5-3B-Instruct (GGUF Q4_K_M) | [Qwen Research License](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/LICENSE) — **non-commercial use only** |
| Silero VAD v6.2 (bundled, voice-activity detection) | MIT |

open-flow itself is MIT, but that does not change the models' terms. If you use open-flow for paid work, choose the Fast or Balanced tier (or disable LLM cleanup). Full notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Where things live
| What | Path |
|---|---|
| Models | `~/Library/Application Support/open-flow/models/` (override with `OPEN_FLOW_MODELS_DIR`) |
| Preferences | `~/Library/Application Support/open-flow/preferences.json` |
| Logs | `~/Library/Logs/open-flow/error.log`; `debug.log` when *Debug logging* is on (5 MB, 3 rotations) |

To uninstall: quit, delete `/Applications/open-flow.app` and the folders above, and remove open-flow from the Accessibility and Microphone lists.

## Troubleshooting
- **Holding Option does nothing.** Check that Accessibility and Microphone are granted (System Settings → Privacy & Security), and that the tray menu does not say *Enable hotkey* (meaning it was disabled). If you granted Accessibility after launch, relaunch the app. Also note that while a password field has focus, macOS Secure Input can swallow the Option key release; turn on *Debug logging* and look for `DESYNC` in `debug.log` if you suspect it.
- **The first dictation after a long idle is slow.** macOS throttles the app and the GPU when idle (App Nap). open-flow mitigates it with a power-save blocker and a periodic keepalive pass, but the first dictation after a long break can still be slower than the following ones.
- **The app quit and reopened by itself.** If a Whisper pass hangs for more than 30 seconds the app relaunches itself (`whisper pass stalled` in the log). If it happens repeatedly, open an issue with the log.
- **"Paste failed — text in clipboard".** The ⌘V keystroke was refused or timed out. Your text is on the clipboard: paste it by hand.
- **My previous clipboard was not restored.** If an iOS Simulator is running, reading the clipboard can time out, so open-flow cannot save the old contents to put them back.
- **Only Spotify and Apple Music are paused** while you dictate. Other players are left alone.
- **The setup window appeared again.** A model file for your chosen tier was deleted or changed, so open-flow downloads it again. Let it finish, or pick another tier.
- **Cleanup garbles short phrases.** Small cleanup models can mangle very short or non-English input. Use the Balanced tier, pin the language, or turn LLM cleanup off in Preferences.

## Build from source
Apple Silicon, macOS 11+, Node 20+, Xcode Command Line Tools, `brew install cmake git`.

```bash
git clone https://github.com/Fraank98/open-flow.git && cd open-flow
npm run fetch-binaries      # build whisper.cpp + llama.cpp (5–15 min) — must run BEFORE npm install
npm install                 # also compiles the native addons
npm run fetch-test-models   # optional: tiny models for `npm test`
npm run lint && npm run typecheck && npm test
npm run dev                 # launch the menubar app
npm run package             # → release/open-flow-<version>-arm64.dmg
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the arm64 / Rosetta caveats.

## How it works

```
Option key ─▶ audio capture ─▶ streaming Whisper ─▶ spoken punctuation ─▶ dictionary ─▶ LLM cleanup ─▶ paste
 (ptt_monitor)  (overlay window)  (whisper_stream)                                        (llama-server)  (⌘V)
```

Main-process modules live under `src/main/`:
- `ptt-manager.ts` with the `ptt_monitor.mm` native addon — detects holding either Option key.
- `streaming-whisper-runner.ts` with the `whisper_stream.mm` addon — in-process streaming transcription ([design notes](docs/streaming-whisper-design.md)); `whisper-server.ts` is a batch fallback.
- `llm-server.ts` / `llm-cleaner.ts` — local `llama-server` cleanup pass with a removal-only output sanitizer.
- `pipeline-coordinator.ts` — orchestrates transcribe → spoken punctuation → custom dictionary → cleanup → paste.
- `text-injector.ts` — swaps the clipboard, presses ⌘V through `osascript`, then restores the clipboard.
- `setup-wizard.ts`, `preferences-window.ts`, `model-manager.ts`, `overlay-window.ts`, `menubar-app.ts` — the GUI shell and model downloads.

Release procedure: [docs/release-process.md](docs/release-process.md).

## Roadmap
Configurable hotkey · signed and notarised builds (needs an Apple Developer ID) · an Apache-licensed LLM for the Max tier · Intel support · more languages for spoken punctuation.

## Contributing
Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License
[MIT](LICENSE) © 2026 Danilo Franco. Third-party components and model licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [llama.cpp](https://github.com/ggml-org/llama.cpp) by Georgi Gerganov and the ggml authors.
- [OpenAI Whisper](https://github.com/openai/whisper), the [Qwen](https://github.com/QwenLM/Qwen2.5) team, [Silero VAD](https://github.com/snakers4/silero-vad).
- [Electron](https://www.electronjs.org/).
- The hold-to-talk interaction is inspired by [Wispr Flow](https://wisprflow.ai). open-flow is an independent open-source project and is not affiliated with, endorsed by, or connected to Wispr in any way; "Wispr Flow" is a trademark of its owner.
