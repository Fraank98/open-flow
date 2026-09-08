/**
 * ax-context-probe — manual verification of Plan A, no model involved.
 *
 * Run under Electron (the addon is built for Electron's ABI):
 *   npm run ax-probe -- [--user-name NAME] [--delay SECONDS] [--budget CHARS]
 *                       [--allow BUNDLE_ID[,BUNDLE_ID…]] [--metrics-only]
 *
 * Counts down, reads the AX context under the mouse once, prints the reader
 * metrics, then what the deterministic parser makes of it. Prints to stdout
 * ONLY; nothing is written to disk and no logger is attached: this is the one
 * place where screen text is shown, on purpose, to the person who asked for it.
 */
import { app } from "electron";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AxContextReader, toLogMeta as readerLogMeta } from "../src/main/ax-context-reader.js";
import { parse, toLogMeta as parserLogMeta } from "../src/main/utils/conversation-parser.js";
import { PreferencesStore } from "../src/main/preferences-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist-tools/tools → repo root
const APP_ROOT = join(__dirname, "..", "..");
const PREFS_PATH = join(homedir(), "Library", "Application Support", "open-flow", "preferences.json");

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
      "metrics-only": { type: "boolean", default: false },
    },
  });

  const prefs = await new PreferencesStore(PREFS_PATH).load();
  const userDisplayName = values["user-name"] ?? prefs.userDisplayName;
  if (userDisplayName.trim().length === 0) {
    console.error("Nome utente mancante: passa --user-name oppure imposta userDisplayName nelle preferenze.");
    return 2;
  }
  const delayS = Number(values.delay);
  const budget = Number(values.budget);
  const filter = values.allow
    ? { mode: "allowlist" as const, bundleIds: values.allow.split(",").map((s) => s.trim()).filter(Boolean) }
    : undefined;

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
  const r = reader.read(filter ? { bundleIdFilter: filter } : {});
  console.log("=== READER ===");
  console.log(JSON.stringify(readerLogMeta(r), null, 2));
  if (!r.ok) {
    console.log(`ESITO: nessun contesto (${r.reason})`);
    return 0;
  }
  console.log(`frontmost pid: ${frontBefore} ${frontBefore === r.context.pid ? "== target" : "!= target (sarebbe not-frontmost nel coordinatore)"}`);
  for (const l of r.context.levelSummary) {
    console.log(`  livello ${l.depth}: ${String(l.chars).padStart(6)} char, ${String(l.n).padStart(4)} frammenti${l.depth === r.context.chosenLevel ? "  ← scelto" : ""}`);
  }
  if (r.context.chosenLevel === -1) console.log("  nessun salto: il parser usa il livello più ricco");

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
