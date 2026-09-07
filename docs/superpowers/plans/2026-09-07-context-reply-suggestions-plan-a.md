# Proposte di risposta dal contesto — Piano A (acquisizione + parser deterministico)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portare nel repo la metà **deterministica e senza modello** della feature "proposte di risposta dal contesto": leggere il contesto Accessibility sotto il puntatore (addon nativo `ax_context` + wrapper `AxContextReader`), ricostruire una trascrizione a ruoli espliciti (`ConversationParser`), decidere se c'è qualcosa a cui rispondere (cancelli di astensione), e rendere tutto verificabile da solo con un punto d'ingresso di debug.

**Architecture:** Tre strati con contratti stretti. (1) `native/ax-context/ax_context.mm`: sottile strato Obj-C++ di raccolta dati, stesso schema di `ptt_monitor`, nessuna logica di conversazione. (2) `src/main/ax-context-reader.ts`: wrapper con `native` iniettabile (come `PTTManager`), normalizza i frammenti e converte in `RawContext`. (3) `src/main/utils/conversation-parser.ts`: modulo puro, senza I/O, che fa tutto il lavoro testabile — sopravvivenza, dedup per contenimento, turni, ruoli, cancelli, coda con budget, gist, lingua. Il corpus dei dieci casi dello spike 2 diventa il fixture condiviso `test/fixtures/conversations/spike-corpus.ts`. Il tool `tools/ax-context-probe.ts` (eseguito sotto Electron, mai pacchettizzato) stampa a terminale ciò che il parser ricostruisce da una finestra reale.

**Tech Stack:** TypeScript (ESM, import con `.js`), Vitest, Electron 32 (main process), N-API Obj-C++ (`node-addon-api`, ARC), `electron-rebuild`.

**Branch:** `context-reply-suggestions` (da creare da `main`; la spec la nomina in testa). **Nessun merge in `main` senza autorizzazione esplicita** — vale anche per i fast-forward.

**Spec di riferimento (autorità):** `docs/superpowers/specs/2026-09-07-context-reply-suggestions-design.md`. Dove il piano e la spec divergono, vince la spec. Le divergenze deliberate del piano sono elencate in §Deviazioni dichiarate e vanno lette prima di eseguire.

---

## Contesto

La feature completa (spec §Problema): l'utente preme una hotkey, l'app legge la conversazione **sotto il puntatore del mouse** via Accessibility API e, se è una conversazione a cui si risponde con una decisione, mostra nella pill tre proposte di risposta. È spenta per default.

Questo è il **Piano A**: soltanto gli strati 1 e 2 della pipeline a sei strati della spec (§Architettura), più la preferenza `userDisplayName` che il parser richiede, i fixture e un tool di debug. Il Piano A **non** genera testo, **non** tocca l'overlay, **non** avvia server LLM, **non** introduce hotkey, **non** tocca il catalogo modelli. Quello è il Piano B (classificatore, posizioni, generatore, filtri, pill, secondo `llama-server`, hotkey, preferenze UI, bump di `llama.cpp`).

Il Piano A è **verificabile da solo**: al termine, `npm run ax-probe` sotto Electron legge una finestra reale e stampa la trascrizione a ruoli espliciti o il codice di astensione, senza alcun modello.

Materiale già verificato negli spike, da portare in TypeScript (non copiare):

- il parser deterministico dello spike 2 (10/10 sui cancelli): espressioni regolari, soglie e algoritmo sono citati alla lettera nei task 2-4;
- il corpus dei dieci casi con il rumore AX realistico: portato nel task 1;
- la sonda AX dello spike 1 (`axprobe2.m`): la sequenza esatta di chiamate Accessibility è citata nel task 6.

---

## Global Constraints

Questa sezione viene copiata alla lettera nel prompt dei reviewer. Ogni riga è un requisito controllabile.

**Ambito e file**

1. Il Piano A crea **solo** questi file: `native/ax-context/ax_context.mm`, `src/main/ax-context-reader.ts`, `src/main/utils/conversation-parser.ts`, `test/fixtures/conversations/spike-corpus.ts`, `test/unit/conversation-parser.test.ts`, `test/unit/conversation-parser.corpus.test.ts`, `test/unit/ax-context-reader.test.ts`, `tools/ax-context-probe.ts`, `tsconfig.tools.json`.
2. Il Piano A modifica **solo** questi file esistenti: `binding.gyp` (nuovo target), `package.json` (script `ax-probe` e `rebuild-native`), `.gitignore` (riga `dist-tools/`), `src/main/preferences-store.ts` (campo `userDisplayName`), `test/unit/preferences-store.test.ts` (due test). Il fixture `test/fixtures/conversations/spike-corpus.ts`, creato nel task 1, viene esteso nel task 5.
3. **Nessun task tocca** `src/main/text-injector.ts`, `src/main/llm-server.ts`, `src/main/overlay-window.ts`, `scripts/fetch-binaries.sh`, `src/main/index.ts`, `src/main/llm-cleaner.ts`, `src/main/pipeline-coordinator.ts`, `src/main/ptt-manager.ts`, `native/ptt-monitor/`, `native/whisper-stream/`, `src/shared/ipc-channels.ts`, `src/main/model-catalog.ts`, `src/renderer/**`, `src/preload/**`, `electron-builder.yml`. Verifica: `git diff --name-only main...HEAD` non contiene nessuno di questi percorsi.
4. Nessun codice del Piano A avvia processi, apre socket, registra hotkey (`globalShortcut`), crea finestre o timer periodici. Verifica: `grep -rn "globalShortcut\|BrowserWindow\|setInterval\|spawn(" src/main/ax-context-reader.ts src/main/utils/conversation-parser.ts` non produce righe.

**TDD e qualità**

5. Ogni task che produce logica scrive **prima** il test che fallisce (passo "RED" con il comando e l'errore atteso), poi il codice, poi il test che passa. I test vanno in `test/unit/` con lo stile di `test/unit/dictionary.test.ts`: `import { describe, it, expect } from "vitest"`, import del modulo con suffisso `.js`, un `describe` per area, asserzioni `toBe` / `toEqual` con valori letterali.
6. A fine di **ogni** task questi tre comandi escono con codice 0: `npm run lint`, `npm run typecheck`, `npm run test`. Vanno eseguiti e il loro esito riportato nel messaggio di completamento del task.
7. Tutta la logica testabile sta in TypeScript. L'addon nativo (`ax_context.mm`) è **solo** raccolta dati: nessuna espressione regolare, nessuna euristica sul contenuto del testo, nessuna decisione "è una conversazione". Verifica: `grep -c "regex\|NSRegularExpression" native/ax-context/ax_context.mm` stampa `0`.
8. `AxContextReader` accetta `native?: AxContextNative` nel costruttore (stesso pattern di `PTTManagerOptions.native`) e **tutti** i suoi test usano un finto nativo; nessun test di `test/unit/` carica un file `.node`. Verifica: `grep -rn "\.node" test/unit/` non produce righe.
9. Stile TypeScript: tipi espliciti sulle firme esportate, nessuna variabile mutabile a livello di modulo (`let` fuori da funzioni è vietato; `const` con oggetti immutabili è permesso), JSDoc dove il *perché* non è ovvio, `noUncheckedIndexedAccess` rispettato (accessi indicizzati con `!` solo dove l'indice è dimostrabilmente valido, con commento).
10. Le espressioni regolari, le soglie e i dieci casi citati nei task 1-4 sono **materiale verificato dallo spike**: vanno riusati alla lettera dove il piano li cita. Ogni scostamento va motivato in un commento nel codice e dichiarato nel messaggio di completamento.

**Privacy (requisiti della spec §Privacy che toccano il Piano A)**

11. **Nessun contenuto letto dallo schermo nei log** (spec, privacy 2). Ogni chiamata a `logger.info/warn/error/debug` nel codice del Piano A riceve **solo** metriche: tempi (`ms`), conteggi (`chars`, `n`, `turns`), `bundleId`, `pid`, `depth`, codici (`reason`). **Mai** frammenti AX, testo dei turni, nomi degli interlocutori, oggetto, trascrizione, gist. Verifica automatica: il test `"non passa mai al logger testo letto dallo schermo"` in `test/unit/ax-context-reader.test.ts` e il test `"toLogMeta non contiene testo del corpus"` in `test/unit/conversation-parser.corpus.test.ts` (task 5 e 7) alimentano un logger-spia e falliscono se un qualunque argomento serializzato contiene una sottostringa di lunghezza ≥ 8 dei frammenti del corpus o uno dei nomi `Marta`, `Fulvio`, `Francesca`, `Giulia`, `Helen`, `Matteo`.
12. **Nessuna lettura senza gesto** (spec, privacy 3). In `src/` il metodo `readContextUnderCursor` è chiamato in un solo punto: dentro `AxContextReader.read()` in `src/main/ax-context-reader.ts`. Nessun timer, listener di focus o polling lo invoca. Verifica: `grep -rn "readContextUnderCursor" src/` restituisce righe solo in `src/main/ax-context-reader.ts`. (Il tool `tools/ax-context-probe.ts` lo invoca una volta su comando esplicito dell'utente e non è mai incluso nel pacchetto: `electron-builder.yml` include `dist/**/*`, non `dist-tools/`.)
13. **Controllo dell'app prima della raccolta** (spec, privacy 4). L'addon accetta un filtro opzionale sul `bundleId` e, se l'app non passa, restituisce `reason: "app-not-allowed"` **prima** di risalire e raccogliere frammenti: dopo `AXUIElementCopyElementAtPosition` legge solo pid e bundle id.
14. **Budget stretto** (spec, privacy 5). L'addon si ferma al livello del salto e non sale oltre; `maxDepth` 8, `maxTotalChars` 16 000, `timeBudgetMs` 300; il parser dà al massimo `tailBudgetChars` = 2 500 caratteri in uscita. I text marker vengono tentati **solo** sull'antenato scelto e sul campo editabile, mai sulla finestra o sulla web area intera.
15. **Il mouse sceglie la finestra** (spec, privacy 6). L'addon non enumera finestre né legge titoli di finestra o di tab: `kAXWindowsAttribute`, `kAXTitleAttribute` sull'elemento finestra e `kAXFocusedWindowAttribute` **non** compaiono in `ax_context.mm`. Verifica: `grep -c "kAXWindowsAttribute\|kAXFocusedWindowAttribute" native/ax-context/ax_context.mm` stampa `0`.
16. **Nessuna persistenza** (spec, privacy 2 e §Out). Nessun file viene scritto con contenuto letto dallo schermo: `writeFile`/`appendFile`/`fs` non compaiono in `ax-context-reader.ts`, `conversation-parser.ts`, `ax-context-probe.ts`. Il probe stampa **solo su stdout**.
17. **Corpus anonimizzato** (spec, privacy 9). Il fixture usa nomi di fantasia e domini `example.com` / `.example`: l'indirizzo reale `danilo@ergonai.com` presente nello spike **non** entra nel repo (sostituito con `danilo@example.com`). I log della sonda degli spike (`ax.log`, `ax2.log`, `diag.log`, `s1.log`) non entrano nel repo. Verifica: `grep -rn "ergonai" test/ src/ tools/` non produce righe.

**Commit**

18. Un commit per task, messaggio in stile Conventional Commits con scope (`feat(context): …`, `test(context): …`, `build(native): …`), corpo che spiega il *perché*, e queste due righe finali:
    ```
    Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh
    ```

---

## Deviazioni dichiarate rispetto alla spec

Tre sole, tutte a favore di requisiti che la spec stessa pone altrove.

1. **`app-not-allowed` a livello nativo.** L'enum `reason` di `NativeContextResult` nella spec ha cinque valori; il piano ne aggiunge un sesto, `"app-not-allowed"`, e aggiunge a `readContextUnderCursor(opts)` il campo opzionale `bundleIdFilter?: { mode: "allowlist" | "blocklist"; bundleIds: string[] }`. Serve al requisito privacy 4 della spec ("il controllo avviene **prima** della raccolta del testo … la risalita e la raccolta dei frammenti partono solo se l'app è permessa"), che senza un aggancio nell'addon sarebbe impossibile da rispettare. Il Piano B passerà le preferenze `replyAppsMode`/`replyApps` in questo campo.
2. **Due attributi text-marker in più.** La spec cita `AXStartTextMarker` (sonda di capacità) e `AXStringForTextMarkerRange` (lettura). Per costruire il range servono anche `AXEndTextMarker` e l'attributo parametrizzato `AXTextMarkerRangeForUnorderedTextMarkers`: sono quelli usati e verificati dalla sonda dello spike 1 (`axprobe2.m`, funzione `textMarkerString`), non invenzioni. Il task 6 li cita alla lettera.
3. **Il caso `chatgpt-conversazione` del corpus cambia attesa.** Nello spike (precedente al benchmark) era `expect: "reply"`; la spec successiva dichiara gli assistenti fuori ambito e introduce il cancello `assistant-speaker`. Il fixture porta il caso con `expect: "abstain"` e `expectedReason: "assistant-speaker"`. Il conteggio resta 10/10 sui cancelli, con 5 casi `reply` e 5 `abstain`.

Estensioni compatibili (non contraddicono la spec): `ParseResult` porta un campo `stats` con soli conteggi, e il modulo espone `toLogMeta()` che produce l'oggetto da passare al logger — è il modo in cui il requisito privacy 2 diventa un test.

---

## File Structure

| File | Ruolo | Task |
|---|---|---|
| `test/fixtures/conversations/spike-corpus.ts` | I dieci casi dello spike 2 (frammenti AX rumorosi + attese), fixture condiviso | 1 |
| `src/main/preferences-store.ts` | Nuovo campo `userDisplayName: string`, default `""` | 1 |
| `test/unit/preferences-store.test.ts` | Un test sul default | 1 |
| `src/main/utils/conversation-parser.ts` | Modulo puro: costanti, fasi 1-10, `parse()`, `toLogMeta()` | 2, 3, 4 |
| `test/unit/conversation-parser.test.ts` | Test unitari per fase, casi sintetici | 2, 3, 4 |
| `test/unit/conversation-parser.corpus.test.ts` | I dieci casi end-to-end + test privacy su `toLogMeta` | 5 |
| `native/ax-context/ax_context.mm` | Addon N-API: lettura AX sotto il mouse, attivazione app, pid frontmost, trust | 6 |
| `binding.gyp` | Target `ax_context` | 6 |
| `package.json` | Script `rebuild-native` (task 6) e `ax-probe` (task 8) | 6, 8 |
| `src/main/ax-context-reader.ts` | Wrapper con DI, normalizzazione, `RawContext`, `toLogMeta()` | 7 |
| `test/unit/ax-context-reader.test.ts` | Test con finto nativo, incluso logger-spia | 7 |
| `tools/ax-context-probe.ts`, `tsconfig.tools.json`, `.gitignore` | Punto d'ingresso di debug sotto Electron | 8 |

**Ordine e dipendenze:**

```
Task 1 (fixture + pref)  ──┐
                           ├──▶ Task 2 (parser fasi 1-3) ──▶ Task 3 (fasi 4-6) ──▶ Task 4 (fasi 7-10, parse) ──▶ Task 5 (corpus + privacy)
Task 6 (addon nativo)  ────┴──────────────────────────────────────────────────────▶ Task 7 (reader) ──────────────▶ Task 8 (probe)
```

- Task 1 non dipende da nulla. Task 6 non dipende da nulla (può correre in parallelo a 1-5).
- Task 2 dipende da 1 solo per convenzione di ordine (il fixture è utile per ragionare); tecnicamente `conversation-parser.ts` non importa il fixture. Il fixture del task 1 **non** importa il parser: definisce da sé l'unione letterale `ExpectedAbstainReason` (task 1, passo 2); il task 5 verifica che coincida con `AbstainReason` del parser.
- Task 3 dipende da 2; Task 4 da 3; Task 5 da 4 e da 1.
- Task 7 dipende da 6 (per le firme di `AxContextNative`); il reader **non** importa il parser. Task 8 dipende da 7 e da 4.

---

## Task 1: Fixture condiviso del corpus e preferenza `userDisplayName`

**Obiettivo:** portare nel repo i dieci casi dello spike 2 come fixture tipizzato e anonimizzato, e aggiungere alle preferenze il nome dell'utente che il parser userà per distinguere i suoi turni.

**Dipende da:** nessun task.

**Files:**
- Create: `test/fixtures/conversations/spike-corpus.ts`
- Modify: `src/main/preferences-store.ts`
- Modify: `test/unit/preferences-store.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce sulla preferenza**

Aggiungi in coda al `describe("PreferencesStore", …)` di `test/unit/preferences-store.test.ts`:

```typescript
  it("defaults userDisplayName to an empty string", () => {
    expect(DEFAULT_PREFS.userDisplayName).toBe("");
  });

  it("loads an old preferences file without userDisplayName as an empty string", async () => {
    const path = join(dir, "prefs.json");
    const { writeFile } = await import("node:fs/promises");
    // A file written by a version that predates the field.
    await writeFile(path, JSON.stringify({ setupComplete: true, language: "it" }));
    const prefs = await new PreferencesStore(path).load();
    expect(prefs.userDisplayName).toBe("");
    expect(prefs.language).toBe("it");
  });
```

Run: `npx vitest run test/unit/preferences-store.test.ts`
Expected: FAIL — `DEFAULT_PREFS.userDisplayName` è `undefined` (errore di tipo in typecheck, valore `undefined` a runtime).

- [ ] **Step 2: Aggiungi il campo alle preferenze**

In `src/main/preferences-store.ts`, dopo `dictionary: string[];` nell'interfaccia:

```typescript
  /** The name the user appears with in chats and mails ("Danilo", "Danilo
   *  Franco"). The reply-suggestions parser compares it — normalized on case,
   *  accents and whitespace, on the full string and on its first token — with
   *  the speaker of each turn to tell the user's turns from the counterpart's.
   *  Empty means "not configured": the feature cannot be enabled without it. */
  userDisplayName: string;
```

e in `DEFAULT_PREFS`, dopo `dictionary: [],`:

```typescript
  userDisplayName: "",
```

`load()` fonde `{ ...DEFAULT_PREFS, ...parsed }`: i file esistenti ricevono `""` senza migrazione.

Run: `npx vitest run test/unit/preferences-store.test.ts`
Expected: PASS (9 test).

- [ ] **Step 3: Crea il fixture del corpus**

Crea `test/fixtures/conversations/spike-corpus.ts`. Il contenuto dei dieci casi è quello dello spike, con **una** anonimizzazione obbligatoria (`danilo@ergonai.com` → `danilo@example.com`) e **un** cambio di attesa (caso `chatgpt-conversazione`, vedi §Deviazioni dichiarate, punto 3). I campi `must` / `mustNot` sono annotazioni di merito per il Piano B: si portano così come sono.

```typescript
/**
 * The ten-case corpus of spike 2 (2026-09-04), as noisy Accessibility dumps.
 *
 * `ax` mimics the REAL shape of the AX output measured in spike 1: fragments
 * separated by " ⋄ ", the same text repeated as AXValue and AXDescription,
 * timestamps in several formats, button labels mixed with content.
 *
 * `expect` is what the deterministic parser must decide: "reply" when the
 * gates let the conversation through, "abstain" otherwise, with the exact
 * abstain code in `expectedReason`. `must` / `mustNot` are merit annotations
 * for the generation half of the feature (Plan B); they are not used here.
 *
 * Every name, address and figure is fictional (spec, privacy 9).
 */

export const USER_NAME = "Danilo";

/** Mirrors `AbstainReason` in src/main/utils/conversation-parser.ts. Kept as
 *  a literal here so the fixture has no import into production code; the
 *  corpus test asserts the two unions agree. */
export type ExpectedAbstainReason =
  | "no-attributed-turns"
  | "only-user-turns"
  | "last-turn-is-user"
  | "last-message-too-short"
  | "more-than-two-speakers"
  | "assistant-speaker";

export interface ConversationCase {
  readonly id: string;
  readonly app: string;
  readonly expect: "reply" | "abstain";
  readonly expectedReason?: ExpectedAbstainReason;
  readonly note: string;
  readonly ax: string;
  readonly must: readonly string[];
  readonly mustNot: readonly string[];
}

export const CASES: readonly ConversationCase[] = [
  {
    id: "slack-decisione",
    app: "Slack",
    expect: "reply",
    note: "Domanda binaria diretta: la risposta deve PRENDERE POSIZIONE.",
    ax: "Marta (messaggio diretto, disponibile) ⋄ Oggi Premi Invio per passare a una data specifica. ⋄ Marta: ciao, ho visto che la PR sul login è ferma da due giorni, la review la fai tu o la giro a Paolo? 09:12. ⋄ Oggi alle 09:12:41 ⋄ 09:12 ⋄ ciao, ho visto che la PR sul login è ferma da due giorni, la review la fai tu o la giro a Paolo? ⋄ Marta: te lo chiedo perché venerdì dovremmo rilasciare e quella è bloccante 09:13. ⋄ 09:13 ⋄ te lo chiedo perché venerdì dovremmo rilasciare e quella è bloccante ⋄ Messaggio a Marta ⋄ Invia ⋄ Allega file ⋄ Formattazione ⋄ Emoji ⋄ Registra clip audio",
    must: ["decide chi fa la review"],
    mustNot: ["ripete la domanda a Marta senza rispondere", "si firma Marta"],
  },
  {
    id: "slack-richiesta-aiuto",
    app: "Slack",
    expect: "reply",
    note: "Collega segnala un problema e chiede una mano: risposta di disponibilità.",
    ax: "frontend-hub (Canale) - 12 nuovi elementi ⋄ Cerca ⋄ Aiuto ⋄ Attività ⋄ Fulvio: raga il build di staging è rotto da stamattina, errore sul lockfile. qualcuno ci ha già messo mano? 11:04. ⋄ Oggi alle 11:04:12 ⋄ 11:04 ⋄ raga il build di staging è rotto da stamattina, errore sul lockfile. qualcuno ci ha già messo mano? ⋄ Messaggio a frontend-hub ⋄ Invia ⋄ Allega file",
    must: ["risponde alla domanda se qualcuno ci ha messo mano"],
    mustNot: ["si firma Fulvio", "chiede all'utente come può aiutarlo"],
  },
  {
    id: "mail-preventivo",
    app: "Mail",
    expect: "reply",
    note: "Preventivo del SECONDO piano, 4.850 €. Il numero e il piano non vanno alterati.",
    ax: "Re: Preventivo revisione impianto ⋄ A: ⋄ francesca.bianchi@studiotecnico.example ⋄ aggiungi contatti ⋄ Cc: ⋄ Oggetto: ⋄ message body ⋄ Il giorno 4 set 2026, alle ore 11:20, Francesca Bianchi <francesca.bianchi@studiotecnico.example> ha scritto: ⋄ Buongiorno, le invio il preventivo aggiornato per la revisione dell'impianto elettrico del secondo piano. Come discusso, ho incluso anche la sostituzione del quadro. Il totale è 4.850 euro IVA esclusa, con inizio lavori previsto entro tre settimane dall'accettazione. Resto a disposizione per chiarimenti. Cordiali saluti, Francesca Bianchi ⋄ Da: ⋄ danilo@example.com ⋄ Rispondi a tutti ⋄ Formato ⋄ Emoji e simboli ⋄ Strumenti di scrittura ⋄ Allega ⋄ Invia più tardi ⋄ Invia",
    must: ["si rivolge a Francesca", "resta sul secondo piano se cita il piano"],
    mustNot: ["si firma Francesca", "cambia la cifra", "dice primo piano"],
  },
  {
    id: "mail-thread-lungo",
    app: "Mail",
    expect: "reply",
    note: "Thread con due messaggi: deve rispondere all'ULTIMO, non al primo.",
    ax: "Re: Sopralluogo di giovedì ⋄ A: ⋄ g.rossi@edilrossi.example ⋄ Cc: ⋄ message body ⋄ Il giorno 3 set 2026 Giulia Rossi ha scritto: Buongiorno, confermo il sopralluogo per giovedì alle 9. ⋄ Il giorno 4 set 2026, alle ore 08:15, Giulia Rossi ha scritto: ⋄ Buongiorno, mi devo scusare ma giovedì mi è saltato un imprevisto. Riusciamo a spostare a venerdì stessa ora, o preferisce la settimana prossima? ⋄ Invia ⋄ Rispondi a tutti ⋄ Allega",
    must: ["risponde allo spostamento a venerdì", "sceglie tra venerdì e settimana prossima"],
    mustNot: ["conferma giovedì alle 9", "si firma Giulia"],
  },
  {
    id: "chatgpt-conversazione",
    app: "Brave",
    expect: "abstain",
    expectedReason: "assistant-speaker",
    note: "L'interlocutore è un assistente. Fuori ambito per la spec (§Out): il cancello assistant-speaker deve fermarlo prima di qualunque modello.",
    ax: "Piani Allenamento di forza - Brave ⋄ Barra degli indirizzi e di ricerca ⋄ chatgpt.com ⋄ Preferiti ⋄ Estensioni ⋄ Vai ai contenuti ⋄ ChatGPT ha detto: ⋄ Posso prepararti la scheda, ma prima mi serve sapere una cosa: quante volte a settimana riesci ad andare in palestra e hai già esperienza con i bilancieri o parti da zero? ⋄ Azioni di risposta ⋄ Copia ⋄ Fai una domanda ⋄ Invia messaggio",
    must: [],
    mustNot: ["propone qualsiasi testo"],
  },
  {
    id: "mail-inglese",
    app: "Mail",
    expect: "reply",
    note: "Conversazione in inglese: la risposta deve essere in inglese.",
    ax: "Re: Invoice #2291 ⋄ A: ⋄ accounts@northlake.example ⋄ Cc: ⋄ message body ⋄ On 4 Sep 2026, at 09:40, Helen Carter wrote: ⋄ Hi, we still haven't received payment for invoice #2291, due on 28 August. Could you confirm when we can expect it? Best, Helen ⋄ Invia ⋄ Rispondi a tutti",
    must: ["risponde in inglese", "cita la fattura 2291 o la data"],
    mustNot: ["risponde in italiano", "si firma Helen"],
  },
  {
    id: "abst-scheda-vuota",
    app: "Brave",
    expect: "abstain",
    expectedReason: "no-attributed-turns",
    note: "Nessuna conversazione: solo cromo del browser.",
    ax: "Nuova scheda ⋄ Barra degli indirizzi e di ricerca ⋄ Cerca o inserisci un indirizzo ⋄ Preferiti ⋄ Gruppi di schede ⋄ Estensioni ⋄ Portafoglio ⋄ VPN ⋄ Aggiorna",
    must: [],
    mustNot: ["propone qualsiasi testo"],
  },
  {
    id: "abst-form-registrazione",
    app: "Brave",
    expect: "abstain",
    expectedReason: "no-attributed-turns",
    note: "Campo di input reale, ma non è una conversazione: è un form.",
    ax: "Crea il tuo account ⋄ Nome e cognome ⋄ Indirizzo email ⋄ Password ⋄ Almeno 8 caratteri, una maiuscola e un numero ⋄ Conferma password ⋄ Accetto i termini di servizio ⋄ Iscrivimi alla newsletter ⋄ Crea account ⋄ Hai già un account? Accedi",
    must: [],
    mustNot: ["propone qualsiasi testo"],
  },
  {
    id: "abst-ultimo-messaggio-mio",
    app: "Slack",
    expect: "abstain",
    expectedReason: "last-turn-is-user",
    note: "Caso insidioso: c'è una conversazione, ma l'ultimo messaggio è dell'utente. Non c'è nulla a cui rispondere.",
    ax: "Matteo (messaggio diretto) ⋄ Matteo: ti ho girato il file ieri sera 17:20. ⋄ 17:20 ⋄ ti ho girato il file ieri sera ⋄ Danilo: perfetto grazie, lo guardo domani mattina 17:22. ⋄ Oggi alle 17:22:03 ⋄ 17:22 ⋄ perfetto grazie, lo guardo domani mattina ⋄ Messaggio a Matteo ⋄ Invia ⋄ Allega file",
    must: [],
    mustNot: ["propone qualsiasi testo"],
  },
  {
    id: "abst-editor-codice",
    app: "Superset",
    expect: "abstain",
    expectedReason: "no-attributed-turns",
    note: "Un campo di ricerca in un'app di sviluppo. Nessuna conversazione.",
    ax: "Cerca file ⋄ open-flow ⋄ Modifiche ⋄ Revisione ⋄ main ⋄ Tutte le modifiche ⋄ 0 file ⋄ Vista ad albero ⋄ Comprimi tutto ⋄ Nessuna modifica ⋄ src ⋄ package.json ⋄ tsconfig.json ⋄ Apri in Finder",
    must: [],
    mustNot: ["propone qualsiasi testo"],
  },
];

/** Splits an `ax` dump into the fragment list the parser receives from
 *  AxContextReader: one entry per " ⋄ "-separated piece, trimmed, non-empty. */
export function axFragments(ax: string): string[] {
  return ax.split("⋄").map((s) => s.trim()).filter((s) => s.length > 0);
}
```

Nota sui domini: `studiotecnico.it` → `studiotecnico.example`, `edilrossi.it` → `edilrossi.example`, `northlake.co.uk` → `northlake.example`. I domini con TLD riservato `.example` non possono appartenere a nessuno.

- [ ] **Step 4: Lint, typecheck, test completi**

```bash
npm run lint && npm run typecheck && npm run test
```

Expected: tutti e tre escono con 0. Il fixture è coperto da `lint` (`test/**/*.ts`) e dal `tsc --noEmit` di root (`include: test/**/*`). Nessun test lo importa ancora: è atteso.

- [ ] **Step 5: Verifica anonimizzazione**

```bash
grep -rn "ergonai\|\.co\.uk\|studiotecnico\.it\|edilrossi\.it" test/fixtures/conversations/ ; echo "exit=$?"
```

Expected: nessuna riga, `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/conversations/spike-corpus.ts src/main/preferences-store.ts test/unit/preferences-store.test.ts
git commit -m "feat(context): userDisplayName preference + spike-2 conversation corpus

The reply-suggestions parser needs the user's display name to tell their
own turns from the counterpart's; without it role inversion is inevitable
(spec, spike 2). Empty by default: old preference files load unchanged.

The ten-case corpus of spike 2 becomes a typed, anonymized fixture. The
chatgpt case flips to abstain/assistant-speaker per the spec's declared
non-scope; the user's real address is replaced with an example.com one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh"
```

**Criteri di completamento:** `DEFAULT_PREFS.userDisplayName === ""`; il fixture esporta `USER_NAME`, `CASES` (10 elementi, id unici, 5 `reply` e 5 `abstain`, ogni `abstain` con `expectedReason`), `axFragments`; `grep -rn ergonai test/` vuoto; lint/typecheck/test verdi.

---

## Task 2: `ConversationParser` — fasi 1-3: normalizzazione, sopravvivenza, dedup per contenimento

**Obiettivo:** creare `src/main/utils/conversation-parser.ts` con le costanti verificate dello spike e le tre funzioni pure che dai frammenti grezzi tengono solo ciò che ha forma di contenuto, senza duplicati.

**Dipende da:** Task 1 (ordine); nessun import dal fixture.

**Files:**
- Create: `src/main/utils/conversation-parser.ts`
- Create: `test/unit/conversation-parser.test.ts`

Regole del porting (valgono anche per i task 3 e 4): niente `let` a livello di modulo; ogni funzione esportata ha tipi espliciti; le regex sono `const` esportate con un commento che ne spiega il ruolo; nessun campo attaccato agli array.

- [ ] **Step 1: Scrivi i test che falliscono**

Crea `test/unit/conversation-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  normalizeFragments,
  keepContentful,
  dedupeByContainment,
  SENTENCE_MIN,
} from "../../src/main/utils/conversation-parser.js";

describe("normalizeFragments", () => {
  it("splits on the ⋄ separator and on newlines, trims, collapses whitespace", () => {
    expect(normalizeFragments(["a  b ⋄  c\nd ", "", "  e  "])).toEqual(["a b", "c", "d", "e"]);
  });

  it("drops empty and whitespace-only pieces", () => {
    expect(normalizeFragments(["  ", "⋄", "\n", "x"])).toEqual(["x"]);
  });

  it("removes exact duplicates keeping the first occurrence", () => {
    expect(normalizeFragments(["Invia", "Allega", "Invia"])).toEqual(["Invia", "Allega"]);
  });
});

describe("keepContentful", () => {
  it("keeps attributed chat lines (Name: text HH:MM.)", () => {
    expect(keepContentful(["Marta: ciao 09:12."])).toEqual(["Marta: ciao 09:12."]);
  });

  it("keeps speech markers with or without inline body", () => {
    expect(keepContentful([
      "ChatGPT ha detto:",
      "On 4 Sep 2026, at 09:40, Helen Carter wrote:",
      "Il giorno 3 set 2026 Giulia Rossi ha scritto: Buongiorno, confermo.",
    ])).toHaveLength(3);
  });

  it("keeps unattributed fragments only when at least SENTENCE_MIN chars long", () => {
    const short = "x".repeat(SENTENCE_MIN - 1);
    const long = "x".repeat(SENTENCE_MIN);
    expect(SENTENCE_MIN).toBe(60);
    expect(keepContentful([short, long])).toEqual([long]);
  });

  it("drops pure noise: timestamps, counters, glyphs, booleans, 'message body'", () => {
    expect(keepContentful([
      "09:12", "17:22:03", "42", "—", "•", "⌘", "true", "false", "NaN", "message body", "   ",
    ])).toEqual([]);
  });

  it("drops UI chrome labels", () => {
    expect(keepContentful([
      "Invia", "Allega file", "Messaggio a Marta", "Rispondi a tutti", "Barra degli indirizzi e di ricerca",
      "Oggi Premi Invio per passare a una data specifica.",
    ])).toEqual([]);
  });

  it("does not treat mail header labels as attribution", () => {
    // ATTRIBUTED requires text after the colon.
    expect(keepContentful(["A:", "Cc:", "Da:", "Oggetto:"])).toEqual([]);
  });

  it("does not treat 'Oggi alle 09:12:41' as attribution (digits are not a name)", () => {
    expect(keepContentful(["Oggi alle 09:12:41"])).toEqual([]);
  });

  it("keeps subject lines", () => {
    expect(keepContentful(["Re: Preventivo revisione impianto"])).toEqual(["Re: Preventivo revisione impianto"]);
  });
});

describe("dedupeByContainment", () => {
  it("drops a fragment contained in a longer one, ignoring a trailing timestamp", () => {
    const full = "Marta: ciao, ho visto che la PR è ferma, la review la fai tu o la giro a Paolo? 09:12.";
    const body = "ciao, ho visto che la PR è ferma, la review la fai tu o la giro a Paolo?";
    expect(dedupeByContainment([full, body])).toEqual([full]);
    expect(dedupeByContainment([body, full])).toEqual([full]);
  });

  it("preserves the original order of the survivors", () => {
    const a = "Fulvio: raga il build è rotto, qualcuno ci ha messo mano? 11:04.";
    const b = "Marta: te lo chiedo perché venerdì dovremmo rilasciare 09:13.";
    const bBody = "te lo chiedo perché venerdì dovremmo rilasciare";
    expect(dedupeByContainment([a, bBody, b])).toEqual([a, b]);
  });

  it("collapses identical fragments to a single occurrence", () => {
    const x = "Buongiorno, confermo il sopralluogo per giovedì alle 9, va bene per lei?";
    expect(dedupeByContainment([x, x, x])).toEqual([x]);
  });

  it("drops fragments whose normalized form is shorter than 2 chars", () => {
    expect(dedupeByContainment(["a", "ab", " 09:12"])).toEqual(["ab"]);
  });

  it("keeps two unrelated fragments", () => {
    expect(dedupeByContainment(["alpha beta", "gamma delta"])).toEqual(["alpha beta", "gamma delta"]);
  });
});
```

Run: `npx vitest run test/unit/conversation-parser.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/utils/conversation-parser.js'`.

- [ ] **Step 2: Crea il modulo con costanti e fasi 1-3**

Crea `src/main/utils/conversation-parser.ts`:

```typescript
/**
 * Deterministic pre-processor for the reply-suggestions feature. No model.
 *
 * Turns the noisy fragments harvested from the Accessibility tree under the
 * mouse into a transcript with explicit roles (`TU (Danilo): …` /
 * `INTERLOCUTORE (Marta): …`), or abstains with a code. It is the first line
 * of privacy: only what survives here ever reaches a model.
 *
 * Phases (spec §3): normalize → keep contentful → dedupe by containment →
 * subject → turns → roles → gates → tail with budget → gist → language.
 *
 * Regexes and thresholds are the ones validated in spike 2 (10/10 on the
 * abstention gates); do not tune them without re-running the corpus test.
 */

/** "X ha scritto:" / "X wrote:" with or without the body on the same line.
 *  Accepts long date prefixes ("Il giorno 4 set 2026, alle ore 11:20, …").
 *  Group 1: everything before the verb (the prefix that contains the name).
 *  Group 2: the inline body, possibly empty. */
export const SPEECH_MARKER =
  /^(.{2,140}?)\s+(?:ha scritto|ha detto|wrote|said|says)\s*:\s*(.*)$/iu;

/** Chat attribution "Nome: testo". The name starts with an uppercase letter and
 *  contains only letters, apostrophes, dots, hyphens and spaces (1-28 more
 *  chars): digits are excluded so "Oggi alle 09:12:41" is not a speaker. */
export const ATTRIBUTED = /^(\p{Lu}[\p{L}'.\- ]{1,28}?):\s*(.+)$/u;

/** "Re:", "Fwd:", "Oggetto:", … are the subject, never a speaker. */
export const SUBJECT = /^(?:re|r|fwd|fw|oggetto|subject)\s*:\s*(.+)$/i;

/** Trailing chat timestamp: " 09:12", " 09:12.", " 9.05", " 09:12 PM". */
export const TRAILING_TIME = /\s+\d{1,2}[:.]\d{2}(?:\s*[AaPp]\.?[Mm]\.?)?\.?$/;

/** Fragments that are never content: bare times, counters, glyphs, booleans,
 *  Mail's "message body" placeholder, whitespace. */
export const PURE_NOISE =
  /^(?:\d{1,2}:\d{2}(?::\d{2})?|\d+|[-–—•⌘⇧↑]|true|false|nan|message body|\p{Z}*)$/iu;

/** An unattributed fragment survives only if it is at least this long: the
 *  length at which it has the shape of a sentence rather than a button label. */
export const SENTENCE_MIN = 60;

const FRAGMENT_SPLIT = /\s*⋄\s*|\r?\n/u;

/** Phase 1. Splits every input on " ⋄ " and newlines, trims, collapses
 *  internal whitespace to one space, drops empties and exact duplicates
 *  (first occurrence wins). Order is preserved: it encodes who spoke first. */
export function normalizeFragments(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    for (const piece of raw.split(FRAGMENT_SPLIT)) {
      const f = piece.replace(/\s+/gu, " ").trim();
      if (f.length === 0 || seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/** Phase 2. Survival criterion (general, not an app-specific word list): a
 *  fragment stays if it is attributed to someone, marked as speech, a subject
 *  line, or long enough to be a sentence. Everything else is interface. */
export function keepContentful(fragments: readonly string[]): string[] {
  return fragments.filter((f) => {
    if (PURE_NOISE.test(f)) return false;
    if (SUBJECT.test(f)) return true;
    if (SPEECH_MARKER.test(f)) return true;
    if (ATTRIBUTED.test(f)) return true;
    return f.length >= SENTENCE_MIN;
  });
}

function stripTrailingTime(s: string): string {
  return s.replace(TRAILING_TIME, "").trim();
}

/** Phase 3. The AX tree exposes the same text several times (AXValue +
 *  AXDescription, with and without timestamp). Keeps the most informative
 *  version and drops every fragment whose normalized form is contained in a
 *  kept one. Works on indices so the original order is preserved and
 *  identical strings collapse to one (a value-based lookup would keep both). */
export function dedupeByContainment(fragments: readonly string[]): string[] {
  const normalized = fragments.map(stripTrailingTime);
  // Longest first so containers are decided before their contents.
  const byLengthDesc = normalized
    .map((n, i) => i)
    .sort((a, b) => normalized[b]!.length - normalized[a]!.length); // indices come from the same array
  const keptIdx: number[] = [];
  for (const i of byLengthDesc) {
    const n = normalized[i]!; // i is a valid index of `normalized`
    if (n.length < 2) continue;
    if (keptIdx.some((k) => normalized[k]!.includes(n))) continue;
    keptIdx.push(i);
  }
  const keep = new Set(keptIdx);
  return fragments.filter((_, i) => keep.has(i));
}
```

Run: `npx vitest run test/unit/conversation-parser.test.ts`
Expected: PASS (17 test).

Difetti dello spike corretti qui, da citare nel commit: (a) `kept.includes(f)` finale sostituito da un insieme di indici — O(n) e senza il baco per cui due frammenti identici ricomparivano entrambi; (b) `TRAILING_TIME` estesa a `H.MM` e `AM/PM` come richiede la spec (fase 5), con il costo dichiarato che un messaggio che *termina* con un orario senza timestamp di chat lo perde.

- [ ] **Step 3: Lint, typecheck, test completi**

```bash
npm run lint && npm run typecheck && npm run test
```

Expected: 0, 0, 0.

- [ ] **Step 4: Commit**

```bash
git add src/main/utils/conversation-parser.ts test/unit/conversation-parser.test.ts
git commit -m "feat(context): conversation parser — normalize, survive, dedupe by containment

Port of the spike-2 pre-processor, phases 1-3. Regexes and the 60-char
sentence threshold are the validated ones. Dedup works on indices to keep
the original order and collapse identical fragments (the spike's value
lookup re-admitted duplicates).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh"
```

**Criteri di completamento:** le sei costanti esportate hanno esattamente le sorgenti sopra; `normalizeFragments`, `keepContentful`, `dedupeByContainment` esportate con le firme sopra; 17 test verdi; nessun `let` a livello di modulo; lint/typecheck/test verdi.

---

## Task 3: `ConversationParser` — fasi 4-6: oggetto, ricostruzione dei turni, ruoli

**Obiettivo:** dai frammenti sopravvissuti ricavare `{ turns, subject }` tipizzato (niente proprietà attaccate ad array) e assegnare a ogni turno il ruolo `user` / `counterpart` confrontando lo speaker con `userDisplayName`.

**Dipende da:** Task 2.

**Files:**
- Modify: `src/main/utils/conversation-parser.ts`
- Modify: `test/unit/conversation-parser.test.ts`

- [ ] **Step 1: Scrivi i test che falliscono (append)**

Aggiorna l'import in testa al file di test aggiungendo `toTurns`, `speakerFromPrefix`, `isUserSpeaker`, `assignRoles`, poi aggiungi:

```typescript
describe("speakerFromPrefix", () => {
  it("extracts the name from an Italian Mail prefix with time", () => {
    expect(speakerFromPrefix("Il giorno 4 set 2026, alle ore 11:20, Francesca Bianchi <francesca.bianchi@studiotecnico.example>"))
      .toBe("Francesca Bianchi");
  });
  it("extracts the name from an Italian prefix without comma", () => {
    expect(speakerFromPrefix("Il giorno 3 set 2026 Giulia Rossi")).toBe("Giulia Rossi");
  });
  it("extracts the name from an English prefix", () => {
    expect(speakerFromPrefix("On 4 Sep 2026, at 09:40, Helen Carter")).toBe("Helen Carter");
  });
  it("returns the bare name when there is no prefix", () => {
    expect(speakerFromPrefix("ChatGPT")).toBe("ChatGPT");
  });
  it("falls back to 'Sconosciuto' when nothing is left", () => {
    expect(speakerFromPrefix("<x@y.example>")).toBe("Sconosciuto");
  });
  it("caps the name at 40 characters", () => {
    expect(speakerFromPrefix("A".repeat(80))).toHaveLength(40);
  });
});

describe("toTurns", () => {
  it("builds a chat turn from 'Name: text HH:MM.' stripping the timestamp", () => {
    expect(toTurns(["Marta: ciao, la review la fai tu? 09:12."])).toEqual({
      turns: [{ speaker: "Marta", text: "ciao, la review la fai tu?" }],
      subject: undefined,
      unattributedDropped: 0,
    });
  });

  it("attaches the fragment after a bare speech marker to that speaker", () => {
    const body = "Buongiorno, mi devo scusare ma giovedì mi è saltato un imprevisto. Riusciamo a spostare a venerdì?";
    expect(toTurns(["Il giorno 4 set 2026, alle ore 08:15, Giulia Rossi ha scritto:", body]).turns)
      .toEqual([{ speaker: "Giulia Rossi", text: body }]);
  });

  it("builds a turn from a speech marker with the body inline", () => {
    expect(toTurns(["Il giorno 3 set 2026 Giulia Rossi ha scritto: Buongiorno, confermo il sopralluogo."]).turns)
      .toEqual([{ speaker: "Giulia Rossi", text: "Buongiorno, confermo il sopralluogo." }]);
  });

  it("extracts the subject from Re:/Fwd:/Oggetto: lines and does not make them turns", () => {
    const r = toTurns(["Re: Preventivo revisione impianto", "Marta: ok, procedo 09:12."]);
    expect(r.subject).toBe("Preventivo revisione impianto");
    expect(r.turns).toHaveLength(1);
    expect(toTurns(["Fwd: Bozza", "Oggetto: Altro"]).subject).toBe("Bozza"); // first wins
  });

  it("appends an unattributed sentence-length fragment to the previous turn", () => {
    const tail = "x".repeat(60);
    expect(toTurns(["Marta: ciao 09:12.", tail]).turns).toEqual([{ speaker: "Marta", text: `ciao ${tail}` }]);
  });

  it("drops (and counts) an unattributed fragment that precedes any turn", () => {
    const r = toTurns(["x".repeat(60), "Marta: ciao 09:12."]);
    expect(r.turns).toEqual([{ speaker: "Marta", text: "ciao" }]);
    expect(r.unattributedDropped).toBe(1);
  });

  it("keeps the order of turns", () => {
    const r = toTurns(["Matteo: ti ho girato il file 17:20.", "Danilo: perfetto grazie 17:22."]);
    expect(r.turns.map((t) => t.speaker)).toEqual(["Matteo", "Danilo"]);
  });
});

describe("isUserSpeaker", () => {
  it("matches the full name and the first token, ignoring case, accents and spacing", () => {
    expect(isUserSpeaker("Danilo", "Danilo")).toBe(true);
    expect(isUserSpeaker("danilo", "Danilo Franco")).toBe(true);
    expect(isUserSpeaker("Danilo Franco", "Danilo")).toBe(true);
    expect(isUserSpeaker("DANILO  FRANCO", "Danilo Franco")).toBe(true);
    expect(isUserSpeaker("Nicolò", "Nicolo")).toBe(true);
  });
  it("does not match a different person or a prefix that is not a whole token", () => {
    expect(isUserSpeaker("Marta", "Danilo")).toBe(false);
    expect(isUserSpeaker("Daniloz", "Danilo")).toBe(false);
    expect(isUserSpeaker("Dan", "Danilo")).toBe(false);
  });
  it("never matches when the preference is empty", () => {
    expect(isUserSpeaker("Danilo", "")).toBe(false);
    expect(isUserSpeaker("Danilo", "   ")).toBe(false);
  });
});

describe("assignRoles", () => {
  it("labels the user's turns 'user' and everyone else 'counterpart'", () => {
    const turns = assignRoles(
      [{ speaker: "Matteo", text: "ti ho girato il file" }, { speaker: "Danilo", text: "perfetto grazie" }],
      "Danilo Franco",
    );
    expect(turns).toEqual([
      { speaker: "Matteo", role: "counterpart", text: "ti ho girato il file" },
      { speaker: "Danilo", role: "user", text: "perfetto grazie" },
    ]);
  });
});
```

Run: `npx vitest run test/unit/conversation-parser.test.ts`
Expected: FAIL — `toTurns`, `speakerFromPrefix`, `isUserSpeaker`, `assignRoles` non esportati.

- [ ] **Step 2: Implementa fasi 4-6**

Aggiungi a `src/main/utils/conversation-parser.ts`:

```typescript
/** A turn before role assignment. */
export interface RawTurn {
  speaker: string;
  text: string;
}

/** A turn with its role, as the spec's `Turn`. */
export interface Turn {
  speaker: string;
  role: "user" | "counterpart";
  text: string;
}

export interface TurnsResult {
  turns: RawTurn[];
  /** From the first Re:/Fwd:/Fw:/Oggetto:/Subject: line, if any. */
  subject: string | undefined;
  /** Sentence-length fragments that preceded any turn: counted for the log,
   *  never kept (nothing to attach them to). */
  unattributedDropped: number;
}

const SPEAKER_MAX = 40;

/** From "Il giorno 4 set 2026, alle ore 11:20, Francesca Bianchi <x@y>" to
 *  "Francesca Bianchi". Strips angle-bracketed addresses, the Italian/English
 *  date prefixes (with or without the time clause), trailing punctuation. */
export function speakerFromPrefix(prefix: string): string {
  const who = prefix
    .replace(/<[^>]*>/g, "")
    .replace(/^(?:il giorno|on)\b.*?(?:,\s*(?:alle ore|at)\s*\d{1,2}:\d{2}\s*)?,\s*/i, "")
    .replace(/^(?:il giorno|on)\s+\S+\s+\S+\s+\d{4},?\s*/i, "")
    .replace(/[,;]\s*$/, "")
    .trim()
    .slice(0, SPEAKER_MAX);
  return who.length > 0 ? who : "Sconosciuto";
}

/** Phases 4-5. Rebuilds the message sequence from the two attribution forms
 *  ("Nome: testo HH:MM." and "X ha scritto:" + body) and pulls the subject
 *  out. An unattributed sentence-length fragment is appended to the previous
 *  turn (spec §3, phase 5); before any turn it is dropped and counted. */
export function toTurns(fragments: readonly string[]): TurnsResult {
  const turns: RawTurn[] = [];
  let subject: string | undefined;
  let pending: string | null = null;
  let unattributedDropped = 0;

  for (const f of fragments) {
    const su = SUBJECT.exec(f);
    if (su) {
      if (subject === undefined) subject = su[1]!.trim(); // group 1 is mandatory in SUBJECT
      continue;
    }
    const sm = SPEECH_MARKER.exec(f);
    if (sm) {
      const who = speakerFromPrefix(sm[1]!); // groups 1 and 2 always exist in SPEECH_MARKER
      const inline = sm[2]!.trim();
      if (inline.length >= 2) {
        turns.push({ speaker: who, text: inline });
        pending = null;
      } else {
        pending = who;
      }
      continue;
    }
    const am = ATTRIBUTED.exec(f);
    if (am) {
      turns.push({ speaker: am[1]!.trim(), text: stripTrailingTime(am[2]!) }); // both groups mandatory
      pending = null;
      continue;
    }
    if (pending !== null) {
      turns.push({ speaker: pending, text: stripTrailingTime(f) });
      pending = null;
      continue;
    }
    if (f.length >= SENTENCE_MIN) {
      const last = turns[turns.length - 1];
      if (last) last.text = `${last.text} ${f}`;
      else unattributedDropped += 1;
    }
  }
  return { turns, subject, unattributedDropped };
}

/** Case-, accent- and whitespace-insensitive form of a name. */
function normalizeName(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Phase 6 criterion. True when the speaker, normalized, equals the
 *  preference, equals its first token (name without surname), or extends it
 *  by whole tokens in either direction ("Danilo Franco" vs "Danilo"). An
 *  empty preference matches nobody: without a name, role inversion is
 *  inevitable, so the feature must not run (spec §Preferenze). */
export function isUserSpeaker(speaker: string, userDisplayName: string): boolean {
  const u = normalizeName(userDisplayName);
  const s = normalizeName(speaker);
  if (u.length === 0 || s.length === 0) return false;
  const first = u.split(" ")[0]!; // split() always yields at least one element
  return s === u || s === first || s.startsWith(`${u} `) || u.startsWith(`${s} `);
}

/** Phase 6. */
export function assignRoles(turns: readonly RawTurn[], userDisplayName: string): Turn[] {
  return turns.map((t) => ({
    speaker: t.speaker,
    role: isUserSpeaker(t.speaker, userDisplayName) ? "user" : "counterpart",
    text: t.text,
  }));
}
```

Nota: `let` dentro `toTurns` è locale alla funzione — permesso. Il vincolo 9 riguarda il livello di modulo.

Run: `npx vitest run test/unit/conversation-parser.test.ts`
Expected: PASS.

- [ ] **Step 3: Lint, typecheck, test completi**

```bash
npm run lint && npm run typecheck && npm run test
```

Expected: 0, 0, 0.

- [ ] **Step 4: Commit**

```bash
git add src/main/utils/conversation-parser.ts test/unit/conversation-parser.test.ts
git commit -m "feat(context): conversation parser — subject, turns, roles

Phases 4-6 of the spike-2 pre-processor. toTurns returns a typed
{ turns, subject, unattributedDropped } instead of a property glued onto an
array. Roles come from userDisplayName, compared on the normalized full
name and on its first token.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh"
```

**Criteri di completamento:** `toTurns(fragments): TurnsResult` con i tre campi; `speakerFromPrefix` con le quattro `replace` dello spike più il cap a 40; `isUserSpeaker` con la normalizzazione NFD; `assignRoles` che restituisce `Turn[]`; tutti i test del file verdi; lint/typecheck/test verdi.

---

## Task 4: `ConversationParser` — fasi 7-10, `parse()` e `toLogMeta()`

**Obiettivo:** completare il modulo con i sei cancelli di astensione nell'ordine della spec, la coda con budget parametrizzato e testato ai bordi, il gist deterministico, l'euristica di lingua, la funzione pubblica `parse(input): ParseResult` e l'oggetto metriche-only per il logger.

**Dipende da:** Task 3.

**Files:**
- Modify: `src/main/utils/conversation-parser.ts`
- Modify: `test/unit/conversation-parser.test.ts`

- [ ] **Step 1: Scrivi i test che falliscono (append)**

Aggiorna l'import aggiungendo `gate`, `buildTranscript`, `buildGist`, `guessLanguage`, `parse`, `toLogMeta`, `ASSISTANT_NAMES`, e il tipo `Turn`. Poi:

```typescript
const T = (speaker: string, role: "user" | "counterpart", text: string): Turn => ({ speaker, role, text });

describe("gate", () => {
  it("no-attributed-turns when there are no turns", () => {
    expect(gate([])).toEqual({ ok: false, reason: "no-attributed-turns" });
  });
  it("assistant-speaker when the last speaker is a known assistant, case-insensitive", () => {
    expect(ASSISTANT_NAMES).toEqual(["chatgpt", "claude", "gemini", "copilot", "assistant", "assistente"]);
    expect(gate([T("ChatGPT", "counterpart", "Posso prepararti la scheda, quante volte a settimana?")]))
      .toEqual({ ok: false, reason: "assistant-speaker" });
    expect(gate([T("GEMINI", "counterpart", "Certo, ecco tre opzioni per il viaggio.")]).ok).toBe(false);
  });
  it("more-than-two-speakers when the last 8 turns have 3 distinct counterparts (user counts once)", () => {
    const turns = [
      T("Marta", "counterpart", "ci vediamo giovedì o venerdì?"),
      T("Luca", "counterpart", "per me venerdì va benissimo"),
      T("Danilo", "user", "anche per me"),
      T("Danilo Franco", "user", "confermo"),
      T("Paolo", "counterpart", "io preferirei giovedì, si può fare?"),
    ];
    expect(gate(turns)).toEqual({ ok: false, reason: "more-than-two-speakers" });
  });
  it("ignores a third speaker older than the last 8 turns", () => {
    const old = T("Paolo", "counterpart", "messaggio vecchio di un terzo");
    const recent = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? T("Danilo", "user", `mio ${i}`) : T("Marta", "counterpart", `suo ${i} abbastanza lungo`));
    expect(gate([old, ...recent]).ok).toBe(true);
  });
  it("only-user-turns when every turn is the user's", () => {
    expect(gate([T("Danilo", "user", "promemoria per me stesso, lungo")]))
      .toEqual({ ok: false, reason: "only-user-turns" });
  });
  it("last-turn-is-user when the user spoke last", () => {
    expect(gate([T("Matteo", "counterpart", "ti ho girato il file"), T("Danilo", "user", "perfetto grazie")]))
      .toEqual({ ok: false, reason: "last-turn-is-user" });
  });
  it("last-message-too-short below 15 chars, passes at 15", () => {
    expect(gate([T("Marta", "counterpart", "x".repeat(14))])).toEqual({ ok: false, reason: "last-message-too-short" });
    expect(gate([T("Marta", "counterpart", "x".repeat(15))])).toEqual({ ok: true });
  });
  it("applies the gates in the spec order: assistant beats only-user/last-user", () => {
    expect(gate([T("Danilo", "user", "prova"), T("Claude", "counterpart", "ok")]))
      .toEqual({ ok: false, reason: "assistant-speaker" });
  });
});

describe("buildTranscript", () => {
  const marta = T("Marta", "counterpart", "ci vediamo giovedì o venerdì?");
  const me = T("Danilo", "user", "fammi controllare l'agenda");
  const lastLine = "INTERLOCUTORE (Marta): ci vediamo giovedì o venerdì?";
  const meLine = "TU (Danilo): fammi controllare l'agenda";

  it("formats one turn per line with explicit roles, oldest first", () => {
    expect(buildTranscript([me, marta], { tailBudgetChars: 2500 })).toBe(`${meLine}\n${lastLine}`);
  });

  it("prepends the subject line when present", () => {
    expect(buildTranscript([marta], { tailBudgetChars: 2500, subject: "Riunione" }))
      .toBe(`OGGETTO: Riunione\n${lastLine}`);
  });

  it("takes turns from the tail, dropping the oldest when the budget is exceeded", () => {
    const older = T("Marta", "counterpart", "y".repeat(30));
    // Budget that fits exactly meLine + "\n" + lastLine and nothing more.
    const budget = Math.max(100, meLine.length + 1 + lastLine.length);
    const out = buildTranscript([older, me, marta], { tailBudgetChars: budget });
    expect(out).toBe(`${meLine}\n${lastLine}`);
    expect(out.length).toBeLessThanOrEqual(budget);
  });

  it("drops the older turn as soon as the budget is one char short of fitting it", () => {
    const older = T("Marta", "counterpart", "y".repeat(60));
    const olderLine = `INTERLOCUTORE (Marta): ${"y".repeat(60)}`;
    const budget = olderLine.length + 1 + lastLine.length; // >= 100 by construction
    expect(buildTranscript([older, marta], { tailBudgetChars: budget })).toBe(`${olderLine}\n${lastLine}`);
    expect(buildTranscript([older, marta], { tailBudgetChars: budget - 1 })).toBe(lastLine);
  });

  it("always includes the last turn whole when only it fits", () => {
    const longMe = T("Danilo", "user", "x".repeat(60)); // line = 73 chars: 52 + 1 + 73 > 100
    expect(buildTranscript([longMe, marta], { tailBudgetChars: 100 })).toBe(lastLine);
  });

  it("truncates the last turn at the head, never at the tail, when it alone exceeds the budget", () => {
    const long = T("Marta", "counterpart", `${"a".repeat(200)} la review la fai tu?`);
    const out = buildTranscript([long], { tailBudgetChars: 100 });
    expect(out.startsWith("INTERLOCUTORE (Marta): …")).toBe(true);
    expect(out.endsWith("la review la fai tu?")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it("counts the subject line against the budget", () => {
    // Without the subject, meLine + lastLine (92 chars) would fit in 100.
    // "OGGETTO: " + 30 chars = 39 → remaining 60: only the last turn fits.
    const out = buildTranscript([me, marta], { tailBudgetChars: 100, subject: "S".repeat(30) });
    expect(out).toBe(`OGGETTO: ${"S".repeat(30)}\n${lastLine}`);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it("rejects a budget below 100", () => {
    expect(() => buildTranscript([marta], { tailBudgetChars: 99 })).toThrow(RangeError);
  });
});

describe("buildGist", () => {
  it("uses the first sentence ending with '?'", () => {
    expect(buildGist("Fulvio", "raga il build di staging è rotto da stamattina, errore sul lockfile. qualcuno ci ha già messo mano?"))
      .toBe("Rispondi a Fulvio: qualcuno ci ha già messo mano?");
  });
  it("falls back to the first sentence when there is no question", () => {
    expect(buildGist("Marta", "Ci vediamo venerdì. Porto io i documenti.")).toBe("Rispondi a Marta: Ci vediamo venerdì.");
  });
  it("truncates the sentence to 70 chars with an ellipsis", () => {
    const g = buildGist("Giulia Rossi", "Riusciamo a spostare a venerdì stessa ora, o preferisce la settimana prossima?");
    expect(g.startsWith("Rispondi a Giulia Rossi: Riusciamo a spostare")).toBe(true);
    expect(g.endsWith("…")).toBe(true);
    expect(g.length - "Rispondi a Giulia Rossi: ".length).toBeLessThanOrEqual(70);
  });
  it("keeps a 70-char sentence untouched", () => {
    const s = "x".repeat(69) + "?";
    expect(buildGist("M", s)).toBe(`Rispondi a M: ${s}`);
  });
});

describe("guessLanguage", () => {
  it("detects Italian and English from function words", () => {
    expect(guessLanguage("ciao, ho visto che la PR è ferma e non so se la review la fai tu")).toBe("it");
    expect(guessLanguage("we still haven't received the payment, could you confirm when we can expect it?")).toBe("en");
  });
  it("returns 'other' when there is not enough signal", () => {
    expect(guessLanguage("ok")).toBe("other");
    expect(guessLanguage("Kubernetes 1.31 released")).toBe("other");
  });
});

describe("parse", () => {
  it("returns a conversation with transcript, counterpart, lastMessage, gist, language and stats", () => {
    const r = parse({
      fragments: ["Marta: ciao, la review della PR la fai tu o la giro a Paolo? 09:12.", "Invia", "09:12"],
      userDisplayName: "Danilo",
      tailBudgetChars: 2500,
    });
    expect(r.kind).toBe("conversation");
    if (r.kind !== "conversation") return;
    expect(r.counterpart).toBe("Marta");
    expect(r.lastMessage).toBe("ciao, la review della PR la fai tu o la giro a Paolo?");
    expect(r.transcript).toBe("INTERLOCUTORE (Marta): ciao, la review della PR la fai tu o la giro a Paolo?");
    expect(r.gist).toBe("Rispondi a Marta: ciao, la review della PR la fai tu o la giro a Paolo?");
    expect(r.languageGuess).toBe("it");
    expect(r.subject).toBeUndefined();
    expect(r.stats).toEqual({
      fragmentsIn: 3, fragmentsKept: 1, fragmentsDeduped: 1, turns: 1, speakers: 1,
      unattributedDropped: 0, transcriptChars: r.transcript.length,
    });
  });

  it("abstains with the gate's reason and still reports stats", () => {
    const r = parse({ fragments: ["Invia", "Allega file"], userDisplayName: "Danilo", tailBudgetChars: 2500 });
    expect(r.kind).toBe("abstain");
    if (r.kind !== "abstain") return;
    expect(r.reason).toBe("no-attributed-turns");
    expect(r.stats.fragmentsIn).toBe(2);
    expect(r.stats.turns).toBe(0);
  });

  it("propagates the budget to the transcript and never truncates lastMessage", () => {
    const r = parse({
      fragments: [`Marta: ${"a".repeat(300)} va bene per te? 09:12.`],
      userDisplayName: "Danilo",
      tailBudgetChars: 120,
    });
    if (r.kind !== "conversation") throw new Error("expected conversation");
    expect(r.transcript.length).toBeLessThanOrEqual(120);
    expect(r.lastMessage.length).toBeGreaterThan(300);
  });
});

describe("toLogMeta", () => {
  it("contains only codes and numbers, never text", () => {
    const r = parse({
      fragments: ["Marta: ciao, la review della PR la fai tu o la giro a Paolo? 09:12."],
      userDisplayName: "Danilo",
      tailBudgetChars: 2500,
    });
    const meta = toLogMeta(r);
    expect(meta).toEqual({ kind: "conversation", reason: null, languageGuess: "it", ...r.stats });
    for (const v of Object.values(meta)) {
      if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(24);
      else expect(v === null || typeof v === "number").toBe(true);
    }
  });
});
```

Run: `npx vitest run test/unit/conversation-parser.test.ts`
Expected: FAIL — le nuove funzioni non sono esportate.

- [ ] **Step 2: Implementa fasi 7-10, `parse`, `toLogMeta`**

Aggiungi a `src/main/utils/conversation-parser.ts`:

```typescript
export type AbstainReason =
  | "no-attributed-turns"
  | "only-user-turns"
  | "last-turn-is-user"
  | "last-message-too-short"
  | "more-than-two-speakers"
  | "assistant-speaker";

export type GateResult = { ok: true } | { ok: false; reason: AbstainReason };

/** Speakers that are conversational assistants: out of scope by design
 *  (spec §Out). Compared against the normalized speaker name. */
export const ASSISTANT_NAMES: readonly string[] =
  ["chatgpt", "claude", "gemini", "copilot", "assistant", "assistente"];

const RECENT_TURNS_FOR_SPEAKER_COUNT = 8;
const LAST_MESSAGE_MIN_CHARS = 15;
const MIN_TAIL_BUDGET = 100;
const GIST_MAX_CHARS = 70;

/** Phase 7. All gates are blocking and run in this exact order (spec §3.7).
 *  Abstaining is the normal outcome, not an error. */
export function gate(turns: readonly Turn[]): GateResult {
  const last = turns[turns.length - 1];
  if (!last) return { ok: false, reason: "no-attributed-turns" };
  if (ASSISTANT_NAMES.includes(normalizeName(last.speaker))) return { ok: false, reason: "assistant-speaker" };
  const recent = turns.slice(-RECENT_TURNS_FOR_SPEAKER_COUNT);
  // The user may appear under several spellings ("Danilo", "Danilo Franco"):
  // count them as one via the role, not the name.
  const distinct = new Set(recent.map((t) => (t.role === "user" ? " user" : normalizeName(t.speaker))));
  if (distinct.size > 2) return { ok: false, reason: "more-than-two-speakers" };
  if (turns.every((t) => t.role === "user")) return { ok: false, reason: "only-user-turns" };
  if (last.role === "user") return { ok: false, reason: "last-turn-is-user" };
  if (last.text.trim().length < LAST_MESSAGE_MIN_CHARS) return { ok: false, reason: "last-message-too-short" };
  return { ok: true };
}

function roleLabel(t: Turn): string {
  return t.role === "user" ? `TU (${t.speaker}): ` : `INTERLOCUTORE (${t.speaker}): `;
}

/** Phase 8. Tail with a character budget: turns are taken newest-first while
 *  the whole transcript stays <= tailBudgetChars. The last turn is always
 *  present; if it alone exceeds the budget it is cut at the HEAD (the
 *  question is at the end). The subject line, when present, is counted. */
export function buildTranscript(
  turns: readonly Turn[],
  opts: { tailBudgetChars: number; subject?: string },
): string {
  if (opts.tailBudgetChars < MIN_TAIL_BUDGET) {
    throw new RangeError(`tailBudgetChars must be >= ${MIN_TAIL_BUDGET}, got ${opts.tailBudgetChars}`);
  }
  const last = turns[turns.length - 1];
  if (!last) return "";
  const head = opts.subject !== undefined ? `OGGETTO: ${opts.subject}` : null;
  const remaining = opts.tailBudgetChars - (head ? head.length + 1 : 0);

  const label = roleLabel(last);
  let lastLine = label + last.text;
  if (lastLine.length > remaining) {
    const keep = Math.max(1, remaining - label.length - 1); // 1 for the ellipsis
    lastLine = `${label}…${last.text.slice(last.text.length - keep)}`;
  }

  const lines: string[] = [lastLine];
  let total = lastLine.length;
  for (let i = turns.length - 2; i >= 0; i--) {
    const t = turns[i]!; // i in [0, length-2]
    const line = roleLabel(t) + t.text;
    if (total + 1 + line.length > remaining) break;
    lines.unshift(line);
    total += 1 + line.length;
  }
  return (head ? `${head}\n` : "") + lines.join("\n");
}

/** Phase 9. "Rispondi a {counterpart}: {frase}" — the first sentence of the
 *  last message that ends with "?", else its first sentence, cut to 70 chars
 *  with "…". Deterministic on purpose: the user sees exactly what the code
 *  took as the question and can reject at a glance. */
export function buildGist(counterpart: string, lastMessage: string): string {
  const sentences = lastMessage.trim().split(/(?<=[.!?…])\s+/u).map((s) => s.trim()).filter((s) => s.length > 0);
  const question = sentences.find((s) => s.endsWith("?"));
  const chosen = question ?? sentences[0] ?? "";
  const frase = chosen.length > GIST_MAX_CHARS ? `${chosen.slice(0, GIST_MAX_CHARS - 1).trimEnd()}…` : chosen;
  return `Rispondi a ${counterpart}: ${frase}`;
}

// Function words chosen to have no homograph in the other language ("a",
// "in", "due", "come", "i" are excluded for that reason).
const IT_WORDS: ReadonlySet<string> = new Set(["il", "la", "di", "che", "e", "non", "per", "un", "una",
  "con", "sono", "ho", "hai", "è", "ma", "se", "ci", "anche", "del", "della", "le", "gli", "mi", "ti", "lo", "so"]);
const EN_WORDS: ReadonlySet<string> = new Set(["the", "and", "to", "of", "is", "you", "that", "we", "for",
  "it", "with", "on", "are", "this", "have", "can", "be", "at", "not", "from", "or", "will", "your", "when", "could"]);

/** Phase 10. Coarse it/en/other guess on function-word counts. Only the
 *  downstream variant filter uses it (Plan B); "other" is the safe default. */
export function guessLanguage(text: string): "it" | "en" | "other" {
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let it = 0;
  let en = 0;
  for (const t of tokens) {
    if (IT_WORDS.has(t)) it += 1;
    if (EN_WORDS.has(t)) en += 1;
  }
  if (it >= 2 && it > en) return "it";
  if (en >= 2 && en > it) return "en";
  return "other";
}

export interface ParseInput {
  fragments: readonly string[];
  /** Preference, mandatory: empty means every turn is a counterpart's. */
  userDisplayName: string;
  /** 2_500 in production (spec §3.8). */
  tailBudgetChars: number;
}

/** Counts only — safe to log. */
export interface ParseStats {
  fragmentsIn: number;
  fragmentsKept: number;
  fragmentsDeduped: number;
  turns: number;
  speakers: number;
  unattributedDropped: number;
  transcriptChars: number;
}

export type ParseResult =
  | { kind: "abstain"; reason: AbstainReason; stats: ParseStats }
  | {
      kind: "conversation";
      subject?: string;
      turns: Turn[];
      counterpart: string;
      transcript: string;
      lastMessage: string;
      gist: string;
      languageGuess: "it" | "en" | "other";
      stats: ParseStats;
    };

/** The whole pipeline. Pure: same input, same output; no I/O, no logging. */
export function parse(input: ParseInput): ParseResult {
  const normalized = normalizeFragments(input.fragments);
  const kept = keepContentful(normalized);
  const deduped = dedupeByContainment(kept);
  const { turns: raw, subject, unattributedDropped } = toTurns(deduped);
  const turns = assignRoles(raw, input.userDisplayName);
  const stats: ParseStats = {
    fragmentsIn: normalized.length,
    fragmentsKept: kept.length,
    fragmentsDeduped: deduped.length,
    turns: turns.length,
    speakers: new Set(turns.map((t) => normalizeName(t.speaker))).size,
    unattributedDropped,
    transcriptChars: 0,
  };
  const g = gate(turns);
  if (!g.ok) return { kind: "abstain", reason: g.reason, stats };
  const last = turns[turns.length - 1]!; // gate guarantees at least one turn
  const transcript = buildTranscript(turns, { tailBudgetChars: input.tailBudgetChars, subject });
  const result: ParseResult = {
    kind: "conversation",
    turns,
    counterpart: last.speaker,
    transcript,
    lastMessage: last.text,
    gist: buildGist(last.speaker, last.text),
    languageGuess: guessLanguage(turns.map((t) => t.text).join(" ")),
    stats: { ...stats, transcriptChars: transcript.length },
  };
  if (subject !== undefined) result.subject = subject;
  return result;
}

/** What may reach the logger: codes and counts, never text (spec, privacy 2). */
export function toLogMeta(result: ParseResult): Record<string, string | number | null> {
  return {
    kind: result.kind,
    reason: result.kind === "abstain" ? result.reason : null,
    languageGuess: result.kind === "conversation" ? result.languageGuess : null,
    ...result.stats,
  };
}
```

Run: `npx vitest run test/unit/conversation-parser.test.ts`
Expected: PASS.

- [ ] **Step 3: Lint, typecheck, test completi**

```bash
npm run lint && npm run typecheck && npm run test
```

Expected: 0, 0, 0.

- [ ] **Step 4: Commit**

```bash
git add src/main/utils/conversation-parser.ts test/unit/conversation-parser.test.ts
git commit -m "feat(context): conversation parser — gates, tail budget, gist, language, parse()

Phases 7-10 and the public parse() entry point. The six abstention gates
run in the spec's order, before any model. The tail budget is a parameter
tested at its edges; the last turn is always present and is cut at the
head, never at the tail. toLogMeta() is the only shape allowed to reach
the logger: codes and counts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh"
```

**Criteri di completamento:** `parse`, `toLogMeta`, `gate`, `buildTranscript`, `buildGist`, `guessLanguage` esportate con le firme sopra; `AbstainReason` è esattamente l'unione dei sei codici della spec; le costanti valgono 8 (turni recenti), 15 (min ultimo messaggio), 100 (min budget), 70 (gist); tutti i test verdi; lint/typecheck/test verdi.

---

## Task 5: Test end-to-end sul corpus e test di privacy su `toLogMeta`

**Obiettivo:** dimostrare che il parser portato in TypeScript ottiene 10/10 sui cancelli del corpus (con le attese della spec), che le trascrizioni hanno la forma richiesta e non trasportano cromo, e che l'oggetto passato al logger non contiene mai testo letto dallo schermo.

**Dipende da:** Task 1, Task 4.

**Files:**
- Modify: `test/fixtures/conversations/spike-corpus.ts` (aggiunge l'helper `leaksScreenText`)
- Create: `test/unit/conversation-parser.corpus.test.ts`

- [ ] **Step 1: Aggiungi l'helper di privacy al fixture**

In coda a `test/fixtures/conversations/spike-corpus.ts`:

```typescript
/** Names that appear in the corpus: content, hence never allowed in logs. */
export const CORPUS_NAMES: readonly string[] = ["Marta", "Fulvio", "Francesca", "Giulia", "Helen", "Matteo", "Paolo"];

const WINDOW = 8;

/**
 * True when `haystack` (a serialized log payload) contains any 8-char window
 * of any fragment of `ax`, case-insensitively, or any corpus name. This is the
 * executable form of spec privacy requirement 2: metrics only, never text.
 */
export function leaksScreenText(haystack: string, ax: string): boolean {
  const h = haystack.toLowerCase();
  for (const name of CORPUS_NAMES) {
    if (h.includes(name.toLowerCase())) return true;
  }
  for (const fragment of axFragments(ax)) {
    const f = fragment.toLowerCase();
    for (let i = 0; i + WINDOW <= f.length; i++) {
      if (h.includes(f.slice(i, i + WINDOW))) return true;
    }
  }
  return false;
}
```

- [ ] **Step 2: Scrivi il test del corpus (fallisce solo se il porting è sbagliato: è la verifica finale del parser)**

Crea `test/unit/conversation-parser.corpus.test.ts`:

```typescript
import { describe, it, expect, expectTypeOf } from "vitest";
import {
  parse,
  toLogMeta,
  type AbstainReason,
  type ParseResult,
} from "../../src/main/utils/conversation-parser.js";
import {
  CASES,
  USER_NAME,
  axFragments,
  leaksScreenText,
  type ConversationCase,
  type ExpectedAbstainReason,
} from "../fixtures/conversations/spike-corpus.js";

const TAIL_BUDGET = 2_500;

function run(c: ConversationCase): ParseResult {
  return parse({ fragments: axFragments(c.ax), userDisplayName: USER_NAME, tailBudgetChars: TAIL_BUDGET });
}

function conversation(id: string) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`missing case ${id}`);
  const r = run(c);
  if (r.kind !== "conversation") throw new Error(`${id}: expected conversation, got ${r.reason}`);
  return r;
}

/** Labels of the UI chrome present in the dumps: none may survive. */
const CHROME = ["Invia", "Allega", "Rispondi a tutti", "Messaggio a ", "Barra degli indirizzi", "message body",
  "aggiungi contatti", "Formattazione", "Registra clip audio", "Preferiti", "Estensioni", "Cerca file"];

describe("spike-2 corpus — shape", () => {
  it("has ten cases with unique ids, five reply and five abstain, every abstain with a reason", () => {
    expect(CASES).toHaveLength(10);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(10);
    expect(CASES.filter((c) => c.expect === "reply")).toHaveLength(5);
    const abstain = CASES.filter((c) => c.expect === "abstain");
    expect(abstain).toHaveLength(5);
    for (const c of abstain) expect(c.expectedReason).toBeDefined();
  });

  it("uses the same abstain codes as the parser", () => {
    expectTypeOf<ExpectedAbstainReason>().toEqualTypeOf<AbstainReason>();
  });
});

describe("spike-2 corpus — gates (10/10, no model)", () => {
  for (const c of CASES) {
    it(`${c.id} → ${c.expect}${c.expectedReason ? ` (${c.expectedReason})` : ""}`, () => {
      const r = run(c);
      if (c.expect === "abstain") {
        expect(r.kind).toBe("abstain");
        if (r.kind === "abstain") expect(r.reason).toBe(c.expectedReason);
      } else {
        expect(r.kind).toBe("conversation");
      }
    });
  }
});

describe("spike-2 corpus — transcript invariants", () => {
  const convs = CASES.filter((c) => c.expect === "reply").map((c) => [c.id, conversation(c.id)] as const);

  it("keeps every transcript within the budget", () => {
    for (const [, r] of convs) expect(r.transcript.length).toBeLessThanOrEqual(TAIL_BUDGET);
  });

  it("writes one turn per line with explicit roles, subject first when present", () => {
    for (const [, r] of convs) {
      const lines = r.transcript.split("\n");
      for (const line of lines) expect(line).toMatch(/^(OGGETTO: |TU \(|INTERLOCUTORE \()/);
      expect(lines[lines.length - 1]!.startsWith("INTERLOCUTORE (")).toBe(true); // at least one line by construction
    }
  });

  it("carries no UI chrome into the transcript", () => {
    for (const [, r] of convs) for (const label of CHROME) expect(r.transcript).not.toContain(label);
  });

  it("never truncates lastMessage and reports it as the last counterpart turn", () => {
    for (const [, r] of convs) {
      const last = r.turns[r.turns.length - 1]!; // conversation ⇒ ≥ 1 turn
      expect(last.role).toBe("counterpart");
      expect(r.lastMessage).toBe(last.text);
      expect(r.counterpart).toBe(last.speaker);
    }
  });
});

describe("spike-2 corpus — per-case expectations", () => {
  it("slack-decisione: two Marta turns, gist on the last message, Italian", () => {
    const r = conversation("slack-decisione");
    expect(r.counterpart).toBe("Marta");
    expect(r.turns.map((t) => t.role)).toEqual(["counterpart", "counterpart"]);
    expect(r.transcript).toBe(
      "INTERLOCUTORE (Marta): ciao, ho visto che la PR sul login è ferma da due giorni, la review la fai tu o la giro a Paolo?\n" +
      "INTERLOCUTORE (Marta): te lo chiedo perché venerdì dovremmo rilasciare e quella è bloccante",
    );
    expect(r.gist).toBe("Rispondi a Marta: te lo chiedo perché venerdì dovremmo rilasciare e quella è bloccante");
    expect(r.languageGuess).toBe("it");
    expect(r.subject).toBeUndefined();
  });

  it("slack-richiesta-aiuto: question sentence picked for the gist", () => {
    const r = conversation("slack-richiesta-aiuto");
    expect(r.counterpart).toBe("Fulvio");
    expect(r.gist).toBe("Rispondi a Fulvio: qualcuno ci ha già messo mano?");
    expect(r.transcript).not.toContain("frontend-hub (Canale)");
  });

  it("mail-preventivo: subject, full name from the date prefix, figure preserved", () => {
    const r = conversation("mail-preventivo");
    expect(r.subject).toBe("Preventivo revisione impianto");
    expect(r.counterpart).toBe("Francesca Bianchi");
    expect(r.transcript.startsWith(
      "OGGETTO: Preventivo revisione impianto\nINTERLOCUTORE (Francesca Bianchi): Buongiorno, le invio il preventivo",
    )).toBe(true);
    expect(r.transcript).toContain("4.850 euro");
    expect(r.transcript).not.toContain("danilo@example.com");
    expect(r.turns).toHaveLength(1);
  });

  it("mail-thread-lungo: two turns, answers the LAST one, truncated gist", () => {
    const r = conversation("mail-thread-lungo");
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]!.text).toBe("Buongiorno, confermo il sopralluogo per giovedì alle 9.");
    expect(r.lastMessage.startsWith("Buongiorno, mi devo scusare")).toBe(true);
    expect(r.lastMessage).toContain("venerdì");
    expect(r.gist.startsWith("Rispondi a Giulia Rossi: Riusciamo a spostare a venerdì")).toBe(true);
    expect(r.gist.endsWith("…")).toBe(true);
  });

  it("mail-inglese: English prefix, English language, question gist", () => {
    const r = conversation("mail-inglese");
    expect(r.subject).toBe("Invoice #2291");
    expect(r.counterpart).toBe("Helen Carter");
    expect(r.languageGuess).toBe("en");
    expect(r.gist).toBe("Rispondi a Helen Carter: Could you confirm when we can expect it?");
    expect(r.lastMessage.endsWith("Best, Helen")).toBe(true);
  });

  it("abst-ultimo-messaggio-mio: the conversation is parsed (2 turns) but the user spoke last", () => {
    const c = CASES.find((x) => x.id === "abst-ultimo-messaggio-mio")!;
    const r = run(c);
    expect(r.kind).toBe("abstain");
    expect(r.stats.turns).toBe(2);
    expect(r.stats.speakers).toBe(2);
  });

  it("chatgpt-conversazione: the assistant turn is parsed, then gated", () => {
    const c = CASES.find((x) => x.id === "chatgpt-conversazione")!;
    const r = run(c);
    expect(r).toMatchObject({ kind: "abstain", reason: "assistant-speaker" });
    expect(r.stats.turns).toBe(1);
  });
});

describe("spike-2 corpus — privacy", () => {
  it("toLogMeta non contiene testo del corpus", () => {
    for (const c of CASES) {
      const serialized = JSON.stringify(toLogMeta(run(c)));
      expect(leaksScreenText(serialized, c.ax), `${c.id} leaked: ${serialized}`).toBe(false);
    }
  });

  it("leaksScreenText detects a leak (sanity check of the helper)", () => {
    const c = CASES[0]!;
    expect(leaksScreenText(JSON.stringify({ text: axFragments(c.ax)[2] }), c.ax)).toBe(true);
    expect(leaksScreenText(JSON.stringify({ speaker: "marta" }), c.ax)).toBe(true);
    expect(leaksScreenText(JSON.stringify({ turns: 2, chars: 3748, reason: "last-turn-is-user" }), c.ax)).toBe(false);
  });
});
```

Run: `npx vitest run test/unit/conversation-parser.corpus.test.ts`
Expected: PASS — 10/10 sui cancelli. Se un caso fallisce, il porting devia dallo spike: **non** cambiare le attese del fixture; confronta le regex e l'algoritmo dei task 2-4 con quanto scritto lì e correggi il parser.

Se `expectTypeOf` non fosse disponibile nella versione di Vitest installata (è in 1.6), sostituisci il test dei tipi con due assegnazioni a livello di modulo:
```typescript
const _a: AbstainReason = "no-attributed-turns" as ExpectedAbstainReason;
const _b: ExpectedAbstainReason = "no-attributed-turns" as AbstainReason;
void _a; void _b;
```

- [ ] **Step 3: Lint, typecheck, test completi**

```bash
npm run lint && npm run typecheck && npm run test
```

Expected: 0, 0, 0.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/conversations/spike-corpus.ts test/unit/conversation-parser.corpus.test.ts
git commit -m "test(context): spike-2 corpus end-to-end — 10/10 gates, transcript shape, no text in log meta

Runs the ten anonymized cases through parse(): five conversations, five
abstentions with the exact reason. Transcripts stay within budget, carry
explicit roles, no chrome. leaksScreenText() turns spec privacy req. 2
into an assertion: no 8-char window of any fragment reaches the log meta.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh"
```

**Criteri di completamento:** i dieci `it` dei cancelli passano con le attese del fixture (5 `conversation`, 5 `abstain` con i codici `assistant-speaker`, `no-attributed-turns` ×3, `last-turn-is-user`); i test per caso sopra passano senza modifiche alle stringhe attese; `leaksScreenText` esportato dal fixture; lint/typecheck/test verdi.

---

## Task 6: Addon nativo `ax_context` e cablaggio in `binding.gyp`

**Obiettivo:** scrivere lo strato Obj-C++ che legge il contesto Accessibility sotto il puntatore con budget rigidi e lo restituisce come dati grezzi (livelli, frammenti, conteggi, tempi), più `activateApp`, `frontmostPid`, `isTrusted`; aggiungere il target a `binding.gyp` e uno script di rebuild.

**Dipende da:** nessun task (può correre in parallelo a 1-5).

**Files:**
- Create: `native/ax-context/ax_context.mm`
- Modify: `binding.gyp`
- Modify: `package.json` (script `rebuild-native`)

> Obj-C++ puro: nessun test in `vitest` (vincolo 7-8). Il contratto verso JS è verificato dal wrapper del task 7 con un finto nativo; il binario reale è verificato a mano nel task 8. Modello di stile: `native/ptt-monitor/ptt_monitor.mm` (commento di testa con l'API JS, funzioni `static`, `Napi::Value Fn(const Napi::CallbackInfo&)`, `NODE_API_MODULE`). Sorgente verificata della sequenza di chiamate AX (leggila se disponibile, non copiarla): `/private/tmp/claude-501/-Users-danilofranco-Developer-open-flow/5d0e36ea-c5aa-419d-b5ea-f5d25d300647/scratchpad/axprobe2.m`. Tutto ciò che serve è comunque riportato qui sotto.

- [ ] **Step 1: Aggiungi il target a `binding.gyp`**

Dopo il blocco `ptt_monitor` (prima di `whisper_stream`), stesso schema, senza CoreAudio:

```json
    {
      "target_name": "ax_context",
      "sources": ["native/ax-context/ax_context.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": ["-fobjc-arc"],
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_ENABLE_OBJC_ARC": "YES"
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/Cocoa.framework",
              "$(SDKROOT)/System/Library/Frameworks/Foundation.framework",
              "$(SDKROOT)/System/Library/Frameworks/ApplicationServices.framework"
            ]
          }
        }]
      ]
    },
```

`electron-builder.yml` include già `build/Release/*.node` e lo estrae dall'asar (`asarUnpack`): nessuna modifica. La CI (`npm ci` su `macos-14`) compila tutti i target di `binding.gyp` con node-gyp: il file deve compilare pulito con i soli framework pubblici.

- [ ] **Step 2: Aggiungi lo script di rebuild a `package.json`**

In `scripts`, dopo `"package"`:

```json
    "rebuild-native": "electron-rebuild -f --arch arm64"
```

`--arch arm64` è obbligatorio: la shell di sviluppo ha un `node` x86_64 sotto Rosetta e senza il flag si produce un `.node` che l'Electron arm64 rifiuta (`incompatible architecture`).

- [ ] **Step 3: Scrivi `native/ax-context/ax_context.mm`**

Contratto JS (commento di testa del file, come in `ptt_monitor.mm`):

```
// ax_context: reads the Accessibility context under the mouse pointer.
//
// Runs in the Electron main process (same TCC entry as ptt_monitor). Pure data
// collection: no text heuristics live here — they are in
// src/main/utils/conversation-parser.ts, where they are testable.
//
// JS API:
//   const ax = require('./build/Release/ax_context.node');
//   ax.readContextUnderCursor({ maxDepth, maxTotalChars, timeBudgetMs, jumpRatio, jumpMinChars,
//                               bundleIdFilter?: { mode: "allowlist"|"blocklist", bundleIds: string[] } })
//     → NativeContextResult (see src/main/ax-context-reader.ts)
//   ax.activateApp(pid)  → boolean
//   ax.frontmostPid()    → number (-1 if none)
//   ax.isTrusted()       → boolean (AXIsProcessTrusted)
```

Costanti (tutte `static const`, con un commento sul perché):

| Nome | Valore | Perché |
|---|---|---|
| `kElementTimeoutSec` | `0.1f` | `AXUIElementSetMessagingTimeout` per elemento: un'app bloccata non deve mangiare il budget totale di 300 ms (la sonda usava 0.5 s, incompatibile con quel budget) |
| `kSystemWideTimeoutSec` | `0.25f` | timeout dell'elemento system-wide per `AXUIElementCopyElementAtPosition` (28-49 ms misurati) |
| `kSubtreeMaxDepth` | `30` | profondità massima del sottoalbero raccolto per livello (sonda) |
| `kSubtreeMaxNodes` | `3000` | nodi massimi per livello (sonda) |
| `kMinFragmentChars` | `2` | frammenti più corti sono rumore (sonda) |
| `kChromeRoles` | `AXButton, AXMenuItem, AXMenuButton, AXMenu, AXMenuBar, AXMenuBarItem, AXToolbar, AXTabGroup, AXTab, AXRadioButton, AXCheckBox, AXPopUpButton, AXImage, AXSlider, AXIncrementor, AXScrollBar, AXDisclosureTriangle, AXProgressIndicator` | ruoli di puro cromo: il loro testo non viene raccolto, i figli sì (sonda, `chromeRoles()`) |

Default delle opzioni se il campo manca nell'oggetto JS: `maxDepth 8`, `maxTotalChars 16000`, `timeBudgetMs 300`, `jumpRatio 10`, `jumpMinChars 400`. Il wrapper li passa sempre espliciti; i default nativi servono solo a rendere l'addon usabile da solo.

Helper `static`:

- `NSString* stringAttr(AXUIElementRef el, CFStringRef attr)` — `AXUIElementCopyAttributeValue`; accetta `CFString` e `CFNumber` (convertito con `stringValue`); `nil` altrimenti; rilascia il valore.
- `AXUIElementRef copyElementAttr(AXUIElementRef el, CFStringRef attr)` — come sopra ma restituisce solo se `CFGetTypeID(v) == AXUIElementGetTypeID()`; il chiamante fa `CFRelease`.
- `NSString* roleOf(AXUIElementRef el)` — `kAXRoleAttribute` o `@"?"`.
- `bool isChromeRole(NSString* role)`.
- `CGPoint cursorPointAX()` — `CGEventRef ev = CGEventCreate(NULL); CGPoint p = CGEventGetLocation(ev); CFRelease(ev); return p;` (già in coordinate AX, origine in alto a sinistra, multi-monitor incluso: nessuna conversione).
- `double nowMs()` — `CFAbsoluteTimeGetCurrent() * 1000.0`.

Struttura della raccolta:

```cpp
struct Budget { NSUInteger maxTotalChars; double deadlineMs; };
struct Harvest {
  NSMutableArray<NSString*>* fragments;  // in document order
  NSUInteger chars;                      // sum of fragment lengths
  int nodes;
  bool budgetHit;                        // maxTotalChars or deadline crossed
};

// Depth-first walk of `el`'s subtree. For every non-chrome node reads
// kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute (in this
// order), trims whitespace, drops < kMinFragmentChars and exact duplicates
// (`seen`), appends to h.fragments and adds the length to h.chars. Chrome nodes
// contribute no text but their children are still visited. Stops when
// depth > kSubtreeMaxDepth, h.nodes >= kSubtreeMaxNodes, h.chars > budget.maxTotalChars
// (sets budgetHit) or nowMs() > budget.deadlineMs (sets budgetHit).
static void collectSubtree(AXUIElementRef el, int depth, Harvest& h, const Budget& b, NSMutableSet<NSString*>* seen);
```

Text marker (rete di sicurezza, solo WebKit; sequenza verificata dalla sonda — vedi §Deviazioni dichiarate, punto 2):

```cpp
// Returns the flat string of `el`'s text-marker range, or nil when the element
// does not expose text markers (non-WebKit apps) or any step fails. The probe
// is AXStartTextMarker: if it does not answer, nothing else is attempted.
static NSString* textMarkerString(AXUIElementRef el, NSUInteger maxChars) {
  // 1. AXUIElementCopyAttributeValue(el, CFSTR("AXStartTextMarker"), &start)   → nil on failure
  // 2. AXUIElementCopyAttributeValue(el, CFSTR("AXEndTextMarker"), &end)       → nil on failure
  // 3. CFArrayRef pair = {start, end};
  //    AXUIElementCopyParameterizedAttributeValue(el, CFSTR("AXTextMarkerRangeForUnorderedTextMarkers"), pair, &range)
  // 4. AXUIElementCopyParameterizedAttributeValue(el, CFSTR("AXStringForTextMarkerRange"), range, &str)
  // 5. CFGetTypeID(str) == CFStringGetTypeID() else nil; truncate to maxChars; CFRelease everything.
}
```

`readContextUnderCursor` — procedura, nell'ordine; ogni uscita anticipata costruisce comunque l'oggetto risultato completo (campi assenti = valori vuoti: `levels: []`, `chosenLevel: -1`, `editableFound: false`, `editableIsFocused: false`, `bundleId: ""`, `pid: -1`):

1. `t0 = nowMs()`; leggi le opzioni dall'oggetto JS (`info[0]`), applica i default; `deadlineMs = t0 + timeBudgetMs`.
2. `sysWide = AXUIElementCreateSystemWide()`, timeout `kSystemWideTimeoutSec`; `p = cursorPointAX()`; `AXUIElementCopyElementAtPosition(sysWide, (float)p.x, (float)p.y, &el)`. Errore o `el == NULL` → `ok:false, reason:"no-element"`. `elementAtPositionMs = nowMs() - t0`.
3. `AXUIElementGetPid(el, &pid)`; `NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid]`; `bundleId = app.bundleIdentifier ?: @""`.
4. **Filtro app, prima di qualunque raccolta** (privacy 4): se `bundleIdFilter` è presente — `mode == "allowlist"` e `bundleId` non è nella lista, oppure `mode == "blocklist"` e `bundleId` è nella lista — → `ok:false, reason:"app-not-allowed"`, con `pid` e `bundleId` valorizzati e nient'altro.
5. `appEl = AXUIElementCreateApplication(pid)`, timeout `kElementTimeoutSec`; `axManualAccessibility = AXUIElementSetAttributeValue(appEl, CFSTR("AXManualAccessibility"), kCFBooleanTrue)` — il codice `AXError` va nel risultato (campo numerico `axManualAccessibility`) e non decide nulla (accettato = 0 su Slack/Electron, non necessario su Brave e Mail).
6. Campo editabile: `editable = copyElementAttr(el, CFSTR("AXEditableAncestor"))`; se `NULL`, `focused = copyElementAttr(appEl, kAXFocusedUIElementAttribute)` e `editable = focused`. Se ancora `NULL` → `ok:false, reason:"no-editable"`. `editableFound = true`; `editableIsFocused = (focused != NULL && CFEqual(editable, focused))` (se `editable` proviene dal fallback è per definizione `true`; altrimenti leggi `focused` per confrontare). Applica `kElementTimeoutSec` a `editable`.
7. **Risalita con rilevazione del salto.** `levels` è un array di `{depth, chars, fragments}`; `collectMs` accumula. Livello 0: `collectSubtree(editable, 0, …)` → `levels[0]` con `depth 0`. Poi per `depth = 1 … maxDepth`: `parent = copyElementAttr(current, kAXParentAttribute)`; se `NULL` interrompi; timeout `kElementTimeoutSec`; nuova `Harvest` (con un `seen` **nuovo** per livello: ogni livello è una raccolta indipendente, come nella sonda); `collectSubtree(parent, 0, …)`; aggiungi `levels[depth]`. Se `budgetHit` → `ok:false, reason:"budget-exceeded"` restituendo i livelli raccolti finora (i conteggi servono al log). **Salto**: `prev = levels[depth-1].chars`; se `chars >= jumpMinChars && chars >= jumpRatio * max(prev, 1)` → `chosenLevel = depth`, interrompi la risalita (non si sale oltre: privacy 5). Rilascia `current` quando si passa al `parent`.
8. Se nessun livello ha `chars > 0` → `ok:false, reason:"no-text"`.
9. Se `chosenLevel >= 0`: `webkitMarkerText = textMarkerString(chosenAncestor, maxTotalChars) ?: textMarkerString(editable, maxTotalChars)`; incluso nel risultato solo se non `nil` e non vuoto. Se `chosenLevel == -1` nessun tentativo (il parser lavorerà sul livello più ricco; il log registrerà il caso per ricalibrare le soglie).
10. `timings = { elementAtPositionMs, collectMs, totalMs: nowMs() - t0 }`; `ok:true`.
11. `CFRelease` di `el`, `appEl`, `sysWide`, `editable`, `focused`, di ogni antenato ritenuto. Gli oggetti `NS*` sono gestiti da ARC.

Costruzione del risultato: `Napi::Object` con `Set(...)` per ogni campo; `levels` è `Napi::Array` di oggetti `{ depth: Number, chars: Number, fragments: Array<String> }`; `reason` è impostato solo quando `ok == false`; `webkitMarkerText` solo quando presente.

`activateApp(pid)`: `NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid]`; se `nil` → `false`; altrimenti `return [app activateWithOptions:NSApplicationActivateIgnoringOtherApps]`. (Il flag è deprecato da macOS 14 ma funzionante; il sostituto `activate` richiede la cooperazione dell'app di destinazione, che qui non c'è. Aggiungi `#pragma clang diagnostic ignored "-Wdeprecated-declarations"` intorno alla chiamata così la CI resta pulita.)

`frontmostPid()`: `NSRunningApplication* f = NSWorkspace.sharedWorkspace.frontmostApplication; return f ? f.processIdentifier : -1`.

`isTrusted()`: `AXIsProcessTrusted()`, identico a `ptt_monitor`.

`Init`: `exports.Set("readContextUnderCursor", …)`, `"activateApp"`, `"frontmostPid"`, `"isTrusted"`; `NODE_API_MODULE(ax_context, Init)`.

Cosa **non** deve comparire nel file (privacy 6, vincolo 15): `kAXWindowsAttribute`, `kAXFocusedWindowAttribute`, `kAXTitleAttribute` letto su un elemento di ruolo `AXWindow` (il titolo dei nodi interni è raccolto da `collectSubtree` come parte del contenuto, ma il nodo finestra non è mai la radice di una raccolta: la risalita parte dal campo editabile e si ferma al salto o a `maxDepth`), `AXUIElementCopyAttributeNames` (era diagnostica della sonda), scrittura su file, `NSLog` con contenuto (ammessi solo `NSLog` senza testo raccolto — meglio nessuno).

- [ ] **Step 4: Compila e verifica il caricamento**

```bash
npm run rebuild-native 2>&1 | tail -5
ls -la build/Release/ax_context.node && file build/Release/ax_context.node
```

Expected: nessun errore di compilazione; `file` riporta `Mach-O 64-bit bundle arm64`.

Caricamento sotto il Node di Electron (la shell non può caricare un `.node` arm64; il bootstrap di Electron sporca stdout, quindi si scrive su file):

```bash
ELEC=$(node -e "process.stdout.write(require('electron'))")
ELECTRON_RUN_AS_NODE=1 "$ELEC" -e "require('fs').writeFileSync(process.env.TMPDIR + '/ax_context_keys.txt', Object.keys(require(process.cwd() + '/build/Release/ax_context.node')).sort().join(','))"
cat "$TMPDIR/ax_context_keys.txt"; echo
```

Expected: `activateApp,frontmostPid,isTrusted,readContextUnderCursor`.

- [ ] **Step 5: Verifiche di vincolo**

```bash
grep -c "regex\|NSRegularExpression" native/ax-context/ax_context.mm
grep -c "kAXWindowsAttribute\|kAXFocusedWindowAttribute\|AXUIElementCopyAttributeNames" native/ax-context/ax_context.mm
grep -n "CFSTR(\"AX" native/ax-context/ax_context.mm
```

Expected: `0`, `0`, e la terza stampa esattamente sei attributi non nei header: `AXManualAccessibility`, `AXEditableAncestor`, `AXStartTextMarker`, `AXEndTextMarker`, `AXTextMarkerRangeForUnorderedTextMarkers`, `AXStringForTextMarkerRange`.

- [ ] **Step 6: Lint, typecheck, test (invariati: nessun TS toccato) e commit**

```bash
npm run lint && npm run typecheck && npm run test
git add native/ax-context/ax_context.mm binding.gyp package.json
git commit -m "build(native): ax_context addon — AX context under the cursor with hard budgets

Thin Obj-C++ collector on the ptt_monitor pattern: element at cursor →
AXEditableAncestor (fallback focused element) → climb one ancestor at a
time harvesting the subtree with chrome roles filtered → stop at the
character-count jump (≥10× and ≥400 chars). Budgets: depth 8, 16 000
chars, 300 ms. Bundle-id filter applied before any harvest (privacy 4).
Text markers only as a WebKit safety net on the chosen ancestor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh"
```

**Criteri di completamento:** `build/Release/ax_context.node` esiste, arm64, esporta le quattro funzioni; i grep dello step 5 danno i valori attesi; `binding.gyp` ha il target con i tre framework; `package.json` ha `rebuild-native`; lint/typecheck/test verdi.

---

## Task 7: `AxContextReader` — wrapper TypeScript con dependency injection

**Obiettivo:** incapsulare l'addon dietro un'interfaccia iniettabile, normalizzare i frammenti in un `RawContext` pronto per il parser, applicare il timeout esterno di sicurezza e loggare **solo** metriche.

**Dipende da:** Task 6 (contratto `NativeContextResult`); il codice TS non richiede il binario per essere testato.

**Files:**
- Create: `src/main/ax-context-reader.ts`
- Create: `test/unit/ax-context-reader.test.ts`

- [ ] **Step 1: Scrivi i test che falliscono**

Crea `test/unit/ax-context-reader.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  AxContextReader,
  DEFAULT_READ_OPTIONS,
  normalizeNativeFragments,
  splitByMarkerLines,
  toLogMeta,
  type AxContextNative,
  type NativeContextResult,
  type ReadOptions,
} from "../../src/main/ax-context-reader.js";
import { CASES, axFragments, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";

function okResult(over: Partial<NativeContextResult> = {}): NativeContextResult {
  return {
    ok: true,
    pid: 4242,
    bundleId: "com.tinyspeck.slackmacgap",
    editableFound: true,
    editableIsFocused: true,
    levels: [
      { depth: 0, chars: 17, fragments: ["Messaggio a Marta"] },
      { depth: 1, chars: 22, fragments: ["Messaggio a Marta", "Invia"] },
      { depth: 2, chars: 3748, fragments: ["Marta: ciao 09:12. ⋄ 09:12 ⋄ ciao", "Invia"] },
    ],
    chosenLevel: 2,
    axManualAccessibility: 0,
    timings: { elementAtPositionMs: 31, collectMs: 23, totalMs: 60 },
    ...over,
  };
}

function makeFakeNative(result: NativeContextResult, trusted = true) {
  const calls: ReadOptions[] = [];
  const native: AxContextNative = {
    readContextUnderCursor: (opts) => { calls.push(opts); return result; },
    activateApp: vi.fn(() => true),
    frontmostPid: vi.fn(() => 4242),
    isTrusted: () => trusted,
  };
  return { native, calls };
}

describe("AxContextReader.read", () => {
  it("returns not-trusted without calling the native reader when Accessibility is not granted", () => {
    const fake = makeFakeNative(okResult(), false);
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r).toEqual({ ok: false, reason: "not-trusted", pid: -1, bundleId: "", levelSummary: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("passes the spec budgets to the addon by default", () => {
    const fake = makeFakeNative(okResult());
    new AxContextReader({ native: fake.native }).read();
    expect(DEFAULT_READ_OPTIONS).toEqual({ maxDepth: 8, maxTotalChars: 16_000, timeBudgetMs: 300, jumpRatio: 10, jumpMinChars: 400 });
    expect(fake.calls[0]).toEqual(DEFAULT_READ_OPTIONS);
  });

  it("forwards a bundleIdFilter untouched", () => {
    const fake = makeFakeNative(okResult());
    const filter = { mode: "allowlist" as const, bundleIds: ["com.apple.mail"] };
    new AxContextReader({ native: fake.native }).read({ bundleIdFilter: filter });
    expect(fake.calls[0]?.bundleIdFilter).toEqual(filter);
  });

  it("maps a failed native result to ok:false with the native reason and the level counts", () => {
    const fake = makeFakeNative(okResult({ ok: false, reason: "no-editable", editableFound: false, levels: [], chosenLevel: -1 }));
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-editable");
    expect(r.pid).toBe(4242);
    expect(r.bundleId).toBe("com.tinyspeck.slackmacgap");
  });

  it("uses 'ax-error' when a failed result carries no reason", () => {
    const fake = makeFakeNative(okResult({ ok: false }));
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r.ok === false && r.reason).toBe("ax-error");
  });

  it("returns the chosen level's fragments, normalized (⋄ split, trimmed, deduped)", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read();
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.fragments).toEqual(["Marta: ciao 09:12.", "09:12", "ciao", "Invia"]);
    expect(r.context.chosenLevel).toBe(2);
    expect(r.context.levelSummary).toEqual([
      { depth: 0, chars: 17, n: 1 }, { depth: 1, chars: 22, n: 2 }, { depth: 2, chars: 3748, n: 2 },
    ]);
    expect(r.context.pid).toBe(4242);
    expect(r.context.editableIsFocused).toBe(true);
  });

  it("falls back to the richest level when the addon found no jump", () => {
    const fake = makeFakeNative(okResult({ chosenLevel: -1 }));
    const r = new AxContextReader({ native: fake.native }).read();
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.chosenLevel).toBe(-1);
    expect(r.context.fragments[0]).toBe("Marta: ciao 09:12.");
  });

  it("returns no-text when the chosen level normalizes to nothing", () => {
    const fake = makeFakeNative(okResult({ levels: [{ depth: 0, chars: 3, fragments: ["   ", "⋄"] }], chosenLevel: 0 }));
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r.ok === false && r.reason).toBe("no-text");
  });

  it("rejects as 'timeout' a call that took longer than timeoutMs (500 by default)", () => {
    const fake = makeFakeNative(okResult());
    const clock = [0, 501];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 501 }).read();
    expect(r.ok === false && r.reason).toBe("timeout");
  });

  it("accepts a call that took exactly timeoutMs", () => {
    const fake = makeFakeNative(okResult());
    const clock = [0, 500];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 500 }).read();
    expect(r.ok).toBe(true);
  });

  it("passes through isTrusted, frontmostPid and activateApp", () => {
    const fake = makeFakeNative(okResult());
    const reader = new AxContextReader({ native: fake.native });
    expect(reader.isTrusted()).toBe(true);
    expect(reader.frontmostPid()).toBe(4242);
    expect(reader.activateApp(4242)).toBe(true);
    expect(fake.native.activateApp).toHaveBeenCalledWith(4242);
  });
});

describe("AxContextReader — privacy", () => {
  it("non passa mai al logger testo letto dallo schermo", () => {
    const slack = CASES[0]!;   // slack-decisione
    const mail = CASES[2]!;    // mail-preventivo (used as marker text)
    const result = okResult({
      levels: [
        { depth: 0, chars: 17, fragments: ["Messaggio a Marta"] },
        { depth: 7, chars: slack.ax.length, fragments: axFragments(slack.ax) },
      ],
      chosenLevel: 1,
      webkitMarkerText: axFragments(mail.ax).join("\n"),
    });
    const seen: string[] = [];
    const logger = {
      info: vi.fn(async (msg: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([msg, meta])); }),
      warn: vi.fn(async (msg: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([msg, meta])); }),
    };
    const fake = makeFakeNative(result);
    const r = new AxContextReader({ native: fake.native, logger }).read();
    expect(r.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) {
      expect(leaksScreenText(line, slack.ax), line).toBe(false);
      expect(leaksScreenText(line, mail.ax), line).toBe(false);
    }
  });

  it("toLogMeta exposes counts, codes, bundleId and timings only", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read();
    const meta = toLogMeta(r);
    expect(Object.keys(meta).sort()).toEqual([
      "bundleId", "chosenLevel", "editableFound", "editableIsFocused", "fragments", "levels", "ok", "pid", "reason", "timings",
    ]);
    expect(meta.fragments).toBe(4); // a COUNT, never the strings
    expect(JSON.stringify(meta)).not.toContain("Marta");
  });
});

describe("normalizeNativeFragments", () => {
  it("splits on ⋄ and newlines, trims, collapses spaces, dedupes, keeps order", () => {
    expect(normalizeNativeFragments(["a ⋄ b\nc", " a ", "d  e"])).toEqual(["a", "b", "c", "d e"]);
  });
});

describe("splitByMarkerLines", () => {
  const p1 = "Buongiorno, le invio il preventivo aggiornato per la revisione dell'impianto elettrico del secondo piano.";
  const p2 = "Il totale è 4.850 euro IVA esclusa, con inizio lavori previsto entro tre settimane dall'accettazione.";
  const joined = `${p1} ${p2}`; // ≥ 120 chars: the AX tree lost the newline

  it("re-splits a long fragment along the newlines of the marker text when the lines cover it exactly", () => {
    expect(splitByMarkerLines([joined], `Re: Preventivo\n${p1}\n${p2}\nCordiali saluti`)).toEqual([p1, p2]);
  });
  it("leaves the fragment alone when the marker lines do not cover it exactly", () => {
    expect(splitByMarkerLines([joined], `${p1}\nqualcos'altro`)).toEqual([joined]);
  });
  it("leaves short fragments and fragments without marker text alone", () => {
    expect(splitByMarkerLines(["Marta: ciao"], "Marta:\nciao")).toEqual(["Marta: ciao"]);
    expect(splitByMarkerLines([joined], undefined)).toEqual([joined]);
  });
});
```

Run: `npx vitest run test/unit/ax-context-reader.test.ts`
Expected: FAIL — modulo non trovato.

- [ ] **Step 2: Scrivi `src/main/ax-context-reader.ts`**

```typescript
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Logger } from "./logger.js";

export type NativeReason =
  | "no-element" | "no-editable" | "no-text" | "budget-exceeded" | "ax-error" | "app-not-allowed";

export interface BundleIdFilter {
  mode: "allowlist" | "blocklist";
  bundleIds: string[];
}

export interface ReadOptions {
  maxDepth: number;
  maxTotalChars: number;
  timeBudgetMs: number;
  jumpRatio: number;
  jumpMinChars: number;
  /** Checked by the addon BEFORE any harvest (spec, privacy 4). */
  bundleIdFilter?: BundleIdFilter;
}

/** Spec §1 budgets: depth 8 covers the measured jump at level 7 with one level
 *  of margin; 16 000 chars is twice the largest measured level (8 291); 300 ms
 *  is about twice the worst measured total (49 + 98 ms); 10× / 400 chars sit
 *  between the measured pre-jump (20-93 chars) and post-jump (1 454-8 291, 40-200×). */
export const DEFAULT_READ_OPTIONS: Readonly<ReadOptions> = {
  maxDepth: 8,
  maxTotalChars: 16_000,
  timeBudgetMs: 300,
  jumpRatio: 10,
  jumpMinChars: 400,
};

export interface NativeLevel { depth: number; chars: number; fragments: string[] }

export interface NativeContextResult {
  ok: boolean;
  reason?: NativeReason;
  pid: number;
  bundleId: string;
  editableFound: boolean;
  editableIsFocused: boolean;
  levels: NativeLevel[];
  chosenLevel: number;
  webkitMarkerText?: string;
  /** AXError of setting AXManualAccessibility on the app element; log only. */
  axManualAccessibility: number;
  timings: { elementAtPositionMs: number; collectMs: number; totalMs: number };
}

export interface AxContextNative {
  readContextUnderCursor(opts: ReadOptions): NativeContextResult;
  activateApp(pid: number): boolean;
  frontmostPid(): number;
  isTrusted(): boolean;
}

export interface LevelSummary { depth: number; chars: number; n: number }

export interface RawContext {
  pid: number;
  bundleId: string;
  editableFound: boolean;
  editableIsFocused: boolean;
  chosenLevel: number;
  levelSummary: LevelSummary[];
  /** Normalized fragments of the chosen level (richest level when no jump). */
  fragments: string[];
  timings: { elementAtPositionMs: number; collectMs: number; totalMs: number; wrapperMs: number };
}

export type ReadContextResult =
  | { ok: true; context: RawContext }
  | { ok: false; reason: NativeReason | "not-trusted" | "timeout"; pid: number; bundleId: string; levelSummary: LevelSummary[] };

export interface AxContextReaderOptions {
  appRoot?: string;
  isPackaged?: boolean;
  /** Injected addon, for tests. When given, appRoot/isPackaged are unused. */
  native?: AxContextNative;
  /** Receives metrics only — never text (spec, privacy 2). */
  logger?: Pick<Logger, "info" | "warn">;
  /** Outer safety timeout; 500 ms by default. */
  timeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}
```

Caricatore (duplicato deliberato di `loadNativeAddon` in `ptt-manager.ts`, che non è esportato e non va toccato — vincolo 3): stessi due percorsi, nome `ax_context.node`, stesso messaggio d'errore con i candidati provati.

Funzioni pure esportate:

```typescript
const FRAGMENT_SPLIT = /\s*⋄\s*|\r?\n/u;

/** Splits on the " ⋄ " separator and on newlines, trims, collapses internal
 *  whitespace, drops empties and exact duplicates; order preserved. */
export function normalizeNativeFragments(fragments: readonly string[]): string[]

/** Fragments of the chosen level, or of the level with the most chars when
 *  the addon found no jump (chosenLevel === -1). Empty when there are no levels. */
export function pickFragments(result: NativeContextResult): string[]

const MARKER_SPLIT_MIN_CHARS = 120;

/**
 * WebKit safety net (spec §1.7): the AX tree loses paragraph breaks, the text
 * markers keep them. For every fragment of at least 120 chars, if a run of
 * two or more consecutive marker lines, joined by single spaces, equals the
 * fragment exactly, the fragment is replaced by those lines. Never adds text
 * from the marker string that is not already in the fragment: the marker
 * text has no scope (spike 1) and must not become a content source.
 */
export function splitByMarkerLines(fragments: readonly string[], markerText: string | undefined): string[]

/** Metrics only. `fragments` is a COUNT. */
export function toLogMeta(r: ReadContextResult): Record<string, unknown>
```

`toLogMeta` restituisce esattamente le chiavi `ok, reason, pid, bundleId, editableFound, editableIsFocused, chosenLevel, levels, fragments, timings` — con `reason: null` quando `ok`, `levels` = `levelSummary`, `fragments` = numero di frammenti (0 se `ok:false`), `editableFound/editableIsFocused/chosenLevel/timings` = `null` quando `ok:false`.

Classe:

```typescript
export class AxContextReader {
  private readonly native: AxContextNative;
  private readonly logger: Pick<Logger, "info" | "warn"> | null;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: AxContextReaderOptions) {
    this.native = opts.native ?? loadNativeAddon(opts.appRoot ?? "", opts.isPackaged ?? false);
    this.logger = opts.logger ?? null;
    this.timeoutMs = opts.timeoutMs ?? 500;
    this.now = opts.now ?? (() => performance.now());
  }

  isTrusted(): boolean { return this.native.isTrusted(); }
  frontmostPid(): number { return this.native.frontmostPid(); }
  activateApp(pid: number): boolean { return this.native.activateApp(pid); }

  /**
   * One synchronous read under the cursor. The addon call cannot be
   * interrupted (it is synchronous on the main thread, like every ptt_monitor
   * call), so the 500 ms outer timeout is enforced after the fact: a call that
   * overran is rejected as "timeout" rather than trusted, because an addon that
   * ignored its own budget may also have ignored its depth limit.
   */
  read(overrides: Partial<ReadOptions> = {}): ReadContextResult {
    if (!this.native.isTrusted()) {
      const r: ReadContextResult = { ok: false, reason: "not-trusted", pid: -1, bundleId: "", levelSummary: [] };
      void this.logger?.warn("ax-context read blocked", toLogMeta(r));
      return r;
    }
    const opts: ReadOptions = { ...DEFAULT_READ_OPTIONS, ...overrides };
    const t0 = this.now();
    const native = this.native.readContextUnderCursor(opts);
    const wrapperMs = this.now() - t0;
    const levelSummary = native.levels.map((l) => ({ depth: l.depth, chars: l.chars, n: l.fragments.length }));
    // … then, in order: wrapperMs > timeoutMs → "timeout"; !native.ok → native.reason ?? "ax-error";
    // fragments = splitByMarkerLines(normalizeNativeFragments(pickFragments(native)), native.webkitMarkerText);
    // fragments.length === 0 → "no-text"; else ok:true with RawContext.
    // Every return passes through `void this.logger?.info("ax-context read", toLogMeta(result))`.
  }
}
```

Nota su `Partial<ReadOptions>` con `bundleIdFilter?`: lo spread `{ ...DEFAULT_READ_OPTIONS, ...overrides }` produce `bundleIdFilter: undefined` se non passato; il test `toEqual(DEFAULT_READ_OPTIONS)` lo accetta (`toEqual` ignora le proprietà `undefined`). Se si preferisce evitarlo, copia `bundleIdFilter` solo se definito.

Run: `npx vitest run test/unit/ax-context-reader.test.ts`
Expected: PASS.

- [ ] **Step 3: Verifiche di vincolo, lint, typecheck, test**

```bash
grep -rn "readContextUnderCursor" src/
grep -rn "\.node" test/unit/ ; echo "exit=$?"
grep -rn "writeFile\|appendFile\|from \"node:fs" src/main/ax-context-reader.ts ; echo "exit=$?"
npm run lint && npm run typecheck && npm run test
```

Expected: la prima stampa solo righe di `src/main/ax-context-reader.ts`; la seconda e la terza `exit=1` (nessuna riga); i tre comandi escono con 0.

- [ ] **Step 4: Commit**

```bash
git add src/main/ax-context-reader.ts test/unit/ax-context-reader.test.ts
git commit -m "feat(context): AxContextReader — injectable wrapper over ax_context with metrics-only logging

PTTManager pattern: native addon injectable for tests, loaded from
build/Release (dev) or app.asar.unpacked (packaged) otherwise. Normalizes
the chosen level's fragments, re-splits long ones along WebKit marker
newlines when they cover the fragment exactly, rejects overruns of the
500 ms outer budget. toLogMeta() carries counts, codes, bundleId and
timings; a logger-spy test proves no screen text reaches it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh"
```

**Criteri di completamento:** `AxContextReader` con costruttore `AxContextReaderOptions`, metodi `read`, `isTrusted`, `frontmostPid`, `activateApp`; `DEFAULT_READ_OPTIONS` con i cinque valori della spec; `normalizeNativeFragments`, `pickFragments`, `splitByMarkerLines`, `toLogMeta` esportate; tutti i test verdi incluso il logger-spia; i grep dello step 3 come atteso; lint/typecheck/test verdi.

---

## Task 8: Punto d'ingresso di debug `ax-context-probe` (sotto Electron)

**Obiettivo:** un comando che, senza modelli e senza toccare l'app, legge la finestra sotto il mouse con l'addon reale e stampa a terminale i conteggi per livello, la trascrizione ricostruita (o il codice di astensione), il gist e la lingua — così il Piano A si verifica da solo su Slack, Mail e Brave.

**Dipende da:** Task 4, Task 7 (e il binario del Task 6 per l'esecuzione).

**Files:**
- Create: `tools/ax-context-probe.ts`
- Create: `tsconfig.tools.json`
- Modify: `package.json` (script `ax-probe`)
- Modify: `.gitignore` (riga `dist-tools/`)

> Perché sotto Electron e non con `tsx`: il `.node` è compilato contro l'ABI di Electron (`electron-rebuild`) e per arm64; il `node` della shell non può caricarlo. Eseguire il probe come script main di Electron riproduce esattamente l'ambiente in cui l'addon vivrà. Il permesso Accessibility del binario di sviluppo (`node_modules/electron/dist/Electron.app`) è lo stesso che `npm run dev` usa per il PTT. Il probe **non** è mai pacchettizzato: `electron-builder.yml` include `dist/**/*`, non `dist-tools/`. Nessun test unitario: è un tool manuale, come `tools/pipeline-smoke.ts`; è però coperto da `npm run lint` e da `npm run typecheck` (il `tsconfig.json` di root include `tools/**/*`).

- [ ] **Step 1: `tsconfig.tools.json` e `.gitignore`**

Crea `tsconfig.tools.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist-tools",
    "rootDir": ".",
    "noEmit": false,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "sourceMap": false,
    "declaration": false
  },
  "include": ["tools/ax-context-probe.ts"],
  "exclude": ["node_modules", "dist", "dist-tools", "resources"]
}
```

`tsc` compila il file incluso e, per import, `src/main/ax-context-reader.ts`, `src/main/utils/conversation-parser.ts`, `src/main/preferences-store.ts`, `src/main/logger.ts` (solo tipi) → `dist-tools/tools/ax-context-probe.js` e `dist-tools/src/main/…`. Con `rootDir: "."` i percorsi relativi degli import `../src/main/*.js` restano validi nell'output.

In `.gitignore`, dopo `dist/`:

```
dist-tools/
```

- [ ] **Step 2: Script npm**

In `package.json`, `scripts`, dopo `"rebuild-native"`:

```json
    "ax-probe": "tsc --project tsconfig.tools.json && electron dist-tools/tools/ax-context-probe.js"
```

Argomenti dopo `--` arrivano al probe: `npm run ax-probe -- --user-name Danilo --delay 5`.

- [ ] **Step 3: Scrivi `tools/ax-context-probe.ts`**

```typescript
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
```

Compila in isolamento per controllare l'output:

```bash
npx tsc --project tsconfig.tools.json && ls dist-tools/tools/ax-context-probe.js dist-tools/src/main/ax-context-reader.js
```

Expected: entrambi i file esistono.

- [ ] **Step 4: Esecuzione reale (richiede il binario del task 6 e Accessibility per Electron.app)**

```bash
npm run rebuild-native >/dev/null 2>&1 && npm run ax-probe -- --user-name Danilo --delay 5
```

Durante il conto alla rovescia, porta il mouse sopra una conversazione in Slack (o una mail aperta in Mail). Expected: le sezioni `=== READER ===`, la tabella dei livelli con un `← scelto`, `=== PARSER ===`, e o `ASTENSIONE: <codice>` o la trascrizione con righe `INTERLOCUTORE (…)` / `TU (…)`. Vedi §Come verificare il Piano A a mano per l'esito atteso su ciascuna app.

Prova anche l'astensione: mouse su una pagina web senza conversazione → `ESITO: nessun contesto (no-editable)` oppure `ASTENSIONE: no-attributed-turns`.

- [ ] **Step 5: Verifiche di vincolo, lint, typecheck, test**

```bash
grep -n "writeFile\|appendFile\|createLogger" tools/ax-context-probe.ts ; echo "exit=$?"
grep -rn "readContextUnderCursor" src/
npm run lint && npm run typecheck && npm run test
git status --short   # dist-tools/ must NOT appear
```

Expected: `exit=1`; solo righe di `src/main/ax-context-reader.ts`; 0, 0, 0; `dist-tools/` ignorato.

- [ ] **Step 6: Commit**

```bash
git add tools/ax-context-probe.ts tsconfig.tools.json package.json .gitignore
git commit -m "feat(context): ax-context-probe — manual verification of Plan A under Electron

Compiles the probe with its own tsconfig into dist-tools/ (gitignored,
never packaged) and runs it as an Electron main script so the real
Electron-ABI addon loads. Counts down, reads once, prints reader metrics,
per-level counts, and the reconstructed transcript or the abstain code.
stdout only: no logger, no file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ca7xX8JBicBZgwMgYTGxgh"
```

**Criteri di completamento:** `npm run ax-probe -- --user-name X` compila ed esegue senza eccezioni; con il mouse su Slack stampa una trascrizione o un codice di astensione; `dist-tools/` non è tracciato; il probe non importa `logger.ts` né `node:fs`; lint/typecheck/test verdi.

---

## Come verificare il Piano A a mano

Prerequisiti: `npm ci` (o `npm install`) fatto; `npm run rebuild-native` eseguito dopo il task 6; Accessibility concessa a `Electron.app` di `node_modules/electron/dist` (già vero se `npm run dev` fa funzionare il PTT); il proprio nome impostato con `--user-name` o in `preferences.json`.

Comando: `npm run ax-probe -- --user-name <Nome> --delay 5`, poi portare il mouse sul punto indicato entro cinque secondi.

| Dove sta il mouse | Sezione READER attesa | Sezione PARSER attesa |
|---|---|---|
| **Slack**, sopra i messaggi di un DM in cui l'altra persona ha scritto per ultima | `ok: true`, `bundleId: "com.tinyspeck.slackmacgap"`, `editableFound: true`, livelli 1-6 con poche decine di caratteri, un livello (misurato: 7) con migliaia di caratteri e `← scelto`, `totalMs` sotto i 300 | `kind: "conversation"`, trascrizione con `INTERLOCUTORE (<nome>)` e `TU (<Nome>)` un turno per riga, ultimo turno dell'interlocutore, nessun `Invia` / `Allega file` / `Messaggio a …`; `GIST` = `Rispondi a <nome>: <prima frase con ?>`; `lingua: it` |
| **Slack**, stesso DM ma l'ultimo messaggio è tuo | come sopra | `ASTENSIONE: last-turn-is-user` |
| **Mail**, sopra il corpo di una mail ricevuta con la risposta aperta | `ok: true`, `bundleId: "com.apple.mail"`, salto già al livello 1 (misurato: 1454 char) | `kind: "conversation"`, prima riga `OGGETTO: …` se c'era `Re:`, poi `INTERLOCUTORE (Nome Cognome): …` con il nome estratto da "Il giorno …, Nome Cognome <…> ha scritto:" |
| **Brave**, pagina web senza conversazione (nuova scheda, un articolo) | `ok: false, reason: "no-editable"` oppure `ok: true` con pochi caratteri | `ASTENSIONE: no-attributed-turns` |
| **Brave**, chatgpt.com con una risposta dell'assistente | `ok: true`, `bundleId: "com.brave.Browser"`, salto misurato al livello 7 (~8000 char) | `ASTENSIONE: assistant-speaker` |
| Un editor di codice o un form di registrazione | `ok: true` con un solo livello povero, o `no-editable` | `ASTENSIONE: no-attributed-turns` |
| `--allow com.apple.mail` con il mouse su Slack | `ok: false, reason: "app-not-allowed"`, `levels: []` (nessuna raccolta è avvenuta) | (non eseguito) |

Controlli aggiuntivi da fare una volta:

1. **Privacy nel log dell'app**: il probe non scrive log. Ma il reader, quando il Piano B lo costruirà con il `logger` dell'app, scriverà `ax-context read` con `toLogMeta`: apri `~/Library/Logs/open-flow/error.log` dopo aver eseguito i test unitari — non deve contenere nulla di nuovo (i test non usano il logger reale).
2. **Nessun call site nascosto**: `grep -rn "readContextUnderCursor" src/` → solo `src/main/ax-context-reader.ts`.
3. **Il pacchetto non include il probe**: `npm run package` (facoltativo, lungo) e poi `ls release/mac-arm64/open-flow.app/Contents/Resources/app.asar.unpacked/build/Release/` deve contenere `ax_context.node`; `dist-tools` non compare da nessuna parte nel bundle.
4. **Ripetibilità**: due letture consecutive sulla stessa conversazione ferma producono la stessa trascrizione (il parser è puro; l'addon raccoglie in ordine di documento).

Se su un'app il salto non c'è (`nessun salto: il parser usa il livello più ricco`) o il livello scelto non contiene i messaggi, annota `bundleId` e i conteggi per livello: sono il materiale per ricalibrare `jumpRatio`/`jumpMinChars` (spec §Rischi 3). Non cambiare le soglie in questo piano.

---

## Self-Review (completato in fase di pianificazione)

- **Copertura della spec (Piano A):** addon `ax_context` con la procedura 1-7 della spec §1 e i budget 8 / 16 000 / 300 / 10× / 400 (task 6); `AxContextReader` con DI, normalizzazione, timeout 500 ms (task 7); `ConversationParser` con le dieci fasi della spec §3 e i sei cancelli nell'ordine (task 2-4); preferenza `userDisplayName` default `""` (task 1); corpus in `test/fixtures/conversations/` (task 1, 5); strato 1 della strategia di test per `conversation-parser`, `preferences-store` e logger-spia (task 4, 5, 7); requisiti privacy 2, 3, 4, 5, 6, 9 resi verificabili (Global Constraints 11-17).
- **Cosa resta al Piano B, per esplicita esclusione:** classificatore, posizioni, generatore, filtri, pill/overlay, secondo `llama-server`, hotkey, `ReplyCoordinator` (unico call site di produzione di `AxContextReader.read`), catalogo modelli, UI preferenze (compreso il campo per `userDisplayName`), `index.ts`, README, smoke checklist, bump di `llama.cpp`.
- **Coerenza dei tipi fra task:** `NativeContextResult` / `AxContextNative` / `ReadOptions` definiti nel task 7 e implementati nel task 6 (stessi nomi di campo: `pid, bundleId, editableFound, editableIsFocused, levels[{depth, chars, fragments}], chosenLevel, webkitMarkerText?, axManualAccessibility, timings{elementAtPositionMs, collectMs, totalMs}`); `ParseInput.fragments` riceve `RawContext.fragments` (task 8); `AbstainReason` (task 4) ≡ `ExpectedAbstainReason` (task 1) verificato da `expectTypeOf` (task 5); `toLogMeta` esiste in entrambi i moduli con nomi importati distinti nel probe.
- **Materiale dello spike riusato alla lettera:** `SPEECH_MARKER`, `ATTRIBUTED`, `SUBJECT`, `PURE_NOISE`, `SENTENCE_MIN = 60`, le quattro `replace` di `speakerFromPrefix`, la soglia 15 dell'ultimo messaggio, i dieci `ax`; i ruoli di cromo e la sequenza text-marker di `axprobe2.m`. Scostamenti dichiarati: `TRAILING_TIME` estesa (spec fase 5), dedup per indici, `toTurns` tipizzato, budget parametrizzato, caso chatgpt → abstain, `app-not-allowed`, `AXEndTextMarker` + `AXTextMarkerRangeForUnorderedTextMarkers`.
- **Scansione dei placeholder:** nessun "TBD"; ogni passo contiene codice completo o l'algoritmo con valori esatti; l'unico blocco lasciato in forma di procedura è l'Obj-C++ del task 6, per il quale sono dati costanti, firme, ordine dei passi, codici di uscita e verifiche.
