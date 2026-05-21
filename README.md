# Open Flow

Local-first dictation app for macOS. Hotkey → record → Whisper → LLM cleanup → paste into the active text field.

Status: **foundation phase** — headless core modules only. No GUI yet.

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

## Project layout

See `docs/superpowers/specs/2026-05-21-open-flow-mvp-design.md` for the full design.

Headless modules live under `src/main/`:
- `whisper-runner.ts` — spawns `whisper-cli`
- `llm-cleaner.ts` — spawns `llama-cli` with cleanup prompt + sanitizer
- `logger.ts` — file logger with rotation
- `utils/` — WAV encoder, prompt template, output sanitizer, model paths

## Known limitations (foundation phase)

- Output sanitizer doesn't yet strip llama.cpp end-of-text markers (`<<</transcript>`, `[end of text]`) that may leak into cleaned output. Hardening pass in Plan 2.
- On Apple Silicon, Node must run natively (arm64). The build script auto-reexecs via `arch -arm64` if needed, but tests assume the runtime path is also arm64.
- Tiny Whisper model produces imperfect transcriptions — fine for integration tests, but use `base` or larger for real use.

## Status / next plans

- Plan 1 — Foundation (this repo) — done
- Plan 2 — Electron shell (hotkey, audio capture, overlay, paste) — pending
- Plan 3 — Distribution (setup wizard, model manager, .dmg, CI) — pending
