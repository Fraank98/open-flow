/**
 * reply-classifier-bench — the Task 1 experiment (Plan B).
 *
 * Starts its own llama-server on a given GGUF, runs the constrained-output
 * ReplyClassifier against the 16 hand-annotated classifier-corpus cases plus
 * the 5 "reply" cases from the deterministic-parser spike corpus (fed through
 * `parse()` so the classifier sees exactly what production would hand it),
 * repeats the whole pass `--repeats` times to catch non-determinism at
 * temperature 0, and prints accuracy / false-positive / latency metrics.
 *
 * Pure HTTP + child_process — no native addon, so it runs under `tsx`
 * directly (no Electron). Prints to stdout only; no logger is attached to
 * the classifier's metric-only logging, so the tool wires its own in-memory
 * one purely to recover `completionTokens` for the latency report (spec
 * §Privacy: this stays local to the process, never written to disk).
 *
 * This is a manual measurement tool over a fictional fixture corpus, exactly
 * like ax-context-probe: it prints the returned alternative texts on
 * purpose, so the person running it can eyeball quality case by case.
 */
import { parseArgs } from "node:util";
import { LLMServer } from "../src/main/llm-server.js";
import { ReplyChatClient } from "../src/main/reply-chat-client.js";
import { ReplyClassifier, CLASSIFIER_PREFIX, type Classification, type ClassifyResult } from "../src/main/reply-classifier.js";
import { parse } from "../src/main/utils/conversation-parser.js";
import { CASES, axFragments, USER_NAME } from "../test/fixtures/conversations/spike-corpus.js";
import { CLASSIFIER_CASES, type ClassifierCase } from "../test/fixtures/conversations/classifier-corpus.js";

interface BenchCase {
  readonly id: string;
  readonly transcript: string;
  readonly lastMessage: string;
  readonly counterpart: string;
  readonly expectedAnswerable: boolean;
  readonly expectedKind?: Classification["kind"];
  readonly expectedLanguage: "it" | "en";
}

function fromClassifierCase(c: ClassifierCase): BenchCase {
  return {
    id: c.id,
    transcript: c.transcript,
    lastMessage: c.lastMessage,
    counterpart: c.counterpart,
    expectedAnswerable: c.expected.answerable,
    expectedKind: c.expected.kind,
    expectedLanguage: c.expected.language,
  };
}

/** The 5 spike-corpus cases the spec designates as this experiment's
 *  "answerable" reply cases, with the kind/language a human annotator
 *  assigned by reading them (spec §6). Every other spike case is either an
 *  abstention (the deterministic parser already handles those) or out of
 *  scope for this bench. */
const SPIKE_REPLY_EXPECTATIONS: Readonly<Record<string, { kind: Classification["kind"]; language: "it" | "en" }>> = {
  "slack-decisione": { kind: "alternative", language: "it" },
  "slack-richiesta-aiuto": { kind: "generic", language: "it" },
  "mail-preventivo": { kind: "offer", language: "it" },
  "mail-thread-lungo": { kind: "alternative", language: "it" },
  "mail-inglese": { kind: "generic", language: "en" },
};

function buildSpikeCases(): BenchCase[] {
  const out: BenchCase[] = [];
  for (const sc of CASES) {
    const exp = SPIKE_REPLY_EXPECTATIONS[sc.id];
    if (!exp) continue;
    const parsed = parse({ fragments: axFragments(sc.ax), userDisplayName: USER_NAME, tailBudgetChars: 2500 });
    if (parsed.kind !== "conversation") {
      throw new Error(`spike case ${sc.id} did not parse to a conversation (reason: ${parsed.reason})`);
    }
    out.push({
      id: sc.id,
      transcript: parsed.transcript,
      lastMessage: parsed.lastMessage,
      counterpart: parsed.counterpart,
      expectedAnswerable: true,
      expectedKind: exp.kind,
      expectedLanguage: exp.language,
    });
  }
  return out;
}

function actualAnswerable(r: ClassifyResult): boolean | null {
  if (r.ok) return true;
  if (r.reason === "not-answerable") return false;
  return null; // invalid-classification / llm-error: no usable answer at all
}

/** Stable subset of a result, for detecting non-determinism across repeats
 *  at temperature 0. Excludes durationMs on purpose: timing always varies. */
function resultKey(r: ClassifyResult): string {
  if (r.ok) return JSON.stringify({ ok: true, ...r.classification });
  if (r.reason === "llm-error") return JSON.stringify({ ok: false, reason: r.reason, error: r.error });
  return JSON.stringify({ ok: false, reason: r.reason });
}

function fmtExpected(c: BenchCase): string {
  return c.expectedAnswerable ? `true(${c.expectedKind ?? "?"},${c.expectedLanguage})` : "false";
}

function fmtActual(r: ClassifyResult): string {
  if (r.ok) {
    const alts = r.classification.alternatives ? JSON.stringify(r.classification.alternatives) : "[]";
    return `true(${r.classification.kind},${alts},${r.classification.language})`;
  }
  if (r.reason === "llm-error") return `error:${r.error}`;
  if (r.reason === "invalid-classification") return "invalid-shape";
  return "false"; // reason === "not-answerable"
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx]!; // idx clamped into [0, length-1] above
}

function pct(n: number, m: number): string {
  return m === 0 ? "n/a" : `${((n / m) * 100).toFixed(1)}%`;
}

function parseFiniteInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a finite number, got "${raw}"`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string" },
      "server-bin": { type: "string", default: "resources/bin/llama-server" },
      port: { type: "string", default: "18089" },
      repeats: { type: "string", default: "2" },
      context: { type: "string", default: "3072" },
    },
  });

  if (!values.model) {
    console.error("--model <path> is required.");
    return 2;
  }
  const port = parseFiniteInt(values.port, "--port", 18089);
  const repeats = parseFiniteInt(values.repeats, "--repeats", 2);
  const context = parseFiniteInt(values.context, "--context", 3072);

  const cases: BenchCase[] = [...CLASSIFIER_CASES.map(fromClassifierCase), ...buildSpikeCases()];

  const server = new LLMServer({
    binaryPath: values["server-bin"]!, // has a parseArgs default, always a string

    modelPath: values.model,
    port,
    contextSize: context,
    startupTimeoutMs: 120_000,
    warmupPrompt: CLASSIFIER_PREFIX,
  });

  console.error(`Avvio llama-server su ${values.model} (porta ${port}, contesto ${context})…`);
  await server.start();

  try {
    const client = new ReplyChatClient({ endpoint: server.getEndpoint() });

    // Captures completionTokens from the classifier's own metric-only log
    // calls (never transcript/lastMessage/counterpart: the classifier itself
    // never passes those to the logger — spec §Privacy 6). Held in memory
    // only, never written to disk (spec §Privacy 8).
    const completionTokenSamples: number[] = [];
    const logger = {
      info: async (_msg: string, meta?: Record<string, unknown>): Promise<void> => {
        if (typeof meta?.completionTokens === "number") completionTokenSamples.push(meta.completionTokens);
      },
      warn: async (_msg: string, meta?: Record<string, unknown>): Promise<void> => {
        if (typeof meta?.completionTokens === "number") completionTokenSamples.push(meta.completionTokens);
      },
    };
    const classifier = new ReplyClassifier({ client, timeoutMs: 20_000, logger });

    const resultsByCase = new Map<string, ClassifyResult[]>();
    for (let rep = 0; rep < repeats; rep++) {
      for (const c of cases) {
        console.error(`[rep ${rep + 1}/${repeats}] ${c.id}…`);
        const r = await classifier.classify({ transcript: c.transcript, lastMessage: c.lastMessage, counterpart: c.counterpart });
        const list = resultsByCase.get(c.id) ?? [];
        list.push(r);
        resultsByCase.set(c.id, list);
      }
    }

    const primaryByCase = new Map<string, ClassifyResult>();
    for (const c of cases) {
      const list = resultsByCase.get(c.id);
      if (!list || list.length === 0) throw new Error(`no results recorded for case ${c.id}`);
      primaryByCase.set(c.id, list[0]!); // just pushed above, length >= 1
    }

    let answerableMatches = 0;
    let infoFalsePositives = 0;
    let infoCaseCount = 0;
    let truePositiveExpected = 0;
    let truePositiveFalseNegatives = 0;
    let kindMatches = 0;
    let kindDenominator = 0;
    let languageMatches = 0;
    let languageDenominator = 0;
    let nonDeterministicCases = 0;
    const allDurations: number[] = [];

    for (const c of cases) {
      const primary = primaryByCase.get(c.id)!; // populated above for every case
      const results = resultsByCase.get(c.id)!; // same

      if (actualAnswerable(primary) === c.expectedAnswerable) answerableMatches += 1;

      if (c.id.startsWith("info-")) {
        infoCaseCount += 1;
        if (actualAnswerable(primary) === true) infoFalsePositives += 1;
      }

      if (c.expectedAnswerable) {
        truePositiveExpected += 1;
        if (actualAnswerable(primary) !== true) truePositiveFalseNegatives += 1;
      }

      if (primary.ok) {
        languageDenominator += 1;
        if (primary.classification.language === c.expectedLanguage) languageMatches += 1;
        if (c.expectedKind !== undefined) {
          kindDenominator += 1;
          if (primary.classification.kind === c.expectedKind) kindMatches += 1;
        }
      }

      for (const r of results) allDurations.push(r.durationMs);

      const keys = new Set(results.map(resultKey));
      if (keys.size > 1) nonDeterministicCases += 1;
    }

    allDurations.sort((a, b) => a - b);
    completionTokenSamples.sort((a, b) => a - b);

    console.log(`modello: ${values.model}   casi: ${cases.length}   ripetizioni: ${repeats}`);
    console.log(`accuratezza answerable: ${answerableMatches}/${cases.length} (${pct(answerableMatches, cases.length)})`);
    console.log(`falsi positivi su solo-informazione (answerable=true su casi info-*): ${infoFalsePositives}/${infoCaseCount} (${pct(infoFalsePositives, infoCaseCount)})`);
    console.log(`falsi negativi su rispondibili: ${truePositiveFalseNegatives}/${truePositiveExpected}`);
    console.log(`accuratezza kind sui rispondibili classificati true: ${kindMatches}/${kindDenominator}`);
    console.log(`accuratezza language: ${languageMatches}/${languageDenominator}`);
    console.log(
      `latenza p50: ${percentile(allDurations, 50)} ms   p95: ${percentile(allDurations, 95)} ms   completion_tokens p50: ${percentile(completionTokenSamples, 50)}`,
    );
    console.log(`non-determinismo fra ripetizioni: ${nonDeterministicCases} casi`);
    console.log("per caso: id | atteso | ottenuto (kind, alternatives, language) | ms");
    for (const c of cases) {
      const primary = primaryByCase.get(c.id)!; // populated above for every case
      console.log(`${c.id} | ${fmtExpected(c)} | ${fmtActual(primary)} | ${primary.durationMs}ms`);
    }

    return 0;
  } finally {
    server.stop();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
