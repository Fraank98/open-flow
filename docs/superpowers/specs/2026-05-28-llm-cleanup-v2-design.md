# LLM Cleanup v2 — design

**Date:** 2026-05-28
**Branch:** `llm-cleanup-v2`
**Status:** approved (verbal across three brainstorming sections), ready for implementation plan

## Problem

The current LLM cleanup (qwen2.5-1.5B, prompt "add punctuation only") is
**net-negative** on Italian speech:

- Whisper-large-v3-turbo already punctuates Italian well, so "add punctuation"
  is mostly a redundant task. Recorded behaviour: the sanitizer's drift
  detector rejected 3 of 3 recent cleanups, and the user has manually disabled
  the feature.
- When the LLM's output DOES slip through (markdown / minor typos under the
  drift threshold), the user receives degraded text instead of Whisper's
  already-good output.
- Every dictation pays ~0.9s of LLM round-trip even when the result is
  thrown away.

The product question is two-fold: which **task** could the LLM realistically
do better than Whisper, and at what **model size** can it do it reliably?

## Scope

In:

- Replace the 1.5B model with a more capable one (qwen2.5-3B-Instruct).
- Replace the punctuation task with **disfluency removal only** — a narrow,
  high-value role Whisper structurally cannot do (Whisper transcribes
  verbatim, including "ehm" / "cioè" / "io— io penso che").
- New prompt: explicit Italian-aware filler list, strict verbatim contract on
  everything else, single allowed exception (capitalize after removing a
  sentence-initial filler).
- Fast-path skip: if the raw transcript contains no obvious filler markers,
  skip the LLM call entirely.
- Catalog + tier update so a user who wants v2 quality can pick it via the
  "max" tier.

Out (explicitly excluded for v1):

- Semantic self-corrections ("send to John, no to Mary" → "send to Mary").
- Number / acronym normalization ("millecinquecento" → "1500").
- Stylistic rewriting / per-app modes (the VoiceInk-style direction).
- Auto-migration of existing user prefs to the new model.

## Design

### Model

**`qwen2.5-3B-Instruct` (GGUF Q4_K_M, ~1.9 GB).** Same family as the
current 1.5B (zero tooling change in `llm-server.ts`), strong multilingual
including Italian, well-tested. Sourced from
`https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF`.

Alternatives considered: Llama-3.2-3B-Instruct (used by the Lirevo project
with identical architecture; slightly weaker on Italian), Gemma-3-4B-it
(~2.5 GB, newer but less track record on this stack). Qwen wins on
Italian quality and continuity.

### Prompt

New `buildCleanupPrompt` template (English instructions, Italian-aware
filler list):

```
Your ONLY job is to remove disfluencies from the transcript. Nothing else.

ABSOLUTE RULES — your output is discarded if you break any of these:
1. Keep ALL other words EXACTLY as they are. Same order, same vocabulary,
   same spelling.
2. Do NOT add, replace, reorder, or paraphrase ANY word.
3. Do NOT translate. Output language = input language.
4. Do NOT touch punctuation or capitalization. The transcript is already
   punctuated. ONLY exception: when you remove a sentence-initial filler
   ("Allora, ..."), also drop the comma that followed it and capitalize
   the next word.
5. Output ONLY the cleaned text. NO commentary, NO preamble like "here is",
   NO quotes, NO markdown.

What to remove (only these, only when CLEARLY fillers — not meaningful words):

A. Verbal fillers (always remove): "uh", "um", "uhh", "ehm", "uhm", "ah", "eh"
   (when standalone, not part of another word).

B. Sentence-initial Italian discourse markers used as filler:
   "allora", "cioè", "diciamo", "praticamente", "insomma", "tipo", "ecco"
   — remove only when they DON'T carry meaning.
   ✓ "Allora, pensavo di andare al mare." → "Pensavo di andare al mare." (filler)
   ✗ "Allora ho deciso di partire." → leave unchanged ("allora" means "then" here)

C. False-start stutters (repetition right after a dash/break):
   "io— io penso che..." → "io penso che..."
   "vol- volevo dire..." → "volevo dire..."
   This is NOT a semantic self-correction; only true repetitions.

When in doubt, leave the word in. Verbatim is always safer than guessing.
```

The existing `<<<transcript>>> ... <<</transcript>>> Cleaned:` framing and
the language-hint line stay (they work).

**Other languages (non-Italian).** The prompt body is the same for all
languages — the Italian list in rule B is always included. For dictation
in en/es/fr/etc. the model sees the Italian list as irrelevant and falls
back to rule A (universal "uh"/"um"/...) plus the verbatim contract.
That's an acceptable v1 behavior: the user's primary language is Italian,
and other languages still benefit from rule A. Per-language filler lists
can be a follow-up if non-Italian dictation becomes a real use case.

### Fast-path skip

Before calling the LLM, the cleaner checks two regexes against the raw
transcript:

```ts
const FILLER_TOKENS = /\b(ehm|uhm|uh|um|ah|eh|cioè|allora|diciamo|praticamente|insomma|tipo|ecco)\b/i;
const FALSE_START = /\w+— ?\w+|\w+- \w+/;
```

If neither matches, the LLM is **not called**. The raw transcript is
returned as-is (with `lightTouchUp` applied — capitalize first letter,
trailing period if missing — to match the existing short-word path's
output style).

The cleaner returns `{ text, usedFallback: false, skipped: true, durationMs }`
with `durationMs` being just the regex check time (sub-millisecond). The
`skipped` field is added to `SanitizedOutput` as an OPTIONAL boolean — old
callers that don't consume it (sanitizer's direct callers) are unaffected;
the pipeline coordinator extends its `cleaned { ... }` log line with
`skipped: true` so the path is obvious in the field log.

Rationale: from the recorded sample of recent dictations, ~70-80% of the
user's transcripts have no filler markers and the LLM's only realistic
output is `verbatim copy of input`. Skipping that round-trip saves the
full ~1.5s LLM latency and removes any drift risk for those inputs.

### Sanitizer / guards

No changes to the output sanitizer — the existing rules (drift > 0.35
fallback, markdown strip, length-ratio guard, repetition guard, single-
short-word skip) are correct and the new task scope makes the drift
detector tighter in practice (a removal-only LLM produces words ⊆ input
words, so legitimate drift is ~0).

**One small tightening** in `LLMCleaner.clean`:

```ts
// was:
const dynamicCap = Math.max(48, Math.ceil(approxInputTokens * 1.8));
// becomes:
const dynamicCap = Math.max(48, Math.ceil(approxInputTokens * 1.2));
```

Removal-only output is ≤ input length; 1.2× covers the few extra tokens a
capitalize-after-filler boundary needs. Lower cap = less runaway.

### Catalog and tiers

`model-catalog.ts` gains one entry:

```ts
{
  id: "qwen-3b",
  filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
  sizeBytes: <fetched from HF at plan time>,
  sha256:   <fetched from HF at plan time>,
  url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
}
```

`TIERS` updates so "max" uses it:

```ts
{ id: "max", label: "Maximum quality",
  description: "Large v3 Turbo + 3B cleanup. ~3.5 GB total. Best accuracy.",
  whisperId: "whisper-large-v3-turbo", llmId: "qwen-3b" }
```

`fast` and `balanced` keep their current models (small + 0.5b / small +
1.5b respectively). The 3B is heavier than `balanced` should be.

`DEFAULT_PREFS.useLlmCleanup` stays `true`. Existing users keep whatever
they have selected (no migration).

### Files touched

- `src/main/model-catalog.ts` — add qwen-3b entry, update max tier.
- `src/main/utils/prompt-template.ts` — replace `SYSTEM_INSTRUCTIONS` with
  the new disfluency-only template; keep `buildCleanupPrompt` signature.
- `src/main/llm-cleaner.ts` — tighten dynamicCap from 1.8× to 1.2×, add
  the fast-path-skip regex check at the top of `clean()` (return raw
  immediately if no markers). Add an optional `fetchImpl` to
  `LLMCleanerOptions` (default: global fetch) so the unit tests can mock
  it without spying on globals — same DI pattern as
  `StreamingWhisperRunner.native` and `MediaController.scripter`.
- `test/unit/prompt-template.test.ts` — update assertions for the new
  prompt body.
- `test/unit/llm-cleaner.test.ts` (new) — test the fast-path skip path.
  The existing happy-path is integration-tested.

No changes to `llm-server.ts` (qwen-3b takes the same flags as 1.5b: `-fa`,
`-ctk q8_0`, `-ctv q8_0`, contextSize 1536). No changes to the sanitizer.

## Risks and edge cases

- **First-launch model download**: ~1.9 GB vs current 1.1 GB. ~70% bigger.
  Acceptable trade-off; the wizard already shows model sizes and lets the
  user pick a smaller tier.
- **Memory footprint** at runtime: qwen-3B-Q4 uses ~2.2 GB RAM with KV cache.
  On low-RAM Macs the wizard's `balanced` (1.5B) is still recommended.
- **Inference latency**: ~2× the 1.5B. Warm ~1.0-1.5s for ~30 tokens of output.
  Combined with the fast-path skip, average dictation latency drops because
  ~70-80% of calls bypass the LLM entirely.
- **Fast-path false negatives**: a transcript with subtle false-start that
  our regex misses ("io, io penso" without a dash) would also miss
  cleanup. Acceptable: Whisper rarely produces that pattern, and the
  failure mode is "verbatim instead of cleaned" — never harmful.
- **Fast-path false positives**: a transcript that contains a filler word
  in legitimate meaning ("Tipo di mascotte" → "tipo" matched as filler)
  triggers an LLM call. The prompt's rule B explicitly handles this
  ("leave when it carries meaning"), and the drift detector is the
  backstop. Cost: an unnecessary LLM call, no harm.

## Test plan

Unit:

1. `prompt-template`: the new system prompt mentions disfluencies (not
   "punctuation"), includes the rule-4 boundary exception, and the
   Italian filler list (B) shows up when language hint is `it`.
2. `llm-cleaner`:
   - Fast-path skip: a clean transcript ("No, lo scroll automatico non
     funziona ancora.") returns `{ usedFallback: false, skipped: true }`
     WITHOUT a fetch call. Mock fetch confirms 0 calls.
   - Filler-present: an input with "ehm" triggers a fetch call (mock
     responds with cleaned text; assert `skipped` is absent/falsy and
     the cleaner returns the cleaned text).
   - False-start "io— io" triggers a fetch call (no fast-path).
   - `dynamicCap` is computed at 1.2× input tokens (numeric assertion via
     mock fetch capturing the request body).
3. `model-catalog`: the "max" tier resolves to whisper-large-v3-turbo +
   qwen-3b; qwen-3b exists in LLM_MODELS.
4. `preferences-store`: no test change (DEFAULT_PREFS unchanged).

Manual / integration (cannot be CI-tested):
- Download qwen-3b via the wizard, switch to "max" tier, dictate a few
  Italian sentences with and without fillers, verify the user-visible
  text is correct.
