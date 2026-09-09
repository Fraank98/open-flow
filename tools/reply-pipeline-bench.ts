/**
 * reply-pipeline-bench — the Task 10 human-reading instrument (Plan B).
 *
 * Layer 3 of the spec's test strategy is the primary metric: the automatic
 * numbers did not discriminate quality in the benchmark (91-100% for every
 * model), so this tool exists to print what a person has to READ. It starts
 * its own `LLMServer`, runs the full production pipeline — `parse` →
 * `ReplyClassifier` → `positionsFor` → `ReplyGenerator` → `filterVariants` —
 * on the spike corpus's RAW AX fragments (never copying that logic: reading
 * on a different path than the app measures a different app), and prints the
 * material for the five-axis manual rubric plus the Jaccard recalibration
 * figures the filter's two similarity thresholds need.
 *
 * Pure HTTP + child_process — no native addon, so it runs under `tsx`
 * directly (no Electron). Prints to stdout only; no logger is attached, ever
 * (like ax-context-probe): this is the one place conversation text and
 * generated replies are meant to be shown, to the person who asked for them.
 *
 * Run:
 *   npm run reply-pipeline-bench -- --model /path/to/gemma-3-4b-it-Q4_K_M.gguf
 */
import { parseArgs } from "node:util";
import { basename } from "node:path";
import { LLMServer } from "../src/main/llm-server.js";
import { ReplyChatClient } from "../src/main/reply-chat-client.js";
import { ReplyClassifier, type ClassifyResult } from "../src/main/reply-classifier.js";
import { ReplyGenerator, GENERATOR_PREFIX, type GenerateResult } from "../src/main/reply-generator.js";
import { positionsFor, type Position } from "../src/main/utils/reply-positions.js";
import { filterVariants, jaccardWords, MIN_KEPT, type FilterRule, type FilterOutput } from "../src/main/utils/variant-filter.js";
import { parse } from "../src/main/utils/conversation-parser.js";
import { CASES, USER_NAME, axFragments } from "../test/fixtures/conversations/spike-corpus.js";

/** The five in-scope cases of the corpus and the kind each one must get
 *  (spec §6, Task 1's own hand annotation — duplicated here rather than
 *  imported from the integration test on purpose: a tool and a test are two
 *  independent consumers of the same corpus, not one importing the other). */
const EXPECTED_KIND: Readonly<Record<string, "generic" | "alternative" | "offer">> = {
  "slack-decisione": "alternative",
  "slack-richiesta-aiuto": "generic",
  "mail-preventivo": "offer",
  "mail-thread-lungo": "alternative",
  "mail-inglese": "generic",
};

const OUT_OF_SCOPE_IDS: readonly string[] = CASES.filter((c) => c.expect === "abstain").map((c) => c.id);
const IN_SCOPE_IDS: readonly string[] = Object.keys(EXPECTED_KIND);

function parseFiniteInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a finite number, got "${raw}"`);
  return n;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx]!; // idx clamped into [0, length-1] above
}

interface Aggregates {
  kindHits: number;
  kindTotal: number;
  formatMatches: number;
  formatTotal: number;
  pillShown: number;
  pillTotal: number;
  ruleCounts: Map<FilterRule, number>;
  latenciesMs: number[];
  echoMax: number;
  dupMax: number;
}

function newAggregates(): Aggregates {
  return { kindHits: 0, kindTotal: 0, formatMatches: 0, formatTotal: 0, pillShown: 0, pillTotal: 0, ruleCounts: new Map(), latenciesMs: [], echoMax: 0, dupMax: 0 };
}

function recordDropped(agg: Aggregates, dropped: FilterOutput["dropped"]): void {
  for (const d of dropped) agg.ruleCounts.set(d.rule, (agg.ruleCounts.get(d.rule) ?? 0) + 1);
}

/** Jaccard recalibration figures for one filter result: echo against
 *  lastMessage, near-duplicate among the kept variants themselves. */
function recordJaccard(agg: Aggregates, kept: FilterOutput["kept"], lastMessage: string): void {
  for (const v of kept) agg.echoMax = Math.max(agg.echoMax, jaccardWords(v.text, lastMessage));
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      agg.dupMax = Math.max(agg.dupMax, jaccardWords(kept[i]!.text, kept[j]!.text));
    }
  }
}

function fmtRuleCounts(counts: Map<FilterRule, number>): string {
  if (counts.size === 0) return "nessuno";
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([rule, n]) => `${rule} ${n}`).join(", ");
}

const PILL_LABEL_WIDTH = 26;

async function runInScopeCase(
  id: string,
  repIdx: number,
  repeats: number,
  userDisplayName: string,
  classifier: ReplyClassifier,
  generator: ReplyGenerator,
  metricsOnly: boolean,
  agg: Aggregates,
): Promise<void> {
  const c = CASES.find((x) => x.id === id)!; // id comes from IN_SCOPE_IDS, always present in CASES
  const expectedKind = EXPECTED_KIND[id]!; // id comes from EXPECTED_KIND's own keys
  console.log(`\n── caso: ${id} (${c.app})   ripetizione ${repIdx + 1}/${repeats} ──`);

  const parsed = parse({ fragments: axFragments(c.ax), userDisplayName, tailBudgetChars: 2_500 });
  if (parsed.kind !== "conversation") {
    console.log(`ERRORE: il parser non produce più una conversazione per questo caso (${parsed.reason}) — regressione, non misurabile.`);
    return;
  }

  agg.pillTotal += 1;
  agg.kindTotal += 1;

  const cls: ClassifyResult = await classifier.classify({
    transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
  });
  if (!cls.ok) {
    if (!metricsOnly) console.log(`gist:      ${parsed.gist}`);
    console.log(`kind:      ESITO NEGATIVO (${cls.reason === "llm-error" ? `llm-error: ${cls.error}` : cls.reason}) (atteso: ${expectedKind})`);
    console.log(`latenza:   classificatore ${cls.durationMs} ms   (generatore non eseguito)`);
    return;
  }
  if (cls.classification.kind === expectedKind) agg.kindHits += 1;

  const positions: Position[] = positionsFor({
    kind: cls.classification.kind, language: cls.classification.language,
    ...(cls.classification.alternatives ? { alternatives: cls.classification.alternatives } : {}),
  });

  if (!metricsOnly) console.log(`gist:      ${parsed.gist}`);
  console.log(`kind:      ${cls.classification.kind} (atteso: ${expectedKind})   lingua: ${cls.classification.language}`);
  if (!metricsOnly && cls.classification.alternatives) {
    console.log(`alternative: «${cls.classification.alternatives[0]}» | «${cls.classification.alternatives[1]}»`);
  }

  agg.formatTotal += 1;
  const gen: GenerateResult = await generator.generate({
    transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
    userDisplayName, subject: parsed.subject, positions, language: cls.classification.language,
  });
  if (!gen.ok) {
    console.log(`latenza:   classificatore ${cls.durationMs} ms   generatore FALLITO (${gen.reason === "llm-error" ? gen.error : gen.reason}) dopo ${gen.durationMs} ms`);
    return;
  }
  const formatOk = gen.variants.length === positions.length && gen.variants.every((v, i) => v.key === positions[i]!.key);
  if (formatOk) agg.formatMatches += 1;
  console.log(`latenza:   classificatore ${cls.durationMs} ms   generatore ${gen.durationMs} ms   totale ${cls.durationMs + gen.durationMs} ms`);
  if (!formatOk) console.log(`ATTENZIONE: chiavi restituite non conformi a quelle richieste (${gen.variants.map((v) => v.key).join(",")} vs ${positions.map((p) => p.key).join(",")})`);
  agg.latenciesMs.push(cls.durationMs + gen.durationMs);

  const filtered = filterVariants({
    variants: gen.variants, lastMessage: parsed.lastMessage, transcript: parsed.transcript,
    counterpart: parsed.counterpart, userDisplayName, language: cls.classification.language,
  });
  recordDropped(agg, filtered.dropped);
  recordJaccard(agg, filtered.kept, parsed.lastMessage);
  if (filtered.kept.length >= MIN_KEPT) agg.pillShown += 1;

  console.log(`scartate:  ${filtered.dropped.length === 0 ? "nessuna" : filtered.dropped.map((d) => `${d.key}=${d.rule}`).join(", ")}`);
  console.log(`proposte mostrate: ${filtered.kept.length} di ${positions.length}`);
  if (!metricsOnly) {
    filtered.kept.forEach((v, i) => {
      console.log(`  ⌘${i + 1}  ${v.label.padEnd(PILL_LABEL_WIDTH)}│ ${v.text}`);
    });
    console.log("rubrica (compila a mano, un voto binario per asse e per variante):");
    console.log("  ruoli  inventato  posizione  lingua  distinta");
    filtered.kept.forEach((_v, i) => {
      console.log(`  ⌘${i + 1}  [ ]    [ ]        [ ]      [ ]     [ ]`);
    });
  }
}

async function runOutOfScopeCase(
  id: string,
  userDisplayName: string,
  classifier: ReplyClassifier,
  generator: ReplyGenerator,
): Promise<void> {
  const c = CASES.find((x) => x.id === id)!; // id comes from OUT_OF_SCOPE_IDS, always present in CASES
  const parsed = parse({ fragments: axFragments(c.ax), userDisplayName, tailBudgetChars: 2_500 });
  if (parsed.kind !== "conversation") {
    console.log(`── fuori ambito: ${id} → astensione (${parsed.reason})`);
    return;
  }
  const cls = await classifier.classify({ transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart });
  if (!cls.ok) {
    console.log(`── fuori ambito: ${id} → astensione (classificatore: ${cls.reason === "llm-error" ? `llm-error: ${cls.error}` : cls.reason})`);
    return;
  }
  const positions = positionsFor({
    kind: cls.classification.kind, language: cls.classification.language,
    ...(cls.classification.alternatives ? { alternatives: cls.classification.alternatives } : {}),
  });
  const gen = await generator.generate({
    transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
    userDisplayName, subject: parsed.subject, positions, language: cls.classification.language,
  });
  if (!gen.ok) {
    console.log(`── fuori ambito: ${id} → astensione (generatore: ${gen.reason})`);
    return;
  }
  const filtered = filterVariants({
    variants: gen.variants, lastMessage: parsed.lastMessage, transcript: parsed.transcript,
    counterpart: parsed.counterpart, userDisplayName, language: cls.classification.language,
  });
  if (filtered.kept.length >= MIN_KEPT) {
    console.log(`── fuori ambito: ${id} → PILL (FALLIMENTO: ${filtered.kept.length} proposte mostrate — il caso doveva astenersi)`);
  } else {
    console.log(`── fuori ambito: ${id} → astensione (filtro: ${filtered.kept.length} tenute < MIN_KEPT)`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string" },
      "server-bin": { type: "string", default: "resources/bin/llama-server" },
      port: { type: "string", default: "18096" },
      cases: { type: "string" },
      repeats: { type: "string", default: "1" },
      "user-name": { type: "string", default: USER_NAME },
      "metrics-only": { type: "boolean", default: false },
      context: { type: "string", default: "3072" },
    },
  });

  if (!values.model) {
    console.error("--model <path> is required.");
    return 2;
  }
  let port: number;
  let repeats: number;
  let context: number;
  try {
    port = parseFiniteInt(values.port, "--port", 18096);
    repeats = parseFiniteInt(values.repeats, "--repeats", 1);
    context = parseFiniteInt(values.context, "--context", 3072);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const allIds = new Set([...IN_SCOPE_IDS, ...OUT_OF_SCOPE_IDS]);
  const selected = values.cases !== undefined
    ? values.cases.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [...IN_SCOPE_IDS, ...OUT_OF_SCOPE_IDS];
  for (const id of selected) {
    if (!allIds.has(id)) {
      console.error(`Caso sconosciuto: "${id}". Casi in ambito: ${IN_SCOPE_IDS.join(", ")}. Fuori ambito: ${OUT_OF_SCOPE_IDS.join(", ")}.`);
      return 2;
    }
  }
  const inScopeCases = selected.filter((id) => IN_SCOPE_IDS.includes(id));
  const outOfScopeCases = selected.filter((id) => OUT_OF_SCOPE_IDS.includes(id));

  const server = new LLMServer({
    binaryPath: values["server-bin"]!, // has a parseArgs default, always a string
    modelPath: values.model,
    port,
    contextSize: context,
    startupTimeoutMs: 180_000,
    warmupPrompt: GENERATOR_PREFIX,
  });

  console.error(`Avvio llama-server su ${values.model} (porta ${port}, contesto ${context})…`);
  await server.start();

  try {
    const client = new ReplyChatClient({ endpoint: server.getEndpoint() });
    const classifier = new ReplyClassifier({ client, timeoutMs: 30_000 });
    const generator = new ReplyGenerator({ client, timeoutMs: 30_000 });

    const agg = newAggregates();
    for (let rep = 0; rep < repeats; rep++) {
      for (const id of inScopeCases) {
        await runInScopeCase(id, rep, repeats, values["user-name"]!, classifier, generator, values["metrics-only"]!, agg);
      }
    }
    for (const id of outOfScopeCases) {
      await runOutOfScopeCase(id, values["user-name"]!, classifier, generator);
    }

    const sortedLatencies = [...agg.latenciesMs].sort((a, b) => a - b);
    console.log("\n=== RIEPILOGO ===");
    console.log(`modello: ${basename(values.model)}   casi in ambito: ${inScopeCases.length}   fuori ambito: ${outOfScopeCases.length}   ripetizioni: ${repeats}`);
    console.log(`pill mostrate: ${agg.pillShown}/${agg.pillTotal}   (soglia di rilascio: zero pill sui casi fuori ambito — vedi le righe "fuori ambito" sopra)`);
    console.log(`conformità di formato: ${agg.formatMatches}/${agg.formatTotal} chiavi attese restituite`);
    console.log(`accuratezza kind: ${agg.kindHits}/${agg.kindTotal}`);
    console.log(`scarti per regola: ${fmtRuleCounts(agg.ruleCounts)}`);
    console.log(`latenza p50: ${percentile(sortedLatencies, 50)} ms   p95: ${percentile(sortedLatencies, 95)} ms`);
    console.log(`ritaratura Jaccard (§Deviazioni 5): eco max fra le TENUTE: ${agg.echoMax.toFixed(2)}   quasi-duplicato max fra le TENUTE: ${agg.dupMax.toFixed(2)}`);
    console.log("  → se l'eco massima fra le tenute supera 0.6 o il quasi-duplicato massimo supera 0.75 le soglie sono da alzare;");
    console.log("    se nessuna variante buona è stata scartata per queste due regole, sono da lasciare come sono.");
    console.log("rubrica: da compilare a mano. Soglia di rilascio: ≥ 90% dei casi in ambito con");
    console.log("  TUTTE le varianti mostrate che passano TUTTI i cinque assi, e zero pill fuori ambito.");

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
