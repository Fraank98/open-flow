# Open Flow

Local-first dictation app for macOS — a Wispr Flow-style replica that runs entirely on-device. Hold a key, speak, and your words are transcribed, cleaned up, and pasted into whatever text field has focus. Speech-to-text and cleanup both run locally; nothing is sent to the cloud.

**Pipeline:** hold Option → record → streaming Whisper → spoken punctuation + custom dictionary → optional local LLM cleanup → paste into the active text field.

**Reply suggestions (optional, off by default):** Command+Control+R → read the conversation under the mouse via the Accessibility API → local classifier → local generator → three proposals in the pill → Command+1/2/3 pastes the one you pick. Nothing leaves the machine here either.

## Requirements

- macOS (Apple Silicon recommended)
- Node 20+
- `cmake` and `git` (`brew install cmake git`)
- `ffmpeg` for generating audio fixtures (`brew install ffmpeg`)
- ~6 GB disk for binaries + dev models

## Setup

```bash
npm install
npm run fetch-binaries       # builds whisper.cpp + llama.cpp (~5–15 min)
npm run fetch-test-models    # downloads tiny Whisper + Qwen 0.5B (~500 MB)
```

## Verify the install

```bash
npm run lint && npm run typecheck && npm test
```

All three should pass.

## Try the pipeline

```bash
npm run smoke -- --wav test/fixtures/audio/en-short-clean.wav
```

## Run the Electron dev app

```bash
npm run dev
```

Launches a menubar tray icon. Hold either **Option** key over any text field to dictate; release to transcribe and paste. See `docs/electron-smoke-checklist.md` for the full manual test plan.

## Project layout

See `docs/superpowers/specs/2026-05-21-open-flow-mvp-design.md` for the original design.

Main-process modules live under `src/main/`:
- `ptt-manager.ts` / `hotkey-manager.ts` — push-to-talk on the Option key
- `streaming-whisper-runner.ts` — in-process streaming transcription via the `whisper_stream` native addon (`native/whisper-stream/`), with `whisper-server.ts` as a batch fallback
- `llm-server.ts` / `llm-cleaner.ts` — local `llama-server` cleanup pass with a removal-only output sanitizer
- `pipeline-coordinator.ts` — orchestrates transcribe → spoken punctuation → custom dictionary → cleanup → paste
- `reply-coordinator.ts`, `reply-classifier.ts`, `reply-generator.ts`, `reply-server-manager.ts`, `ax-context-reader.ts` — the optional reply-suggestions feature: a second `llama-server` (port 18082) started only while the feature is on
- `preferences-window.ts`, `setup-wizard.ts`, `model-manager.ts`, `overlay-window.ts`, `menubar-app.ts` — the GUI shell
- `utils/` — spoken punctuation, dictionary correction, initial-prompt builder, WAV encoder, prompt template, output sanitizer, model paths

## Known limitations

- On Apple Silicon, Node and the native addons must run as arm64. The build script auto-reexecs via `arch -arm64` if needed; rebuild native addons with `electron-rebuild -f --arch arm64` (the dev shell's Rosetta x86_64 node otherwise produces an incompatible `.node`).
- The tiny dev Whisper model used by the test fixtures produces imperfect transcriptions — fine for integration tests, but the app downloads `base` or larger for real use.
- The packaged build is unsigned, so the first launch needs **right-click → Open**.
- Reply suggestions are off by default. On, they add a second model in RAM (~3.1 GB with the Standard tier, ~5.8 GB with Max, estimates); off, memory use is identical to before.
- The feature reads only the apps you list (Slack, Mail and Brave by default) and only the window under the mouse, and only when it is frontmost. Nothing read or generated is written to disk or to the log.
- While the proposals are on screen (at most 20 s) `Command+1/2/3` and `Esc` do not reach the app underneath — in browsers those switch tabs.
- The reply hotkey cannot contain Option: dictation is Hold Option.

## Status

- ✅ Plan 1 — Foundation (headless Whisper + LLM cleanup)
- ✅ Plan 2 — Electron shell (hotkey, audio, overlay, paste)
- ✅ Plan 3 — Distribution (setup wizard, model manager, .dmg, CI)

## Install (end-user)

Download the latest `.dmg` from the [Releases page](../../releases), drag `open-flow.app` to Applications, then **right-click → Open** the first time (the build is unsigned).

On first launch, a setup wizard walks you through:

1. Granting microphone + accessibility permissions
2. Picking a quality tier (Fast / Balanced / Max)
3. Downloading the chosen AI models

Then hold the **Option** key over any text field to start dictating, and release to paste.

## Build a release locally

```bash
npm install
npm run fetch-binaries
npm run package
```

Produces `release/open-flow-<version>-arm64.dmg`. See `docs/release-process.md` for the full release workflow.

## License

open-flow is **source-available, not open source**, under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, modify, and
share it for **noncommercial purposes only**. Commercial use — selling it,
offering it as a paid service, or bundling it into a paid product — is reserved
to the project owner. See [CONTRIBUTING.md](CONTRIBUTING.md) for how
contributions are licensed.
