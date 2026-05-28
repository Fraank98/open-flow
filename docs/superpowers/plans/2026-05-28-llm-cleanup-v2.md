# LLM Cleanup v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the punctuation-only qwen-1.5B cleanup with a disfluency-only qwen-3B cleanup that is skipped entirely when the transcript has no obvious filler markers.

**Architecture:** Add qwen-3b to the model catalog (max tier), rewrite the prompt to remove disfluencies only (strict verbatim contract), add a regex fast-path that bypasses the LLM when no filler markers are present, and tighten the per-request token cap. The output sanitizer is unchanged.

**Tech Stack:** TypeScript, Vitest, llama-server (GGUF), HuggingFace API for model metadata.

**Branch:** `llm-cleanup-v2` (already created, spec at `docs/superpowers/specs/2026-05-28-llm-cleanup-v2-design.md`, commit `525aa08`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/main/model-catalog.ts` | Model registry + tier mapping | Add qwen-3b entry; "max" tier uses it |
| `src/main/utils/prompt-template.ts` | LLM prompt builder | New `SYSTEM_INSTRUCTIONS` (disfluency-only) |
| `src/main/utils/light-touch-up.ts` (NEW) | Tiny pure helper | Extracted from pipeline-coordinator so both coordinator and cleaner can use it |
| `src/main/llm-cleaner.ts` | LLM HTTP client | `fetchImpl` DI, fast-path regex skip, cap 1.8x→1.2x, `skipped` on `CleanResult` |
| `src/main/pipeline-coordinator.ts` | Pipeline orchestration | Import lightTouchUp from new path; extend "cleaned" log line with `skipped` |
| `test/unit/prompt-template.test.ts` | Prompt tests | Update assertions for the new prompt body |
| `test/unit/llm-cleaner.test.ts` (NEW) | Cleaner unit tests | Fast-path skip, fetch DI, cap 1.2x |
| `test/unit/model-catalog.test.ts` | Catalog tests | No edits — structural assertions still hold |
| `test/unit/pipeline-coordinator.test.ts` | Coordinator tests | No edits — meta-field extension is logger-only |

---

## Task 1: Add qwen-3b to the model catalog

**Files:**
- Modify: `src/main/model-catalog.ts`

- [ ] **Step 1: Fetch the exact `sizeBytes` and `sha256` from HuggingFace**

The catalog requires the SHA-256 of the GGUF file for download verification. HF exposes this via its API without downloading the ~1.9 GB file. Run:

```bash
curl -s "https://huggingface.co/api/models/Qwen/Qwen2.5-3B-Instruct-GGUF/tree/main" \
  | python3 -c "import sys,json; data=json.load(sys.stdin); m=next(f for f in data if f['path']=='qwen2.5-3b-instruct-q4_k_m.gguf'); print('sizeBytes:', m['size']); print('sha256:', m['lfs']['oid'])"
```

Expected: two lines, e.g.
```
sizeBytes: 1929456416
sha256: 3a8b...e9d2
```

Record the two values; you'll paste them into the catalog entry in Step 2.

- [ ] **Step 2: Add `qwen-3b` to `LLM_MODELS` and update the `max` tier**

In `src/main/model-catalog.ts`, add the new entry to `LLM_MODELS` after `qwen-1.5b` (substitute the real `sizeBytes` and `sha256` you fetched):

```ts
{
  id: "qwen-3b",
  filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
  sizeBytes: <SIZE_FROM_STEP_1>,
  sha256: "<SHA_FROM_STEP_1>",
  url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
},
```

Then update the `max` tier in `TIERS` to use it:

```ts
{
  id: "max",
  label: "Maximum quality",
  description: "Large v3 Turbo + 3B cleanup. ~3.5 GB total. Best accuracy, disfluency-aware.",
  whisperId: "whisper-large-v3-turbo",
  llmId: "qwen-3b",
},
```

The `fast` and `balanced` tiers remain unchanged.

- [ ] **Step 3: Run the catalog tests**

```bash
cd /Users/dany/Developer/open-flow
npx vitest run test/unit/model-catalog.test.ts 2>&1 | tail -6
```

Expected: `Test Files  1 passed (1)` / `Tests  6 passed (6)`. The existing tests assert structural invariants ("each tier references existing whisper + llm ids") which still hold; no test edits required.

- [ ] **Step 4: Typecheck and lint**

```bash
npm run typecheck >/dev/null 2>&1 && echo PASS
npx eslint src/main/model-catalog.ts >/dev/null 2>&1 && echo "lint PASS"
```

Expected: `PASS` and `lint PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/main/model-catalog.ts
git commit -m "feat(catalog): add qwen-3b; max tier now turbo + 3B cleanup

The 3B is the model size for the new disfluency-only cleanup task. Sized
~1.9 GB (Q4_K_M), so the max tier total moves from ~2.7 GB to ~3.5 GB.
fast and balanced are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rewrite the prompt template (TDD)

**Files:**
- Modify: `src/main/utils/prompt-template.ts`
- Modify: `test/unit/prompt-template.test.ts`

- [ ] **Step 1: Read the current prompt-template tests**

```bash
cd /Users/dany/Developer/open-flow
cat test/unit/prompt-template.test.ts
```

You'll need to understand which existing assertions to remove/replace. The test currently asserts properties of the OLD prompt (e.g., "Add punctuation"). Those assertions will need updating.

- [ ] **Step 2: Replace the test body**

Overwrite `test/unit/prompt-template.test.ts` with the new behavior we want. The 5 tests assert that the new disfluency-only prompt has the right shape:

```ts
import { describe, it, expect } from "vitest";
import { buildCleanupPrompt } from "../../src/main/utils/prompt-template.js";

describe("buildCleanupPrompt (disfluency-only)", () => {
  it("frames the task as disfluency removal, not punctuation", () => {
    const p = buildCleanupPrompt("test", "it");
    expect(p).toMatch(/remove disfluencies/i);
    // The old "Add punctuation" framing must be gone.
    expect(p).not.toMatch(/Add punctuation and capitalization/i);
  });

  it("includes the Italian discourse-marker filler list (rule B)", () => {
    const p = buildCleanupPrompt("test", "it");
    for (const f of ["allora", "cioè", "diciamo", "praticamente", "insomma", "tipo", "ecco"]) {
      expect(p).toContain(f);
    }
  });

  it("includes the universal verbal fillers (rule A)", () => {
    const p = buildCleanupPrompt("test", "it");
    for (const f of ["uh", "um", "ehm", "uhm"]) {
      expect(p).toContain(f);
    }
  });

  it("documents the only allowed punctuation exception (capitalize after sentence-initial filler)", () => {
    const p = buildCleanupPrompt("test", "it");
    expect(p).toMatch(/sentence-initial filler/i);
    expect(p).toMatch(/capitalize/i);
  });

  it("wraps the raw transcript verbatim between the transcript delimiters", () => {
    const p = buildCleanupPrompt("HELLO world", "it");
    expect(p).toContain("<<<transcript>>>\nHELLO world\n<<</transcript>>>");
    expect(p.trim().endsWith("Cleaned:")).toBe(true);
  });

  it("appends a language hint when given a non-auto language", () => {
    const p = buildCleanupPrompt("ciao", "it");
    expect(p).toContain("Italian");
  });

  it("omits the language hint when language is 'auto'", () => {
    const p = buildCleanupPrompt("hello", "auto");
    expect(p).not.toMatch(/The input is in /);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail (RED)**

```bash
npx vitest run test/unit/prompt-template.test.ts 2>&1 | tail -12
```

Expected: most tests fail — the current prompt has "Add punctuation and capitalization", does not mention "remove disfluencies", and does not contain the Italian filler list.

- [ ] **Step 4: Replace `SYSTEM_INSTRUCTIONS` in `src/main/utils/prompt-template.ts`**

Read the file first to see the existing constant and `buildCleanupPrompt` signature. Then replace the `SYSTEM_INSTRUCTIONS` block with the new template. The `LANGUAGE_NAMES` map and the `buildCleanupPrompt` function body (including the `<<<transcript>>>` framing) stay unchanged.

```ts
const SYSTEM_INSTRUCTIONS = `Your ONLY job is to remove disfluencies from the transcript. Nothing else.

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

When in doubt, leave the word in. Verbatim is always safer than guessing.`;
```

- [ ] **Step 5: Run the tests to verify they pass (GREEN)**

```bash
npx vitest run test/unit/prompt-template.test.ts 2>&1 | tail -6
```

Expected: `Test Files  1 passed (1)` / `Tests  7 passed (7)`.

- [ ] **Step 6: Run the full unit suite to confirm nothing else regressed**

```bash
npx vitest run test/unit 2>&1 | grep -E "Test Files|Tests "
```

Expected: still all green (count depends on prior tasks, but no failures).

- [ ] **Step 7: Typecheck + lint**

```bash
npm run typecheck >/dev/null 2>&1 && echo PASS
npx eslint src/main/utils/prompt-template.ts test/unit/prompt-template.test.ts >/dev/null 2>&1 && echo "lint PASS"
```

Expected: `PASS` and `lint PASS`.

- [ ] **Step 8: Commit**

```bash
git add src/main/utils/prompt-template.ts test/unit/prompt-template.test.ts
git commit -m "feat(prompt): disfluency-only cleanup prompt with Italian filler list

The previous prompt asked the LLM to 'add punctuation', a task whisper
large-v3-turbo already does well — so the cleanup added latency without
value and frequently got rejected as drift. The new prompt confines the
LLM to a task whisper structurally cannot do: removing 'ehm'/'cioè'/
false-starts while preserving every other word verbatim.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Cleaner refactor — fast-path skip + fetch DI + cap 1.2x (TDD)

**Files:**
- Create: `src/main/utils/light-touch-up.ts`
- Modify: `src/main/llm-cleaner.ts`
- Modify: `src/main/pipeline-coordinator.ts`
- Create: `test/unit/llm-cleaner.test.ts`
- Create: `test/unit/light-touch-up.test.ts`

- [ ] **Step 1: Extract `lightTouchUp` to its own file (small refactor)**

The current `lightTouchUp` lives in `src/main/pipeline-coordinator.ts` (top-of-file local function). The cleaner's fast-path needs to use it too. Extract it.

Create `src/main/utils/light-touch-up.ts`:

```ts
/**
 * Cosmetic touch-up for transcripts that we did NOT send through the LLM
 * (single short words, or LLM-skipped because no filler markers). Just
 * capitalizes the first letter and adds a trailing period if missing — never
 * changes the wording.
 */
export function lightTouchUp(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const head = trimmed[0]!.toUpperCase();
  const rest = trimmed.slice(1);
  const lastChar = trimmed[trimmed.length - 1] ?? "";
  const endsWithPunct = /[.!?…]/.test(lastChar);
  return head + rest + (endsWithPunct ? "" : ".");
}
```

Create `test/unit/light-touch-up.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lightTouchUp } from "../../src/main/utils/light-touch-up.js";

describe("lightTouchUp", () => {
  it("capitalizes the first letter", () => {
    expect(lightTouchUp("hello world.")).toBe("Hello world.");
  });

  it("adds a trailing period when missing", () => {
    expect(lightTouchUp("hello")).toBe("Hello.");
  });

  it("preserves existing terminal punctuation", () => {
    expect(lightTouchUp("hello!")).toBe("Hello!");
    expect(lightTouchUp("hello?")).toBe("Hello?");
    expect(lightTouchUp("hello…")).toBe("Hello…");
  });

  it("returns empty for whitespace-only input", () => {
    expect(lightTouchUp("   ")).toBe("");
    expect(lightTouchUp("")).toBe("");
  });
});
```

Run the new test to confirm it passes immediately (the function is already correct — we're just relocating it):

```bash
cd /Users/dany/Developer/open-flow
npx vitest run test/unit/light-touch-up.test.ts 2>&1 | tail -6
```

Expected: `Tests  4 passed (4)`.

- [ ] **Step 2: Replace `pipeline-coordinator.ts`'s local `lightTouchUp` with the import**

In `src/main/pipeline-coordinator.ts`, locate the top-of-file local `function lightTouchUp(text: string): string { ... }` (lines ~8-16 — the function is defined near the top) and **delete** that local definition. Add an import at the top of the file:

```ts
import { lightTouchUp } from "./utils/light-touch-up.js";
```

The single call site inside the coordinator class (`textToInject = lightTouchUp(withPunct);`) is unchanged.

- [ ] **Step 3: Run the coordinator's existing tests to confirm the refactor is invisible**

```bash
npx vitest run test/unit/pipeline-coordinator.test.ts 2>&1 | tail -6
```

Expected: all coordinator tests still pass — `lightTouchUp` produces identical output.

- [ ] **Step 4: Write failing tests for the new cleaner behavior**

Create `test/unit/llm-cleaner.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { LLMCleaner } from "../../src/main/llm-cleaner.js";

/** Build a fake `fetch` returning a configurable JSON response with `content`. */
function fakeFetchReturning(content: string) {
  return vi.fn(async (_url: unknown, _init?: RequestInit) => {
    return new Response(JSON.stringify({ content }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("LLMCleaner fast-path skip", () => {
  it("skips the LLM when the transcript has no disfluency markers", async () => {
    const fetchImpl = fakeFetchReturning("never sent");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await cleaner.clean("No, lo scroll automatico non funziona ancora.", "it");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.usedFallback).toBe(false);
    // lightTouchUp does not alter already-punctuated text:
    expect(result.text).toBe("No, lo scroll automatico non funziona ancora.");
  });

  it("calls the LLM when the transcript contains an Italian filler", async () => {
    const fetchImpl = fakeFetchReturning(" pensavo di andare al mare.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await cleaner.clean("Allora, pensavo di andare al mare.", "it");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBeFalsy();
  });

  it("calls the LLM on a false-start with em-dash repetition", async () => {
    const fetchImpl = fakeFetchReturning("io penso che è giusto.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await cleaner.clean("io— io penso che è giusto.", "it");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls the LLM on a verbal 'uh' filler", async () => {
    const fetchImpl = fakeFetchReturning(" hello world.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await cleaner.clean("uh, hello world.", "en");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("LLMCleaner n_predict cap", () => {
  it("requests n_predict at most 1.2x the input token estimate", async () => {
    // The dynamicCap formula is `max(48, ceil(approxTokens * 1.2))`. Use a
    // long enough input so the 1.2x term dominates the 48-token floor —
    // otherwise this test would just verify the floor and miss any regression
    // in the multiplier.
    const inputText =
      "Ehm, hello world, this is intentionally long enough that the 1.2x " +
      "multiplier in the dynamic-cap formula dominates the 48-token floor — " +
      "so we actually verify the multiplier, not just the floor value.";
    // ~210 chars → ~70 tokens → ceil(70*1.2)=84 → cap = 84 (dominates floor 48).

    let capturedBody: { n_predict?: number } | null = null;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify({ content: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await cleaner.clean(inputText, "en");
    const approxTokens = Math.ceil(inputText.length / 3);
    const expectedCap = Math.max(48, Math.ceil(approxTokens * 1.2));
    expect(expectedCap).toBeGreaterThan(48); // sanity: floor is NOT dominating
    expect(capturedBody!.n_predict).toBe(expectedCap);
  });
});
```

- [ ] **Step 5: Run the new cleaner tests to verify they fail (RED)**

```bash
npx vitest run test/unit/llm-cleaner.test.ts 2>&1 | tail -12
```

Expected: failures. The current cleaner does not accept `fetchImpl`, does not skip, does not return `skipped`, and uses 1.8× cap.

- [ ] **Step 6: Refactor `src/main/llm-cleaner.ts`**

Read the file first to see the current shape. Then apply these changes:

(a) Add `fetchImpl` to `LLMCleanerOptions`:

```ts
export interface LLMCleanerOptions {
  /** Base URL of the llama-server, e.g. http://127.0.0.1:18080 */
  endpoint: string;
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  /** Override the HTTP fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}
```

(b) Add `skipped` to `CleanResult`:

```ts
export interface CleanResult extends SanitizedOutput {
  durationMs: number;
  /** True if the LLM was skipped because the transcript had no obvious
   *  disfluency markers. The returned `text` is the raw transcript with
   *  `lightTouchUp` applied. */
  skipped?: boolean;
}
```

(c) Add the regex constants near the top of the module (after imports):

```ts
import { lightTouchUp } from "./utils/light-touch-up.js";

// Markers that justify invoking the LLM. If neither matches, the transcript
// has no disfluencies the model could realistically remove, so we skip the
// round-trip entirely.
const FILLER_TOKENS = /\b(ehm|uhm|uh|um|ah|eh|cioè|allora|diciamo|praticamente|insomma|tipo|ecco)\b/i;
const FALSE_START = /\w+— ?\w+|\w+- \w+/;

function needsCleanup(text: string): boolean {
  return FILLER_TOKENS.test(text) || FALSE_START.test(text);
}
```

(d) At the top of `clean()`, before any work, add the fast-path:

```ts
async clean(rawTranscript: string, languageHint?: string): Promise<CleanResult> {
  const start = Date.now();

  // Fast-path: nothing for the LLM to remove → return raw with lightTouchUp.
  if (!needsCleanup(rawTranscript)) {
    return {
      text: lightTouchUp(rawTranscript),
      usedFallback: false,
      skipped: true,
      durationMs: Date.now() - start,
    };
  }

  // ... rest of the existing implementation unchanged below ...
```

(e) Change the dynamicCap factor in the existing body from `1.8` to `1.2`:

```ts
const dynamicCap = Math.max(48, Math.ceil(approxInputTokens * 1.2));
```

(f) Resolve the fetch implementation once at the top of the file (or inline at the call site). At the call site (the `fetch(...)` call inside `clean()`), replace `fetch(...)` with `(this.opts.fetchImpl ?? fetch)(...)`. Concretely:

```ts
const fetchFn = this.opts.fetchImpl ?? fetch;
let res: Response;
try {
  res = await fetchFn(`${this.opts.endpoint}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(this.opts.timeoutMs),
  });
} catch (err) {
  ...
}
```

- [ ] **Step 7: Run the cleaner tests to verify they pass (GREEN)**

```bash
npx vitest run test/unit/llm-cleaner.test.ts 2>&1 | tail -6
```

Expected: `Tests  5 passed (5)`.

- [ ] **Step 8: Run the full unit suite to confirm nothing else regressed**

```bash
npx vitest run test/unit 2>&1 | grep -E "Test Files|Tests "
```

Expected: all green.

- [ ] **Step 9: Typecheck + lint**

```bash
npm run typecheck >/dev/null 2>&1 && echo PASS
npx eslint src/main/llm-cleaner.ts src/main/pipeline-coordinator.ts \
  src/main/utils/light-touch-up.ts test/unit/llm-cleaner.test.ts \
  test/unit/light-touch-up.test.ts >/dev/null 2>&1 && echo "lint PASS"
```

Expected: `PASS` and `lint PASS`.

- [ ] **Step 10: Commit**

```bash
git add src/main/utils/light-touch-up.ts src/main/llm-cleaner.ts \
        src/main/pipeline-coordinator.ts test/unit/light-touch-up.test.ts \
        test/unit/llm-cleaner.test.ts
git commit -m "feat(cleaner): fast-path skip, fetch DI, cap 1.2x, lightTouchUp util

A regex (FILLER_TOKENS | FALSE_START) gates LLM invocation: if the raw
transcript has no obvious disfluency markers, we skip the LLM entirely
and return the raw text with lightTouchUp applied. This saves the full
~1.5s LLM round-trip on dictation samples without fillers (most of them
in practice). CleanResult gains an optional 'skipped' field to log the
path. fetchImpl DI lets the unit tests verify 'no call was made'.

dynamicCap moves from 1.8x to 1.2x to match the removal-only task:
output is always <= input, no need for headroom beyond a few tokens for
the capitalize-after-filler boundary.

lightTouchUp moved from pipeline-coordinator into its own util so the
cleaner can reuse it without a cross-file circular import.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Coordinator log — surface `skipped` in the "cleaned" line

**Files:**
- Modify: `src/main/pipeline-coordinator.ts`

- [ ] **Step 1: Locate the `cleaned` log call**

```bash
grep -n '"cleaned"' src/main/pipeline-coordinator.ts
```

Expected: a single match around line ~158 inside the `useLlmCleanup` branch.

- [ ] **Step 2: Extend the log meta with `skipped`**

Change the existing log call from:

```ts
await this.deps.logger.info("cleaned", {
  text: c.text,
  usedFallback: c.usedFallback,
  durationMs: c.durationMs,
});
```

to:

```ts
await this.deps.logger.info("cleaned", {
  text: c.text,
  usedFallback: c.usedFallback,
  skipped: c.skipped ?? false,
  durationMs: c.durationMs,
});
```

- [ ] **Step 3: Run the full unit suite**

```bash
cd /Users/dany/Developer/open-flow
npx vitest run test/unit 2>&1 | grep -E "Test Files|Tests "
```

Expected: all green. The coordinator tests use mock loggers; the extra field flows through transparently.

- [ ] **Step 4: Typecheck + lint**

```bash
npm run typecheck >/dev/null 2>&1 && echo PASS
npx eslint src/main/pipeline-coordinator.ts >/dev/null 2>&1 && echo "lint PASS"
```

Expected: `PASS` and `lint PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/main/pipeline-coordinator.ts
git commit -m "chore(pipeline): log 'skipped' on cleaned line for fast-path visibility

cleaner now returns CleanResult.skipped when it bypassed the LLM via the
regex fast-path. Surfacing it in the 'cleaned' field log makes it easy to
tell in the wild whether the LLM is being skipped (good — fewer LLM calls)
or actually running (and whether it fell back).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Verification summary

After all 4 tasks pass:

- 4 commits on `llm-cleanup-v2` (one per task).
- Full unit suite green; expect total count to grow by **~12** (4 lightTouchUp + 5 llm-cleaner + 7 prompt-template − ~5 retired prompt-template assertions).
- typecheck PASS, lint clean on touched files.
- The branch is ready for manual runtime verification with the qwen-3b model downloaded:
  - Switch to "max" tier in Setup or Preferences.
  - Dictate Italian sentences both with disfluencies ("Allora, ehm, pensavo di...") and without ("No, lo scroll automatico non funziona ancora.").
  - Verify the `cleaned` log line shows `skipped: true` for the no-filler one and `skipped: false` for the filler one.
- Then merge `llm-cleanup-v2` into `main` (fast-forward, same pattern as before).
