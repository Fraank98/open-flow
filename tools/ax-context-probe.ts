/**
 * ax-context-probe — manual verification of Plan A, no model involved.
 *
 * Run under Electron (the addon is built for Electron's ABI):
 *   npm run ax-probe -- [--user-name NAME] [--delay SECONDS] [--budget CHARS]
 *                       [--allow BUNDLE_ID[,…]] [--block BUNDLE_ID[,…]]
 *                       [--metrics-only] [--jump-ratio N] [--jump-min CHARS]
 *                       [--text-markers]
 *
 * Il filtro è obbligatorio dopo il Task 6: senza `--allow`/`--block` vale la
 * lista delle tre app verificate. Non esiste un `--allow-all`: la lettura
 * senza filtro non è esprimibile.
 *
 * Counts down, reads the AX context under the mouse once, prints the reader
 * metrics, then what the deterministic parser makes of it. Prints to stdout
 * ONLY; nothing is written to disk and no logger is attached: this is the one
 * place where screen text is shown, on purpose, to the person who asked for it.
 *
 * --text-markers turns on the addon's WebKit text-marker safety net (off by
 * default — final review, correction 4): the one way to measure its benefit
 * without rebuilding. --jump-ratio/--jump-min override the jump-detection
 * budgets, e.g. to force a jump on a shorter body while testing.
 */
import { app } from "electron";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AxContextReader,
  parseFiniteNumber,
  toLogMeta as readerLogMeta,
  type BundleIdFilter,
  type ReadBudgets,
} from "../src/main/ax-context-reader.js";
import { parse, toLogMeta as parserLogMeta } from "../src/main/utils/conversation-parser.js";
import { PreferencesStore } from "../src/main/preferences-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist-tools/tools → repo root
const APP_ROOT = join(__dirname, "..", "..");
const PREFS_PATH = join(homedir(), "Library", "Application Support", "open-flow", "preferences.json");
/** The three apps measured in spike 1. Duplicated here as a literal on
 *  purpose: the probe must not depend on the preferences of Task 2. */
const PROBE_DEFAULT_APPS = ["com.tinyspeck.slackmacgap", "com.apple.mail", "com.brave.Browser"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "user-name": { type: "string" },
      delay: { type: "string", default: "3" },
      budget: { type: "string", default: "2500" },
      allow: { type: "string" },
      block: { type: "string" },
      "metrics-only": { type: "boolean", default: false },
      "jump-ratio": { type: "string" },
      "jump-min": { type: "string" },
      "text-markers": { type: "boolean", default: false },
    },
  });

  const prefs = await new PreferencesStore(PREFS_PATH).load();
  const userDisplayName = values["user-name"] ?? prefs.userDisplayName;
  if (userDisplayName.trim().length === 0) {
    console.error("Nome utente mancante: passa --user-name oppure imposta userDisplayName nelle preferenze.");
    return 2;
  }

  // Number(x) silently turns a bad argument into NaN, which then skips guards
  // downstream instead of failing loudly (final review, correction 8): NaN >
  // 0 is false, so the countdown loop below would just not run, and NaN < 100
  // is also false, so buildTranscript's minimum-budget guard would never
  // fire. parseFiniteNumber throws instead, and every throw in main() is
  // caught by the top-level handler and reported with exit code 1.
  let delayS: number;
  let budget: number;
  const overrides: Partial<ReadBudgets> = {};
  try {
    delayS = parseFiniteNumber(values.delay, "--delay");
    budget = parseFiniteNumber(values.budget, "--budget");
    if (values["jump-ratio"] !== undefined) overrides.jumpRatio = parseFiniteNumber(values["jump-ratio"], "--jump-ratio");
    if (values["jump-min"] !== undefined) overrides.jumpMinChars = parseFiniteNumber(values["jump-min"], "--jump-min");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (values["text-markers"]) overrides.textMarkers = true;

  const ids = (raw: string): string[] => raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (values.allow !== undefined && values.block !== undefined) {
    console.error("--allow e --block sono alternativi: passane uno solo.");
    return 2;
  }
  const filter: BundleIdFilter = values.block !== undefined
    ? { mode: "blocklist", bundleIds: ids(values.block) }
    : { mode: "allowlist", bundleIds: values.allow !== undefined ? ids(values.allow) : PROBE_DEFAULT_APPS };

  const reader = new AxContextReader({ appRoot: APP_ROOT, isPackaged: false });
  if (!reader.isTrusted()) {
    console.error("Accessibility non concessa a Electron.app (node_modules/electron/dist). Concedila in Privacy & Security → Accessibility e riprova.");
    return 3;
  }

  for (let s = delayS; s > 0; s--) {
    console.error(`Sposta il mouse sopra la conversazione. Lettura fra ${s}…`);
    await sleep(1000);
  }

  const frontBefore = reader.frontmostPid();
  const r = reader.read(filter, overrides);
  console.log("=== READER ===");
  console.log(JSON.stringify(readerLogMeta(r), null, 2));
  if (!r.ok) {
    console.log(`ESITO: nessun contesto (${r.reason})`);
    return 0;
  }
  console.log(`frontmost pid: ${frontBefore} ${frontBefore === r.context.pid ? "== target" : "!= target (sarebbe not-frontmost nel coordinatore)"}`);
  console.log(`filtro: ${filter.mode} [${filter.bundleIds.join(", ")}]`);
  console.log(`  stadio 1 (identificazione): ${r.context.timings.probeMs.toFixed(1)} ms`);
  for (const l of r.context.levelSummary) {
    console.log(`  livello ${l.depth}: ${String(l.chars).padStart(6)} char, ${String(l.n).padStart(4)} frammenti${l.truncated ? " (troncato)" : ""}${l.depth === r.context.chosenLevel ? "  ← scelto" : ""}`);
  }
  if (r.context.chosenLevel === -1) console.log("  nessun salto: il parser usa il livello più ricco");
  console.log(r.context.markerText === null
    ? "  webkit marker: assente"
    : `  webkit marker: presente, ${r.context.markerText.chars} char, ${r.context.markerText.fragmentsTouched} frammenti toccati dallo split`);

  const p = parse({ fragments: r.context.fragments, userDisplayName, tailBudgetChars: budget });
  console.log("=== PARSER ===");
  console.log(JSON.stringify(parserLogMeta(p), null, 2));
  if (p.kind === "abstain") {
    console.log(`ASTENSIONE: ${p.reason}`);
    return 0;
  }
  if (values["metrics-only"]) return 0;
  console.log("--- TRASCRIZIONE ---");
  console.log(p.transcript);
  console.log("--- GIST ---");
  console.log(p.gist);
  console.log(`interlocutore: ${p.counterpart}   lingua: ${p.languageGuess}   turni: ${p.turns.length}`);
  return 0;
}

app.whenReady().then(async () => {
  app.dock?.hide(); // keep the target app in front; the probe has no window
  let code = 1;
  try {
    code = await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
  }
  app.exit(code);
});
