# Streaming Whisper — design notes (branch: `streaming-whisper`)

## Goal

Cut user-perceived latency on medium/long dictations by transcribing
audio chunks as the user speaks, so by the time Option is released
most of the transcription work is already done.

Target steady state on 10s of audio: ~900ms post-release (today: ~2.5s).

## Architecture

```
recorder.js                  main process                    whisper-stream addon
─────────────                ────────────                    ─────────────────────
captures 16kHz audio  ───►   AudioOrchestrator              [whisper_context]
                              .appendChunk()                  loaded once at boot
                                  │
                                  ▼
                            every N seconds while
                            recording:
                              .snapshot()    ──────────►   feedSamples(buf)
                                                            │
                                                            ▼
                                                          processChunk(language)
                                                            ◄──── new text suffix
                              merge & dedup
                                  │
                                  ▼
                           overlay live preview
                              (optional)

on PTT 'stop':                whisper-stream:
                              finalize(language)
                                ◄──── final tail
                              merge committed + tail
                                  │
                                  ▼
                              LLM cleanup → paste
```

## Phase plan

### Phase 1 — Foundation

- Build `libwhisper.a` (static) via fetch-binaries.sh (already linked into
  whisper-cli, but we now expose it for the native addon).
- New native addon `native/whisper-stream/whisper_stream.mm` that:
  - links libwhisper + ggml + Metal frameworks
  - exposes `init(modelPath)`, `start()`, `feedSamples(buf)`,
    `processChunk(language)`, `finalize(language)`, `release()` from JS
- node-gyp config (mirror of `binding.gyp` for the PTT addon)
- electron-rebuild flow

### Phase 2 — Inference loop

- Internal Vec<float> buffer holds all samples for the current utterance
- `processChunk()` calls `whisper_full()` on the **entire** buffer (Whisper's
  model expects ≤30s windows; we re-encode each time — duplicate compute
  but simple, deterministic)
- Returns the latest full transcript as a string
- `finalize()` does one last `whisper_full()` to capture any tail not seen
  by the last processChunk, returns final transcript

### Phase 3 — Merge & dedup

The native addon returns the FULL transcript each call. The Node side
needs:

- A `committedText: string` representing the text we've already shown the
  user (in overlay) or kept for the pipeline.
- After each `processChunk()` returns `current`:
  - find longest common **word-level** prefix between `committedText` and
    `current` (split by whitespace, compare lowercased tokens)
  - `newSuffix = current.slice(commonPrefix.length)`
  - update `committedText = current` (we trust the latest full inference)
  - emit `newSuffix` to overlay for live preview
- On finalize: ignore committedText entirely, use the FINAL whisper output
  as the source of truth for the LLM cleanup + paste

**Why word-level not char-level**: whisper changes its mind about word
boundaries (e.g. "non ne ho" vs "non n'ho") across passes. Char-diff
would over-report changes; word-level is more stable.

### Phase 4 — Race conditions

Single in-flight inference per utterance. The chunk pump is gated:

```ts
class StreamingWhisperManager {
  private inFlight: Promise<string> | null = null;

  async tick() {
    if (this.inFlight) return; // skip — previous chunk still processing
    this.inFlight = this.processChunk()
      .finally(() => { this.inFlight = null; });
    const text = await this.inFlight;
    this.applyDiff(text);
  }
}
```

- A new tick can't start while the previous is running → no concurrent
  whisper_full on the same context (libwhisper isn't thread-safe per
  context).
- On `finalize()`, AWAIT any in-flight chunk first, then run finalize.
- On `cancel()` (user chord), set a `cancelled` flag and ignore any
  in-flight chunk's result + skip finalize.
- A new `start()` waits for previous `release()` to complete (idempotent
  if already released).

### Phase 5 — Live preview UI (optional)

- Coordinator emits a new state event with partial text
- Overlay updates "Transcribing…" → shows the current text in a small
  font preview
- On finalize, the cleaned text replaces the preview

This phase is purely additive and can be deferred.

## Trade-offs (re-confirmed)

| Aspect | Win | Loss |
|---|---|---|
| Latency (>5s audio) | -500/1500ms post-release | — |
| Latency (<3s audio) | ~0 | One extra inference round during recording |
| Quality | — | -5/15% vs batch (model trained on 30s windows; chunked input has less context) |
| Battery | — | Whisper always active during recording |
| Complexity | — | Native addon + race-condition state machine |
| LLM cleanup latency | — | Unchanged (still needs full transcript) |

## Cancel / quit safety

- `release()` is idempotent. Called on app quit + on every model switch.
- All sample buffers cleared on `start()`.
- whisper-stream addon shipped as a separate `.node` file (asarUnpack
  for the dlopen path).

## What lands first

This commit only sets up the branch + design doc. Implementation will
land progressively:

1. fetch-binaries.sh exposes libwhisper for linking
2. binding.gyp + scaffold .mm file
3. JS bridge with init/release pair (smoke test)
4. feedSamples + processChunk
5. dedup + integration into PipelineCoordinator
6. live preview UI hookup
