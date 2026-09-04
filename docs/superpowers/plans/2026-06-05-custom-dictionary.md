# Custom Dictionary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user define a list of preferred spellings (proper nouns, jargon, product names) that the dictation pipeline normalizes in the transcript and biases Whisper toward.

**Architecture:** Two phases. **Phase 1 (pure TypeScript, shippable alone, no native rebuild):** a deterministic `applyDictionary(text, terms)` text→text stage runs in `PipelineCoordinator.finishWithAudio` right after spoken-punctuation and before the LLM cleanup; the term list lives in `Preferences.dictionary` and is read fresh on every utterance (hot — no restart). A new "Dictionary" section in the preferences window edits the list. **Phase 2 (native + rebuild):** the dictionary terms are joined into a capped `initial_prompt` string and passed through `StreamingWhisperRunner.start()` into the native `whisper_stream` addon's `whisper_full_params.initial_prompt`, biasing Whisper to emit correct spellings from the start.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Electron (main + preload + vanilla-JS renderer), N-API C++/Obj-C++ addon (`node-addon-api`), `electron-rebuild`.

---

## Design notes carried from brainstorming

- **Fuzzy gating mechanism (deviation, flagged).** Brainstorming agreed "fuzzy only for terms ≥6 chars, and only when the source is not already a valid word." There is **no multilingual lexicon** available in this app (`/usr/share/dict/words` is English-only and fragile), so the literal "is it a real word" check is not implementable. This plan preserves the *intent* (conservatism, don't corrupt real words) with three implementable gates instead: **(a)** term length ≥ 6; **(b)** source-token length within ±2 of the term length; **(c)** uniqueness — if a source token is within threshold of two or more different terms, it is left untouched. Single-token fuzzy only (no multi-word fuzzy windows — YAGNI).
- **Stage order (Phase 1):** `transcribe → spoken punctuation → applyDictionary → (LLM cleanup | lightTouchUp) → inject`. Placing it before the LLM is safe because the sanitizer is removal-only (commit 63e2953) — the LLM cannot un-correct `Wispr Flow` back to `Whisper Flow`.
- **Hot vs restart.** Phase 1 correction is hot (prefs re-read at finalize, `index.ts:423`). Phase 2 biasing reads the in-memory `prefs.dictionary` at `arm` time (same staleness as `prefs.language` at `index.ts:387`), so editing the dictionary changes the *biasing* only after a restart, while the *correction* is always hot. This is acceptable and consistent with the existing language handling; do not over-engineer a hot prompt reload.
- **Empty dictionary → no-op fast path** in both the correction util and the prompt builder.

---

## File Structure

**Phase 1**
- Create `src/main/utils/dictionary.ts` — `applyDictionary(text, terms)`, pure text→text. Owns exact, multi-word, and fuzzy correction.
- Create `test/unit/dictionary.test.ts` — unit tests for the above.
- Modify `src/main/preferences-store.ts` — add `dictionary: string[]` to `Preferences` and `DEFAULT_PREFS`.
- Modify `src/main/pipeline-coordinator.ts` — call `applyDictionary` between spoken-punctuation and the LLM; add `dictionary?: string[]` to the `finishWithAudio` options.
- Modify `test/unit/pipeline-coordinator.test.ts` — assert the dictionary stage runs and feeds corrected text downstream.
- Modify `src/main/index.ts` — pass `dictionary: currentPrefs.dictionary` into `finishWithAudio`.
- Modify `src/renderer/preferences.html` — add the "Dictionary" `<section>`.
- Modify `src/renderer/preferences.js` — render/add/remove terms; include `dictionary` in `buildNextPrefs`.

**Phase 2**
- Create `src/main/utils/initial-prompt.ts` — `buildInitialPrompt(terms, opts)`, pure, capped, returns `{ prompt, dropped }`.
- Create `test/unit/initial-prompt.test.ts` — unit tests.
- Modify `native/whisper-stream/whisper_stream.mm` — accept an initial-prompt string in `Start`, thread it into `runWhisperFull` as `params.initial_prompt`.
- Modify `src/main/streaming-whisper-runner.ts` — `start(language, initialPrompt?)`; widen the `NativeWhisperStream.start` type.
- Modify `test/unit/streaming-whisper-runner.test.ts` — assert the prompt is forwarded to the native `start`.
- Modify `src/main/index.ts` — build the prompt from `prefs.dictionary` and pass it to `streamingWhisper.start(...)` in the `arm` handler.

---

# PHASE 1 — Pure TypeScript (shippable on its own)

## Task 1: `applyDictionary` — exact + multi-word correction

**Files:**
- Create: `src/main/utils/dictionary.ts`
- Test: `test/unit/dictionary.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/dictionary.test.ts
import { describe, it, expect } from "vitest";
import { applyDictionary } from "../../src/main/utils/dictionary.js";

describe("applyDictionary — exact & multi-word", () => {
  it("returns text unchanged when the dictionary is empty", () => {
    expect(applyDictionary("ho usato slack oggi", [])).toBe("ho usato slack oggi");
    expect(applyDictionary("ho usato slack oggi", ["   "])).toBe("ho usato slack oggi");
  });

  it("normalizes spelling on a case-insensitive exact match", () => {
    expect(applyDictionary("ho usato slack oggi", ["Slack"])).toBe("ho usato Slack oggi");
    expect(applyDictionary("SLACK rocks", ["Slack"])).toBe("Slack rocks");
  });

  it("matches on Unicode word boundaries and preserves adjacent punctuation", () => {
    expect(applyDictionary("uso slack, ogni giorno", ["Slack"])).toBe("uso Slack, ogni giorno");
    expect(applyDictionary("(slack)", ["Slack"])).toBe("(Slack)");
  });

  it("does not match inside a larger word", () => {
    expect(applyDictionary("slacker", ["Slack"])).toBe("slacker");
  });

  it("corrects multi-word terms with flexible whitespace", () => {
    expect(applyDictionary("apri whisper flow adesso", ["Wispr Flow"]))
      .toBe("apri Wispr Flow adesso");
    expect(applyDictionary("whisper   flow", ["Wispr Flow"])).toBe("Wispr Flow");
  });

  it("applies longer terms before shorter overlapping ones", () => {
    // "Wispr Flow" must win over a bare "Flow" term
    expect(applyDictionary("uso whisper flow", ["Flow", "Wispr Flow"]))
      .toBe("uso Wispr Flow");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/dictionary.test.ts`
Expected: FAIL — `applyDictionary` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/main/utils/dictionary.ts
/**
 * Normalize a transcript against a user-defined dictionary of preferred
 * spellings (proper nouns, product names, jargon). Pure text→text, runs after
 * spoken-punctuation and before the LLM cleanup in the pipeline.
 *
 * Two correction modes:
 *   - Exact / multi-word: case-insensitive, Unicode-word-bounded replacement of
 *     a term (which may contain spaces) with its canonical spelling.
 *   - Fuzzy (see applyFuzzy, Task 2): conservative single-token near-miss repair
 *     gated by term length, source-length proximity, and match uniqueness.
 *
 * Empty / whitespace-only dictionaries are a no-op fast path.
 */

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyDictionary(text: string, terms: string[]): string {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return text;

  // Longest first so multi-word / longer terms win over shorter overlaps
  // (e.g. "Wispr Flow" before "Flow").
  const ordered = [...cleaned].sort((a, b) => b.length - a.length);

  let result = text;
  for (const term of ordered) {
    // Build a Unicode-aware, case-insensitive, word-bounded pattern. Internal
    // runs of whitespace in a multi-word term match any whitespace run.
    const body = escapeRegExp(term).replace(/\s+/g, "\\s+");
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`,
      "giu",
    );
    result = result.replace(pattern, term);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/dictionary.test.ts`
Expected: PASS (all exact/multi-word cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/utils/dictionary.ts test/unit/dictionary.test.ts
git commit -m "feat(dictionary): exact & multi-word transcript correction"
```

---

## Task 2: `applyDictionary` — gated fuzzy correction

**Files:**
- Modify: `src/main/utils/dictionary.ts`
- Test: `test/unit/dictionary.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append to test/unit/dictionary.test.ts
describe("applyDictionary — fuzzy (gated)", () => {
  it("repairs a clear near-miss on a long term (non-word source)", () => {
    expect(applyDictionary("ciao gianluk", ["Gianluca"])).toBe("ciao Gianluca");
    expect(applyDictionary("apri slac ora", ["Slack"]))   // 'Slack' is 5 chars → see below
      .toBe("apri slac ora"); // NOT corrected: term < 6 → fuzzy disabled
  });

  it("never fuzzy-matches short terms (< 6 chars)", () => {
    // "flow" (4) must never swallow "slow"/"glow"/"flew"
    expect(applyDictionary("going slow now", ["flow"])).toBe("going slow now");
    expect(applyDictionary("the river flew", ["flow"])).toBe("the river flew");
  });

  it("respects the distance threshold scaled by term length", () => {
    // 'kubernetes' (10) allows distance <= 2
    expect(applyDictionary("uso kubernets", ["Kubernetes"])).toBe("uso Kubernetes");
    // distance 3 is too far → untouched
    expect(applyDictionary("uso kuberxyz", ["Kubernetes"])).toBe("uso kuberxyz");
  });

  it("skips fuzzy when the source length is far from the term length", () => {
    // 'doc' is way shorter than 'Postgres' → never matched
    expect(applyDictionary("the doc", ["Postgres"])).toBe("the doc");
  });

  it("leaves a token untouched when it is ambiguous between two terms", () => {
    // 'korpus' is within distance 1 of both 'Corpus' and 'Korpus' → ambiguous
    expect(applyDictionary("the korpus", ["Corpus", "Korpux"])).toBe("the korpus");
  });

  it("does not fuzzy-rewrite a token already exact-matched", () => {
    expect(applyDictionary("Gianluca", ["Gianluca"])).toBe("Gianluca");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/dictionary.test.ts`
Expected: FAIL — fuzzy cases (e.g. `gianluk` → `Gianluca`) not corrected.

- [ ] **Step 3: Write minimal implementation (extend `dictionary.ts`)**

Add the Levenshtein helper and fuzzy pass, and call it after the exact pass.

```typescript
// add to src/main/utils/dictionary.ts

/** Classic iterative Levenshtein edit distance. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Fuzzy distance budget for a term: 1 for 6-7 chars, 2 for >=8. The >=8
 *  band (not >=10) is what lets the canonical example "gianluk" -> "Gianluca"
 *  (8 chars, edit distance 2) correct while 6-7 char terms stay at distance 1. */
function fuzzyThreshold(termLen: number): number {
  return termLen >= 8 ? 2 : 1;
}

/**
 * Conservative single-token fuzzy repair. Gates (all must hold):
 *   - term length >= 6 (short terms are never fuzzy-matched);
 *   - |sourceToken.length - term.length| <= 2 (length proximity);
 *   - edit distance <= fuzzyThreshold(term.length);
 *   - the token isn't already an exact (case-insensitive) match of any term;
 *   - the match is UNIQUE — if two+ eligible terms tie/qualify, skip the token.
 */
function applyFuzzy(text: string, terms: string[]): string {
  const eligible = terms.filter((t) => t.length >= 6);
  if (eligible.length === 0) return text;
  const exactLower = new Set(terms.map((t) => t.toLowerCase()));

  // Tokenize into Unicode word tokens with their offsets, rebuild around them.
  const tokenRe = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(tokenRe)) {
    const token = match[0];
    const start = match.index!;
    out += text.slice(last, start);
    last = start + token.length;

    const lower = token.toLowerCase();
    let replacement = token;
    if (!exactLower.has(lower)) {
      const candidates: string[] = [];
      for (const term of eligible) {
        if (Math.abs(token.length - term.length) > 2) continue;
        if (editDistance(lower, term.toLowerCase()) <= fuzzyThreshold(term.length)) {
          candidates.push(term);
        }
      }
      if (candidates.length === 1) replacement = candidates[0]!;
    }
    out += replacement;
  }
  out += text.slice(last);
  return out;
}
```

Then chain it in `applyDictionary` after the exact loop:

```typescript
// in applyDictionary, replace `return result;` with:
  return applyFuzzy(result, ordered);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/dictionary.test.ts`
Expected: PASS (exact + fuzzy).

- [ ] **Step 5: Commit**

```bash
git add src/main/utils/dictionary.ts test/unit/dictionary.test.ts
git commit -m "feat(dictionary): conservative gated fuzzy correction"
```

---

## Task 3: Persist the dictionary in preferences

**Files:**
- Modify: `src/main/preferences-store.ts:4-26`
- Test: `test/unit/preferences-store.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append inside the existing describe in test/unit/preferences-store.test.ts
  it("defaults dictionary to an empty array and round-trips terms", async () => {
    const { PreferencesStore, DEFAULT_PREFS } = await import(
      "../../src/main/preferences-store.js"
    );
    expect(DEFAULT_PREFS.dictionary).toEqual([]);
    // (file round-trip is already covered by existing save/load tests; this
    //  just locks the new field's default and type.)
  });
```

> If `preferences-store.test.ts` does not already import these symbols at top, use the dynamic `await import` shown above to avoid disturbing existing imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/preferences-store.test.ts`
Expected: FAIL — `DEFAULT_PREFS.dictionary` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/main/preferences-store.ts`, add the field to the interface (after `spokenPunctuation: boolean;` on line 13):

```typescript
  spokenPunctuation: boolean;
  /** User-defined preferred spellings normalized in the transcript and used to
   *  bias Whisper (proper nouns, product names, jargon). */
  dictionary: string[];
```

And to `DEFAULT_PREFS` (after `spokenPunctuation: false,` on line 25):

```typescript
  spokenPunctuation: false,
  dictionary: [],
```

> Note: `load()` already merges `{ ...DEFAULT_PREFS, ...parsed }` (line 35), so existing preference files without the key transparently get `[]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/preferences-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/preferences-store.ts test/unit/preferences-store.test.ts
git commit -m "feat(prefs): add dictionary term list to preferences"
```

---

## Task 4: Wire the dictionary stage into the pipeline

**Files:**
- Modify: `src/main/pipeline-coordinator.ts:1-3` (import), `:80-128` (options + stage)
- Modify: `src/main/index.ts:424-427` (pass the option)
- Test: `test/unit/pipeline-coordinator.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing describe)**

```typescript
// append inside describe("PipelineCoordinator", ...) in
// test/unit/pipeline-coordinator.test.ts
  it("applies dictionary correction before the LLM cleanup", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: "ho usato slack", language: "it", durationMs: 1 })),
    });
    const coord = new PipelineCoordinator(deps);
    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(16000), 16000, "it", {
      useLlmCleanup: true,
      dictionary: ["Slack"],
    });
    // The LLM must receive the dictionary-corrected text, not the raw one.
    expect(deps.clean).toHaveBeenCalledWith("ho usato Slack", expect.anything());
  });

  it("applies dictionary correction even when LLM cleanup is off", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: "ho usato slack", language: "it", durationMs: 1 })),
    });
    const coord = new PipelineCoordinator(deps);
    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(16000), 16000, "it", {
      useLlmCleanup: false,
      dictionary: ["Slack"],
    });
    expect(deps.inject).toHaveBeenCalledWith("ho usato Slack");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/pipeline-coordinator.test.ts`
Expected: FAIL — `clean` called with `"ho usato slack"` (uncorrected).

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `src/main/pipeline-coordinator.ts` (after line 2):

```typescript
import { applySpokenPunctuation } from "./utils/spoken-punctuation.js";
import { applyDictionary } from "./utils/dictionary.js";
import { lightTouchUp } from "./utils/light-touch-up.js";
```

Extend the `finishWithAudio` options type (line 84):

```typescript
    options: { useLlmCleanup?: boolean; spokenPunctuation?: boolean; dictionary?: string[] } = {},
```

Read it alongside the other options (after line 88):

```typescript
    const spokenPunctuation = options.spokenPunctuation === true; // default false
    const dictionary = options.dictionary ?? [];
```

Insert the correction stage between the spoken-punctuation block (ends line 128) and `let textToInject = withPunct;` (line 130):

```typescript
      }

      // Deterministic dictionary normalization (preferred spellings of proper
      // nouns / jargon). Runs after spoken-punctuation and before the LLM so
      // the corrected spelling is what the (removal-only) LLM polishes. No-op
      // fast path on an empty dictionary. Applies with or without LLM cleanup.
      let corrected = withPunct;
      if (dictionary.length > 0) {
        corrected = applyDictionary(withPunct, dictionary);
        if (corrected !== withPunct) {
          await this.deps.logger.info("dictionary applied", { text: corrected });
        }
      }

      let textToInject = corrected;
```

Then update the two downstream references that used `withPunct` for the LLM/short-word path to use `corrected`:
- Line 136: `const isSingleShortWord = corrected.length < 12 && !corrected.trim().includes(" ");`
- Line 141: `textToInject = lightTouchUp(corrected);`
- Line 144: `const c = await this.deps.clean(corrected, langHint ?? undefined);`

> Leave the `withPunct` computation and its log untouched; only the post-punctuation consumers move to `corrected`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/pipeline-coordinator.test.ts`
Expected: PASS (including the pre-existing tests, which pass an empty/absent dictionary → no-op).

- [ ] **Step 5: Wire the option in `index.ts`**

In `src/main/index.ts`, extend the `finishWithAudio` call (lines 424-427):

```typescript
      await coordinator.finishWithAudio(samples, SAMPLE_RATE, currentPrefs.language, {
        useLlmCleanup: currentPrefs.useLlmCleanup,
        spokenPunctuation: currentPrefs.spokenPunctuation,
        dictionary: currentPrefs.dictionary,
      });
```

- [ ] **Step 6: Typecheck + full unit run**

Run: `npx tsc --noEmit && npx vitest run test/unit`
Expected: no type errors; all unit tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/pipeline-coordinator.ts src/main/index.ts test/unit/pipeline-coordinator.test.ts
git commit -m "feat(pipeline): apply dictionary correction before LLM cleanup"
```

---

## Task 5: Dictionary section in the preferences UI

**Files:**
- Modify: `src/renderer/preferences.html:37-40` (add a section after spoken-punctuation)
- Modify: `src/renderer/preferences.js:16-27` (load), `:190-206` (buildNextPrefs)

> No automated test — the renderer is vanilla JS with no harness. Verified manually in Step 4. The dictionary is **not** a restart-required field (hot at finalize), so it is intentionally absent from `RESTART_REQUIRED_FIELDS`.

- [ ] **Step 1: Add the HTML section**

In `src/renderer/preferences.html`, after the spoken-punctuation `</section>` (line 40), add:

```html
      <section>
        <label>Dictionary</label>
        <p class="muted">Preferred spellings for names, products, and jargon. Applied to every transcript (no restart needed) and used to nudge Whisper toward the right spelling.</p>
        <div class="dict-add">
          <input id="dictInput" type="text" placeholder="e.g. Wispr Flow" />
          <button id="dictAdd" type="button">Add</button>
        </div>
        <ul id="dictList" class="dict-list"></ul>
      </section>
```

- [ ] **Step 2: Wire load + state in `preferences.js`**

After `$("#spokenPunctuation").checked = prefs.spokenPunctuation === true;` (line 27), seed the working copy of the term list:

```javascript
  $("#spokenPunctuation").checked = prefs.spokenPunctuation === true;

  // Working copy of the dictionary terms; rendered as a removable list.
  let dictTerms = Array.isArray(prefs.dictionary) ? [...prefs.dictionary] : [];

  function renderDict() {
    const list = $("#dictList");
    list.innerHTML = "";
    dictTerms.forEach((term, i) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "dict-term";
      span.textContent = term;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "danger";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Remove ${term}`);
      rm.addEventListener("click", () => {
        dictTerms.splice(i, 1);
        renderDict();
        refreshSaveButton();
      });
      li.append(span, rm);
      list.appendChild(li);
    });
  }

  function addDictTerm() {
    const input = $("#dictInput");
    const term = input.value.trim();
    if (!term) return;
    // Case-insensitive de-dupe; keep the spelling the user typed last.
    dictTerms = dictTerms.filter((t) => t.toLowerCase() !== term.toLowerCase());
    dictTerms.push(term);
    input.value = "";
    renderDict();
    refreshSaveButton();
  }

  $("#dictAdd").addEventListener("click", addDictTerm);
  $("#dictInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addDictTerm();
    }
  });
  renderDict();
```

> `refreshSaveButton` is defined later in `init()` but is in scope by call time (these handlers fire on user interaction, after `init()` has finished). This mirrors the existing model-row handlers that also reference it.

- [ ] **Step 3: Include the terms in `buildNextPrefs`**

In `buildNextPrefs` (the returned object, after `spokenPunctuation: $("#spokenPunctuation").checked,` on line 204), add:

```javascript
      spokenPunctuation: $("#spokenPunctuation").checked,
      dictionary: dictTerms,
```

- [ ] **Step 4: Manual verification**

Run: `npm run build && npm start` (or the project's existing dev launch). Then:
1. Open Preferences. Confirm the Dictionary section renders.
2. Type `Wispr Flow`, click Add (and try Enter) → appears in the list.
3. Add a second term, remove the first via `×` → list updates, Save button stays "Save" (not "Save & Restart").
4. Click Save, reopen Preferences → terms persist.
5. Inspect `~/Library/Application Support/open-flow/preferences.json` → `"dictionary": ["Wispr Flow", ...]`.
6. Dictate a phrase containing a lowercase term (e.g. say "wispr flow") with LLM cleanup off → injected text shows the canonical spelling.

> NOTE ([[running-app-is-packaged]]): the installed `.app` runs packaged code — these renderer/main changes only take effect after `npm run build` + relaunching from the freshly built output, not against a previously installed bundle.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/preferences.html src/renderer/preferences.js
git commit -m "feat(prefs-ui): dictionary add/remove section"
```

**Phase 1 is complete and shippable here.** Phase 2 adds Whisper-side biasing and requires a native rebuild.

---

# PHASE 2 — Native `initial_prompt` biasing (requires rebuild)

## Task 6: `buildInitialPrompt` — capped prompt string

**Files:**
- Create: `src/main/utils/initial-prompt.ts`
- Test: `test/unit/initial-prompt.test.ts`

Whisper truncates `initial_prompt` to roughly the last `n_text_ctx/2` (~224) tokens. We cap the term count on the JS side and **log what we drop** (dropped terms are still covered by the Phase 1 correction).

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/initial-prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildInitialPrompt } from "../../src/main/utils/initial-prompt.js";

describe("buildInitialPrompt", () => {
  it("returns an empty prompt and no dropped terms for an empty dictionary", () => {
    expect(buildInitialPrompt([])).toEqual({ prompt: "", dropped: [] });
    expect(buildInitialPrompt(["  "])).toEqual({ prompt: "", dropped: [] });
  });

  it("joins terms into a comma-separated vocabulary hint", () => {
    expect(buildInitialPrompt(["Slack", "Wispr Flow"]))
      .toEqual({ prompt: "Slack, Wispr Flow", dropped: [] });
  });

  it("caps to maxChars and reports dropped terms", () => {
    const terms = ["aaaa", "bbbb", "cccc"];
    // maxChars small enough that only the first two fit ("aaaa, bbbb" = 10)
    const { prompt, dropped } = buildInitialPrompt(terms, { maxChars: 10 });
    expect(prompt).toBe("aaaa, bbbb");
    expect(dropped).toEqual(["cccc"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/initial-prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/main/utils/initial-prompt.ts
/**
 * Build a Whisper `initial_prompt` from dictionary terms — a comma-separated
 * vocabulary hint that biases the decoder toward the user's preferred spellings.
 *
 * Whisper truncates initial_prompt to ~224 tokens (n_text_ctx/2); we cap by
 * character budget on this side so the cut is explicit and the dropped terms
 * can be logged (they remain covered by the downstream dictionary correction).
 */
export interface BuiltPrompt {
  prompt: string;
  dropped: string[];
}

// ~4 chars/token heuristic against the ~224-token budget, kept conservative.
const DEFAULT_MAX_CHARS = 700;

export function buildInitialPrompt(
  terms: string[],
  opts: { maxChars?: number } = {},
): BuiltPrompt {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return { prompt: "", dropped: [] };

  const kept: string[] = [];
  const dropped: string[] = [];
  let len = 0;
  for (const term of cleaned) {
    const add = (kept.length === 0 ? 0 : 2) + term.length; // ", " separator
    if (len + add <= maxChars) {
      kept.push(term);
      len += add;
    } else {
      dropped.push(term);
    }
  }
  return { prompt: kept.join(", "), dropped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/initial-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/utils/initial-prompt.ts test/unit/initial-prompt.test.ts
git commit -m "feat(dictionary): build capped Whisper initial_prompt from terms"
```

---

## Task 7: Thread the prompt through the native addon

**Files:**
- Modify: `native/whisper-stream/whisper_stream.mm`

> Pure C++/Obj-C++; no unit test (covered by the runner test in Task 8 with an injected fake, and by manual verification in Task 9).

- [ ] **Step 1: Add a guarded global for the utterance prompt**

After the `g_samples` declaration (`whisper_stream.mm:46`), add:

```cpp
// Sample buffer for the in-flight utterance. Reset by start().
std::vector<float> g_samples;

// initial_prompt for the in-flight utterance (dictionary vocabulary hint).
// Set by start(), snapshotted per-pass into ProcessWorker. Guarded by
// g_samplesMutex (utterance state, same lifetime as g_samples).
std::string g_initialPrompt;
```

- [ ] **Step 2: Set `params.initial_prompt` in `runWhisperFull`**

Change the signature and body of `runWhisperFull` (lines 65-100). Add a `prompt` parameter and set it on the params (only when non-empty):

```cpp
std::string runWhisperFull(const std::vector<float>& samples,
                           const std::string& language,
                           const std::string& prompt) {
  if (samples.empty()) return "";

  struct whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.language = language.c_str();
  // ... (unchanged params through line 82) ...
  params.abort_callback = abortCallback;
  params.abort_callback_user_data = nullptr;
  if (!prompt.empty()) {
    params.initial_prompt = prompt.c_str();
  }
  // ... (rest unchanged) ...
```

> `params.initial_prompt` is independent of `params.no_context` (line 80): `no_context` controls carrying past-segment text between windows; `initial_prompt` seeds the decoder's prompt tokens. Both coexist. `prompt` must outlive `whisper_full` — it does, since the `ProcessWorker` owns the `std::string` for the whole `Execute()` (Step 4).

- [ ] **Step 3: Accept the prompt in `Start`**

Replace `Start` (lines 122-127) so it reads an optional string argument:

```cpp
Napi::Value Start(const Napi::CallbackInfo& info) {
  g_abort.store(false, std::memory_order_relaxed);
  std::string prompt;
  if (info.Length() >= 1 && info[0].IsString()) {
    prompt = info[0].As<Napi::String>().Utf8Value();
  }
  std::lock_guard<std::mutex> lock(g_samplesMutex);
  g_samples.clear();
  g_initialPrompt = std::move(prompt);
  return info.Env().Undefined();
}
```

- [ ] **Step 4: Carry the prompt into `ProcessWorker`**

Add a `prompt_` field and constructor param to `ProcessWorker` (lines 156-194), use it in `Execute`:

```cpp
  ProcessWorker(Napi::Function& callback, std::vector<float> snapshot,
                std::string language, std::string prompt)
      : AsyncWorker(callback),
        snapshot_(std::move(snapshot)),
        language_(std::move(language)),
        prompt_(std::move(prompt)),
        queued_(std::chrono::steady_clock::now()) {}

  void Execute() override {
    execStart_ = std::chrono::steady_clock::now();
    result_ = runWhisperFull(snapshot_, language_, prompt_);
    execEnd_ = std::chrono::steady_clock::now();
    aborted_ = g_abort.load(std::memory_order_relaxed);
  }
```

Add the field next to `language_` (line 188):

```cpp
  std::string language_;
  std::string prompt_;
```

- [ ] **Step 5: Snapshot the prompt at `ProcessChunk` and `Finalize`**

In `ProcessChunk` (lines 205-214), snapshot the prompt under the same lock as the samples and pass it to the worker:

```cpp
  std::vector<float> snapshot;
  std::string prompt;
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    snapshot = g_samples; // copy
    prompt = g_initialPrompt;
  }
  if (!g_ctx || snapshot.empty()) {
    cb.Call({env.Null(), Napi::String::New(env, "")});
    return env.Undefined();
  }
  auto * worker = new ProcessWorker(cb, std::move(snapshot), std::move(language), std::move(prompt));
```

In `Finalize` (lines 230-241), do the same (note it moves `g_samples`):

```cpp
  std::vector<float> snapshot;
  std::string prompt;
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    snapshot = std::move(g_samples);
    g_samples.clear();
    prompt = g_initialPrompt;
  }
  if (!g_ctx || snapshot.empty()) {
    cb.Call({env.Null(), Napi::String::New(env, "")});
    return env.Undefined();
  }
  auto * worker = new ProcessWorker(cb, std::move(snapshot), std::move(language), std::move(prompt));
```

- [ ] **Step 6: Fix the `Keepalive` call site**

`Keepalive` (line 265) constructs a `ProcessWorker` with no prompt — pass an empty string:

```cpp
  auto * worker = new ProcessWorker(cb, std::move(silence), "en", "");
```

- [ ] **Step 7: Clear the prompt in `Release`**

In `Release` (lines 282-285), clear it alongside the samples:

```cpp
  {
    std::lock_guard<std::mutex> lock(g_samplesMutex);
    g_samples.clear();
    g_initialPrompt.clear();
  }
```

- [ ] **Step 8: Commit (build happens in Task 9)**

```bash
git add native/whisper-stream/whisper_stream.mm
git commit -m "feat(whisper-stream): accept initial_prompt for dictionary biasing"
```

---

## Task 8: Forward the prompt from the TS runner

**Files:**
- Modify: `src/main/streaming-whisper-runner.ts:16-29` (type), `:133-143` (start)
- Test: `test/unit/streaming-whisper-runner.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append to test/unit/streaming-whisper-runner.test.ts
  it("forwards the initial prompt to the native start()", () => {
    const calls: unknown[][] = [];
    const fakeNative = {
      init: () => true,
      start: (...args: unknown[]) => { calls.push(args); },
      feedSamples: () => undefined,
      processChunk: () => undefined,
      requestAbort: () => undefined,
      finalize: () => undefined,
      keepalive: () => undefined,
      release: () => undefined,
    };
    const runner = new StreamingWhisperRunner({ modelPath: "x", native: fakeNative as never });
    runner.start("it", "Slack, Wispr Flow");
    expect(calls[0]).toEqual(["Slack, Wispr Flow"]);
  });
```

> Check the top of the existing test file for how it imports `StreamingWhisperRunner` and constructs a fake native; reuse that exact pattern instead of the inline literal if one already exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/streaming-whisper-runner.test.ts`
Expected: FAIL — `start` called with `[]` (prompt not forwarded), or a type error.

- [ ] **Step 3: Widen the native type and the `start` method**

In `src/main/streaming-whisper-runner.ts`, change the `start` signature in the `NativeWhisperStream` interface (line 18):

```typescript
  init: (modelPath: string) => boolean;
  start: (initialPrompt?: string) => void;
```

Change the public `start` method (lines 133-143):

```typescript
  start(language: string, initialPrompt?: string): void {
    if (this.released) {
      throw new Error("StreamingWhisperRunner.start() called after release()");
    }
    this.native.start(initialPrompt ?? "");
    this.committed = "";
    this.currentLanguage = language;
    this.active = true;
    this.cancelled = false;
    this.armChunkLoop();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/streaming-whisper-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the prompt and pass it in `index.ts`**

Add the import near the other util imports at the top of `src/main/index.ts`:

```typescript
import { buildInitialPrompt } from "./utils/initial-prompt.js";
```

In the `arm` handler (lines 383-388), build and pass the prompt:

```typescript
    if (streamingWhisper) {
      // Read language + dictionary synchronously from last-known prefs — the
      // chunk loop needs them right away. (Like language, the dictionary's
      // biasing reflects the launch-time value; the hot, always-correct layer
      // is the dictionary CORRECTION applied at finalize in the coordinator.)
      const { prompt, dropped } = buildInitialPrompt(prefs.dictionary);
      if (dropped.length > 0) {
        void logger.info("initial_prompt truncated", { dropped });
      }
      streamingWhisper.start(prefs.language, prompt);
    }
```

- [ ] **Step 6: Typecheck + full unit run**

Run: `npx tsc --noEmit && npx vitest run test/unit`
Expected: no type errors; all unit tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/streaming-whisper-runner.ts src/main/index.ts test/unit/streaming-whisper-runner.test.ts
git commit -m "feat(streaming): forward dictionary initial_prompt to whisper"
```

---

## Task 9: Rebuild the native addon and verify end-to-end

**Files:** none (build + manual verification)

- [ ] **Step 1: Rebuild the addon for the Electron ABI / arm64**

Per [[native-addon-rebuild]] — under Rosetta the arch must be forced explicitly:

Run: `npx electron-rebuild --arch arm64 -f -w whisper_stream` (or the project's documented rebuild command; check `package.json` scripts / CLAUDE.md first).
Expected: `build/Release/whisper_stream.node` rebuilds with no errors.

- [ ] **Step 2: Confirm the binary is fresh and loads**

Run: `node -e "const w=require('./build/Release/whisper_stream.node'); console.log(typeof w.start)"`
Expected: prints `function` (sanity that the module loads after the rebuild).

- [ ] **Step 3: Repackage and relaunch**

Per [[running-app-is-packaged]], the installed app won't pick up native or src changes until repackaged.

Run: the project's build/package command (e.g. `npm run build` then the packaging step used in prior commits; check `package.json`).
Expected: a fresh bundle whose `app.asar.unpacked/build/Release/whisper_stream.node` is the just-rebuilt binary.

- [ ] **Step 4: Manual end-to-end verification**

1. Add a distinctive term to the dictionary that Whisper normally mis-spells (e.g. a name like `Gianluca`, a product like `Wispr Flow`).
2. With **LLM cleanup OFF** (isolates the dictionary path), dictate a sentence using that term.
3. Confirm the injected text shows the correct spelling.
4. With `debugLogging` ON, confirm the log shows `dictionary applied` (Phase 1 correction) and, when the term list is long, `initial_prompt truncated` with the dropped terms.
5. Regression: clear the dictionary, dictate normally → behaviour identical to before (no-op fast paths), no errors in the log.

- [ ] **Step 5: Commit any packaging/lockfile changes**

```bash
git add -A
git commit -m "chore(dictionary): rebuild whisper_stream with initial_prompt support"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** persistence (Task 3), correction module exact/multi-word/fuzzy (Tasks 1-2), pipeline innesto after spoken-punctuation & before LLM with/without cleanup (Task 4), no-restart hot UI (Task 5), Phase 2 native `initial_prompt` + prompt builder + token-budget cap with logged drops (Tasks 6-9). All brainstorming points map to a task.
- **Fuzzy tuning:** matches the chosen "fuzzy only on long terms" — gates implemented as ≥6 chars + length proximity + uniqueness (deviation from the unimplementable "is-a-real-word" check, flagged in Design Notes).
- **Type consistency:** `applyDictionary(text: string, terms: string[]): string`; `buildInitialPrompt(terms: string[], opts?) → { prompt, dropped }`; `Preferences.dictionary: string[]`; `start(language: string, initialPrompt?: string)`; native `start(initialPrompt?)` and `runWhisperFull(samples, language, prompt)`. Names consistent across tasks.
- **Placeholder scan:** none — every code step contains full code or exact edits.
