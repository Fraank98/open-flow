# Proposte di risposta dal contesto — Piano B (classificatore, generazione, pill, secondo server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Ogni task è autosufficiente: contiene firme, valori, prompt e casi di test da usare alla lettera. Non rimanda alla spec per nessun valore.

**Goal:** Rendere visibile e utile la feature "proposte di risposta dal contesto": una hotkey legge il contesto sotto il mouse (Piano A, già nel repo), un classificatore a output vincolato decide se il messaggio è rispondibile con una decisione e con quale set di posizioni, un generatore scrive la prosa delle tre posizioni fissate dal codice, filtri per singola variante scartano le guaste, la pill mostra il gist e le proposte, l'accettazione incolla nell'app di destinazione. Il modello di generazione vive in un secondo `llama-server` acceso solo a feature accesa.

**Architecture:** Strati 3-6 della pipeline della spec, più il ciclo di vita del secondo server, l'hotkey, il coordinatore e la UI delle preferenze. Tutti i moduli nuovi di `src/main/` che contengono logica sono **senza import di `electron`** e con dipendenze iniettate (pattern `PTTManager.native`, `LLMCleaner.fetchImpl`), così ogni riga è testabile in Vitest senza processi, finestre o modelli. L'unico codice che tocca Electron sta in `overlay-window.ts`, `preferences-window.ts`, `index.ts`, nei preload e nei renderer.

**Tech Stack:** TypeScript (ESM, import con `.js`), Vitest, Electron 32, `llama-server` **v0.4.0** (già in `resources/bin/` dopo il bump: `--jinja` attivo per default, `chat_template_kwargs`, `response_format` a schema JSON con `maxLength`/`minItems`/`maxItems`, architetture `gemma3` e `gemma4` caricabili — tutto verificato nel sorgente del binario pinnato).

**Branch:** `feat/reply-suggestions-plan-b` (già attivo; contiene il Piano A completo, il bump di llama.cpp e la correzione del packaging). **Nessun merge in `main` senza autorizzazione esplicita**, fast-forward inclusi.

**Spec di riferimento (autorità):** `docs/superpowers/specs/2026-09-07-context-reply-suggestions-design.md`. Dove il piano e la spec divergono, vince la spec, salvo le divergenze dichiarate in §Deviazioni dichiarate.

**Piano A (già eseguito):** `docs/superpowers/plans/2026-09-07-context-reply-suggestions-plan-a.md`. Questo piano ne imita struttura e granularità e ne consuma il codice: `src/main/ax-context-reader.ts`, `src/main/utils/conversation-parser.ts`, `test/fixtures/conversations/spike-corpus.ts`, `tools/ax-context-probe.ts`.

---

## Contesto

Il Piano A ha portato nel repo la metà deterministica: l'addon `ax_context`, il wrapper `AxContextReader` (con `read(overrides)`, `isTrusted()`, `frontmostPid()`, `activateApp(pid)` e `toLogMeta()`), il parser `parse(input): ParseResult` con le dieci fasi e i sei cancelli, il corpus dei dieci casi, il probe manuale. Baseline attuale: **293 test su 293, 27 file su 27**, `npm run lint` e `npm run typecheck` verdi. Nessun task di questo piano può peggiorare questi numeri.

Il Piano B fa il resto. I vincoli sperimentali che lo plasmano sono **misure** eseguite su cinque modelli, dieci casi e tre ripetizioni (spec §Spike 3 e §Benchmark), e vanno rispettati alla lettera:

1. **Il compito è sottodeterminato.** "Scrivi tre risposte" produce tre riscritture o la domanda rigirata. Quindi **le tre posizioni le decide il codice**; il modello scrive solo la prosa di una posizione data. Tre set: generico (`accept`/`decline`/`defer`), alternativa esplicita (`first`/`second`/`defer`), offerta o preventivo (`accept_offer`/`reject_offer`/`request_changes`; senza questo set il modello si scambiava per il fornitore).
2. **Il `decline` non inventa un motivo**: anche il motivo è sottodeterminato.
3. **Output vincolato con chiavi fissate dalla grammatica**: conformità di formato da "mai" a 100%. Lo schema **non è visibile al modello** (va descritto a parole) e garantisce la sintassi, non la semantica.
4. *Let Me Speak Freely?* (arXiv 2408.02442): il decoding vincolato **peggiora il ragionamento e migliora la classificazione**. Quindi: classificatore vincolato; al generatore si vincola solo l'involucro (le tre chiavi), il testo dentro resta libero.
5. **I few-shot non risolvono il formato** sui modelli piccoli e li degradano con l'accumularsi. Il formato si ottiene vincolando il decoding.
6. **Le istruzioni astratte vengono copiate alla lettera** ("verifichi e fai sapere a breve" in seconda persona). Servono esempi di voce in prima persona — ma quando il modello ha poco da dire **copia gli esempi**. È una calibrazione da fare sul corpus, per tier (§Rischi aperti).
7. **Sampling Gemma**: `temperature 1.0, top_p 0.95, top_k 64, min_p 0, repeat_penalty 1.0`. **Gemma non ha il ruolo `system`**: le istruzioni vanno nel primo turno utente.
8. **Trappola verificata**: Gemma 4 (e Qwen3.5) hanno il ragionamento attivo per default nei GGUF provati. Senza `chat_template_kwargs: { enable_thinking: false }` consumano tutti i token e restituiscono `content` vuoto (6,5-9,7 s per nulla).
9. **Filtri per singola variante**, mai per l'intero risultato; **numeri anche in lettere** ("quattro mila ottocento cinquanta euro" sfuggiva al controllo sulle cifre); **meno di due sopravvissute → nessuna pill**.
10. **Classifica alla lettura**: Gemma 4 E4B nettamente migliore; Gemma 3 4B discreto ma inventa motivi. **Le metriche automatiche non discriminano** (91-100% per tutti): la lettura umana è la metrica primaria (§Task 10).
11. **BUCO NOTO**: decidere se un messaggio è "rispondibile con una decisione" **non funziona con le regex** (le wh-question passano). Va fatto col classificatore a output vincolato, ed è **il primo esperimento del piano** (Task 1): il tasso di falsi positivi sui casi "informazione che solo l'utente possiede" decide se la feature è rilasciabile.

Cosa il Piano A ha lasciato al Piano B, verificato sul codice:

- `AxContextReader.read()` non ha filtro di default (`bundleIdFilter?` opzionale): senza argomenti legge qualunque app. Il Piano B lo rende **obbligatorio** (Task 6).
- L'addon confronta i bundle id con `[NSSet containsObject:]`, **sensibile alle maiuscole**; macOS li tratta case-insensitive. La normalizzazione spetta al wrapper (Task 6, con una lettura in due stadi che resta fail-closed).
- `textMarkers` è a default `false` e **non va acceso** in questo piano.
- La guardia `nil` in `ax_context.mm` (fail-open su UTF-8 non valido) resta: `native/` non si tocca.
- Il salto (`chosenLevel >= 0`) è stato eseguito dal vivo (livello 5 a 33 caratteri → livello 6 a 4107, 124×; latenza 123 ms). Le soglie 10× / 400 non si cambiano qui.

Materiale misurato riusato alla lettera nei task: il prompt del generatore e i tre set di posizioni dello spike 3 (strategia S3, portata al vincolo "esempi di voce non copiabili"), i parametri di sampling, le regex dei validatori dello spike (azione già svolta, impegno inventato, istruzione in seconda persona, copia dell'esempio, firma, eco Jaccard 0,6, quasi-duplicati 0,75), i due GGUF del benchmark identificati per byte e sha256 (Task 2).

---

## Global Constraints

Questa sezione viene copiata alla lettera nel prompt dei reviewer. Ogni riga è un requisito controllabile.

**Ambito e file**

1. Il Piano B crea **solo** questi file: `src/main/reply-chat-client.ts`, `src/main/reply-classifier.ts`, `src/main/utils/reply-positions.ts`, `src/main/reply-generator.ts`, `src/main/utils/number-words.ts`, `src/main/utils/variant-filter.ts`, `src/main/reply-server-manager.ts`, `src/main/utils/reply-hotkey.ts`, `src/main/utils/overlay-bounds.ts`, `src/main/reply-coordinator.ts`, `src/shared/reply-types.ts`, `test/fixtures/conversations/classifier-corpus.ts`, `test/unit/reply-chat-client.test.ts`, `test/unit/reply-classifier.test.ts`, `test/unit/reply-positions.test.ts`, `test/unit/reply-generator.test.ts`, `test/unit/number-words.test.ts`, `test/unit/variant-filter.test.ts`, `test/unit/reply-server-manager.test.ts`, `test/unit/reply-hotkey.test.ts`, `test/unit/overlay-bounds.test.ts`, `test/unit/reply-coordinator.test.ts`, `test/integration/reply-pipeline.test.ts`, `tools/reply-classifier-bench.ts`, `tools/reply-pipeline-bench.ts`.
2. Il Piano B modifica **solo** questi file esistenti: `src/main/ax-context-reader.ts` (Task 6: `bundleIdFilter` obbligatorio, gate in due stadi), `test/unit/ax-context-reader.test.ts`, `tools/ax-context-probe.ts` (Task 6: passa sempre un filtro), `src/main/preferences-store.ts`, `test/unit/preferences-store.test.ts`, `src/main/model-catalog.ts`, `test/unit/model-catalog.test.ts`, `src/main/overlay-window.ts`, `src/renderer/overlay.html`, `src/renderer/overlay.css`, `src/preload/overlay-preload.ts`, `src/shared/ipc-channels.ts`, `src/main/preferences-window.ts`, `src/renderer/preferences.html`, `src/renderer/preferences.js`, `src/preload/preferences-preload.ts`, `src/main/index.ts`, `package.json` (script `reply-bench`), `README.md`, `docs/electron-smoke-checklist.md`.
3. **Nessun task tocca** `native/**`, `binding.gyp`, `scripts/fetch-binaries.sh`, `electron-builder.yml`, `src/main/utils/conversation-parser.ts`, `src/main/llm-server.ts`, `src/main/llm-cleaner.ts`, `src/main/utils/prompt-template.ts`, `src/main/utils/output-sanitizer.ts`, `src/main/text-injector.ts`, `src/main/pipeline-coordinator.ts`, `src/main/ptt-manager.ts`, `src/main/hotkey-manager.ts`, `test/fixtures/conversations/spike-corpus.ts`. Verifica: `git diff --name-only 2639447...HEAD` non contiene nessuno di questi percorsi.
4. I moduli `reply-chat-client.ts`, `reply-classifier.ts`, `reply-generator.ts`, `reply-server-manager.ts`, `reply-coordinator.ts`, `utils/reply-positions.ts`, `utils/number-words.ts`, `utils/variant-filter.ts`, `utils/reply-hotkey.ts`, `utils/overlay-bounds.ts` **non importano `electron`** e non creano finestre, socket o processi da soli. Verifica: `grep -ln "from \"electron\"" src/main/reply-*.ts src/main/utils/reply-*.ts src/main/utils/variant-filter.ts src/main/utils/number-words.ts src/main/utils/overlay-bounds.ts` non stampa nulla; `grep -n "spawn(\|new LLMServer(" src/main/reply-server-manager.ts` non produce righe (il server arriva da una factory iniettata).
5. `readContextUnderCursor` resta invocato in un solo file di `src/`: `src/main/ax-context-reader.ts`. `AxContextReader.read` è invocato in produzione in un solo punto: `src/main/reply-coordinator.ts`. Verifica: `grep -rn "readContextUnderCursor" src/` → solo `ax-context-reader.ts`; `grep -rn "\.read(" src/main/ --include=*.ts | grep -v ax-context-reader.ts` → solo `reply-coordinator.ts`.

**TDD e test che discriminano**

6. Ogni task che produce logica scrive **prima** il test che fallisce (passo RED con comando ed errore atteso), poi il codice, poi il test che passa (GREEN). Il messaggio di completamento riporta l'output di entrambe le esecuzioni. Stile: `import { describe, it, expect, vi } from "vitest"`, import del modulo con suffisso `.js`, asserzioni con valori letterali.
7. **I test devono discriminare.** Per ogni regola/soglia/guardia coperta, il task indica la **prova di rottura**: l'implementatore modifica deliberatamente la clausola (per esempio inverte la soglia, rimuove il controllo), esegue il test e verifica che fallisca, ripristina, riesegue e riporta **entrambe le esecuzioni** nel messaggio di completamento. Un test che resta verde con la clausola rotta va riscritto prima di procedere. È il difetto ricorrente dell'esecuzione del Piano A e non deve ripetersi.
8. A fine di **ogni** task: `npm run lint`, `npm run typecheck`, `npm run test` escono con 0, e `npm run test` riporta **almeno 293 test e 27 file** passati (baseline), più quelli aggiunti dal task. I tre esiti vanno nel messaggio di completamento.
9. Stile: tipi espliciti sulle firme esportate; nessun `let` a livello di modulo; `noUncheckedIndexedAccess` rispettato (`!` solo con commento che dimostra la validità dell'indice); JSDoc dove il *perché* non è ovvio.

**Privacy (spec §Privacy, estesa al testo generato)**

10. **Nessun contenuto letto dallo schermo né generato nei log.** Ogni chiamata a `logger.info/warn/error/debug` nei moduli del Piano B riceve solo: tempi (`ms`), conteggi, `bundleId`, `pid`, codici (`reason`, `rule`, `kind`, `state`), `key` delle varianti, booleani, codici di stato HTTP. **Mai** trascrizione, gist, `lastMessage`, nomi degli interlocutori, alternative, testo delle varianti, testo scelto, corpo delle risposte HTTP. Verifica automatica: ogni modulo che logga ha un test con logger-spia che alimenta il modulo con il corpus (`leaksScreenText` di `spike-corpus.ts`) e con varianti sintetiche contenenti la sentinella `ZQXV-VARIANT-TEXT`, e fallisce se una riga serializzata contiene una finestra di 8 caratteri dei frammenti, un nome del corpus o la sentinella.
11. **Nessun contenuto negli errori.** `ReplyChatClient` produce `ReplyLLMError` con `message` composto **solo** da codice di stato e tipo (`"reply LLM HTTP 500"`, `"reply LLM request failed: TimeoutError"`, `"reply LLM invalid JSON"`); il corpo della risposta HTTP non viene mai letto in un messaggio d'errore né loggato (a differenza di `LLMError` in `llm-cleaner.ts`, che tiene 500 caratteri). Verifica: `grep -n "res.text()" src/main/reply-chat-client.ts` non produce righe.
12. **Nessuna persistenza**: `writeFile`, `appendFile`, `node:fs` non compaiono in nessun file creato dal Piano B in `src/`. Verifica: `grep -ln "node:fs\|writeFile\|appendFile" src/main/reply-*.ts src/main/utils/reply-*.ts src/main/utils/variant-filter.ts src/main/utils/number-words.ts src/main/utils/overlay-bounds.ts` non stampa nulla. I tool in `tools/` stampano solo su stdout.
13. **Nessuna lettura senza gesto**: `AxContextReader.read` è chiamato solo dentro `ReplyCoordinator.onHotkey()`. Nessun timer, listener di focus o polling lo invoca (il keepalive del server pinga il modello, non lo schermo).
14. **Controllo dell'app prima della raccolta**: dopo il Task 6 non esiste più un percorso che raccolga frammenti senza aver superato il filtro: `read(filter)` richiede il filtro, e il coordinatore lo passa sempre dalle preferenze `replyAppsMode`/`replyApps`.
15. **Budget**: il coordinatore chiama `parse` con `tailBudgetChars: 2500`; il generatore usa `max_tokens: 320`; il classificatore `max_tokens: 64`; `contextSize` del server di risposta `3072`.
16. **Il testo generato non tocca il disco**: la clipboard viene scritta solo all'accettazione (e ripristinata da `TextInjector` salvo la degradazione L3, dove resta di proposito con la pill che lo dice).

**Modello e server**

17. Il classificatore e il generatore inviano **solo** a `/v1/chat/completions` del server di risposta con **un solo messaggio di ruolo `user`** (mai `system`), `chat_template_kwargs: { enable_thinking: false }`, `cache_prompt: true`, `stream: false`. Il generatore usa esattamente `temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0, repeat_penalty: 1.0, max_tokens: 320`; il classificatore `temperature: 0, max_tokens: 64`. I test con `fetchImpl` finto asseriscono ogni campo del body con `toEqual` su un oggetto letterale.
18. Il server di risposta è un secondo `LLMServer` (classe esistente, non modificata) su porta **18082** con `contextSize 3072`, `keepaliveMs 20000`, `startupTimeoutMs 90000`, `warmupPrompt` = `GENERATOR_PREFIX` esportato dal generatore. Nessun processo `llama-server` sulla 18082 a feature spenta. Verifica manuale: `lsof -iTCP:18082 -sTCP:LISTEN` vuoto con `replySuggestionsEnabled: false`.
19. I due GGUF di catalogo sono **gli stessi del benchmark**, identificati per byte e sha256 (Task 2). Nessun modello Qwen entra in `REPLY_MODELS`.

**Commit**

20. Un commit per task, Conventional Commits con scope (`feat(reply): …`, `test(reply): …`, `feat(overlay): …`, `feat(prefs): …`), corpo che spiega il *perché*, e come **ultima riga esattamente**:
    ```
    Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
    ```
    **Nessuna riga `Claude-Session`.**

---

## Deviazioni dichiarate rispetto alla spec

1. **Dimensione del GGUF Gemma 3 4B.** La spec riporta "2,67 GB". Il file usato nel benchmark (scratch `gemma3-4b.gguf`) pesa **2 489 894 016 byte** (2,49 GB) e ha sha256 `04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19`: coincide byte per byte con `unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf`. Il catalogo porta il file del benchmark (spec: "gli stessi usati nel benchmark") e la cifra corretta; la stima di RAM residente scende a ~3,1 GB. Gemma 4 E4B coincide con la spec: **4 977 171 584 byte** (4,98 GB), `unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf`, sha256 `85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87`.
2. **Gate dei bundle id in due stadi.** L'addon confronta case-sensitive e non si tocca. `AxContextReader.read(filter)` chiama il nativo **due volte**: prima con `{ mode: "allowlist", bundleIds: [] }` — che il nativo rifiuta sempre con `app-not-allowed` **prima di qualunque raccolta**, restituendo però `pid` e `bundleId` — poi, se il wrapper decide case-insensitive che l'app è permessa, con `{ mode: "allowlist", bundleIds: [<bundleId esatto restituito dal primo stadio>] }`. Costo: una `AXUIElementCopyElementAtPosition` in più (28-49 ms misurati). Resta fail-closed in entrambe le modalità (in `blocklist` un id con maiuscole diverse non passa più) e la raccolta parte solo se l'app è permessa (spec, privacy 4).
3. **"Aggiungi l'ultima app rifiutata" al posto di "aggiungi l'app in primo piano".** L'addon non espone il bundle id del frontmost (solo il pid) e `native/` è fuori ambito. Il coordinatore ricorda il `bundleId` dell'ultima astensione `app-not-allowed` (non è contenuto: è già ammesso nei log) e la preferences window offre "Aggiungi <bundleId>" — che è anche il flusso naturale dopo il flash "App non abilitata".
4. **Regola "prima persona" resa deterministica.** La spec chiede "almeno un indicatore di prima persona o l'assenza di seconda persona imperativa dominante"; qui diventa la regola misurata dello spike: scarto se la variante inizia con un imperativo copiato dalle istruzioni (`verifichi|puoi|non puoi|fai sapere|scegli|rispondi in senso`) o contiene `nello spirito di`. È ciò che il benchmark ha rilevato; il criterio "verbi in -o" non è formalizzabile senza falsi positivi.
5. **Jaccard senza stopword, soglie da ritarare.** La spec prescrive insiemi "senza stopword"; il benchmark misurava 0,6 / 0,75 **con** le stopword. Il piano segue la spec (lista di stopword esplicita nel Task 4) e le soglie restano 0,6 / 0,75 come punto di partenza; il Task 10 misura la distribuzione degli scarti e riporta se vanno spostate. Dichiarato in §Rischi aperti.
6. **Stati dell'overlay sul canale esistente.** I nuovi stati `reading`, `thinking`, `suggesting`, `nothing`, `flash` viaggiano su `pipeline:state-change` (stringa), come gli stati di dettatura; il payload delle proposte su `reply:suggestions`, il testo dei flash su `reply:flash`. La spec elenca solo `reply:suggestions`, `reply:choose`, `reply:dismiss`; qui si aggiungono `reply:flash` (main → overlay, testo neutro del flash L2/L3) e `reply:hover` (overlay → main, azzera il timer di auto-chiusura come richiede la spec §7).
7. **Il generatore riceve il gist nel prompt** come `«{lastMessage}»` (lo faceva lo spike S3: "X gli ha scritto: «…»") — è l'ultimo messaggio, già nella trascrizione; non un'informazione in più.

Estensioni compatibili: `Classification.alternatives` è nel JSON di risposta come array sempre presente (0 o 2 elementi) perché la grammatica lo richiede stabile; il TS lo mappa a `undefined` quando vuoto. Il coordinatore espone `lastBlockedBundleId()` per la deviazione 3.

---

## File Structure

| File | Ruolo | Task |
|---|---|---|
| `src/main/reply-chat-client.ts` | POST a `/v1/chat/completions` con `fetchImpl` iniettabile, parsing del `content`, `ReplyLLMError` senza corpo | 1 |
| `src/main/reply-classifier.ts` | Prompt, schema JSON, `classify()`, degradazione `alternative`→`generic` | 1 |
| `test/fixtures/conversations/classifier-corpus.ts` | 16 casi annotati a mano (8 rispondibili, 8 solo-informazione) a livello di trascrizione | 1 |
| `tools/reply-classifier-bench.ts` | **L'esperimento**: accuratezza, falsi positivi, latenza del classificatore sul corpus (tsx, server avviato dal tool) | 1 |
| `src/main/preferences-store.ts` | 5 chiavi nuove | 2 |
| `src/main/model-catalog.ts` | `REPLY_MODELS`, `REPLY_TIERS`, `getModelById("reply", …)`, `getReplyTier` | 2 |
| `src/main/utils/reply-hotkey.ts` | `validateReplyAccelerator` | 2 |
| `src/shared/reply-types.ts` | `SuggestionPayload`, `ReplyOverlayState`, `ReplyServerState` | 2 |
| `src/main/utils/reply-positions.ts` | I tre set, etichette, istruzioni di voce, schema del generatore | 3 |
| `src/main/reply-generator.ts` | `GENERATOR_PREFIX`, prompt, `generate()` | 3 |
| `src/main/utils/number-words.ts` | Numerali in lettere it/en → valore | 4 |
| `src/main/utils/variant-filter.ts` | Le dieci regole, `filterVariants()` | 4 |
| `src/main/reply-server-manager.ts` | Ciclo di vita del secondo `LLMServer`, download, stati | 5 |
| `src/main/ax-context-reader.ts` | `read(filter)` obbligatorio, gate in due stadi | 6 |
| `src/main/utils/overlay-bounds.ts` | `computeOverlayBounds(displays, cursor, size)` | 7 |
| `src/main/overlay-window.ts`, `src/renderer/overlay.*`, `src/preload/overlay-preload.ts`, `src/shared/ipc-channels.ts` | Stato `suggesting`, flash, posizionamento a ogni `show()` | 7 |
| `src/main/reply-coordinator.ts` | Orchestrazione, guardie, scorciatoie temporanee, accettazione | 8 |
| `src/main/index.ts`, `src/main/preferences-window.ts`, `src/renderer/preferences.*`, `src/preload/preferences-preload.ts`, `README.md`, `docs/electron-smoke-checklist.md` | Wiring e UI | 9 |
| `test/integration/reply-pipeline.test.ts`, `tools/reply-pipeline-bench.ts`, `package.json` | Strato 2 e 3 della strategia di test | 10 |

**Ordine e dipendenze:**

```
Task 1 (classificatore + ESPERIMENTO) ──▶ Task 3 (posizioni + generatore) ──┐
Task 2 (prefs, catalogo, hotkey, tipi) ──▶ Task 5 (server manager) ──────────┤
Task 4 (number-words + variant-filter) ─────────────────────────────────────┼──▶ Task 8 (coordinatore) ──▶ Task 9 (wiring + UI) ──▶ Task 10 (integrazione + lettura)
Task 6 (reader: filtro obbligatorio) ───────────────────────────────────────┤
Task 7 (overlay-bounds + pill) ─────────────────────────────────────────────┘
```

- Task 1 non dipende da nulla ed è **il primo da eseguire**: il suo esito può cambiare il Task 8 (vedi il paragrafo "Esito e conseguenze" del Task 1).
- Task 2 e Task 4 non dipendono da nulla. Task 6 e Task 7 non dipendono da nulla (Task 7 importa i tipi del Task 2 solo per `SuggestionPayload`: eseguire 2 prima di 7).
- Task 3 dipende da 1 (client) e 2 (tipi). Task 5 dipende da 2. Task 8 dipende da 1-7. Task 9 da 8. Task 10 da 9.

---

## Task 1: `ReplyChatClient`, `ReplyClassifier` e l'esperimento sul classificatore

**Obiettivo:** costruire la chiamata classificatoria a output vincolato e **misurarla** sul corpus: accuratezza su `answerable`, tasso di falsi positivi sui casi "informazione che solo l'utente possiede", accuratezza su `kind`, latenza p50. L'esito decide se la feature è rilasciabile com'è o con la mitigazione deterministica.

**Dipende da:** nessun task.

**Files:**
- Create: `src/main/reply-chat-client.ts`
- Create: `src/main/reply-classifier.ts`
- Create: `test/fixtures/conversations/classifier-corpus.ts`
- Create: `test/unit/reply-chat-client.test.ts`
- Create: `test/unit/reply-classifier.test.ts`
- Create: `tools/reply-classifier-bench.ts`

- [ ] **Step 1: Test del client che falliscono**

Crea `test/unit/reply-chat-client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ReplyChatClient, ReplyLLMError } from "../../src/main/reply-chat-client.js";

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const ok = (content: string) => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { completion_tokens: 7, prompt_tokens: 100 } });

describe("ReplyChatClient.completeJson", () => {
  it("posts one user message to /v1/chat/completions with thinking off, cache on, stream off", async () => {
    const fetchImpl = fetchReturning(200, ok('{"a":1}'));
    const c = new ReplyChatClient({ endpoint: "http://127.0.0.1:18082", fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.completeJson({ prompt: "PROMPT", schema: { type: "object" }, sampling: { temperature: 0 }, maxTokens: 64, timeoutMs: 5000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!; // called once, asserted above
    expect(url).toBe("http://127.0.0.1:18082/v1/chat/completions");
    expect(JSON.parse(init!.body as string)).toEqual({
      messages: [{ role: "user", content: "PROMPT" }],
      max_tokens: 64,
      stream: false,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } },
      temperature: 0,
    });
  });

  it("never sends a system message", async () => {
    const fetchImpl = fetchReturning(200, ok("{}"));
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { messages: Array<{ role: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("returns the parsed JSON, the raw content length, the token count and the duration", async () => {
    const fetchImpl = fetchReturning(200, ok('{"answerable":true}'));
    const clock = [1000, 1250];
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock.shift() ?? 1250 });
    const r = await c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    expect(r).toEqual({ json: { answerable: true }, contentChars: 19, completionTokens: 7, durationMs: 250 });
  });

  it("throws ReplyLLMError 'reply LLM HTTP <status>' on non-2xx without reading the body into the message", async () => {
    const fetchImpl = fetchReturning(500, "SECRET-BODY-TEXT");
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    await expect(p).rejects.toBeInstanceOf(ReplyLLMError);
    await expect(p).rejects.toThrow("reply LLM HTTP 500");
    await expect(p).rejects.not.toThrow("SECRET");
  });

  it("throws 'reply LLM invalid JSON' when content is not JSON, without quoting the content", async () => {
    const fetchImpl = fetchReturning(200, ok("ZQXV-VARIANT-TEXT not json"));
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    await expect(p).rejects.toThrow("reply LLM invalid JSON");
    await expect(p).rejects.not.toThrow("ZQXV");
  });

  it("throws 'reply LLM empty content' when the model returned nothing (thinking swallowed the budget)", async () => {
    const fetchImpl = fetchReturning(200, { choices: [{ message: { content: "", reasoning_content: "thinking…" } }] });
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 })).rejects.toThrow("reply LLM empty content");
  });

  it("wraps a network failure as 'reply LLM request failed: <ErrorName>' with no other detail", async () => {
    const fetchImpl = vi.fn(async () => { const e = new Error("connect ECONNREFUSED 127.0.0.1:18082"); e.name = "TypeError"; throw e; });
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    await expect(p).rejects.toThrow("reply LLM request failed: TypeError");
    await expect(p).rejects.not.toThrow("ECONNREFUSED");
  });

  it("passes the timeout as an AbortSignal", async () => {
    const fetchImpl = fetchReturning(200, ok("{}"));
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1234 });
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
});
```

Run: `npx vitest run test/unit/reply-chat-client.test.ts` — Expected: FAIL, `Cannot find module '../../src/main/reply-chat-client.js'`.

- [ ] **Step 2: Scrivi `src/main/reply-chat-client.ts`**

```typescript
/**
 * The one HTTP path of the reply-suggestions feature: a single-turn chat
 * completion with a JSON schema, against the reply llama-server.
 *
 * Privacy (spec §Privacy 7): errors carry status code and error type ONLY.
 * The response body would contain generated text, so it is never read into a
 * message and never logged. This is stricter than LLMError in llm-cleaner.ts.
 *
 * Gemma has no `system` role: the caller puts the instructions in the single
 * user message. Thinking is turned off explicitly: on the benchmarked GGUFs
 * it is on by default and eats the whole token budget (spec §Spike 3).
 */
export interface ReplyChatClientOptions {
  /** e.g. http://127.0.0.1:18082 */
  endpoint: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
}

export interface CompleteJsonInput {
  prompt: string;
  /** JSON schema passed to llama-server, which turns it into a grammar. */
  schema: Record<string, unknown>;
  sampling: SamplingParams;
  maxTokens: number;
  timeoutMs: number;
}

export interface CompleteJsonResult {
  json: unknown;
  /** Length of the raw content — a count, safe to log. */
  contentChars: number;
  completionTokens: number;
  durationMs: number;
}

export class ReplyLLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyLLMError";
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { completion_tokens?: number };
}

export class ReplyChatClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: ReplyChatClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async completeJson(input: CompleteJsonInput): Promise<CompleteJsonResult> {
    const t0 = this.now();
    const body = {
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: input.maxTokens,
      stream: false,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { schema: input.schema } },
      ...input.sampling,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      throw new ReplyLLMError(`reply LLM request failed: ${name}`);
    }
    if (!res.ok) throw new ReplyLLMError(`reply LLM HTTP ${res.status}`);
    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new ReplyLLMError("reply LLM invalid JSON");
    }
    const content = data.choices?.[0]?.message?.content ?? "";
    if (content.trim().length === 0) throw new ReplyLLMError("reply LLM empty content");
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new ReplyLLMError("reply LLM invalid JSON");
    }
    return {
      json,
      contentChars: content.length,
      completionTokens: data.usage?.completion_tokens ?? 0,
      durationMs: this.now() - t0,
    };
  }
}
```

Run: `npx vitest run test/unit/reply-chat-client.test.ts` — Expected: PASS (8 test).

**Prova di rottura (vincolo 7):** cambia `chat_template_kwargs: { enable_thinking: false }` in `{ enable_thinking: true }` → il primo test deve fallire; rimuovi la riga `if (!res.ok) throw …` → il test HTTP 500 deve fallire. Ripristina e riporta.

- [ ] **Step 3: Fixture del corpus del classificatore**

Crea `test/fixtures/conversations/classifier-corpus.ts`. I casi sono a livello di **trascrizione** (l'output del parser), perché il classificatore non vede i frammenti AX. Nomi e dati di fantasia.

```typescript
/**
 * Hand-annotated cases for the reply classifier (Plan B, Task 1). Each case
 * is what ConversationParser hands to the classifier. `answerable` is the
 * ground truth for "can be answered with a decision" (spec §Out: questions
 * asking for information only the user has are NOT answerable). Fictional
 * names and figures throughout.
 */
export interface ClassifierCase {
  readonly id: string;
  readonly counterpart: string;
  readonly lastMessage: string;
  readonly transcript: string;
  readonly expected: {
    readonly answerable: boolean;
    readonly kind?: "generic" | "alternative" | "offer";
    readonly language: "it" | "en";
  };
}

const T = (counterpart: string, lastMessage: string, prior: string[] = []): Pick<ClassifierCase, "counterpart" | "lastMessage" | "transcript"> => ({
  counterpart,
  lastMessage,
  transcript: [...prior, `INTERLOCUTORE (${counterpart}): ${lastMessage}`].join("\n"),
});

export const CLASSIFIER_CASES: readonly ClassifierCase[] = [
  // ── rispondibili con una decisione ──
  { id: "ans-review-generic", ...T("Marta", "ciao, la PR sul login è ferma da due giorni, la review la fai tu? venerdì rilasciamo"), expected: { answerable: true, kind: "generic", language: "it" } },
  { id: "ans-help-generic", ...T("Fulvio", "raga il build di staging è rotto da stamattina, errore sul lockfile. qualcuno ci ha già messo mano?"), expected: { answerable: true, kind: "generic", language: "it" } },
  { id: "ans-meeting-generic", ...T("Luca", "ti va di fare un punto domani mattina sul rilascio? mezz'ora al massimo"), expected: { answerable: true, kind: "generic", language: "it" } },
  { id: "ans-day-alternative", ...T("Giulia Rossi", "Riusciamo a spostare il sopralluogo a venerdì stessa ora, o preferisce la settimana prossima?", ["INTERLOCUTORE (Giulia Rossi): Buongiorno, confermo il sopralluogo per giovedì alle 9."]), expected: { answerable: true, kind: "alternative", language: "it" } },
  { id: "ans-who-alternative", ...T("Marta", "la review del login la fai tu o la giro a Paolo? te lo chiedo perché venerdì rilasciamo"), expected: { answerable: true, kind: "alternative", language: "it" } },
  { id: "ans-en-alternative", ...T("Helen Carter", "Would you prefer the call on Tuesday afternoon or Wednesday morning?"), expected: { answerable: true, kind: "alternative", language: "en" } },
  { id: "ans-quote-offer", ...T("Francesca Bianchi", "Buongiorno, le invio il preventivo aggiornato per la revisione dell'impianto del secondo piano. Il totale è 4.850 euro IVA esclusa, inizio lavori entro tre settimane dall'accettazione. Resto a disposizione."), expected: { answerable: true, kind: "offer", language: "it" } },
  { id: "ans-en-offer", ...T("Helen Carter", "We can offer the annual plan at 1,200 GBP with onboarding included. Shall we go ahead with that proposal?"), expected: { answerable: true, kind: "offer", language: "en" } },
  // ── NON rispondibili: chiedono un'informazione che solo l'utente possiede ──
  { id: "info-time", ...T("Marta", "a che ora arrivi domani in ufficio? devo prenotare la sala"), expected: { answerable: false, language: "it" } },
  { id: "info-number", ...T("Fulvio", "mi mandi il numero della pratica che hai aperto con il fornitore?"), expected: { answerable: false, language: "it" } },
  { id: "info-opinion", ...T("Luca", "che ne pensi dell'architettura a eventi per il nuovo servizio? vorrei il tuo parere tecnico"), expected: { answerable: false, language: "it" } },
  { id: "info-name", ...T("Giulia Rossi", "Mi ricorda il nome dell'elettricista che aveva fatto il primo intervento?"), expected: { answerable: false, language: "it" } },
  { id: "info-howmany", ...T("Assistant Coach", "quante volte a settimana riesci ad andare in palestra e hai già esperienza con i bilancieri?"), expected: { answerable: false, language: "it" } },
  { id: "info-where", ...T("Matteo", "dove hai messo il file con le misure del quadro? non lo trovo nella cartella condivisa"), expected: { answerable: false, language: "it" } },
  { id: "info-en-when", ...T("Helen Carter", "Could you tell me when you sent the payment and from which account? Our records show nothing yet."), expected: { answerable: false, language: "en" } },
  { id: "info-en-status", ...T("Helen Carter", "What is the current status of the migration on your side? We need the details for the report."), expected: { answerable: false, language: "en" } },
];
```

Nota: il caso `info-howmany` è la domanda dell'assistente del corpus dello spike, qui attribuita a una persona: il parser la fermerebbe con `assistant-speaker`, ma il classificatore deve saperla rifiutare **da solo**, perché la stessa domanda posta da un collega passa i cancelli.

- [ ] **Step 4: Test del classificatore che falliscono**

Crea `test/unit/reply-classifier.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ReplyClassifier, CLASSIFIER_SCHEMA, buildClassifierPrompt, CLASSIFIER_PREFIX } from "../../src/main/reply-classifier.js";
import { ReplyChatClient } from "../../src/main/reply-chat-client.js";
import { CASES, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";

function clientReturning(content: string) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 12 } }), { status: 200 }));
  return { client: new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

const INPUT = { transcript: "INTERLOCUTORE (Marta): la review la fai tu o la giro a Paolo?", lastMessage: "la review la fai tu o la giro a Paolo?", counterpart: "Marta" };

describe("CLASSIFIER_SCHEMA", () => {
  it("fixes the four keys, the enum of kind, the two-string alternatives and the language enum", () => {
    expect(CLASSIFIER_SCHEMA).toEqual({
      type: "object",
      properties: {
        answerable: { type: "boolean" },
        kind: { type: "string", enum: ["generic", "alternative", "offer"] },
        alternatives: { type: "array", items: { type: "string", maxLength: 40 }, minItems: 0, maxItems: 2 },
        language: { type: "string", enum: ["it", "en", "other"] },
      },
      required: ["answerable", "kind", "alternatives", "language"],
      additionalProperties: false,
    });
  });
});

describe("buildClassifierPrompt", () => {
  it("starts with the fixed prefix (for the KV cache) and ends with the transcript", () => {
    const p = buildClassifierPrompt(INPUT);
    expect(p.startsWith(CLASSIFIER_PREFIX)).toBe(true);
    expect(p.endsWith(`${INPUT.transcript}\n</trascrizione>`)).toBe(true);
    expect(p).toContain("Marta");
  });
  it("describes the schema in words: the model cannot see it", () => {
    const p = buildClassifierPrompt(INPUT);
    for (const w of ['"answerable"', '"kind"', '"alternatives"', '"language"', "generic", "alternative", "offer"]) expect(p).toContain(w);
  });
});

describe("ReplyClassifier.classify", () => {
  it("sends temperature 0, max_tokens 64 and the classifier schema", async () => {
    const { client, fetchImpl } = clientReturning('{"answerable":true,"kind":"generic","alternatives":[],"language":"it"}');
    await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(64);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { schema: CLASSIFIER_SCHEMA } });
    expect(Object.keys(body).sort()).toEqual(["cache_prompt", "chat_template_kwargs", "max_tokens", "messages", "response_format", "stream", "temperature"]);
  });

  it("returns the classification with alternatives when kind is alternative and two are present", async () => {
    const { client } = clientReturning('{"answerable":true,"kind":"alternative","alternatives":["la faccio io","la giro a Paolo"],"language":"it"}');
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r).toEqual({ ok: true, classification: { answerable: true, kind: "alternative", alternatives: ["la faccio io", "la giro a Paolo"], language: "it" }, durationMs: expect.any(Number) });
  });

  it("degrades kind alternative to generic when fewer than two non-empty alternatives come back", async () => {
    for (const alts of ["[]", '["solo una"]', '["", "x"]']) {
      const { client } = clientReturning(`{"answerable":true,"kind":"alternative","alternatives":${alts},"language":"it"}`);
      const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
      expect(r.ok && r.classification.kind, alts).toBe("generic");
      expect(r.ok && r.classification.alternatives, alts).toBeUndefined();
    }
  });

  it("drops alternatives when kind is not alternative", async () => {
    const { client } = clientReturning('{"answerable":true,"kind":"generic","alternatives":["a","b"],"language":"en"}');
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r.ok && r.classification.alternatives).toBeUndefined();
  });

  it("returns ok:false reason not-answerable when the model says so", async () => {
    const { client } = clientReturning('{"answerable":false,"kind":"generic","alternatives":[],"language":"it"}');
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r).toEqual({ ok: false, reason: "not-answerable", durationMs: expect.any(Number) });
  });

  it("returns ok:false reason invalid-classification when the JSON has the wrong shape (grammar bypassed)", async () => {
    const { client } = clientReturning('{"answerable":"yes"}');
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r).toEqual({ ok: false, reason: "invalid-classification", durationMs: expect.any(Number) });
  });

  it("propagates ReplyLLMError as ok:false reason llm-error with the error message as code", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 503 }));
    const client = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r).toEqual({ ok: false, reason: "llm-error", error: "reply LLM HTTP 503", durationMs: expect.any(Number) });
  });

  it("logs metrics only: never the transcript, the last message or the counterpart", async () => {
    const slack = CASES[0]!; // slack-decisione
    const { client } = clientReturning('{"answerable":true,"kind":"alternative","alternatives":["tu","Paolo"],"language":"it"}');
    const seen: string[] = [];
    const logger = { info: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
                     warn: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }) };
    await new ReplyClassifier({ client, timeoutMs: 5000, logger }).classify({
      transcript: `INTERLOCUTORE (Marta): ${slack.ax}`, lastMessage: slack.ax, counterpart: "Marta",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) expect(leaksScreenText(line, slack.ax), line).toBe(false);
  });
});
```

Run: `npx vitest run test/unit/reply-classifier.test.ts` — Expected: FAIL, modulo non trovato.

- [ ] **Step 5: Scrivi `src/main/reply-classifier.ts`**

```typescript
import { ReplyChatClient, ReplyLLMError } from "./reply-chat-client.js";
import type { Logger } from "./logger.js";

export interface ClassifyInput { transcript: string; lastMessage: string; counterpart: string }

export interface Classification {
  answerable: boolean;
  kind: "generic" | "alternative" | "offer";
  /** Only for kind = alternative, exactly two non-empty strings. */
  alternatives?: [string, string];
  language: "it" | "en" | "other";
}

export type ClassifyResult =
  | { ok: true; classification: Classification; durationMs: number }
  | { ok: false; reason: "not-answerable" | "invalid-classification"; durationMs: number }
  | { ok: false; reason: "llm-error"; error: string; durationMs: number };

/** The grammar llama-server derives from this fixes keys, enum values and the
 *  0-or-2 alternatives. `alternatives` is always present (possibly empty) so
 *  the grammar has one shape; classify() maps [] to undefined. */
export const CLASSIFIER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answerable: { type: "boolean" },
    kind: { type: "string", enum: ["generic", "alternative", "offer"] },
    alternatives: { type: "array", items: { type: "string", maxLength: 40 }, minItems: 0, maxItems: 2 },
    language: { type: "string", enum: ["it", "en", "other"] },
  },
  required: ["answerable", "kind", "alternatives", "language"],
  additionalProperties: false,
};

/** Fixed instruction prefix, identical across calls so llama-server keeps it
 *  in the KV cache (cache_prompt). Gemma has no system role: this IS the
 *  start of the single user turn. The schema is described in words because
 *  the model never sees it (spec §4). */
export const CLASSIFIER_PREFIX = `Sei un classificatore. Leggi una conversazione e decidi se all'ULTIMO messaggio dell'INTERLOCUTORE si può rispondere con una DECISIONE, cioè scegliendo fra: accettare, rifiutare, rimandare, oppure scegliere fra opzioni esplicite proposte nel messaggio.

NON è rispondibile con una decisione se la risposta richiede un'informazione che solo il destinatario conosce: orari, date, luoghi, numeri, nomi, dati, stato di un lavoro, opinioni o pareri tecnici. In quel caso "answerable" è false.

Rispondi SOLO con un oggetto JSON con esattamente queste chiavi:
- "answerable": true oppure false.
- "kind": "offer" se il messaggio propone un preventivo, un'offerta, un prezzo o una proposta commerciale da accettare o rifiutare; "alternative" se il messaggio chiede di scegliere fra due opzioni esplicite ("X o Y?"); altrimenti "generic".
- "alternatives": se "kind" è "alternative", le due opzioni così come compaiono nel messaggio, brevi (al massimo 40 caratteri ciascuna), nell'ordine in cui compaiono; altrimenti una lista vuota.
- "language": "it" se la conversazione è in italiano, "en" se in inglese, "other" altrimenti.

Non aggiungere altre chiavi, commenti o testo.`;

export function buildClassifierPrompt(input: ClassifyInput): string {
  return `${CLASSIFIER_PREFIX}

L'interlocutore si chiama ${input.counterpart}. Le righe "TU" sono del destinatario, le righe "INTERLOCUTORE" sono sue. Classifica l'ultima riga INTERLOCUTORE.

<trascrizione>
${input.transcript}
</trascrizione>`;
}

export interface ReplyClassifierOptions {
  client: ReplyChatClient;
  timeoutMs: number;
  logger?: Pick<Logger, "info" | "warn">;
}

const KINDS = new Set(["generic", "alternative", "offer"]);
const LANGS = new Set(["it", "en", "other"]);

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

/** Validates the parsed JSON against the shape the grammar should have
 *  enforced. Returns null when the shape is wrong: it should not happen with
 *  the grammar, so the caller logs it as an anomaly (spec §4). */
export function toClassification(json: unknown): Classification | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.answerable !== "boolean") return null;
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return null;
  if (typeof o.language !== "string" || !LANGS.has(o.language)) return null;
  const kind = o.kind as Classification["kind"];
  const language = o.language as Classification["language"];
  const alts = Array.isArray(o.alternatives) ? o.alternatives.filter(isNonEmptyString).map((s) => s.trim()) : [];
  if (kind === "alternative" && alts.length === 2) {
    return { answerable: o.answerable, kind, alternatives: [alts[0]!, alts[1]!], language }; // length checked
  }
  // "alternative" without two usable alternatives degrades to generic (spec §4).
  return { answerable: o.answerable, kind: kind === "alternative" ? "generic" : kind, language };
}

export class ReplyClassifier {
  constructor(private readonly opts: ReplyClassifierOptions) {}

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const t0 = Date.now();
    let json: unknown;
    let completionTokens = 0;
    try {
      const r = await this.opts.client.completeJson({
        prompt: buildClassifierPrompt(input),
        schema: CLASSIFIER_SCHEMA,
        sampling: { temperature: 0 },
        maxTokens: 64,
        timeoutMs: this.opts.timeoutMs,
      });
      json = r.json;
      completionTokens = r.completionTokens;
    } catch (err) {
      const error = err instanceof ReplyLLMError ? err.message : "reply LLM request failed: Error";
      const durationMs = Date.now() - t0;
      void this.opts.logger?.warn("reply classify failed", { error, durationMs, transcriptChars: input.transcript.length });
      return { ok: false, reason: "llm-error", error, durationMs };
    }
    const durationMs = Date.now() - t0;
    const c = toClassification(json);
    if (!c) {
      void this.opts.logger?.warn("reply classify anomaly: invalid shape despite grammar", { durationMs, completionTokens });
      return { ok: false, reason: "invalid-classification", durationMs };
    }
    void this.opts.logger?.info("reply classify", {
      answerable: c.answerable, kind: c.kind, language: c.language, hasAlternatives: c.alternatives !== undefined,
      durationMs, completionTokens, transcriptChars: input.transcript.length,
    });
    if (!c.answerable) return { ok: false, reason: "not-answerable", durationMs };
    return { ok: true, classification: c, durationMs };
  }
}
```

Run: `npx vitest run test/unit/reply-classifier.test.ts` — Expected: PASS.

**Prova di rottura:** in `toClassification` sostituisci `alts.length === 2` con `alts.length >= 1` → il test di degradazione deve fallire su `'["solo una"]'`; aggiungi `lastMessage: input.lastMessage` al meta di `"reply classify"` → il test privacy deve fallire. Ripristina e riporta.

- [ ] **Step 6: Il tool dell'esperimento `tools/reply-classifier-bench.ts`**

Gira con `tsx` (solo HTTP, nessun addon). Avvia da sé un `LLMServer` sul GGUF indicato, classifica ogni caso di `CLASSIFIER_CASES` e i 5 casi `reply` di `CASES` (passati da `parse()` con `USER_NAME` e budget 2500, attesa `answerable: true`, `kind` atteso: `slack-decisione` → alternative, `slack-richiesta-aiuto` → generic, `mail-preventivo` → offer, `mail-thread-lungo` → alternative, `mail-inglese` → generic), `--repeats` volte (default 2: a temperatura 0 due esecuzioni bastano a rilevare non-determinismo), e stampa:

```
modello: <path>   casi: 21   ripetizioni: 2
accuratezza answerable: N/M (P%)
falsi positivi su solo-informazione (answerable=true su casi info-*): N/8 (P%)
falsi negativi su rispondibili: N/13
accuratezza kind sui rispondibili classificati true: N/M
accuratezza language: N/M
latenza p50: X ms   p95: Y ms   completion_tokens p50: Z
non-determinismo fra ripetizioni: N casi
per caso: id | atteso | ottenuto (kind, alternatives, language) | ms
```

Opzioni (`node:util.parseArgs`): `--model <path>` (obbligatorio), `--server-bin <path>` (default `resources/bin/llama-server`), `--port` (default `18089`), `--repeats` (default `2`), `--context` (default `3072`). Usa `LLMServer` da `src/main/llm-server.js` con `warmupPrompt: CLASSIFIER_PREFIX`, `startupTimeoutMs: 120_000`, e `ReplyClassifier` con `timeoutMs: 20_000`. Stampa **solo su stdout**; il tool mostra i testi delle alternative restituite perché è uno strumento manuale, come `ax-context-probe`. Nessun logger. Ferma il server in `finally`.

Aggiungi in `package.json`, `scripts`, dopo `"ax-probe"`:

```json
    "reply-bench": "tsx tools/reply-classifier-bench.ts"
```

- [ ] **Step 7: Esegui l'esperimento su entrambi i tier**

Scarica i due GGUF del benchmark nella cartella dei modelli dell'app (sono quelli che il Task 2 mette in catalogo; il nome file deve coincidere):

```bash
M="$HOME/Library/Application Support/open-flow/models"; mkdir -p "$M"
curl -L -o "$M/gemma-3-4b-it-Q4_K_M.gguf" https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf
curl -L -o "$M/gemma-4-E4B-it-Q4_K_M.gguf" https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf
shasum -a 256 "$M/gemma-3-4b-it-Q4_K_M.gguf" "$M/gemma-4-E4B-it-Q4_K_M.gguf"
```

Expected: `04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19` e `85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87`. Poi:

```bash
npm run reply-bench -- --model "$HOME/Library/Application Support/open-flow/models/gemma-3-4b-it-Q4_K_M.gguf"
npm run reply-bench -- --model "$HOME/Library/Application Support/open-flow/models/gemma-4-E4B-it-Q4_K_M.gguf"
```

Il primo avvio verifica anche il prerequisito del bump: entrambi i GGUF devono caricarsi su `resources/bin/llama-server` v0.4.0 (health 200) e restituire `content` non vuoto (se `content` è vuoto con `finish_reason: "length"`, `enable_thinking: false` non è stato onorato: **fermarsi e riportare**, è un bloccante).

- [ ] **Step 8: Esito e conseguenze (decisione documentata)**

Soglie, dal §Strategia di test della spec e dal rischio 1:

| Metrica (tier default, Gemma 3 4B) | Rilasciabile | Mitigazione richiesta |
|---|---|---|
| falsi positivi su `info-*` | ≤ 1/8 | > 1/8 |
| accuratezza `answerable` complessiva | ≥ 90% | < 90% |
| accuratezza `kind` sui veri positivi | ≥ 80% | < 80% |
| latenza p50 | riportata (attesa: poche centinaia di ms su M5 Pro) | > 1500 ms → segnalare |

- Se **rilasciabile**: il Task 8 usa il classificatore come unico cancello di ambito.
- Se **mitigazione richiesta** sui falsi positivi: il Task 8 aggiunge, **prima** del classificatore, il pre-cancello deterministico `hasExplicitProposal(lastMessage)` con questa regex (dallo spike 3, `YES_NO` ∪ alternative ∪ `OFFER`): `/\b(puoi|riesci|te ne occupi|la fai|lo fai|ci pensi|confermi|va bene|d'accordo|ti va|possiamo|riusciamo|preferisci|preferisce|can you|could you|will you|would you|do you|are you|is it|shall we|preventivo|offerta|proposta|quotazione|quote|proposal|estimate)\b/iu` oppure la presenza di ` o ` / ` oppure ` / ` or ` in una frase con `?`. Chi passa il pre-cancello va al classificatore; chi non passa si astiene con `no-explicit-proposal`. Costa falsi negativi, e va dichiarato nel commit.
- Se il tier `max` ha risultati migliori del default, riportarlo: è materiale per la descrizione dei tier nelle preferenze (Task 2), non per cambiare il default (decisione dell'utente: Gemma 3 4B default per la RAM).

Riporta le due tabelle complete nel corpo del commit e nel messaggio di completamento, con la decisione presa (`RILASCIABILE` / `MITIGAZIONE`). **Il Task 8 legge questa decisione dal commit del Task 1.**

- [ ] **Step 9: Verifiche di vincolo, lint, typecheck, test, commit**

```bash
grep -n "res.text()" src/main/reply-chat-client.ts ; echo "exit=$?"     # atteso exit=1
grep -ln "from \"electron\"" src/main/reply-chat-client.ts src/main/reply-classifier.ts ; echo "exit=$?"   # atteso exit=1
npm run lint && npm run typecheck && npm run test
git add src/main/reply-chat-client.ts src/main/reply-classifier.ts test/fixtures/conversations/classifier-corpus.ts test/unit/reply-chat-client.test.ts test/unit/reply-classifier.test.ts tools/reply-classifier-bench.ts package.json
git commit -m "feat(reply): constrained-output classifier + client, with the scope experiment

<tabelle dell'esperimento per entrambi i tier, decisione RILASCIABILE/MITIGAZIONE>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** `ReplyChatClient.completeJson` con il body esatto del test; `ReplyLLMError` senza corpo HTTP; `CLASSIFIER_SCHEMA` identico al letterale del test; `ReplyClassifier.classify` con i quattro esiti; fixture di 16 casi (8 `answerable: true`, 8 `false`); tool eseguito su entrambi i GGUF con tabelle e decisione nel commit; prove di rottura riportate; lint/typecheck/test verdi (≥ 293 + nuovi).

---

## Task 2: Preferenze, catalogo modelli e tier, validazione della hotkey, tipi condivisi

**Obiettivo:** aggiungere le cinque preferenze nuove con i default della spec, i due modelli di risposta del benchmark e i due tier, il validatore dell'acceleratore ("niente Option"), e i tipi condivisi fra main, preload e coordinatore.

**Dipende da:** nessun task.

**Files:**
- Modify: `src/main/preferences-store.ts`, `test/unit/preferences-store.test.ts`
- Modify: `src/main/model-catalog.ts`, `test/unit/model-catalog.test.ts`
- Create: `src/main/utils/reply-hotkey.ts`, `test/unit/reply-hotkey.test.ts`
- Create: `src/shared/reply-types.ts`

- [ ] **Step 1: Test che falliscono**

Append a `test/unit/preferences-store.test.ts` (dentro il `describe("PreferencesStore")`):

```typescript
  it("defaults the reply-suggestions preferences to off, Command+Control+R, gemma-3-4b, allowlist with the three verified apps", () => {
    expect(DEFAULT_PREFS.replySuggestionsEnabled).toBe(false);
    expect(DEFAULT_PREFS.replySuggestionsHotkey).toBe("Command+Control+R");
    expect(DEFAULT_PREFS.replyModelId).toBe("gemma-3-4b");
    expect(DEFAULT_PREFS.replyAppsMode).toBe("allowlist");
    expect(DEFAULT_PREFS.replyApps).toEqual(["com.tinyspeck.slackmacgap", "com.apple.mail", "com.brave.Browser"]);
  });

  it("loads an old preferences file with the feature OFF and the defaults filled in", async () => {
    const path = join(dir, "prefs.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ setupComplete: true, userDisplayName: "Danilo" }));
    const prefs = await new PreferencesStore(path).load();
    expect(prefs.replySuggestionsEnabled).toBe(false);
    expect(prefs.replyApps).toHaveLength(3);
    expect(prefs.userDisplayName).toBe("Danilo");
  });
```

Append a `test/unit/model-catalog.test.ts` (aggiorna l'import con `REPLY_MODELS`, `REPLY_TIERS`, `getReplyTier`):

```typescript
describe("reply model catalog", () => {
  it("lists exactly the two benchmarked Gemma GGUFs, byte-exact", () => {
    expect(REPLY_MODELS.map((m) => [m.id, m.filename, m.sizeBytes, m.sha256])).toEqual([
      ["gemma-3-4b", "gemma-3-4b-it-Q4_K_M.gguf", 2_489_894_016, "04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19"],
      ["gemma-4-e4b", "gemma-4-E4B-it-Q4_K_M.gguf", 4_977_171_584, "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87"],
    ]);
    for (const m of REPLY_MODELS) expect(m.url).toBe(`https://huggingface.co/unsloth/${m.id === "gemma-3-4b" ? "gemma-3-4b-it-GGUF" : "gemma-4-E4B-it-GGUF"}/resolve/main/${m.filename}`);
  });

  it("has two tiers, default and max, resolving to existing reply models", () => {
    expect(REPLY_TIERS.map((t) => [t.id, t.replyModelId])).toEqual([["default", "gemma-3-4b"], ["max", "gemma-4-e4b"]]);
    const ids = new Set(REPLY_MODELS.map((m) => m.id));
    for (const t of REPLY_TIERS) expect(ids.has(t.replyModelId)).toBe(true);
  });

  it("has no duplicated model id across whisper, llm and reply lists", () => {
    const all = [...WHISPER_MODELS, ...LLM_MODELS, ...REPLY_MODELS].map((m) => m.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("getModelById supports kind reply; getReplyTier resolves by id", () => {
    expect(getModelById("reply", "gemma-4-e4b")?.sizeBytes).toBe(4_977_171_584);
    expect(getModelById("reply", "qwen-3b")).toBeUndefined();
    expect(getModelById("llm", "gemma-3-4b")).toBeUndefined();
    expect(getReplyTier("max")?.replyModelId).toBe("gemma-4-e4b");
    expect(getReplyTier("fast")).toBeUndefined();
  });

  it("keeps Qwen out of the reply catalog", () => {
    for (const m of REPLY_MODELS) expect(m.id.startsWith("qwen")).toBe(false);
  });
});
```

Crea `test/unit/reply-hotkey.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateReplyAccelerator, REPLY_HOTKEY_DEFAULT } from "../../src/main/utils/reply-hotkey.js";

describe("validateReplyAccelerator", () => {
  it("accepts the default and other Command/Control/Shift combinations", () => {
    expect(REPLY_HOTKEY_DEFAULT).toBe("Command+Control+R");
    for (const a of ["Command+Control+R", "Cmd+Ctrl+R", "CommandOrControl+Shift+R", "Control+Shift+F12", "Super+Control+Space"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: true, accelerator: a });
    }
  });
  it("rejects any accelerator containing Alt or Option, in any case", () => {
    for (const a of ["Alt+R", "Option+R", "Command+Alt+R", "command+option+r", "AltGr+R"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: false, reason: "contains-option" });
    }
  });
  it("rejects an accelerator without a modifier or without a key", () => {
    expect(validateReplyAccelerator("R")).toEqual({ ok: false, reason: "no-modifier" });
    expect(validateReplyAccelerator("Command+Control")).toEqual({ ok: false, reason: "no-key" });
    expect(validateReplyAccelerator("")).toEqual({ ok: false, reason: "no-key" });
    expect(validateReplyAccelerator("Command++R")).toEqual({ ok: false, reason: "no-key" });
  });
  it("rejects the bare digits 1-3 and Escape as the key: they are the pill's temporary shortcuts", () => {
    for (const a of ["Command+1", "Command+2", "Command+3", "Control+Escape"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: false, reason: "reserved-key" });
    }
  });
});
```

Run: `npx vitest run test/unit/preferences-store.test.ts test/unit/model-catalog.test.ts test/unit/reply-hotkey.test.ts` — Expected: FAIL (campi `undefined`, export mancanti, modulo `reply-hotkey.js` non trovato).

- [ ] **Step 2: Preferenze**

In `src/main/preferences-store.ts`, dopo `userDisplayName: string;`:

```typescript
  /** Reply suggestions (context → three proposed replies). Off by default:
   *  off means no second llama-server, no extra RAM, identical behaviour. */
  replySuggestionsEnabled: boolean;
  /** Electron accelerator. Must not contain Alt/Option: dictation holds
   *  Option through the native modifier monitor (utils/reply-hotkey.ts). */
  replySuggestionsHotkey: string;
  /** Id in REPLY_MODELS, chosen through REPLY_TIERS in the UI. */
  replyModelId: string;
  /** allowlist: read only the listed apps (default). blocklist: read all but them. */
  replyAppsMode: "allowlist" | "blocklist";
  /** Bundle ids. Compared case-insensitively by AxContextReader. */
  replyApps: string[];
```

e in `DEFAULT_PREFS`, dopo `userDisplayName: "",`:

```typescript
  replySuggestionsEnabled: false,
  replySuggestionsHotkey: "Command+Control+R",
  replyModelId: "gemma-3-4b",
  replyAppsMode: "allowlist",
  replyApps: ["com.tinyspeck.slackmacgap", "com.apple.mail", "com.brave.Browser"],
```

- [ ] **Step 3: Catalogo**

In `src/main/model-catalog.ts`, dopo `LLM_MODELS`:

```typescript
// Reply-suggestion models: the two Gemma GGUFs of the spec's benchmark,
// byte-exact. The "thinking on by default" finding (spec §Spike 3) was made on
// THESE files; a different GGUF of the same family may template differently.
export const REPLY_MODELS: readonly ModelDescriptor[] = [
  {
    id: "gemma-3-4b",
    filename: "gemma-3-4b-it-Q4_K_M.gguf",
    sizeBytes: 2_489_894_016,
    sha256: "04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19",
    url: "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf",
  },
  {
    id: "gemma-4-e4b",
    filename: "gemma-4-E4B-it-Q4_K_M.gguf",
    sizeBytes: 4_977_171_584,
    sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
    url: "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
  },
];

export interface ReplyTierDescriptor {
  id: "default" | "max";
  label: string;
  description: string;
  replyModelId: string;
}

export const REPLY_TIERS: readonly ReplyTierDescriptor[] = [
  {
    id: "default",
    label: "Standard (consigliato)",
    description: "Gemma 3 4B. 2,49 GB su disco, ~3,1 GB di RAM a feature accesa (stima). Buona qualità; può inventare un motivo nel rifiuto, che i filtri intercettano.",
    replyModelId: "gemma-3-4b",
  },
  {
    id: "max",
    label: "Qualità massima",
    description: "Gemma 4 E4B. 4,98 GB su disco, ~5,8 GB di RAM a feature accesa (stima). Il migliore alla lettura: prende posizione, ruoli corretti anche in inglese. Consigliato da 24 GB di RAM.",
    replyModelId: "gemma-4-e4b",
  },
];
```

Cambia `getModelById`:

```typescript
export function getModelById(kind: "whisper" | "llm" | "reply", id: string): ModelDescriptor | undefined {
  const list = kind === "whisper" ? WHISPER_MODELS : kind === "llm" ? LLM_MODELS : REPLY_MODELS;
  return list.find((m) => m.id === id);
}

export function getReplyTier(id: string): ReplyTierDescriptor | undefined {
  return REPLY_TIERS.find((t) => t.id === id);
}
```

- [ ] **Step 4: Validazione della hotkey — `src/main/utils/reply-hotkey.ts`**

```typescript
/**
 * Validates the reply-suggestions accelerator without touching Electron.
 * Option/Alt is forbidden: dictation is "Hold Option" through the native
 * modifier monitor, and Option inside a chord would fire `arm` on the PTT
 * (then a CHORD that cancels it, with a flicker of the recording pill).
 * Command+1/2/3 and Escape are the pill's temporary shortcuts (Task 8):
 * they cannot also be the trigger.
 */
export const REPLY_HOTKEY_DEFAULT = "Command+Control+R";

export type AcceleratorValidation =
  | { ok: true; accelerator: string }
  | { ok: false; reason: "contains-option" | "no-modifier" | "no-key" | "reserved-key" };

const MODIFIERS = new Set(["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "shift", "super", "meta"]);
const OPTION_LIKE = new Set(["alt", "option", "altgr"]);
const RESERVED_KEYS = new Set(["1", "2", "3", "escape", "esc"]);

export function validateReplyAccelerator(accelerator: string): AcceleratorValidation {
  const parts = accelerator.split("+").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) return { ok: false, reason: "no-key" };
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.some((p) => OPTION_LIKE.has(p))) return { ok: false, reason: "contains-option" };
  const keys = lower.filter((p) => !MODIFIERS.has(p));
  const modifiers = lower.filter((p) => MODIFIERS.has(p));
  if (keys.length !== 1) return { ok: false, reason: "no-key" };
  if (modifiers.length === 0) return { ok: false, reason: "no-modifier" };
  if (RESERVED_KEYS.has(keys[0]!)) return { ok: false, reason: "reserved-key" }; // keys.length === 1
  return { ok: true, accelerator };
}
```

Nota sull'ordine: `"Command+Control"` ha 0 chiavi → `no-key` (prima di `no-modifier`); `"R"` ha 1 chiave e 0 modificatori → `no-modifier`; `""` → `[""]` → `no-key`.

- [ ] **Step 5: Tipi condivisi — `src/shared/reply-types.ts`**

```typescript
/** Types shared by main (coordinator, overlay window), preload and renderer.
 *  No runtime code: this file is compiled by both tsconfig.main and
 *  tsconfig.preload. */

export interface SuggestionVariant {
  id: 1 | 2 | 3;
  /** Pill label of the position: "Accetto", "Declino", "Rimando", "Scelgo: …". */
  label: string;
  text: string;
}

export interface SuggestionPayload {
  /** "Rispondi a Marta: chi fa la review?" — deterministic, from the parser. */
  gist: string;
  /** 2 or 3 variants. */
  variants: SuggestionVariant[];
}

/** Overlay states added by the reply feature, sent on pipeline:state-change
 *  next to the dictation states. */
export type ReplyOverlayState = "reading" | "thinking" | "suggesting" | "nothing" | "flash";

export type ReplyServerState = "off" | "downloading" | "starting" | "ready" | "failed";
```

Run: `npx vitest run test/unit/preferences-store.test.ts test/unit/model-catalog.test.ts test/unit/reply-hotkey.test.ts` — Expected: PASS.

**Prova di rottura:** in `validateReplyAccelerator` svuota `OPTION_LIKE` → il test "rejects Alt/Option" fallisce; in `REPLY_MODELS` cambia una cifra del `sizeBytes` → il test byte-exact fallisce. Ripristina e riporta.

- [ ] **Step 6: Lint, typecheck, test, commit**

```bash
npm run lint && npm run typecheck && npm run test
git add src/main/preferences-store.ts test/unit/preferences-store.test.ts src/main/model-catalog.ts test/unit/model-catalog.test.ts src/main/utils/reply-hotkey.ts test/unit/reply-hotkey.test.ts src/shared/reply-types.ts
git commit -m "feat(prefs): reply-suggestions preferences, Gemma reply catalog and tiers, hotkey validation

Five new preference keys, off by default so existing users see no change.
REPLY_MODELS carries the two GGUFs of the benchmark byte-exact (the spec's
2.67 GB for Gemma 3 4B was a misreading: the benchmarked file is
2 489 894 016 bytes). The accelerator validator refuses Alt/Option
because dictation holds Option through the native modifier monitor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** i cinque default esatti; `REPLY_MODELS` e `REPLY_TIERS` come sopra; `getModelById("reply", …)`; `validateReplyAccelerator` con i quattro codici; `src/shared/reply-types.ts` compila in entrambi i tsconfig (`npm run typecheck` lo prova); prove di rottura riportate; lint/typecheck/test verdi.

---

## Task 3: `ReplyPositions` e `ReplyGenerator`

**Obiettivo:** i tre set di posizioni come dato (chiave JSON, etichetta per la pill, istruzione di voce per il prompt), lo schema del generatore con le tre chiavi del set, il prompt misurato nello spike 3, la chiamata con i parametri ufficiali Gemma.

**Dipende da:** Task 1 (`ReplyChatClient`), Task 2 (`src/shared/reply-types.ts`).

**Files:**
- Create: `src/main/utils/reply-positions.ts`, `test/unit/reply-positions.test.ts`
- Create: `src/main/reply-generator.ts`, `test/unit/reply-generator.test.ts`

- [ ] **Step 1: Test che falliscono**

Crea `test/unit/reply-positions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { positionsFor, generatorSchemaFor, POSITION_LABELS } from "../../src/main/utils/reply-positions.js";

describe("positionsFor", () => {
  it("generic: accept / decline / defer with Italian labels and no-reason decline", () => {
    const p = positionsFor({ kind: "generic", language: "it" });
    expect(p.map((x) => x.key)).toEqual(["accept", "decline", "defer"]);
    expect(p.map((x) => x.label)).toEqual(["Accetto", "Declino", "Rimando"]);
    expect(p[1]!.voice).toContain("senza inventare motivi"); // three positions by construction
  });
  it("alternative: first / second / defer, interpolating the alternatives in label and voice", () => {
    const p = positionsFor({ kind: "alternative", language: "it", alternatives: ["venerdì stessa ora", "la settimana prossima"] });
    expect(p.map((x) => x.key)).toEqual(["first", "second", "defer"]);
    expect(p[0]!.label).toBe("Scelgo: venerdì stessa ora");
    expect(p[1]!.label).toBe("Scelgo: la settimana prossima");
    expect(p[0]!.voice).toContain("venerdì stessa ora");
    expect(p[1]!.voice).toContain("la settimana prossima");
  });
  it("alternative without alternatives falls back to generic", () => {
    expect(positionsFor({ kind: "alternative", language: "it" }).map((x) => x.key)).toEqual(["accept", "decline", "defer"]);
  });
  it("offer: accept_offer / reject_offer / request_changes, speaking as the customer", () => {
    const p = positionsFor({ kind: "offer", language: "it" });
    expect(p.map((x) => x.key)).toEqual(["accept_offer", "reject_offer", "request_changes"]);
    expect(p.map((x) => x.label)).toEqual(["Accetto l'offerta", "Rifiuto", "Chiedo modifiche"]);
    expect(p[0]!.voice).toContain("cliente");
  });
  it("uses English labels when the conversation is English", () => {
    expect(positionsFor({ kind: "generic", language: "en" }).map((x) => x.label)).toEqual(["Accept", "Decline", "Defer"]);
    expect(positionsFor({ kind: "alternative", language: "en", alternatives: ["Tuesday", "Wednesday"] })[0]!.label).toBe("Choose: Tuesday");
    expect(POSITION_LABELS.en.request_changes).toBe("Request changes");
  });
  it("truncates a long alternative in the label to 40 chars with an ellipsis", () => {
    const long = "x".repeat(60);
    const p = positionsFor({ kind: "alternative", language: "it", alternatives: [long, "b"] });
    expect(p[0]!.label).toBe(`Scelgo: ${"x".repeat(39)}…`);
  });
});

describe("generatorSchemaFor", () => {
  it("fixes exactly the set's keys as required strings with maxLength 400 and no extra properties", () => {
    const p = positionsFor({ kind: "offer", language: "it" });
    expect(generatorSchemaFor(p)).toEqual({
      type: "object",
      properties: {
        accept_offer: { type: "string", maxLength: 400 },
        reject_offer: { type: "string", maxLength: 400 },
        request_changes: { type: "string", maxLength: 400 },
      },
      required: ["accept_offer", "reject_offer", "request_changes"],
      additionalProperties: false,
    });
  });
});
```

Crea `test/unit/reply-generator.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ReplyGenerator, buildGeneratorPrompt, GENERATOR_PREFIX, GEMMA_SAMPLING } from "../../src/main/reply-generator.js";
import { positionsFor } from "../../src/main/utils/reply-positions.js";
import { ReplyChatClient } from "../../src/main/reply-chat-client.js";
import { CASES, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";

function clientReturning(content: string) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 90 } }), { status: 200 }));
  return { client: new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

const INPUT = {
  transcript: "INTERLOCUTORE (Marta): la review la fai tu o la giro a Paolo?",
  lastMessage: "la review la fai tu o la giro a Paolo?",
  counterpart: "Marta",
  userDisplayName: "Danilo",
  subject: undefined,
  positions: positionsFor({ kind: "alternative", language: "it", alternatives: ["la fai tu", "la giro a Paolo"] }),
  language: "it" as const,
};

describe("GEMMA_SAMPLING", () => {
  it("is the official Gemma profile with repetition penalty off", () => {
    expect(GEMMA_SAMPLING).toEqual({ temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0, repeat_penalty: 1.0 });
  });
});

describe("buildGeneratorPrompt", () => {
  it("starts with the fixed prefix and contains roles, the last message, the positions and the transcript", () => {
    const p = buildGeneratorPrompt(INPUT);
    expect(p.startsWith(GENERATOR_PREFIX)).toBe(true);
    expect(p).toContain("Tu scrivi come Danilo");
    expect(p).toContain("indirizzato a Marta");
    expect(p).toContain("«la review la fai tu o la giro a Paolo?»");
    for (const key of ["first", "second", "defer"]) expect(p).toContain(`"${key}"`);
    expect(p.endsWith(`${INPUT.transcript}\n</trascrizione>`)).toBe(true);
  });
  it("adds the subject line when present and the language instruction", () => {
    expect(buildGeneratorPrompt({ ...INPUT, subject: "Sopralluogo" })).toContain("Oggetto: Sopralluogo");
    expect(buildGeneratorPrompt(INPUT)).toContain("Lingua: italiano");
    expect(buildGeneratorPrompt({ ...INPUT, language: "en" })).toContain("Lingua: inglese");
    expect(buildGeneratorPrompt({ ...INPUT, language: "other" })).toContain("Lingua: la stessa della trascrizione");
  });
  it("forbids the four measured failure modes in words", () => {
    const p = buildGeneratorPrompt(INPUT);
    for (const s of ["Non affermare MAI di aver già svolto un'azione", "Non inventare impegni, riunioni o motivi", "Nessuna cifra, data o nome", "Nessuna firma finale", "non copiarli e non copiare queste istruzioni"]) expect(p).toContain(s);
  });
});

describe("ReplyGenerator.generate", () => {
  it("sends the Gemma sampling, max_tokens 320 and a schema with exactly the set's keys", async () => {
    const { client, fetchImpl } = clientReturning('{"first":"La faccio io.","second":"Girala a Paolo.","defer":"Ti dico entro stasera."}');
    await new ReplyGenerator({ client, timeoutMs: 10_000 }).generate(INPUT);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0, repeat_penalty: 1.0, max_tokens: 320, stream: false, cache_prompt: true, chat_template_kwargs: { enable_thinking: false } });
    expect((body.response_format as { json_schema: { schema: { required: string[] } } }).json_schema.schema.required).toEqual(["first", "second", "defer"]);
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["user"]);
  });

  it("returns the raw variants in set order with key and position label", async () => {
    const { client } = clientReturning('{"first":" La faccio io. ","second":"Girala a Paolo.","defer":"Ti dico entro stasera."}');
    const r = await new ReplyGenerator({ client, timeoutMs: 10_000 }).generate(INPUT);
    expect(r).toEqual({
      ok: true,
      variants: [
        { key: "first", label: "Scelgo: la fai tu", text: " La faccio io. " },
        { key: "second", label: "Scelgo: la giro a Paolo", text: "Girala a Paolo." },
        { key: "defer", label: "Rimando", text: "Ti dico entro stasera." },
      ],
      durationMs: expect.any(Number),
      completionTokens: 90,
    });
  });

  it("skips a key whose value is missing or not a string, keeping the others", async () => {
    const { client } = clientReturning('{"first":"La faccio io.","second":7,"defer":"Ti dico entro stasera."}');
    const r = await new ReplyGenerator({ client, timeoutMs: 10_000 }).generate(INPUT);
    expect(r.ok && r.variants.map((v) => v.key)).toEqual(["first", "defer"]);
  });

  it("returns ok:false llm-error with the error code on ReplyLLMError", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const client = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await new ReplyGenerator({ client, timeoutMs: 10_000 }).generate(INPUT);
    expect(r).toEqual({ ok: false, reason: "llm-error", error: "reply LLM HTTP 500", durationMs: expect.any(Number) });
  });

  it("logs metrics only: never transcript, last message, names or generated text", async () => {
    const slack = CASES[0]!;
    const { client } = clientReturning('{"first":"ZQXV-VARIANT-TEXT uno","second":"ZQXV-VARIANT-TEXT due","defer":"ZQXV-VARIANT-TEXT tre"}');
    const seen: string[] = [];
    const logger = { info: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
                     warn: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }) };
    await new ReplyGenerator({ client, timeoutMs: 10_000, logger }).generate({ ...INPUT, transcript: `INTERLOCUTORE (Marta): ${slack.ax}`, lastMessage: slack.ax });
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) {
      expect(leaksScreenText(line, slack.ax), line).toBe(false);
      expect(line.includes("ZQXV"), line).toBe(false);
    }
  });
});
```

Run: `npx vitest run test/unit/reply-positions.test.ts test/unit/reply-generator.test.ts` — Expected: FAIL, moduli non trovati.

- [ ] **Step 2: `src/main/utils/reply-positions.ts`**

```typescript
/**
 * The three positions the code assigns for each classification kind. The
 * model writes only the prose (spec §Spike 3: the task is underdetermined —
 * asked for "three replies" a small model rewrites the same one three times).
 * `voice` is what the prompt says about the position: a first-person example
 * chosen to be non-copyable (no days, names or figures), because small models
 * copy abstract instructions verbatim and copy examples when they have little
 * to say (both measured).
 */
export type PositionKey = "accept" | "decline" | "defer" | "first" | "second" | "accept_offer" | "reject_offer" | "request_changes";

export interface Position {
  key: PositionKey;
  /** Pill label, in the conversation's language. */
  label: string;
  /** Instruction for the prompt, always in Italian (the prompt is Italian). */
  voice: string;
}

export interface PositionsInput {
  kind: "generic" | "alternative" | "offer";
  language: "it" | "en" | "other";
  alternatives?: [string, string];
}

export const POSITION_LABELS: Record<"it" | "en", Record<PositionKey, string>> = {
  it: { accept: "Accetto", decline: "Declino", defer: "Rimando", first: "Scelgo: ", second: "Scelgo: ",
        accept_offer: "Accetto l'offerta", reject_offer: "Rifiuto", request_changes: "Chiedo modifiche" },
  en: { accept: "Accept", decline: "Decline", defer: "Defer", first: "Choose: ", second: "Choose: ",
        accept_offer: "Accept the offer", reject_offer: "Reject", request_changes: "Request changes" },
};

const LABEL_ALT_MAX = 40;

function altLabel(prefix: string, alt: string): string {
  return alt.length > LABEL_ALT_MAX ? `${prefix}${alt.slice(0, LABEL_ALT_MAX - 1)}…` : `${prefix}${alt}`;
}

export function positionsFor(input: PositionsInput): Position[] {
  const L = POSITION_LABELS[input.language === "en" ? "en" : "it"];
  if (input.kind === "offer") {
    return [
      { key: "accept_offer", label: L.accept_offer, voice: "accetta l'offerta come cliente che la riceve e dà il via ai lavori. Nello spirito di: «per me va bene, procediamo»" },
      { key: "reject_offer", label: L.reject_offer, voice: "non accetta l'offerta, da cliente, senza inventare motivi. Nello spirito di: «per ora lascio stare, grazie»" },
      { key: "request_changes", label: L.request_changes, voice: "chiede una modifica o un chiarimento prima di accettare. Nello spirito di: «prima di confermare avrei bisogno di un dettaglio»" },
    ];
  }
  if (input.kind === "alternative" && input.alternatives) {
    const [a, b] = input.alternatives;
    return [
      { key: "first", label: altLabel(L.first, a), voice: `sceglie la prima alternativa (${a}). Nello spirito di: «per me va bene la prima, confermo»` },
      { key: "second", label: altLabel(L.second, b), voice: `sceglie la seconda alternativa (${b}). Nello spirito di: «preferisco la seconda»` },
      { key: "defer", label: L.defer, voice: "non si impegna ora. Nello spirito di: «devo controllare, ti faccio sapere a breve»" },
    ];
  }
  return [
    { key: "accept", label: L.accept, voice: "accetta e se ne fa carico. Nello spirito di: «ci penso io, confermo»" },
    { key: "decline", label: L.decline, voice: "non se ne fa carico, senza inventare motivi. Nello spirito di: «io non riesco, meglio se lo prende qualcun altro»" },
    { key: "defer", label: L.defer, voice: "non si impegna ora. Nello spirito di: «devo controllare, ti faccio sapere a breve»" },
  ];
}

/** Keys fixed by the grammar; the model fills only the strings (spec §5). */
export function generatorSchemaFor(positions: readonly Position[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(positions.map((p) => [p.key, { type: "string", maxLength: 400 }])),
    required: positions.map((p) => p.key),
    additionalProperties: false,
  };
}
```

- [ ] **Step 3: `src/main/reply-generator.ts`**

```typescript
import { ReplyChatClient, ReplyLLMError, type SamplingParams } from "./reply-chat-client.js";
import { generatorSchemaFor, type Position } from "./utils/reply-positions.js";
import type { Logger } from "./logger.js";

/** Official Gemma sampling (spec §Vincolo tecnico); repetition penalty off. */
export const GEMMA_SAMPLING: Readonly<SamplingParams> = { temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0, repeat_penalty: 1.0 };

export const GENERATOR_MAX_TOKENS = 320;

/** Fixed prefix: identical across calls, so the KV cache keeps it; also the
 *  warmupPrompt of the reply server. Gemma has no system role. */
export const GENERATOR_PREFIX = `Scrivi, al posto di una persona, il messaggio che invierà in risposta a una conversazione. Non stai parlando con quella persona: stai scrivendo al posto suo, in prima persona.

Produci un oggetto JSON con esattamente tre chiavi, indicate sotto. In ognuna scrivi un solo messaggio, che esprime la posizione indicata per quella chiave. Ogni valore è solo il testo del messaggio: nessun saluto iniziale, nessuna firma, nessun commento, nessuna chiave in più.

Gli esempi fra virgolette «» servono solo a darti il tono: non copiarli e non copiare queste istruzioni. Scrivi un messaggio nuovo, riferito a ciò che l'interlocutore ha scritto.

Regole assolute:
- Non ripetere la domanda dell'interlocutore: rispondi.
- Nessuna cifra, data o nome che non sia già nella trascrizione.
- Non affermare MAI di aver già svolto un'azione: non sai cosa la persona ha fatto. Nessun "ho già corretto", "ho appena inviato", "ho rifatto".
- Non inventare impegni, riunioni o motivi che non sono nella trascrizione. Chi declina lo fa senza spiegare perché.
- Da una a tre frasi per messaggio. Nessuna firma finale.`;

export interface GenerateInput {
  transcript: string;
  lastMessage: string;
  counterpart: string;
  userDisplayName: string;
  subject: string | undefined;
  positions: readonly Position[];
  language: "it" | "en" | "other";
}

export interface RawVariant { key: string; label: string; text: string }

export type GenerateResult =
  | { ok: true; variants: RawVariant[]; durationMs: number; completionTokens: number }
  | { ok: false; reason: "llm-error"; error: string; durationMs: number };

const LANGUAGE_LINE: Record<GenerateInput["language"], string> = {
  it: "Lingua: italiano.",
  en: "Lingua: inglese.",
  other: "Lingua: la stessa della trascrizione.",
};

export function buildGeneratorPrompt(input: GenerateInput): string {
  const who = `Tu scrivi come ${input.userDisplayName}. Ogni messaggio è scritto da ${input.userDisplayName} e indirizzato a ${input.counterpart}. Mai firmarsi ${input.counterpart}, mai rivolgersi a ${input.userDisplayName}. Nella trascrizione le righe "TU" sono di ${input.userDisplayName}, le righe "INTERLOCUTORE" sono di ${input.counterpart}.`;
  const subject = input.subject !== undefined ? `\nOggetto: ${input.subject}` : "";
  const last = `${input.counterpart} ha scritto per ultimo: «${input.lastMessage}»`;
  const keys = input.positions.map((p) => `- "${p.key}": ${input.userDisplayName} ${p.voice}`).join("\n");
  return `${GENERATOR_PREFIX}

${who}${subject}
${last}
${LANGUAGE_LINE[input.language]}

Le tre chiavi e la posizione di ciascuna:
${keys}

<trascrizione>
${input.transcript}
</trascrizione>`;
}

export interface ReplyGeneratorOptions {
  client: ReplyChatClient;
  /** 10 000 in production (spec §5). */
  timeoutMs: number;
  logger?: Pick<Logger, "info" | "warn">;
}

export class ReplyGenerator {
  constructor(private readonly opts: ReplyGeneratorOptions) {}

  /** Returns the RAW strings: cleaning and filtering belong to VariantFilter. */
  async generate(input: GenerateInput): Promise<GenerateResult> {
    const t0 = Date.now();
    try {
      const r = await this.opts.client.completeJson({
        prompt: buildGeneratorPrompt(input),
        schema: generatorSchemaFor(input.positions),
        sampling: { ...GEMMA_SAMPLING },
        maxTokens: GENERATOR_MAX_TOKENS,
        timeoutMs: this.opts.timeoutMs,
      });
      const obj = typeof r.json === "object" && r.json !== null ? (r.json as Record<string, unknown>) : {};
      const variants: RawVariant[] = [];
      for (const p of input.positions) {
        const v = obj[p.key];
        if (typeof v === "string" && v.trim().length > 0) variants.push({ key: p.key, label: p.label, text: v });
      }
      void this.opts.logger?.info("reply generate", {
        variants: variants.length, keys: input.positions.map((p) => p.key), durationMs: r.durationMs,
        completionTokens: r.completionTokens, contentChars: r.contentChars, transcriptChars: input.transcript.length,
      });
      return { ok: true, variants, durationMs: Date.now() - t0, completionTokens: r.completionTokens };
    } catch (err) {
      const error = err instanceof ReplyLLMError ? err.message : "reply LLM request failed: Error";
      const durationMs = Date.now() - t0;
      void this.opts.logger?.warn("reply generate failed", { error, durationMs });
      return { ok: false, reason: "llm-error", error, durationMs };
    }
  }
}
```

Run: `npx vitest run test/unit/reply-positions.test.ts test/unit/reply-generator.test.ts` — Expected: PASS.

**Prova di rottura:** in `GEMMA_SAMPLING` metti `repeat_penalty: 1.1` → due test falliscono; in `generatorSchemaFor` togli `additionalProperties: false` → il test dello schema fallisce; aggiungi `sample: variants[0]?.text` al meta di `"reply generate"` → il test privacy fallisce sulla sentinella. Ripristina e riporta.

- [ ] **Step 4: Lint, typecheck, test, commit**

```bash
grep -ln "from \"electron\"" src/main/reply-generator.ts src/main/utils/reply-positions.ts ; echo "exit=$?"   # atteso exit=1
npm run lint && npm run typecheck && npm run test
git add src/main/utils/reply-positions.ts test/unit/reply-positions.test.ts src/main/reply-generator.ts test/unit/reply-generator.test.ts
git commit -m "feat(reply): code-owned position sets and the Gemma generator with grammar-fixed keys

The three positions per kind are data, not model output: the benchmark
showed that asking for three replies yields three rewrites. The generator
constrains only the JSON envelope (the set's keys) and leaves the prose
free, per arXiv 2408.02442. Official Gemma sampling, thinking off, one
user turn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** `positionsFor` restituisce i tre set con le chiavi esatte e le etichette it/en; `generatorSchemaFor` identico al letterale del test; `GENERATOR_PREFIX` e `GEMMA_SAMPLING` esportati; `ReplyGenerator.generate` con il body del test; prove di rottura riportate; lint/typecheck/test verdi.

---

## Task 4: `number-words` e `VariantFilter`

**Obiettivo:** i filtri per singola variante nello spirito di `output-sanitizer.ts`: dieci regole con soglie esatte, il parser dei numerali in lettere (la falla "quattro mila ottocento cinquanta euro"), la soglia "almeno due sopravvissute", e un oggetto di log con soli `{key, rule}`.

**Dipende da:** nessun task (importa solo `guessLanguage` dal parser esistente).

**Files:**
- Create: `src/main/utils/number-words.ts`, `test/unit/number-words.test.ts`
- Create: `src/main/utils/variant-filter.ts`, `test/unit/variant-filter.test.ts`

- [ ] **Step 1: Test dei numerali che falliscono**

Crea `test/unit/number-words.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseNumberWords } from "../../src/main/utils/number-words.js";

describe("parseNumberWords — Italian", () => {
  it("reads spaced and glued thousands/hundreds/tens", () => {
    expect(parseNumberWords("il totale è quattro mila ottocento cinquanta euro")).toEqual([4850]);
    expect(parseNumberWords("quattromila ottocentocinquanta euro")).toEqual([4850]);
    expect(parseNumberWords("quattromilaottocentocinquanta")).toEqual([4850]);
  });
  it("accepts the connector 'e' between numeral words only", () => {
    expect(parseNumberWords("duemila e trecento")).toEqual([2300]);
    expect(parseNumberWords("due e tre persone")).toEqual([2, 3]);
  });
  it("handles elided tens and accented units", () => {
    expect(parseNumberWords("ventuno")).toEqual([21]);
    expect(parseNumberWords("ventotto")).toEqual([28]);
    expect(parseNumberWords("trentatré")).toEqual([33]);
    expect(parseNumberWords("centocinquanta")).toEqual([150]);
    expect(parseNumberWords("mille")).toEqual([1000]);
    expect(parseNumberWords("due milioni")).toEqual([2_000_000]);
  });
  it("ignores lone 'un/uno/una' (articles) and lone 'sei' (the verb), but not 'tre' or 'nove'", () => {
    expect(parseNumberWords("una riunione con un collega")).toEqual([]);
    expect(parseNumberWords("sei d'accordo?")).toEqual([]);
    expect(parseNumberWords("entro tre settimane")).toEqual([3]);
    expect(parseNumberWords("alle nove")).toEqual([9]);
    expect(parseNumberWords("sei mila euro")).toEqual([6000]);
  });
  it("does not read ordinary words as numbers", () => {
    expect(parseNumberWords("confermo il sopralluogo di venerdì, secondo piano")).toEqual([]);
  });
});

describe("parseNumberWords — English", () => {
  it("reads hyphenated and 'and' forms", () => {
    expect(parseNumberWords("twenty-five thousand pounds")).toEqual([25_000]);
    expect(parseNumberWords("one hundred and twelve")).toEqual([112]);
    expect(parseNumberWords("twelve hundred")).toEqual([1200]);
  });
  it("ignores a lone 'one'", () => {
    expect(parseNumberWords("the first one works")).toEqual([]);
    expect(parseNumberWords("one thousand")).toEqual([1000]);
  });
});
```

- [ ] **Step 2: `src/main/utils/number-words.ts`**

```typescript
/**
 * Numerals written in words (Italian and English) → values. Exists because a
 * benchmarked model wrote "quattro mila ottocento cinquanta euro" and slipped
 * past the digit check of the variant filter (spec §Spike 3).
 *
 * Tokens are lower-cased, accent-stripped letter runs (hyphens split). Each
 * token is segmented greedily, longest vocabulary prefix first; a token is a
 * numeral only if it segments completely ("ottocento" → otto+cento,
 * "ventuno" → vent+uno). Consecutive numeral tokens, optionally joined by
 * "e"/"and", form one number. A run made of a single ambiguous token
 * (un/uno/una/one — articles; sei — "you are") is dropped.
 */
const IT: Record<string, number> = {
  zero: 0, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
  undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19,
  venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
  vent: 20, trent: 30, quarant: 40, cinquant: 50, sessant: 60, settant: 70, ottant: 80, novant: 90,
  cento: 100, mille: 1000, mila: 1000, milione: 1_000_000, milioni: 1_000_000,
};
const EN: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1_000_000,
};
const VOCAB: Record<string, number> = { ...EN, ...IT };
const VOCAB_KEYS_BY_LENGTH = Object.keys(VOCAB).sort((a, b) => b.length - a.length);
const CONNECTORS = new Set(["e", "and"]);
const LONE_AMBIGUOUS = new Set(["un", "uno", "una", "one", "sei"]);

function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Greedy longest-prefix segmentation; null when the token is not fully numeral. */
function segment(token: string): number[] | null {
  const out: number[] = [];
  let rest = token;
  while (rest.length > 0) {
    const piece = VOCAB_KEYS_BY_LENGTH.find((k) => rest.startsWith(k));
    if (!piece) return null;
    out.push(VOCAB[piece]!); // piece comes from VOCAB's own keys
    rest = rest.slice(piece.length);
  }
  return out;
}

function evaluate(pieces: readonly number[]): number {
  let total = 0;
  let group = 0;
  for (const v of pieces) {
    if (v === 100) group = (group === 0 ? 1 : group) * 100;
    else if (v >= 1000) { total += (group === 0 ? 1 : group) * v; group = 0; }
    else group += v;
  }
  return total + group;
}

export function parseNumberWords(text: string): number[] {
  const tokens = normalize(text).split(/[^\p{L}]+/u).filter((t) => t.length > 0);
  const numbers: number[] = [];
  let run: number[] = [];
  let runTokens: string[] = [];
  const flush = () => {
    if (runTokens.length > 0 && !(runTokens.length === 1 && LONE_AMBIGUOUS.has(runTokens[0]!))) numbers.push(evaluate(run)); // length checked
    run = [];
    runTokens = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!; // i < tokens.length
    const seg = segment(t);
    if (seg) { run.push(...seg); runTokens.push(t); continue; }
    const next = tokens[i + 1];
    if (CONNECTORS.has(t) && runTokens.length > 0 && next !== undefined && segment(next) !== null) continue;
    flush();
  }
  flush();
  return numbers;
}
```

Run: `npx vitest run test/unit/number-words.test.ts` — Expected: PASS.

**Prova di rottura:** togli `"sei"` da `LONE_AMBIGUOUS` → il test "sei d'accordo?" fallisce; in `evaluate` sostituisci `v >= 1000` con `v > 1000` → "quattro mila…" fallisce. Ripristina e riporta.

- [ ] **Step 3: Test del filtro che falliscono**

Crea `test/unit/variant-filter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { filterVariants, cleanVariantText, jaccardWords, MIN_KEPT, toLogMeta, type FilterInput } from "../../src/main/utils/variant-filter.js";
import { CASES, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";

const CTX = {
  lastMessage: "ciao, ho visto che la PR sul login è ferma da due giorni, la review la fai tu o la giro a Paolo?",
  transcript: "INTERLOCUTORE (Marta): ciao, ho visto che la PR sul login è ferma da due giorni, la review la fai tu o la giro a Paolo?\nINTERLOCUTORE (Marta): te lo chiedo perché venerdì dovremmo rilasciare e quella è bloccante",
  counterpart: "Marta",
  userDisplayName: "Danilo Franco",
  language: "it" as const,
};
const V = (key: string, text: string) => ({ key, label: key, text });
function run(variants: FilterInput["variants"], over: Partial<FilterInput> = {}) {
  return filterVariants({ ...CTX, variants, ...over });
}
const GOOD_A = V("accept", "Ci penso io, la review la faccio oggi pomeriggio così venerdì siamo tranquilli.");
const GOOD_B = V("decline", "Io questa settimana non riesco a prenderla, meglio se la fa qualcun altro.");
const GOOD_C = V("defer", "Fammi controllare l'agenda e ti dico entro stasera se ce la faccio.");

describe("cleanVariantText", () => {
  it("strips markdown, wrapping quotes, label prefixes and collapses whitespace", () => {
    expect(cleanVariantText('  **Risposta:** "Ci  penso io,\n confermo."  ')).toBe("Ci penso io, confermo.");
    expect(cleanVariantText("«Per me va bene, procediamo»")).toBe("Per me va bene, procediamo");
    expect(cleanVariantText("Reply: _sure_, I'll take it.")).toBe("sure, I'll take it.");
  });
});

describe("filterVariants — each rule, positive and negative", () => {
  it("keeps three good variants unchanged in order", () => {
    const r = run([GOOD_A, GOOD_B, GOOD_C]);
    expect(r.kept.map((v) => v.key)).toEqual(["accept", "decline", "defer"]);
    expect(r.dropped).toEqual([]);
  });

  it("length: below 20 or above 280 chars is dropped, 20 and 280 are kept", () => {
    expect(run([V("accept", "x".repeat(19)), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "length" }]);
    expect(run([V("accept", "Va bene, ci penso io."), GOOD_B, GOOD_C]).dropped).toEqual([]); // 21 chars
    expect(run([V("accept", "ok ".repeat(94).trim()), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "length" }]); // 281
    expect(run([V("accept", "ab ".repeat(93) + "c"), GOOD_B, GOOD_C]).dropped).toEqual([]); // 280
  });

  it("done-action: first-person completed actions are dropped (it and en)", () => {
    for (const t of ["Ho già preso in carico la PR, la chiudo entro oggi.", "Ho appena inviato la review a Paolo.", "Ho corretto il problema del lockfile.", "I've already sent the payment yesterday.", "I just fixed the build this morning."]) {
      expect(run([V("accept", t), GOOD_B, GOOD_C]).dropped, t).toEqual([{ key: "accept", rule: "done-action" }]);
    }
    expect(run([V("accept", "Ho visto la PR, la prendo io e la chiudo entro oggi."), GOOD_B, GOOD_C]).dropped).toEqual([]);
  });

  it("invented-reason: a decline/reject_offer with a causal clause not grounded in the context is dropped", () => {
    const invented = "Non riesco a occuparmene perché ho un carico di lavoro pesante in questo periodo.";
    expect(run([GOOD_A, V("decline", invented), GOOD_C]).dropped).toEqual([{ key: "decline", rule: "invented-reason" }]);
    expect(run([GOOD_A, V("reject_offer", "Per ora non procedo, dato che il budget interno è stato tagliato."), GOOD_C]).dropped).toEqual([{ key: "reject_offer", rule: "invented-reason" }]);
    // Grounded reason: the words after the connective are in the transcript.
    expect(run([GOOD_A, V("decline", "Non riesco a prenderla io perché venerdì dovremmo rilasciare."), GOOD_C]).dropped).toEqual([]);
    // Same invented clause on an accept is not this rule's business.
    expect(run([V("accept", "La prendo io perché ho un carico di lavoro leggero in questo periodo."), GOOD_B, GOOD_C]).dropped).toEqual([]);
  });

  it("invented-reason: stock invented commitments are dropped on any position", () => {
    for (const t of ["Non posso, sono in riunione tutto il giorno.", "Ci penso io appena esco, ora sono fuori sede.", "I'm in a meeting all afternoon, will look later."]) {
      expect(run([V("accept", t), GOOD_B, GOOD_C]).dropped, t).toEqual([{ key: "accept", rule: "invented-reason" }]);
    }
  });

  it("signature: ends with the counterpart's or the user's name, or a formal closing with a name", () => {
    for (const t of ["Ci penso io e la chiudo oggi. Grazie, Marta", "Ci penso io e la chiudo oggi. A presto, Marta.", "Ci penso io e la chiudo entro oggi. Danilo", "Confermo la revisione per venerdì. Cordiali saluti, Francesca Bianchi"]) {
      expect(run([V("accept", t), GOOD_B, GOOD_C]).dropped, t).toEqual([{ key: "accept", rule: "signature" }]);
    }
    // A vocative at the start is fine.
    expect(run([V("accept", "Ciao Marta, ci penso io e la chiudo entro oggi."), GOOD_B, GOOD_C]).dropped).toEqual([]);
  });

  it("unanchored-number: digits and number words must appear in the context", () => {
    const quote = { ...CTX, transcript: "OGGETTO: Preventivo\nINTERLOCUTORE (Francesca Bianchi): Il totale è 4.850 euro IVA esclusa, con inizio lavori entro tre settimane.", lastMessage: "Il totale è 4.850 euro IVA esclusa, con inizio lavori entro tre settimane." };
    expect(run([V("accept_offer", "Confermo il preventivo di quattro mila ottocento cinquanta euro, procediamo."), GOOD_B, GOOD_C], quote).dropped).toEqual([]);
    expect(run([V("accept_offer", "Confermo il preventivo di 4850 euro, procediamo pure."), GOOD_B, GOOD_C], quote).dropped).toEqual([]);
    expect(run([V("accept_offer", "Confermo, ma entro due settimane e non tre."), GOOD_B, GOOD_C], quote).dropped).toEqual([{ key: "accept_offer", rule: "unanchored-number" }]);
    expect(run([V("accept_offer", "Confermo il preventivo di 4.900 euro, procediamo."), GOOD_B, GOOD_C], quote).dropped).toEqual([{ key: "accept_offer", rule: "unanchored-number" }]);
    expect(run([V("accept", "Ci penso io, la chiudo entro le 18 di oggi."), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "unanchored-number" }]);
  });

  it("question-echo: Jaccard with the last message above 0.6 is dropped", () => {
    const echo = "Ho visto che la PR sul login è ferma da due giorni: la review la faccio io, non la giro a Paolo.";
    expect(jaccardWords(echo, CTX.lastMessage)).toBeGreaterThan(0.6);
    expect(run([V("accept", echo), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "question-echo" }]);
  });

  it("language: a variant in the other language is dropped; unknown languages are never dropped", () => {
    const en = "I can take the review today and we will be ready for the release on Friday.";
    expect(run([V("accept", en), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "language" }]);
    expect(run([V("accept", en), GOOD_B, GOOD_C], { language: "other" }).dropped).toEqual([]);
    expect(run([V("accept", en), GOOD_B, GOOD_C], { language: "en" }).dropped.map((d) => d.rule)).not.toContain("language");
  });

  it("instruction-echo: second-person imperatives copied from the prompt, or the example marker", () => {
    for (const t of ["Verifichi e fai sapere a breve se riesci a occupartene.", "Rispondi in senso affermativo alla richiesta della review.", "Ci penso io, nello spirito di chi conferma volentieri."]) {
      expect(run([V("accept", t), GOOD_B, GOOD_C]).dropped, t).toEqual([{ key: "accept", rule: "instruction-echo" }]);
    }
  });

  it("near-duplicate: pairwise Jaccard above 0.75 keeps the first in set order", () => {
    const dup = { ...GOOD_A, key: "defer" };
    const r = run([GOOD_A, GOOD_B, dup]);
    expect(r.kept.map((v) => v.key)).toEqual(["accept", "decline"]);
    expect(r.dropped).toEqual([{ key: "defer", rule: "near-duplicate" }]);
  });

  it("returns the CLEANED text of kept variants and MIN_KEPT is 2", () => {
    const r = run([V("accept", '  "Ci penso io, la chiudo entro oggi pomeriggio."  '), GOOD_B, GOOD_C]);
    expect(r.kept[0]!.text).toBe("Ci penso io, la chiudo entro oggi pomeriggio."); // three kept
    expect(MIN_KEPT).toBe(2);
  });
});

describe("jaccardWords", () => {
  const A = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
  it("ignores stopwords and case, 0 on empty", () => {
    expect(jaccardWords("il gatto e la volpe", "IL GATTO E LA VOLPE")).toBe(1);
    expect(jaccardWords("il e la di", "gatto")).toBe(0);
    expect(jaccardWords("", "x")).toBe(0);
  });
  it("hits the exact spec thresholds: 0.611 and 0.765 are above, 0.588 and 0.737 below", () => {
    expect(jaccardWords(A, "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omicron pi rho sigma")).toBeCloseTo(11 / 18, 3);
    expect(jaccardWords(A, "alpha beta gamma delta epsilon zeta eta theta iota kappa omicron pi rho")).toBeCloseTo(10 / 17, 3);
    expect(jaccardWords(A, "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu omicron pi rho")).toBeCloseTo(13 / 17, 3);
    expect(jaccardWords(A, `${A} omicron pi rho sigma tau`)).toBeCloseTo(14 / 19, 3);
  });
  it("the filter uses those thresholds: 0.611 echo dropped, 0.588 kept; 0.765 duplicate dropped, 0.737 kept", () => {
    const base = { ...CTX, language: "other" as const, lastMessage: A, transcript: `INTERLOCUTORE (Marta): ${A}` };
    const echo61 = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omicron pi rho sigma";
    const echo58 = "alpha beta gamma delta epsilon zeta eta theta iota kappa omicron pi rho";
    expect(run([V("accept", echo61), GOOD_B, GOOD_C], base).dropped).toEqual([{ key: "accept", rule: "question-echo" }]);
    expect(run([V("accept", echo58), GOOD_B, GOOD_C], base).dropped).toEqual([]);
    const first = "omicron pi rho sigma tau upsilon phi chi psi omega alpha beta gamma delta";
    const dup76 = "omicron pi rho sigma tau upsilon phi chi psi omega alpha beta gamma zeta eta theta";
    const dup73 = `${first} zeta eta theta iota kappa`;
    expect(run([V("accept", first), V("decline", dup76), GOOD_C], base).dropped).toEqual([{ key: "decline", rule: "near-duplicate" }]);
    expect(run([V("accept", first), V("decline", dup73), GOOD_C], base).dropped).toEqual([]);
  });
});

describe("filterVariants — privacy", () => {
  it("toLogMeta carries only counts, keys and rules", () => {
    const slack = CASES[0]!;
    const r = filterVariants({ ...CTX, transcript: slack.ax, lastMessage: slack.ax, variants: [V("accept", `ZQXV-VARIANT-TEXT ${slack.ax}`), GOOD_B, GOOD_C] });
    const meta = JSON.stringify(toLogMeta(r));
    expect(leaksScreenText(meta, slack.ax)).toBe(false);
    expect(meta).not.toContain("ZQXV");
    expect(toLogMeta(r)).toEqual({ kept: expect.any(Number), dropped: expect.any(Array) });
    for (const d of toLogMeta(r).dropped) expect(Object.keys(d).sort()).toEqual(["key", "rule"]);
  });
});
```

Run: `npx vitest run test/unit/variant-filter.test.ts` — Expected: FAIL, modulo non trovato.

- [ ] **Step 4: `src/main/utils/variant-filter.ts`**

Ordine delle regole (la spec le elenca con "prima persona" ultima; qui `instruction-echo` precede `near-duplicate`, che è a coppie e deve lavorare sulle sole sopravvissute — scostamento dichiarato in §Deviazioni 4): `cleanup → length → done-action → invented-reason → signature → unanchored-number → question-echo → language → instruction-echo → near-duplicate`.

```typescript
import { guessLanguage } from "./conversation-parser.js";
import { parseNumberWords } from "./number-words.js";

export type FilterRule =
  | "length" | "done-action" | "invented-reason" | "signature" | "unanchored-number"
  | "question-echo" | "language" | "instruction-echo" | "near-duplicate";

export interface FilterVariant { key: string; label: string; text: string }

export interface FilterInput {
  variants: readonly FilterVariant[];
  lastMessage: string;
  transcript: string;
  counterpart: string;
  userDisplayName: string;
  language: "it" | "en" | "other";
}

export interface FilterOutput {
  kept: FilterVariant[];
  /** For the log only: never the text (spec §6). */
  dropped: Array<{ key: string; rule: FilterRule }>;
}

/** Fewer survivors than this → the coordinator abstains: one proposal is not
 *  a choice and reads as an authoritative suggestion (spec §6). */
export const MIN_KEPT = 2;

const LENGTH_MIN = 20;
const LENGTH_MAX = 280;
const ECHO_THRESHOLD = 0.6;
const DUPLICATE_THRESHOLD = 0.75;

// Measured in the spike (validate() in strategy.mjs), kept verbatim plus the
// English "I just <verb>ed" form.
const DONE_ACTION = /\b(ho (?:appena|gi[aà]) \p{L}+|ho (?:corretto|inviato|rifatto|risolto|sistemato|completato|girato|accettato)|l'ho (?:gi[aà] )?\p{L}+at[oa]|i(?:'ve| have) (?:just |already )?\p{L}+ed|i just \p{L}+ed)\b/iu;
const INVENTED_COMMITMENT = /\b(sono in riunione|ho una riunione|sono in ferie|sono fuori sede|ho un altro impegno|altre attivit[aà] urgenti|i(?:'m| am) in a meeting|i(?:'m| am) on leave|out of office)\b/iu;
const CAUSAL = /\b(perch[eé]|in quanto|dato che|poich[eé]|siccome|a causa d[iel]|because|since|as i)\b/iu;
const REASON_KEYS = new Set(["decline", "reject_offer"]);
const INSTRUCTION_ECHO = /^\s*(?:verifichi|puoi|non puoi|fai sapere|scegli|rispondi in senso)\b/iu;
const EXAMPLE_ECHO = /\bnello spirito di\b/iu;
const FORMAL_CLOSING = /(?:cordiali|distinti)\s+saluti,?\s+\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+)?\s*[.!]?\s*$/u;
const LABEL_PREFIX = /^(?:risposta|reply|messaggio|message|answer)\s*[:\-–]\s*/iu;

/** Stopwords removed before Jaccard (spec §6: "minuscole, senza stopword"). */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "a", "da", "in", "con", "su", "per", "tra", "fra", "e", "o", "ma",
  "se", "che", "non", "mi", "ti", "ci", "vi", "si", "ne", "al", "del", "dal", "nel", "sul", "alla", "della", "dalla", "nella", "sulla",
  "è", "ho", "hai", "ha", "the", "an", "and", "or", "but", "if", "that", "this", "to", "of", "on", "at", "for", "with", "from", "by",
  "is", "are", "be", "you", "your", "we", "our", "it", "as",
]);

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => !STOPWORDS.has(w)));
}

export function jaccardWords(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / (wa.size + wb.size - inter);
}

export function cleanVariantText(text: string): string {
  let t = text.replace(/[*_]/gu, "").replace(/\s+/gu, " ").trim();
  t = t.replace(LABEL_PREFIX, "").trim();
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ["«", "»"], ["“", "”"]];
  for (const [open, close] of pairs) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) { t = t.slice(1, -1).trim(); break; }
  }
  return t;
}

function firstToken(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSignature(text: string, counterpart: string, user: string): boolean {
  if (FORMAL_CLOSING.test(text)) return true;
  for (const name of [firstToken(counterpart), firstToken(user)].filter((n) => n.length > 0)) {
    const n = escapeRe(name);
    if (new RegExp(`(?:saluti|grazie|presto|cordiali|distinti)[,\\s]*${n}\\s*[.!]?\\s*$`, "iu").test(text)) return true;
    if (new RegExp(`[.!?,]\\s+${n}\\s*[.!]?\\s*$`, "u").test(text)) return true;
  }
  return false;
}

/** Thousands separators removed on both sides; "4.850" and "4850" agree. */
function digitTokens(s: string): string[] {
  return (s.replace(/(?<=\d)[.,](?=\d{3}\b)/gu, "").match(/\d+/gu) ?? []).filter((d) => Number(d) !== 0);
}

function hasUnanchoredNumber(text: string, transcript: string): boolean {
  const ctxDigits = digitTokens(transcript);
  const ctxWordNumbers = new Set(parseNumberWords(transcript));
  const anchored = (value: string) => ctxDigits.some((c) => c.includes(value)) || ctxWordNumbers.has(Number(value));
  for (const d of digitTokens(text)) if (!anchored(d)) return true;
  for (const n of parseNumberWords(text)) if (!anchored(String(n))) return true;
  return false;
}

function contentWords(s: string): string[] {
  return (s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/\p{L}{4,}/gu) ?? []);
}

/** A causal clause whose content words are mostly absent from the context is
 *  a reason the model made up (Gemma 3 4B: "ho un carico di lavoro pesante"). */
function hasInventedReason(text: string, transcript: string): boolean {
  const m = CAUSAL.exec(text);
  if (!m) return false;
  const clause = text.slice(m.index + m[0].length).split(/[.!?]/u)[0] ?? "";
  const cw = contentWords(clause);
  if (cw.length === 0) return false;
  const ctx = new Set(contentWords(transcript));
  const grounded = cw.filter((w) => ctx.has(w)).length;
  return grounded / cw.length < 0.5;
}

function ruleFor(v: FilterVariant, input: FilterInput): FilterRule | null {
  const t = v.text;
  if (t.length < LENGTH_MIN || t.length > LENGTH_MAX) return "length";
  if (DONE_ACTION.test(t)) return "done-action";
  if (INVENTED_COMMITMENT.test(t)) return "invented-reason";
  if (REASON_KEYS.has(v.key) && hasInventedReason(t, input.transcript)) return "invented-reason";
  if (isSignature(t, input.counterpart, input.userDisplayName)) return "signature";
  if (hasUnanchoredNumber(t, input.transcript)) return "unanchored-number";
  if (jaccardWords(t, input.lastMessage) > ECHO_THRESHOLD) return "question-echo";
  if (input.language !== "other") {
    const g = guessLanguage(t);
    if (g !== "other" && g !== input.language) return "language";
  }
  if (INSTRUCTION_ECHO.test(t) || EXAMPLE_ECHO.test(t)) return "instruction-echo";
  return null;
}

export function filterVariants(input: FilterInput): FilterOutput {
  const kept: FilterVariant[] = [];
  const dropped: FilterOutput["dropped"] = [];
  for (const raw of input.variants) {
    const v = { ...raw, text: cleanVariantText(raw.text) };
    const rule = ruleFor(v, input);
    if (rule) { dropped.push({ key: v.key, rule }); continue; }
    if (kept.some((k) => jaccardWords(k.text, v.text) > DUPLICATE_THRESHOLD)) { dropped.push({ key: v.key, rule: "near-duplicate" }); continue; }
    kept.push(v);
  }
  return { kept, dropped };
}

/** Counts, keys and rules: never text (spec §Privacy 2). */
export function toLogMeta(out: FilterOutput): { kept: number; dropped: Array<{ key: string; rule: FilterRule }> } {
  return { kept: out.kept.length, dropped: out.dropped.map((d) => ({ key: d.key, rule: d.rule })) };
}
```

Run: `npx vitest run test/unit/variant-filter.test.ts test/unit/number-words.test.ts` — Expected: PASS. Se un caso di test non torna per una differenza di conteggio parole (per esempio la soglia 280 con `"ab ".repeat(93) + "c"`), correggi **il test** solo dopo aver ricontrollato il conteggio a mano e dichiarandolo nel commit; le soglie del modulo non si toccano.

**Prova di rottura (una per regola, tutte da riportare):** `LENGTH_MIN = 19` → il test length fallisce sul caso 19; commenta la riga `DONE_ACTION` → il test done-action fallisce; `ECHO_THRESHOLD = 0.62` → il test 0.611 fallisce; `DUPLICATE_THRESHOLD = 0.77` → il test 0.765 fallisce; rimuovi `parseNumberWords(text)` dal ciclo di `hasUnanchoredNumber` → il caso "due settimane" fallisce; in `toLogMeta` aggiungi `text: d.key` … no: aggiungi `sample: out.kept[0]?.text` → il test privacy fallisce. Ripristina e riporta.

- [ ] **Step 5: Lint, typecheck, test, commit**

```bash
grep -ln "from \"electron\"\|node:fs" src/main/utils/variant-filter.ts src/main/utils/number-words.ts ; echo "exit=$?"   # atteso exit=1
npm run lint && npm run typecheck && npm run test
git add src/main/utils/number-words.ts test/unit/number-words.test.ts src/main/utils/variant-filter.ts test/unit/variant-filter.test.ts
git commit -m "feat(reply): per-variant filter with word-numeral anchoring

Ten rules in the spirit of output-sanitizer.ts, applied to each variant
alone so one bad text never kills the result. Numbers are anchored to the
context in digits AND in words: a benchmarked model wrote 'quattro mila
ottocento cinquanta euro' past the digit check. Jaccard thresholds 0.6
(echo) and 0.75 (near-duplicate) from the spike, now on stopword-free
sets as the spec asks; recalibration is Task 10's job.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** `parseNumberWords` passa i 12 casi; `filterVariants` con le nove regole nell'ordine dato, `MIN_KEPT = 2`, `toLogMeta` con soli `{kept, dropped:[{key,rule}]}`; test ai bordi 19/20/280/281, 0.588/0.611, 0.737/0.765 verdi; prove di rottura riportate; lint/typecheck/test verdi.

---

## Task 5: `ReplyServerManager`

**Obiettivo:** il ciclo di vita del secondo `llama-server` legato alla preferenza: avvio solo a feature accesa, download del modello se manca, stop allo spegnimento, riavvio al cambio tier, un solo riavvio automatico dopo un errore di richiesta, stati osservabili dalla preferences window.

**Dipende da:** Task 2 (`ReplyServerState`, catalogo).

**Files:**
- Create: `src/main/reply-server-manager.ts`, `test/unit/reply-server-manager.test.ts`

- [ ] **Step 1: Test che falliscono**

Crea `test/unit/reply-server-manager.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ReplyServerManager, type ReplyServerLike } from "../../src/main/reply-server-manager.js";
import { REPLY_MODELS } from "../../src/main/model-catalog.js";
import type { ModelDescriptor } from "../../src/main/utils/model-paths.js";

function fakeServer(opts: { failStart?: boolean } = {}) {
  let running = false;
  const s: ReplyServerLike & { startCalls: number; stopCalls: number } = {
    startCalls: 0, stopCalls: 0,
    async start() { s.startCalls += 1; if (opts.failStart) throw new Error("llama-server did not become healthy within 90000ms"); running = true; },
    stop() { s.stopCalls += 1; running = false; },
    isRunning: () => running,
    getEndpoint: () => "http://127.0.0.1:18082",
  };
  return s;
}

function env(over: { installed?: string[]; failStart?: boolean; failDownload?: boolean } = {}) {
  const installed = new Set(over.installed ?? ["gemma-3-4b-it-Q4_K_M.gguf"]);
  const servers: Array<ReturnType<typeof fakeServer> & { modelPath: string }> = [];
  const download = vi.fn(async (desc: ModelDescriptor, onProgress?: (p: { bytes: number; total: number }) => void) => {
    if (over.failDownload) throw new Error("sha256 mismatch");
    onProgress?.({ bytes: 1, total: 2 });
    installed.add(desc.filename);
  });
  const logger = { info: vi.fn(async () => {}), warn: vi.fn(async () => {}), error: vi.fn(async () => {}) };
  const states: string[] = [];
  const m = new ReplyServerManager({
    createServer: (modelPath) => { const s = Object.assign(fakeServer({ failStart: over.failStart }), { modelPath }); servers.push(s); return s; },
    modelManager: {
      isInstalled: async (d) => installed.has(d.filename),
      download,
      getInstalledPath: (d) => `/models/${d.filename}`,
    },
    logger,
  });
  m.onStateChange((s) => states.push(s));
  return { m, servers, download, logger, states };
}

describe("ReplyServerManager.apply", () => {
  it("starts off and stays off when the feature is disabled: no server is created", async () => {
    const { m, servers, states } = env();
    expect(m.getState()).toBe("off");
    await m.apply({ enabled: false, replyModelId: "gemma-3-4b" });
    expect(servers).toHaveLength(0);
    expect(states).toEqual([]);
    expect(m.getEndpoint()).toBeNull();
  });

  it("enabled + model installed: starting → ready with the model path of the chosen tier", async () => {
    const { m, servers, states } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(states).toEqual(["starting", "ready"]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.modelPath).toBe("/models/gemma-3-4b-it-Q4_K_M.gguf");
    expect(m.isReady()).toBe(true);
    expect(m.getEndpoint()).toBe("http://127.0.0.1:18082");
  });

  it("enabled + model missing: downloading → starting → ready, download called once with progress", async () => {
    const { m, download, states } = env({ installed: [] });
    const progress: Array<{ bytes: number; total: number }> = [];
    m.onDownloadProgress((p) => progress.push(p));
    await m.apply({ enabled: true, replyModelId: "gemma-4-e4b" });
    expect(states).toEqual(["downloading", "starting", "ready"]);
    expect(download).toHaveBeenCalledTimes(1);
    expect((download.mock.calls[0]![0] as ModelDescriptor).id).toBe("gemma-4-e4b");
    expect(progress).toEqual([{ bytes: 1, total: 2 }]);
  });

  it("download failure → failed with lastError, no server created", async () => {
    const { m, servers, states } = env({ installed: [], failDownload: true });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(states).toEqual(["downloading", "failed"]);
    expect(servers).toHaveLength(0);
    expect(m.lastError()).toBe("sha256 mismatch");
  });

  it("start failure → failed; the failed server was stopped", async () => {
    const { m, servers } = env({ failStart: true });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(m.getState()).toBe("failed");
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.lastError()).toContain("did not become healthy");
  });

  it("disabling stops the server and goes back to off", async () => {
    const { m, servers, states } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await m.apply({ enabled: false, replyModelId: "gemma-3-4b" });
    expect(servers[0]!.stopCalls).toBe(1);
    expect(states).toEqual(["starting", "ready", "off"]);
    expect(m.getEndpoint()).toBeNull();
  });

  it("changing the model stops the old server and starts a new one on the new path", async () => {
    const { m, servers } = env({ installed: ["gemma-3-4b-it-Q4_K_M.gguf", "gemma-4-E4B-it-Q4_K_M.gguf"] });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await m.apply({ enabled: true, replyModelId: "gemma-4-e4b" });
    expect(servers).toHaveLength(2);
    expect(servers[0]!.stopCalls).toBe(1);
    expect(servers[1]!.modelPath).toBe("/models/gemma-4-E4B-it-Q4_K_M.gguf");
    expect(m.getState()).toBe("ready");
  });

  it("re-applying identical preferences while ready does nothing", async () => {
    const { m, servers } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.startCalls).toBe(1);
  });

  it("an unknown model id → failed with lastError 'unknown reply model: <id>'", async () => {
    const { m } = env();
    await m.apply({ enabled: true, replyModelId: "qwen-3b" });
    expect(m.getState()).toBe("failed");
    expect(m.lastError()).toBe("unknown reply model: qwen-3b");
  });

  it("serializes concurrent apply() calls: the last one wins, no interleaving", async () => {
    const { m, servers } = env({ installed: ["gemma-3-4b-it-Q4_K_M.gguf", "gemma-4-E4B-it-Q4_K_M.gguf"] });
    await Promise.all([
      m.apply({ enabled: true, replyModelId: "gemma-3-4b" }),
      m.apply({ enabled: true, replyModelId: "gemma-4-e4b" }),
    ]);
    expect(servers.map((s) => s.modelPath)).toEqual(["/models/gemma-3-4b-it-Q4_K_M.gguf", "/models/gemma-4-E4B-it-Q4_K_M.gguf"]);
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.getState()).toBe("ready");
  });
});

describe("ReplyServerManager.recover (one automatic restart)", () => {
  it("restarts once after a request failure, then refuses and goes failed on the second", async () => {
    const { m, servers } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(await m.recover()).toBe(true);
    expect(servers).toHaveLength(2);
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.getState()).toBe("ready");
    expect(await m.recover()).toBe(false);
    expect(servers).toHaveLength(2);
    expect(m.getState()).toBe("failed");
    expect(m.lastError()).toBe("reply server restarted once already");
  });
  it("a fresh apply() resets the restart budget", async () => {
    const { m } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await m.recover();
    await m.apply({ enabled: false, replyModelId: "gemma-3-4b" });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(await m.recover()).toBe(true);
  });
  it("does nothing when off", async () => {
    const { m } = env();
    expect(await m.recover()).toBe(false);
    expect(m.getState()).toBe("off");
  });
});

describe("ReplyServerManager.stop", () => {
  it("stops a running server and reports off (used on will-quit)", async () => {
    const { m, servers } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    m.stop();
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.getState()).toBe("off");
  });
});

describe("ReplyServerManager — logging", () => {
  it("logs state transitions with state, modelId and ms only", async () => {
    const { m, logger } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    const metas = logger.info.mock.calls.map((c) => JSON.stringify(c));
    expect(metas.some((s) => s.includes('"state":"ready"'))).toBe(true);
    for (const s of metas) expect(s).not.toContain("/models/"); // paths are not needed in the log
  });
});
```

Run: `npx vitest run test/unit/reply-server-manager.test.ts` — Expected: FAIL, modulo non trovato.

- [ ] **Step 2: `src/main/reply-server-manager.ts`**

```typescript
import { getModelById } from "./model-catalog.js";
import type { ModelDescriptor } from "./utils/model-paths.js";
import type { ReplyServerState } from "../shared/reply-types.js";
import type { Logger } from "./logger.js";

/** The subset of LLMServer the manager needs; a factory builds the real one
 *  (port 18082, contextSize 3072, keepalive 20 s, warmupPrompt) in index.ts. */
export interface ReplyServerLike {
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
  getEndpoint(): string;
}

export interface ReplyModelManagerLike {
  isInstalled(desc: ModelDescriptor): Promise<boolean>;
  download(desc: ModelDescriptor, onProgress?: (p: { bytes: number; total: number }) => void): Promise<void>;
  getInstalledPath(desc: ModelDescriptor): string;
}

export interface ReplyServerManagerDeps {
  createServer: (modelPath: string) => ReplyServerLike;
  modelManager: ReplyModelManagerLike;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export interface ReplyServerPrefs { enabled: boolean; replyModelId: string }

/**
 * Lifecycle of the second llama-server, tied to the preference (spec §8):
 * off → nothing runs and no RAM is used; on → download if missing, then
 * start; off again → SIGTERM. One automatic restart after a request failure,
 * then `failed` until the user re-applies. All transitions are serialized.
 */
export class ReplyServerManager {
  private state: ReplyServerState = "off";
  private server: ReplyServerLike | null = null;
  private current: ReplyServerPrefs | null = null;
  private restarts = 0;
  private error: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly stateListeners: Array<(s: ReplyServerState) => void> = [];
  private readonly progressListeners: Array<(p: { bytes: number; total: number }) => void> = [];

  constructor(private readonly deps: ReplyServerManagerDeps) {}

  getState(): ReplyServerState { return this.state; }
  isReady(): boolean { return this.state === "ready" && this.server !== null && this.server.isRunning(); }
  getEndpoint(): string | null { return this.isReady() && this.server ? this.server.getEndpoint() : null; }
  lastError(): string | null { return this.error; }

  onStateChange(cb: (s: ReplyServerState) => void): () => void {
    this.stateListeners.push(cb);
    return () => { const i = this.stateListeners.indexOf(cb); if (i >= 0) this.stateListeners.splice(i, 1); };
  }
  onDownloadProgress(cb: (p: { bytes: number; total: number }) => void): () => void {
    this.progressListeners.push(cb);
    return () => { const i = this.progressListeners.indexOf(cb); if (i >= 0) this.progressListeners.splice(i, 1); };
  }

  /** Reconciles the running state with the preferences. Serialized. */
  apply(prefs: ReplyServerPrefs): Promise<void> {
    const job = this.queue.then(() => this.reconcile(prefs));
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** One automatic restart per apply(); false when refused or off. */
  recover(): Promise<boolean> {
    let result = false;
    const job = this.queue.then(async () => { result = await this.doRecover(); });
    this.queue = job.catch(() => undefined);
    return job.then(() => result);
  }

  /** Synchronous stop for will-quit. */
  stop(): void {
    this.stopServer();
    this.current = null;
    this.setState("off");
  }

  private setState(next: ReplyServerState, meta: Record<string, unknown> = {}): void {
    if (next === this.state && next !== "failed") return;
    this.state = next;
    void this.deps.logger.info("reply server state", { state: next, modelId: this.current?.replyModelId ?? null, ...meta });
    for (const l of this.stateListeners) l(next);
  }

  private stopServer(): void {
    if (this.server) { this.server.stop(); this.server = null; }
  }

  private async reconcile(prefs: ReplyServerPrefs): Promise<void> {
    if (!prefs.enabled) {
      if (this.server || this.state !== "off") { this.stopServer(); this.current = null; this.setState("off"); }
      this.current = null;
      return;
    }
    const same = this.current !== null && this.current.replyModelId === prefs.replyModelId && this.state === "ready";
    if (same) return;
    this.stopServer();
    this.current = { ...prefs };
    this.restarts = 0;
    this.error = null;
    const desc = getModelById("reply", prefs.replyModelId);
    if (!desc) { this.error = `unknown reply model: ${prefs.replyModelId}`; this.setState("failed"); return; }
    try {
      if (!(await this.deps.modelManager.isInstalled(desc))) {
        this.setState("downloading");
        const t0 = Date.now();
        await this.deps.modelManager.download(desc, (p) => { for (const l of this.progressListeners) l(p); });
        void this.deps.logger.info("reply model downloaded", { modelId: desc.id, ms: Date.now() - t0 });
      }
      await this.startServer(desc);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.stopServer();
      void this.deps.logger.error("reply server failed", { modelId: desc.id, message: this.error });
      this.setState("failed");
    }
  }

  private async startServer(desc: ModelDescriptor): Promise<void> {
    this.setState("starting");
    const t0 = Date.now();
    const server = this.deps.createServer(this.deps.modelManager.getInstalledPath(desc));
    this.server = server;
    try {
      await server.start();
    } catch (err) {
      server.stop();
      this.server = null;
      throw err;
    }
    this.setState("ready", { loadMs: Date.now() - t0 });
  }

  private async doRecover(): Promise<boolean> {
    if (!this.current || this.state === "off") return false;
    if (this.restarts >= 1) {
      this.error = "reply server restarted once already";
      this.stopServer();
      this.setState("failed");
      return false;
    }
    this.restarts += 1;
    const desc = getModelById("reply", this.current.replyModelId);
    if (!desc) return false;
    this.stopServer();
    try {
      await this.startServer(desc);
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.setState("failed");
      return false;
    }
  }
}
```

Run: `npx vitest run test/unit/reply-server-manager.test.ts` — Expected: PASS. Nota sul test "serializes concurrent apply": la seconda `apply` vede `current.replyModelId === "gemma-3-4b"` e `state === "ready"`, quindi ferma e riavvia; la sequenza dei server è deterministica grazie alla coda.

**Prova di rottura:** in `doRecover` cambia `this.restarts >= 1` in `>= 2` → il test "restarts once" fallisce; in `apply` sostituisci la coda con una chiamata diretta `return this.reconcile(prefs)` → il test "serializes" fallisce (interleaving). Ripristina e riporta.

- [ ] **Step 3: Lint, typecheck, test, commit**

```bash
grep -n "spawn(\|new LLMServer(\|from \"electron\"" src/main/reply-server-manager.ts ; echo "exit=$?"   # atteso exit=1
npm run lint && npm run typecheck && npm run test
git add src/main/reply-server-manager.ts test/unit/reply-server-manager.test.ts
git commit -m "feat(reply): reply-server manager tied to the preference, one automatic restart

Off means no process and no RAM (decision 3). Download on first enable,
restart on tier change, SIGTERM on disable and on quit. Transitions are
serialized so a fast toggle cannot interleave two starts. One automatic
recovery after a request failure, then failed until the user re-applies.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** i 15 test verdi; `ReplyServerManager` con `apply`, `recover`, `stop`, `getState`, `isReady`, `getEndpoint`, `lastError`, `onStateChange`, `onDownloadProgress`; nessun import di `electron` o `LLMServer`; prove di rottura riportate; lint/typecheck/test verdi.

---

## Task 6: `AxContextReader` — filtro delle app obbligatorio e cancello in due stadi

**Obiettivo:** rendere impossibile leggere il contesto di un'app che l'utente non ha permesso: il filtro diventa un parametro obbligatorio di `read()`, il confronto dei bundle id diventa case-insensitive nel wrapper, e la lettura avviene in due stadi in modo che la raccolta del testo parta solo dopo il permesso.

**Dipende da:** nessun task. (Non importa nulla dei Task 1-5: il filtro arriva dal chiamante, che sarà il Task 8.)

**Files:**
- Modify: `src/main/ax-context-reader.ts`
- Modify: `test/unit/ax-context-reader.test.ts`
- Modify: `tools/ax-context-probe.ts`

**Perché.** Il Piano A ha lasciato `bundleIdFilter?` opzionale in `ReadOptions`: `read()` senza argomenti legge **qualunque** app identificabile. Era deliberato — non esisteva un chiamante di produzione — e ora va chiuso (spec §Privacy 4, Global Constraint 14). Inoltre l'addon confronta i bundle id con `[NSSet containsObject:]`, che è **sensibile alle maiuscole**, mentre macOS li tratta case-insensitive: `Com.Apple.Mail` scritto dall'utente nelle preferenze non corrisponderebbe a `com.apple.mail`. `native/` è fuori ambito (Global Constraint 3), quindi la normalizzazione spetta al wrapper, che per farlo deve conoscere il bundle id **prima** di far raccogliere il testo. Da qui i due stadi (§Deviazioni 2).

- [ ] **Step 1: Test che falliscono**

In `test/unit/ax-context-reader.test.ts`, sostituisci `makeFakeNative` con la versione a due stadi (stesso nome, così i test esistenti cambiano solo per l'argomento `filter`) e aggiungi le costanti di filtro in testa al file, dopo gli import:

```typescript
import { type BundleIdFilter, isAppAllowed, normalizeBundleId, PROBE_FILTER } from "../../src/main/ax-context-reader.js";

const SLACK = "com.tinyspeck.slackmacgap";
const ALLOW_SLACK: BundleIdFilter = { mode: "allowlist", bundleIds: [SLACK] };
const ALLOW_SLACK_UPPER: BundleIdFilter = { mode: "allowlist", bundleIds: ["COM.TinySpeck.SlackMacGap"] };
const ALLOW_MAIL: BundleIdFilter = { mode: "allowlist", bundleIds: ["com.apple.mail"] };
const BLOCK_SLACK: BundleIdFilter = { mode: "blocklist", bundleIds: [" COM.TINYSPECK.SLACKMACGAP "] };
const BLOCK_MAIL: BundleIdFilter = { mode: "blocklist", bundleIds: ["com.apple.mail"] };

/**
 * Two-stage native double. Call 1 is the identification probe: it always
 * refuses with `app-not-allowed` (that is what an empty allowlist does in the
 * addon) and still reports pid + bundleId. Call 2 returns `result`.
 * `probeOver` lets a test bend the probe's answer (an unexpected success, a
 * different reason, an empty bundleId, levels that should be ignored).
 */
function makeFakeNative(result: NativeContextResult, trusted = true, probeOver: Partial<NativeContextResult> = {}) {
  const calls: ReadOptions[] = [];
  const native: AxContextNative = {
    readContextUnderCursor: (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return { ...result, ok: false, reason: "app-not-allowed", levels: [], chosenLevel: -1, ...probeOver };
      }
      return result;
    },
    activateApp: vi.fn(() => true),
    frontmostPid: vi.fn(() => 4242),
    isTrusted: () => trusted,
  };
  return { native, calls };
}
```

Poi **aggiorna i test esistenti** di `describe("AxContextReader.read")` e di `describe("AxContextReader — privacy")` così (nient'altro cambia in quei blocchi):

- ogni `.read()` diventa `.read(ALLOW_SLACK)`; ogni `.read({ textMarkers: true })` diventa `.read(ALLOW_SLACK, { textMarkers: true })`;
- `"passes the spec budgets to the addon by default"` → asserisce su **`fake.calls[1]`** (lo stadio 2) e diventa:

```typescript
  it("passes the spec budgets to the addon on both stages, with a synthesized filter", () => {
    const fake = makeFakeNative(okResult());
    new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(DEFAULT_READ_OPTIONS).toEqual({
      maxDepth: 8, maxTotalChars: 16_000, timeBudgetMs: 300, jumpRatio: 10, jumpMinChars: 400, textMarkers: false,
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toEqual({ ...DEFAULT_READ_OPTIONS, bundleIdFilter: { mode: "allowlist", bundleIds: [] } });
    expect(fake.calls[1]).toEqual({ ...DEFAULT_READ_OPTIONS, bundleIdFilter: { mode: "allowlist", bundleIds: [SLACK] } });
  });
```

- `"does not enable textMarkers unless the caller opts in"` → gli indici diventano `calls[1]` (prima lettura) e `calls[3]` (seconda lettura);
- `"computes wrapperMs …"` → clock a quattro valori e `probeMs` nelle timings:

```typescript
  it("computes wrapperMs over BOTH stages and reports probeMs separately", () => {
    const fake = makeFakeNative(okResult());
    const clock = [100, 110, 110, 137];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 137 }).read(ALLOW_SLACK);
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.timings).toEqual({ elementAtPositionMs: 31, collectMs: 23, totalMs: 60, probeMs: 10, wrapperMs: 37 });
  });
```

- `"rejects as 'timeout' …"` → `const clock = [0, 40, 40, 501]`; `"accepts a call that took exactly timeoutMs"` → `const clock = [0, 40, 40, 500]`;
- **cancella** `"forwards a bundleIdFilter untouched"`: il wrapper non inoltra più la lista del chiamante, ed è il nuovo test 3 a dirlo.

Aggiungi infine questi due `describe` nuovi:

```typescript
describe("isAppAllowed / normalizeBundleId", () => {
  it("normalizes case and surrounding whitespace, as macOS does", () => {
    expect(normalizeBundleId("  COM.Apple.Mail ")).toBe("com.apple.mail");
    expect(isAppAllowed("com.apple.mail", { mode: "allowlist", bundleIds: ["COM.APPLE.MAIL"] })).toBe(true);
    expect(isAppAllowed("COM.Apple.Mail", { mode: "allowlist", bundleIds: [" com.apple.mail "] })).toBe(true);
  });
  it("allowlist: only listed ids pass", () => {
    expect(isAppAllowed(SLACK, ALLOW_SLACK)).toBe(true);
    expect(isAppAllowed(SLACK, ALLOW_MAIL)).toBe(false);
    expect(isAppAllowed(SLACK, { mode: "allowlist", bundleIds: [] })).toBe(false);
  });
  it("blocklist: listed ids are refused, everything else passes", () => {
    expect(isAppAllowed(SLACK, BLOCK_SLACK)).toBe(false);
    expect(isAppAllowed(SLACK, BLOCK_MAIL)).toBe(true);
    expect(isAppAllowed(SLACK, { mode: "blocklist", bundleIds: [] })).toBe(true);
  });
  it("fails closed on an unidentifiable app, in BOTH modes", () => {
    for (const id of ["", "   "]) {
      expect(isAppAllowed(id, ALLOW_SLACK), id).toBe(false);
      expect(isAppAllowed(id, BLOCK_MAIL), id).toBe(false);
    }
  });
  it("PROBE_FILTER is an empty allowlist: the addon refuses every app with it", () => {
    expect(PROBE_FILTER).toEqual({ mode: "allowlist", bundleIds: [] });
  });
});

describe("AxContextReader.read — mandatory filter, two-stage gate", () => {
  it("calls the addon twice: an empty allowlist first, then the EXACT id the probe reported", () => {
    const fake = makeFakeNative(okResult());
    // The user typed the id with the wrong case; the addon compares
    // case-sensitively, so stage 2 must get the addon's own spelling back.
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK_UPPER);
    expect(r.ok).toBe(true);
    expect(fake.calls.map((c) => c.bundleIdFilter)).toEqual([
      { mode: "allowlist", bundleIds: [] },
      { mode: "allowlist", bundleIds: [SLACK] },
    ]);
  });

  it("the probe harvests nothing: its levels are never reported, even if the addon returns some", () => {
    const fake = makeFakeNative(okResult(), true, { levels: [lvl(0, 9999, ["testo raccolto per errore"])], bundleId: "com.apple.mail" });
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(r).toEqual({ ok: false, reason: "app-not-allowed", pid: 4242, bundleId: "com.apple.mail", levelSummary: [] });
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses an app outside the allowlist WITHOUT a second call", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_MAIL);
    expect(r).toEqual({ ok: false, reason: "app-not-allowed", pid: 4242, bundleId: SLACK, levelSummary: [] });
    expect(fake.calls).toHaveLength(1);
  });

  it("blocklist: a listed id is refused even with a different case; an unlisted one is read", () => {
    const blocked = makeFakeNative(okResult());
    expect(new AxContextReader({ native: blocked.native }).read(BLOCK_SLACK).ok).toBe(false);
    expect(blocked.calls).toHaveLength(1);
    const allowed = makeFakeNative(okResult());
    expect(new AxContextReader({ native: allowed.native }).read(BLOCK_MAIL).ok).toBe(true);
    expect(allowed.calls).toHaveLength(2);
  });

  it("fails closed when the probe reports an empty bundleId, in both modes", () => {
    for (const filter of [ALLOW_SLACK, BLOCK_MAIL]) {
      const fake = makeFakeNative(okResult(), true, { bundleId: "" });
      const r = new AxContextReader({ native: fake.native }).read(filter);
      expect(r.ok === false && r.reason, filter.mode).toBe("app-not-allowed");
      expect(fake.calls, filter.mode).toHaveLength(1);
    }
  });

  it("fails closed and logs an anomaly when the probe SUCCEEDS despite the empty allowlist", () => {
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(okResult(), true, { ok: true, reason: undefined, levels: okResult().levels, chosenLevel: 2 });
    const r = new AxContextReader({ native: fake.native, logger }).read(ALLOW_SLACK);
    expect(r).toEqual({ ok: false, reason: "app-not-allowed", pid: 4242, bundleId: SLACK, levelSummary: [] });
    expect(fake.calls).toHaveLength(1);
    expect(seen.join(" ")).toContain("anomaly");
    assertNoLeak(seen, CASES[0]!);
  });

  it("propagates a probe failure that is not app-not-allowed, without a second call", () => {
    for (const reason of ["no-element", "ax-error", "budget-exceeded"] as const) {
      const fake = makeFakeNative(okResult(), true, { reason });
      const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
      expect(r.ok === false && r.reason, reason).toBe(reason);
      expect(fake.calls, reason).toHaveLength(1);
    }
  });

  it("times out on the probe alone, without harvesting", () => {
    const fake = makeFakeNative(okResult());
    const clock = [0, 501, 501, 501];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 501 }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("timeout");
    expect(fake.calls).toHaveLength(1);
  });

  it("logs the filter as mode + size, never as the list of ids", () => {
    const { logger, seen } = makeSpyLogger();
    new AxContextReader({ native: makeFakeNative(okResult()).native, logger }).read({
      mode: "allowlist", bundleIds: [SLACK, "com.apple.mail", "com.brave.Browser"],
    });
    const all = seen.join(" ");
    expect(all).toContain('"filterMode":"allowlist"');
    expect(all).toContain('"filterSize":3');
    expect(all).not.toContain("com.apple.mail");
    expect(all).not.toContain("com.brave.Browser");
  });

  it("reports probeMs in the log meta of a refusal too (timings are null there)", () => {
    const { logger, seen } = makeSpyLogger();
    const clock = [0, 12, 12, 12];
    new AxContextReader({ native: makeFakeNative(okResult()).native, logger, now: () => clock.shift() ?? 12 }).read(ALLOW_MAIL);
    expect(seen.join(" ")).toContain('"probeMs":12');
  });
});
```

Run: `npx vitest run test/unit/ax-context-reader.test.ts` — Expected: FAIL (`isAppAllowed`/`normalizeBundleId`/`PROBE_FILTER` non esportati; `read` accetta ancora zero argomenti; una sola chiamata al nativo).

- [ ] **Step 2: `src/main/ax-context-reader.ts`**

Separa i budget dal filtro, così il tipo stesso impedisce una lettura senza filtro. Sostituisci `ReadOptions`, `DEFAULT_READ_OPTIONS` e la firma di `read`:

```typescript
/** The addon's budgets. Separated from the filter so DEFAULT_READ_OPTIONS
 *  cannot carry one: a read without a filter must not be expressible. */
export interface ReadBudgets {
  maxDepth: number;
  maxTotalChars: number;
  timeBudgetMs: number;
  jumpRatio: number;
  jumpMinChars: number;
  /** See the note below: off, and not to be turned on in Plan B. */
  textMarkers: boolean;
}

/** What the addon actually receives. The filter is mandatory: after Plan B
 *  there is no code path that harvests text before the app was permitted
 *  (spec §Privacy 4). */
export interface ReadOptions extends ReadBudgets {
  bundleIdFilter: BundleIdFilter;
}

export const DEFAULT_READ_OPTIONS: Readonly<ReadBudgets> = {
  maxDepth: 8,
  maxTotalChars: 16_000,
  timeBudgetMs: 300,
  jumpRatio: 10,
  jumpMinChars: 400,
  textMarkers: false,
};

/** Stage 1 filter. An empty allowlist matches nothing, so the addon refuses
 *  every app with `app-not-allowed` BEFORE it harvests anything — and its
 *  refusal still carries pid and bundleId. That is what makes the exact-case
 *  id available to stage 2 without touching native/ (§Deviazioni 2). */
export const PROBE_FILTER: Readonly<BundleIdFilter> = { mode: "allowlist", bundleIds: [] };

export function normalizeBundleId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * macOS treats bundle ids case-insensitively; the addon's [NSSet
 * containsObject:] does not. The wrapper owns the comparison.
 *
 * An app that reports no bundle id cannot be matched against either list, so
 * it is refused in BOTH modes: an unidentifiable app was never knowingly
 * permitted by the user, and `blocklist` must not become a way in.
 */
export function isAppAllowed(bundleId: string, filter: BundleIdFilter): boolean {
  const id = normalizeBundleId(bundleId);
  if (id.length === 0) return false;
  const listed = filter.bundleIds.some((b) => normalizeBundleId(b) === id);
  return filter.mode === "allowlist" ? listed : !listed;
}
```

`RawContext.timings` acquista `probeMs` (il costo dello stadio 1, misurato 28-49 ms nello spike):

```typescript
  timings: { elementAtPositionMs: number; collectMs: number; totalMs: number; probeMs: number; wrapperMs: number };
```

e `read` diventa:

```typescript
  /**
   * One read under the cursor, in two stages.
   *
   * Stage 1 asks the addon with an EMPTY allowlist: it refuses every app
   * before harvesting and reports pid + bundleId. Stage 2 runs only if the
   * wrapper, comparing case-insensitively, finds the app permitted — and it
   * passes back the addon's own spelling of the id, so the addon's
   * case-sensitive comparison agrees. Cost: one extra
   * AXUIElementCopyElementAtPosition (28-49 ms measured).
   *
   * `filter` is mandatory. The 500 ms outer timeout covers both stages: the
   * addon call is synchronous and cannot be interrupted, so an overrun is
   * rejected after the fact rather than trusted.
   */
  read(filter: BundleIdFilter, overrides: Partial<ReadBudgets> = {}): ReadContextResult {
    const budgets: ReadBudgets = { ...DEFAULT_READ_OPTIONS, ...overrides };
    const filterMeta = { filterMode: filter.mode, filterSize: filter.bundleIds.length };

    if (!this.native.isTrusted()) {
      const r: ReadContextResult = { ok: false, reason: "not-trusted", pid: -1, bundleId: "", levelSummary: [] };
      void this.logger?.warn("ax-context read blocked", { ...toLogMeta(r), ...filterMeta });
      return r;
    }

    // ── Stage 1: identify the app. No harvest happens here. ──
    const t0 = this.now();
    const probe = this.native.readContextUnderCursor({ ...budgets, bundleIdFilter: { mode: "allowlist", bundleIds: [] } });
    const probeMs = this.now() - t0;
    const refuse = (): ReadContextResult => ({
      ok: false, reason: "app-not-allowed", pid: probe.pid, bundleId: probe.bundleId, levelSummary: [],
    });

    if (probeMs > this.timeoutMs) {
      const r: ReadContextResult = { ok: false, reason: "timeout", pid: probe.pid, bundleId: probe.bundleId, levelSummary: [] };
      void this.logger?.info("ax-context read", { ...toLogMeta(r), ...filterMeta, probeMs });
      return r;
    }
    if (probe.ok) {
      // The addon did not refuse an empty allowlist, so it may also have
      // harvested text it was not allowed to. Its result is discarded and the
      // read fails closed; the anomaly is logged because it means the addon
      // and this wrapper disagree on the gate.
      void this.logger?.warn("ax-context probe anomaly: empty allowlist was not refused", { ...filterMeta, probeMs, pid: probe.pid, bundleId: probe.bundleId });
      return refuse();
    }
    if (probe.reason !== "app-not-allowed") {
      const r: ReadContextResult = {
        ok: false, reason: probe.reason ?? "ax-error", pid: probe.pid, bundleId: probe.bundleId, levelSummary: [],
      };
      void this.logger?.info("ax-context read", { ...toLogMeta(r), ...filterMeta, probeMs });
      return r;
    }
    if (!isAppAllowed(probe.bundleId, filter)) {
      const r = refuse();
      void this.logger?.info("ax-context read", { ...toLogMeta(r), ...filterMeta, probeMs });
      return r;
    }

    // ── Stage 2: permitted. Harvest. ──
    const opts: ReadOptions = { ...budgets, bundleIdFilter: { mode: "allowlist", bundleIds: [probe.bundleId] } };
    const t1 = this.now();
    const native = this.native.readContextUnderCursor(opts);
    const wrapperMs = probeMs + (this.now() - t1);
    const levelSummary = native.levels.map((l) => ({ depth: l.depth, chars: l.chars, n: l.fragments.length, truncated: l.truncated }));
    // …from here on the body is the one Plan A already has, unchanged except
    // that every `void this.logger?.…` call spreads `...filterMeta, probeMs`
    // after toLogMeta(r), and the success branch's timings are
    // `{ ...native.timings, probeMs, wrapperMs }`.
  }
```

Nota: `levelSummary: []` sui rifiuti dello stadio 1 è deliberato — per contratto lo stadio 1 non raccoglie, quindi non c'è niente da riassumere; se l'addon restituisse livelli comunque, vengono scartati (fail-closed anche sulle metriche).

- [ ] **Step 3: `tools/ax-context-probe.ts`**

Il probe non può più chiamare `read()` senza filtro. Non legge `prefs.replyApps` (il Task 6 non dipende dal Task 2): porta la lista come letterale, con `--allow` / `--block` per sovrascriverla.

1. Nell'header, sostituisci la riga d'uso con:
   ```
 *   npm run ax-probe -- [--user-name NAME] [--delay SECONDS] [--budget CHARS]
 *                       [--allow BUNDLE_ID[,…]] [--block BUNDLE_ID[,…]]
 *                       [--metrics-only] [--jump-ratio N] [--jump-min CHARS]
 *                       [--text-markers]
   ```
   e aggiungi: *"Il filtro è obbligatorio dopo il Task 6: senza `--allow`/`--block` vale la lista delle tre app verificate. Non esiste un `--allow-all`: la lettura senza filtro non è esprimibile."*
2. Aggiungi la costante, dopo `PREFS_PATH`:
   ```typescript
   /** The three apps measured in spike 1. Duplicated here as a literal on
    *  purpose: the probe must not depend on the preferences of Task 2. */
   const PROBE_DEFAULT_APPS = ["com.tinyspeck.slackmacgap", "com.apple.mail", "com.brave.Browser"];
   ```
3. In `options` di `parseArgs` aggiungi `block: { type: "string" }`.
4. Sostituisci il blocco `const filter = values.allow ? … : undefined; if (filter) overrides.bundleIdFilter = filter;` con:
   ```typescript
   const ids = (raw: string): string[] => raw.split(",").map((s) => s.trim()).filter(Boolean);
   if (values.allow !== undefined && values.block !== undefined) {
     console.error("--allow e --block sono alternativi: passane uno solo.");
     return 2;
   }
   const filter: BundleIdFilter = values.block !== undefined
     ? { mode: "blocklist", bundleIds: ids(values.block) }
     : { mode: "allowlist", bundleIds: values.allow !== undefined ? ids(values.allow) : PROBE_DEFAULT_APPS };
   ```
   con `BundleIdFilter` aggiunto agli import da `ax-context-reader.js` e `ReadOptions` sostituito da `ReadBudgets` nel tipo di `overrides`.
5. `const r = reader.read(overrides);` diventa `const r = reader.read(filter, overrides);`.
6. Dopo la riga `frontmost pid: …`, stampa il filtro in chiaro (il probe è lo strumento manuale, mostra tutto a chi l'ha chiesto):
   ```typescript
   console.log(`filtro: ${filter.mode} [${filter.bundleIds.join(", ")}]`);
   ```
   e nella riga dei livelli aggiungi `probeMs` alla diagnostica:
   ```typescript
   console.log(`  stadio 1 (identificazione): ${r.context.timings.probeMs.toFixed(1)} ms`);
   ```

Run: `npx vitest run test/unit/ax-context-reader.test.ts` — Expected: PASS (i test esistenti aggiornati + 15 nuovi).

**Prove di rottura (vincolo 7), tutte da riportare:**
1. In `isAppAllowed` togli i due `normalizeBundleId` (confronto diretto) → `"allows a bundle id that differs only in case"` e il blocklist con maiuscole diverse falliscono.
2. In `isAppAllowed` cambia `if (id.length === 0) return false;` in `return true;` → `"fails closed when the probe reports an empty bundleId"` fallisce.
3. In `read` salta lo stadio 1 (una sola chiamata con `bundleIdFilter: filter`) → `"calls the addon twice"`, `"the probe harvests nothing"` e `"refuses an app outside the allowlist WITHOUT a second call"` falliscono.
4. Nel ramo `if (probe.ok)` restituisci il contesto raccolto invece di `refuse()` → `"fails closed when the probe SUCCEEDS"` fallisce.
5. Nel log sostituisci `filterSize` con `bundleIds: filter.bundleIds` → `"logs the filter as mode + size"` fallisce.
Ripristina dopo ognuna e riporta le due esecuzioni.

- [ ] **Step 4: Verifiche di vincolo, lint, typecheck, test, commit**

```bash
grep -rn "readContextUnderCursor" src/                      # atteso: solo src/main/ax-context-reader.ts
grep -rn '\.read(' src/main/ | grep -v ax-context-reader.ts # atteso: nulla (il Task 8 aggiungerà reply-coordinator.ts)
grep -n "bundleIdFilter?" src/main/ax-context-reader.ts ; echo "exit=$?"   # atteso exit=1
git diff --name-only 2639447...HEAD | grep -E "^(native/|binding.gyp|scripts/)" ; echo "exit=$?"  # atteso exit=1
npm run lint && npm run typecheck && npm run test
git add src/main/ax-context-reader.ts test/unit/ax-context-reader.test.ts tools/ax-context-probe.ts
git commit -m "feat(reply): mandatory app filter and two-stage gate in AxContextReader

read(filter, overrides) can no longer be called without a filter: the type
separates budgets from the filter so a filterless read is not expressible
(spec privacy 4). The addon compares bundle ids case-sensitively and
native/ is out of scope, so the wrapper owns the comparison: stage 1 asks
with an empty allowlist, which the addon refuses for every app before
harvesting while still reporting pid and bundleId; stage 2 runs only if the
app is permitted, and passes back the addon's own spelling of the id.
Unidentifiable apps are refused in both modes, and a probe that
unexpectedly succeeds is discarded rather than trusted. Cost: one extra
AXUIElementCopyElementAtPosition, reported as probeMs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** `read` ha la firma `read(filter: BundleIdFilter, overrides?: Partial<ReadBudgets>)` e non compila senza filtro; `ReadOptions.bundleIdFilter` è obbligatorio; `DEFAULT_READ_OPTIONS` è un `ReadBudgets` senza filtro; `isAppAllowed`, `normalizeBundleId`, `PROBE_FILTER` esportati e coperti dalla tabella di test; due chiamate al nativo solo quando l'app è permessa, una sola altrimenti; `probeMs` nelle timings e nel log; il probe passa sempre un filtro; le cinque prove di rottura riportate; lint/typecheck/test verdi (≥ 293 + nuovi).

---

## Task 7: `computeOverlayBounds` e lo stato `suggesting` della pill

**Obiettivo:** la pill compare sul monitor del cursore (oggi esce sempre sul primario) e sa mostrare tre proposte con la riga del gist, gli stati intermedi e i flash neutri; la matematica del posizionamento vive in un modulo puro, testabile senza Electron.

**Dipende da:** Task 2 (`src/shared/reply-types.ts`, per `SuggestionPayload`).

**Files:**
- Create: `src/main/utils/overlay-bounds.ts`, `test/unit/overlay-bounds.test.ts`
- Modify: `src/main/overlay-window.ts`
- Modify: `src/renderer/overlay.html`, `src/renderer/overlay.css`
- Modify: `src/preload/overlay-preload.ts`
- Modify: `src/shared/ipc-channels.ts`

**Perché il modulo puro.** `overlay-window.ts` importa `electron` e non è istanziabile in Vitest. La scelta del display e le due formule sono l'unica logica del file: estratte in `utils/overlay-bounds.ts` diventano l'unica parte con test unitari (Global Constraint 4 e strato 1 della spec), e la finestra resta un guscio che chiama `screen.getAllDisplays()` / `screen.getCursorScreenPoint()` e passa i risultati.

- [ ] **Step 1: Test che falliscono**

Crea `test/unit/overlay-bounds.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  computeOverlayBounds, pickDisplay, PILL_WINDOW_SIZE, SUGGEST_WINDOW_SIZE, SHADOW_MARGIN,
  type DisplayLike,
} from "../../src/main/utils/overlay-bounds.js";

/** A 1512×982 laptop screen with the 25 px menubar excluded from the work area. */
const LAPTOP: DisplayLike = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 25, width: 1512, height: 957 },
};
/** An external 2560×1440 screen to the RIGHT of the laptop. */
const RIGHT: DisplayLike = {
  id: 2,
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1512, y: 25, width: 2560, height: 1415 },
};
/** An external 1920×1080 screen to the LEFT: negative coordinates. */
const LEFT: DisplayLike = {
  id: 3,
  bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -175, width: 1920, height: 1055 },
};

describe("PILL_WINDOW_SIZE / SUGGEST_WINDOW_SIZE / SHADOW_MARGIN", () => {
  it("are the sizes of the spec: 420x124 for the pill, 480x300 for the suggestions, 24 px of shadow", () => {
    expect(PILL_WINDOW_SIZE).toEqual({ width: 420, height: 124 });
    expect(SUGGEST_WINDOW_SIZE).toEqual({ width: 480, height: 300 });
    expect(SHADOW_MARGIN).toBe(24);
  });
});

describe("pickDisplay", () => {
  it("returns the display whose bounds contain the cursor", () => {
    expect(pickDisplay([LAPTOP, RIGHT, LEFT], { x: 700, y: 400 }).id).toBe(1);
    expect(pickDisplay([LAPTOP, RIGHT, LEFT], { x: 2000, y: 900 }).id).toBe(2);
    expect(pickDisplay([LAPTOP, RIGHT, LEFT], { x: -800, y: 300 }).id).toBe(3);
  });
  it("treats the right and bottom edges as belonging to the next display (half-open rectangles)", () => {
    expect(pickDisplay([LAPTOP, RIGHT], { x: 1512, y: 10 }).id).toBe(2);
    expect(pickDisplay([LAPTOP, RIGHT], { x: 1511, y: 10 }).id).toBe(1);
  });
  it("falls back to the nearest display when the cursor is in a gap between displays", () => {
    // A cursor 100 px above the top of both screens: nearest by clamped distance.
    expect(pickDisplay([LAPTOP, RIGHT], { x: 3000, y: -100 }).id).toBe(2);
    expect(pickDisplay([LAPTOP, RIGHT], { x: 10, y: -100 }).id).toBe(1);
  });
  it("throws RangeError on an empty display list", () => {
    expect(() => pickDisplay([], { x: 0, y: 0 })).toThrow(RangeError);
  });
});

describe("computeOverlayBounds", () => {
  it("centers the window on the work area and lets the shadow hang SHADOW_MARGIN below it", () => {
    expect(computeOverlayBounds([LAPTOP], { x: 700, y: 400 }, PILL_WINDOW_SIZE)).toEqual({
      x: 546,            // 0 + (1512 - 420) / 2
      y: 882,            // 25 + 957 - 124 + 24
      width: 420,
      height: 124,
      displayId: 1,
    });
  });

  it("uses the display the cursor is on, not the primary one (the two-monitor bug)", () => {
    const b = computeOverlayBounds([LAPTOP, RIGHT], { x: 2600, y: 700 }, PILL_WINDOW_SIZE);
    expect(b).toEqual({ x: 2582, y: 1340, width: 420, height: 124, displayId: 2 });
  });

  it("handles a display at negative coordinates", () => {
    const b = computeOverlayBounds([LAPTOP, LEFT], { x: -800, y: 300 }, PILL_WINDOW_SIZE);
    expect(b).toEqual({ x: -1170, y: 780, width: 420, height: 124, displayId: 3 });
  });

  it("uses the size it is given: the suggesting window is taller and wider", () => {
    const b = computeOverlayBounds([LAPTOP], { x: 700, y: 400 }, SUGGEST_WINDOW_SIZE);
    expect(b).toEqual({ x: 516, y: 706, width: 480, height: 300, displayId: 1 });
  });

  it("rounds to integers: Electron setBounds takes integers", () => {
    const odd: DisplayLike = { id: 9, bounds: { x: 0, y: 0, width: 1511, height: 900 }, workArea: { x: 0, y: 0, width: 1511, height: 900 } };
    expect(computeOverlayBounds([odd], { x: 5, y: 5 }, PILL_WINDOW_SIZE).x).toBe(546); // 545.5 → 546
  });

  it("never places the window left of or above the work area, even if it does not fit", () => {
    const tiny: DisplayLike = { id: 8, bounds: { x: 100, y: 100, width: 320, height: 200 }, workArea: { x: 100, y: 100, width: 320, height: 200 } };
    const b = computeOverlayBounds([tiny], { x: 150, y: 150 }, SUGGEST_WINDOW_SIZE);
    expect(b.x).toBe(100);
    expect(b.y).toBe(100);
  });

  it("throws RangeError on an empty display list", () => {
    expect(() => computeOverlayBounds([], { x: 0, y: 0 }, PILL_WINDOW_SIZE)).toThrow(RangeError);
  });
});
```

Run: `npx vitest run test/unit/overlay-bounds.test.ts` — Expected: FAIL, modulo non trovato.

- [ ] **Step 2: `src/main/utils/overlay-bounds.ts`**

```typescript
/**
 * Where the overlay window goes. Pure: no electron import, so it is testable
 * in Vitest (Global Constraint 4).
 *
 * The bug it fixes: overlay-window.ts positioned the pill from
 * `screen.getPrimaryDisplay()`, once, in create(). With two monitors the pill
 * came out on the primary screen no matter where the user was working, and it
 * never moved afterwards. The spec asks for
 * `getDisplayNearestPoint(getCursorScreenPoint())` recomputed at every
 * `show()`.
 *
 * `DisplayLike` is structurally what Electron's `Display` gives (`id`,
 * `bounds`, `workArea`), so the caller passes `screen.getAllDisplays()`
 * straight in.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayLike { id: number; bounds: Rect; workArea: Rect }
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface OverlayBounds extends Rect { displayId: number }

/** The dictation pill: 360×56 of visible pill inside a 420×124 window. */
export const PILL_WINDOW_SIZE: Readonly<Size> = { width: 420, height: 124 };
/** The suggesting state: gist row + three variant rows (spec §7). */
export const SUGGEST_WINDOW_SIZE: Readonly<Size> = { width: 480, height: 300 };
/** The window extends this far past the work-area bottom so the pill's
 *  box-shadow is not clipped; the CSS pulls the pill back up. */
export const SHADOW_MARGIN = 24;

/** Squared distance from `p` to the nearest point of `r`; 0 when inside. */
function distanceSquared(r: Rect, p: Point): number {
  const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.width ? p.x - (r.x + r.width) : 0;
  const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.height ? p.y - (r.y + r.height) : 0;
  return dx * dx + dy * dy;
}

function contains(r: Rect, p: Point): boolean {
  // Half-open on the right/bottom edges: with adjacent screens, x = 1512 is
  // the first column of the second screen, not the last of the first.
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

export function pickDisplay(displays: readonly DisplayLike[], cursor: Point): DisplayLike {
  if (displays.length === 0) throw new RangeError("pickDisplay: no displays");
  for (const d of displays) if (contains(d.bounds, cursor)) return d;
  // The cursor can sit in a gap (mismatched resolutions) or, briefly, outside
  // every screen: fall back to the nearest one instead of the primary.
  return displays.reduce((best, d) =>
    distanceSquared(d.bounds, cursor) < distanceSquared(best.bounds, cursor) ? d : best, displays[0]!); // length checked
}

/**
 * Bottom-center of the work area of the display under the cursor, with the
 * shadow margin hanging below. Clamped so the window never starts left of or
 * above the work area even when it is wider/taller than the screen.
 */
export function computeOverlayBounds(displays: readonly DisplayLike[], cursor: Point, size: Size): OverlayBounds {
  const display = pickDisplay(displays, cursor);
  const wa = display.workArea;
  const x = Math.max(wa.x, wa.x + Math.round((wa.width - size.width) / 2));
  const y = Math.max(wa.y, wa.y + wa.height - size.height + SHADOW_MARGIN);
  return { x, y, width: size.width, height: size.height, displayId: display.id };
}
```

Run: `npx vitest run test/unit/overlay-bounds.test.ts` — Expected: PASS (12 test).

**Prove di rottura:** in `pickDisplay` sostituisci il ciclo con `return displays[0]!` → `"uses the display the cursor is on"` e i tre casi di `pickDisplay` falliscono; in `computeOverlayBounds` togli `+ SHADOW_MARGIN` → il caso del centraggio fallisce su `y`; sostituisci `Math.round` con `Math.floor` → `"rounds to integers"` fallisce; togli i due `Math.max` → `"never places the window left of or above the work area"` fallisce. Ripristina e riporta.

- [ ] **Step 3: Canali IPC — `src/shared/ipc-channels.ts`**

```typescript
export const IpcChannels = {
  AudioChunk: "audio:chunk",
  AudioStart: "audio:start",
  AudioStop: "audio:stop",
  PipelineStateChange: "pipeline:state-change",
  PipelineCancel: "pipeline:cancel",
  PrefsGet: "prefs:get",
  PrefsSet: "prefs:set",
  ModelDownloadProgress: "model:download-progress",
  /** main → overlay: the payload of the suggesting state. */
  ReplySuggestions: "reply:suggestions",
  /** overlay → main: the user picked variant `id` (1, 2 or 3). */
  ReplyChoose: "reply:choose",
  /** overlay → main: the user closed the pill (✕ or Esc inside the pill). */
  ReplyDismiss: "reply:dismiss",
  /** main → overlay: neutral flash text (degradation L2/L3). Never a reason
   *  that would describe what was on screen (spec §Errori). */
  ReplyFlash: "reply:flash",
  /** overlay → main: the mouse entered the pill; resets the 20 s timer. */
  ReplyHover: "reply:hover",
} as const;
```

- [ ] **Step 4: `src/main/overlay-window.ts`**

Sostituisci l'import e il posizionamento; la finestra non registra listener IPC (li registra `index.ts` nel Task 9, come già fa per `pipeline:cancel`).

```typescript
import { BrowserWindow, screen } from "electron";
import { IpcChannels } from "../shared/ipc-channels.js";
import type { SuggestionPayload } from "../shared/reply-types.js";
import { computeOverlayBounds, PILL_WINDOW_SIZE, SUGGEST_WINDOW_SIZE, type Size } from "./utils/overlay-bounds.js";
```

Dentro la classe:

```typescript
export class OverlayWindow {
  private win: BrowserWindow | null = null;
  /** Current window size; `show()` re-centers at this size. */
  private size: Size = { ...PILL_WINDOW_SIZE };

  async create(): Promise<void> {
    const b = this.currentBounds();
    this.win = new BrowserWindow({
      width: b.width, height: b.height, x: b.x, y: b.y,
      // …every other option unchanged (frame:false, transparent, alwaysOnTop,
      // focusable:true + acceptFirstMouse:true, show:false, preload, …)
    });
    // …setVisibleOnAllWorkspaces / setAlwaysOnTop / loadFile unchanged
  }

  /** Fresh bounds for the CURRENT cursor position and window size. Called at
   *  every show(): the user changes monitor between one dictation and the next. */
  private currentBounds(): { x: number; y: number; width: number; height: number } {
    return computeOverlayBounds(screen.getAllDisplays(), screen.getCursorScreenPoint(), this.size);
  }

  private reposition(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const { x, y, width, height } = this.currentBounds();
    this.win.setBounds({ x, y, width, height });
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.reposition();
    this.win.showInactive();   // never steal focus: the paste must land in the target app
  }

  hide(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
    this.resetSize();          // the next dictation pill must not be 480×300
  }

  /** Enters the suggesting state: grows the window, sends the payload, shows. */
  showSuggestions(payload: SuggestionPayload): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.size = { ...SUGGEST_WINDOW_SIZE };
    this.win.webContents.send(IpcChannels.ReplySuggestions, payload);
    this.sendState("suggesting");
    this.show();
  }

  /** Back to the pill geometry, repositioning if the window is still visible. */
  resetSize(): void {
    this.size = { ...PILL_WINDOW_SIZE };
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.reposition();
  }

  /** Neutral one-line message (degradation L2/L3). The text comes from the
   *  coordinator's fixed table — never a code that describes the screen. */
  sendFlash(text: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(IpcChannels.ReplyFlash, text);
    this.sendState("flash");
    this.show();
  }

  sendState(state: string): void { /* unchanged, but uses IpcChannels.PipelineStateChange */ }
  sendPartial(text: string): void { /* unchanged */ }
  destroy(): void { /* unchanged */ }
}
```

- [ ] **Step 5: `src/preload/overlay-preload.ts`**

Aggiungi tre listener e tre invii, con `IpcChannels` (importalo: il preload è compilato da `tsconfig.preload.json`, che vede `src/shared`):

```typescript
  onSuggestions: (cb: (p: SuggestionPayload) => void): (() => void) => {
    const handler = (_e: unknown, p: SuggestionPayload) => cb(p);
    ipcRenderer.on(IpcChannels.ReplySuggestions, handler);
    return () => ipcRenderer.removeListener(IpcChannels.ReplySuggestions, handler);
  },
  onFlash: (cb: (text: string) => void): (() => void) => { /* same shape, IpcChannels.ReplyFlash */ },
  choose: (id: number): void => { ipcRenderer.send(IpcChannels.ReplyChoose, id); },
  dismiss: (): void => { ipcRenderer.send(IpcChannels.ReplyDismiss); },
  hover: (): void => { ipcRenderer.send(IpcChannels.ReplyHover); },
```

e le stesse cinque voci nel blocco `declare global { interface Window { openFlowOverlay: { … } } }`.

- [ ] **Step 6: `src/renderer/overlay.html`**

Il markup dello stato `suggesting` convive con la pill esistente: `#pill` è ciò che c'è oggi, `#suggest` è nuovo e nascosto salvo `state-suggesting`. **Il testo generato entra nel DOM solo con `textContent`**: mai `innerHTML`, mai `insertAdjacentHTML` — è testo di un modello, e la pill è una finestra con `contextIsolation` ma non è un posto dove interpretare markup.

```html
    <div id="root" class="state-idle">
      <div id="pill">
        <div class="dot"></div>
        <div class="content">
          <div class="label" id="label">Idle</div>
          <div class="partial" id="partial"></div>
        </div>
        <button id="cancel" type="button">✕</button>
      </div>
      <div id="suggest">
        <div class="gist" id="gist"></div>
        <div class="variants" id="variants"></div>
        <div class="hint">Esc per chiudere</div>
      </div>
    </div>
```

Nello script, estendi `TEXT` e aggiungi i tre handler:

```javascript
      const TEXT = {
        idle: "", recording: "Recording…", transcribing: "Transcribing…",
        cleaning: "Cleaning…", injecting: "Pasting…", error: "Error",
        reading: "Leggo il contesto…", thinking: "Preparo le risposte…",
        nothing: "Nessuna proposta", suggesting: "", flash: "",
      };
      const BADGES = ["⌘1", "⌘2", "⌘3"];
      const gistEl = document.getElementById("gist");
      const variantsEl = document.getElementById("variants");
      let suggesting = false;

      function clearSuggestions() {
        suggesting = false;
        gistEl.textContent = "";
        variantsEl.replaceChildren();
      }

      window.openFlowOverlay.onSuggestions((payload) => {
        suggesting = true;
        gistEl.textContent = payload.gist;
        const rows = payload.variants.map((v, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "variant";
          row.title = v.text;                 // full text on hover
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = BADGES[i] ?? "";
          const label = document.createElement("span");
          label.className = "vlabel";
          label.textContent = v.label;
          const text = document.createElement("span");
          text.className = "vtext";
          text.textContent = v.text;          // textContent, never innerHTML
          row.append(badge, label, text);
          row.addEventListener("click", () => window.openFlowOverlay.choose(v.id));
          return row;
        });
        variantsEl.replaceChildren(...rows);
      });

      window.openFlowOverlay.onFlash((text) => { labelEl.textContent = text; });

      // Any state other than suggesting drops the proposals: they are tied to
      // a moment, and nothing generated should linger in the DOM.
      window.openFlowOverlay.onState((state) => {
        if (state !== "suggesting") clearSuggestions();
        // …the existing body (label + className + partial reset) unchanged,
        // except that `flash` must NOT overwrite the label (onFlash owns it):
        //   if (state !== "flash") labelEl.textContent = TEXT[state] ?? state;
      });

      // The ✕ dismisses the suggestions when they are up, and cancels the
      // dictation pipeline otherwise.
      cancelBtn.addEventListener("click", () => {
        if (suggesting) window.openFlowOverlay.dismiss();
        else window.openFlowOverlay.cancel();
      });

      // Hovering the pill resets the 20 s auto-close timer (spec §7).
      document.getElementById("root").addEventListener("mouseenter", () => {
        if (suggesting) window.openFlowOverlay.hover();
      });
```

- [ ] **Step 7: `src/renderer/overlay.css`**

Le regole esistenti restano; `#root` perde le proprietà della pill, che passano a `#pill` (che oggi *è* `#root`), e si aggiungono le regole dello stato `suggesting`. Non toccare `preferences.css`.

```css
/* #root becomes the positioning shell; #pill keeps the pill's own look. */
#root { position: absolute; left: 50%; bottom: 30px; transform: translateX(-50%); }
#pill { display: flex; align-items: center; gap: 12px; padding: 12px 18px;
  background: rgba(30, 30, 32, 0.92); border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); color: #fff; font-size: 14px;
  height: 56px; width: 360px; transition: opacity 200ms ease; }

#suggest { display: none; width: 420px; padding: 14px 16px; color: #fff;
  background: rgba(30, 30, 32, 0.94); border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
.state-suggesting #pill { display: none; }
.state-suggesting #suggest { display: block; }
#suggest .gist { font-size: 13px; opacity: 0.9; margin-bottom: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#suggest .variants { display: flex; flex-direction: column; gap: 6px; }
button.variant { display: flex; align-items: flex-start; gap: 8px; width: 100%;
  text-align: left; background: rgba(255, 255, 255, 0.08); border: none;
  border-radius: 8px; padding: 7px 9px; color: #fff; font-size: 12px;
  font-family: inherit; cursor: pointer; }
button.variant:hover { background: rgba(255, 255, 255, 0.16); }
.variant .badge { flex-shrink: 0; opacity: 0.7; font-size: 11px; }
.variant .vlabel { flex-shrink: 0; opacity: 0.75; width: 104px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.variant .vtext { flex: 1; min-width: 0; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#suggest .hint { margin-top: 8px; font-size: 10px; opacity: 0.45; }
.state-reading .dot, .state-thinking .dot { background: #5e5ce6; animation: pulse 1s infinite; }
.state-nothing .dot, .state-flash .dot { background: #8e8e93; }
```

Run: `npx vitest run` — Expected: PASS, nessun test rotto (nessun test tocca l'HTML o la finestra).

- [ ] **Step 8: Verifica manuale del posizionamento (l'unica raggiungibile in questo task)**

Lo stato `suggesting` non ha ancora un chiamante (arriva nel Task 8), ma la correzione del monitor riguarda **anche gli stati di dettatura** ed è verificabile subito:

```bash
npm run build && npx electron dist/main/index.js
```

1. Con un solo schermo: detta una frase — la pill compare in basso al centro, come prima.
2. Con due schermi: porta il **mouse sul secondario**, detta — la pill compare **sul secondario**. Prima di questo task compariva sul primario. Ripeti spostando il mouse sul primario: la pill segue il cursore a ogni dettatura.
3. Con il monitor secondario posizionato **a sinistra** (coordinate negative) ripeti il punto 2.

Riporta l'esito dei tre punti nel messaggio di completamento: sono l'unica prova che `getPrimaryDisplay` non è più nel percorso (nessun test unitario può vederlo, perché richiederebbe Electron).

- [ ] **Step 9: Verifiche di vincolo, lint, typecheck, test, commit**

```bash
grep -ln "from \"electron\"" src/main/utils/overlay-bounds.ts ; echo "exit=$?"      # atteso exit=1
grep -n "getPrimaryDisplay" src/main/overlay-window.ts ; echo "exit=$?"             # atteso exit=1
grep -n "innerHTML\|insertAdjacentHTML" src/renderer/overlay.html ; echo "exit=$?"  # atteso exit=1
npm run lint && npm run typecheck && npm run test
git add src/main/utils/overlay-bounds.ts test/unit/overlay-bounds.test.ts src/main/overlay-window.ts src/renderer/overlay.html src/renderer/overlay.css src/preload/overlay-preload.ts src/shared/ipc-channels.ts
git commit -m "feat(overlay): suggesting state, neutral flash, and bounds on the cursor's display

computeOverlayBounds is a pure module so the display choice and the two
formulas have unit tests without Electron; the window became a shell that
recomputes bounds at every show(). With two monitors the pill used to come
out on the primary screen and stay there, because create() read
getPrimaryDisplay() once. The suggesting state renders the gist row and two
or three variant rows with the Command+1/2/3 badges; generated text enters
the DOM through textContent only, and any state other than suggesting
clears it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** `computeOverlayBounds(displays, cursor, size)` e `pickDisplay` esportati e coperti dai 12 test; `PILL_WINDOW_SIZE`/`SUGGEST_WINDOW_SIZE`/`SHADOW_MARGIN` esatti; `overlay-window.ts` senza `getPrimaryDisplay`, con `show()` che riposiziona e `showSuggestions`/`sendFlash`/`resetSize`; i cinque canali `reply:*` in `ipc-channels.ts` e le cinque voci nel preload; nessun `innerHTML` nel renderer; verifica manuale a due monitor riportata; prove di rottura riportate; lint/typecheck/test verdi.

---

## Task 8: `ReplyCoordinator` — orchestrazione, guardie, scorciatoie temporanee, accettazione

**Obiettivo:** il pezzo che tiene insieme tutto: le guardie che rendono l'astensione il comportamento normale, la sequenza hotkey → lettura → parser → classificatore → generatore → filtri → pill, le scorciatoie globali registrate **solo mentre la pill è visibile**, l'accettazione che riattiva l'app di destinazione e incolla, e la mutua esclusione con la dettatura.

**Dipende da:** Task 1 (`ClassifyInput`/`ClassifyResult`), Task 2 (`reply-types.ts`), Task 3 (`positionsFor`, `GenerateInput`/`GenerateResult`), Task 4 (`filterVariants`, `MIN_KEPT`, `toLogMeta`), Task 5 (`ReplyServerManager`, per il tipo delle sue tre funzioni usate), Task 6 (`read(filter, …)`), Task 7 (`SuggestionPayload` verso l'overlay). **Leggi anche il corpo del commit del Task 1**: se dice `MITIGAZIONE`, il pre-cancello deterministico va cablato (Step 5).

**Files:**
- Create: `src/main/reply-coordinator.ts`, `test/unit/reply-coordinator.test.ts`

**Decisioni non negoziabili che questo task attua**

1. **Selezione col mouse e con `Command+1/2/3`, `Esc` chiude.** La pill è mostrata con `showInactive()` per non rubare il focus all'app di destinazione — necessario, perché il `⌘V` finale deve arrivare *lì*. Una finestra inattiva non riceve eventi di tastiera: un `1` premuto finisce nell'app sotto. Quindi le scelte da tastiera sono **scorciatoie globali**, e un tasto nudo come `1` intercetterebbe la digitazione normale per tutta la durata della pill: da qui `Command+N`. Vengono registrate all'ingresso in `suggesting` e **deregistrate all'uscita, qualunque sia il motivo** (scelta, `Esc`, click su ✕, timeout 20 s, `arm` del PTT).
2. **Mutua esclusione con la dettatura.** La dettatura è "Hold Option" via il monitor nativo dei modificatori: le due cose non devono potersi sovrapporre. La hotkey è ignorata se la dettatura è in corso; un `arm` del PTT chiude la pill e annulla una corsa in volo.
3. **L'accettazione riusa `src/main/text-injector.ts`** (clipboard → `⌘V` → ripristino del clipboard precedente) tramite la dipendenza iniettata `inject`. `text-injector.ts` **non si tocca** (Global Constraint 3).
4. **Riattivazione dell'app di destinazione prima del paste**: il click sulla pill può aver attivato la finestra dell'overlay (`focusable: true` + `acceptFirstMouse: true`, necessari al ✕ esistente). Senza focus verificato, **solo clipboard**.
5. **Se sopravvivono meno di due varianti, la pill non compare.**
6. **Scostamento dichiarato in questo task (nuovo, non presente in §Deviazioni).** La spec elenca lo stato `reading` fra quelli *visibili*. Qui `reading` viene **emesso ma non mostrato**: mostrare la finestra dell'overlay prima della chiamata all'addon significherebbe, con il cursore in basso al centro, mettere la pill **sotto il puntatore** e far leggere all'addon l'overlay stesso invece della conversazione — con `bundleId` di open-flow, quindi `app-not-allowed`, quindi feature muta a seconda di dove sta il mouse. La lettura è sincrona e dura ~150 ms misurati: l'attesa percepibile è quella del modello, coperta da `thinking`, che viene mostrata. Il test 11 blocca l'ordine.

- [ ] **Step 1: Test che falliscono — armatura**

Crea `test/unit/reply-coordinator.test.ts`. Prima parte: fixture e fabbrica dell'ambiente.

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  ReplyCoordinator, hasExplicitProposal, FLASH_TEXT, TAIL_BUDGET_CHARS, TOTAL_TIMEOUT_MS,
  SUGGEST_TTL_MS, VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR, ERROR_PILL_MS,
  type ReplyCoordinatorDeps, type ReplyPrefsSnapshot,
} from "../../src/main/reply-coordinator.js";
import { MIN_KEPT, type FilterInput, type FilterOutput, type FilterVariant } from "../../src/main/utils/variant-filter.js";
import type { ReadContextResult } from "../../src/main/ax-context-reader.js";
import type { ParseInput, ParseResult } from "../../src/main/utils/conversation-parser.js";
import type { ClassifyResult } from "../../src/main/reply-classifier.js";
import type { GenerateResult } from "../../src/main/reply-generator.js";
import type { ReplyServerState, SuggestionPayload } from "../../src/shared/reply-types.js";
import { CASES, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";

const SLACK = "com.tinyspeck.slackmacgap";

const CONTEXT = {
  pid: 4242, bundleId: SLACK, editableFound: true, editableIsFocused: true, chosenLevel: 2,
  levelSummary: [{ depth: 2, chars: 3748, n: 4, truncated: false }],
  fragments: ["Marta: la review la fai tu o la giro a Paolo?"],
  markerText: null,
  timings: { elementAtPositionMs: 31, collectMs: 23, totalMs: 60, probeMs: 12, wrapperMs: 75 },
};
const READ_OK: ReadContextResult = { ok: true, context: CONTEXT };
const readFail = (reason: "no-editable" | "budget-exceeded" | "timeout" | "app-not-allowed" | "not-trusted", bundleId = SLACK): ReadContextResult =>
  ({ ok: false, reason, pid: 4242, bundleId, levelSummary: [] });

const CONVERSATION: ParseResult = {
  kind: "conversation",
  turns: [{ speaker: "Marta", role: "counterpart", text: "la review la fai tu o la giro a Paolo?" }],
  counterpart: "Marta",
  transcript: "INTERLOCUTORE (Marta): la review la fai tu o la giro a Paolo?",
  lastMessage: "la review la fai tu o la giro a Paolo?",
  gist: "Rispondi a Marta: la review la fai tu o la giro a Paolo?",
  languageGuess: "it",
  stats: { fragmentsIn: 1, fragmentsKept: 1, fragmentsDeduped: 1, turns: 1, speakers: 1, unattributedDropped: 0, transcriptChars: 60 },
};

const CLASSIFIED: ClassifyResult = {
  ok: true,
  classification: { answerable: true, kind: "alternative", alternatives: ["la fai tu", "la giro a Paolo"], language: "it" },
  durationMs: 210,
};

const THREE: FilterVariant[] = [
  { key: "first", label: "Scelgo: la fai tu", text: "La faccio io, la chiudo entro oggi pomeriggio." },
  { key: "second", label: "Scelgo: la giro a Paolo", text: "Meglio girarla a Paolo, io questa settimana non arrivo." },
  { key: "defer", label: "Rimando", text: "Fammi controllare l'agenda e ti dico entro stasera." },
];
const GENERATED: GenerateResult = { ok: true, variants: THREE, durationMs: 1400, completionTokens: 90 };

interface Over {
  prefs?: Partial<ReplyPrefsSnapshot>;
  serverState?: ReplyServerState;
  trusted?: boolean;
  frontmostPid?: number | (() => number);
  read?: ReadContextResult;
  parse?: ParseResult;
  classify?: ClassifyResult | Promise<ClassifyResult>;
  generate?: GenerateResult | Promise<GenerateResult>;
  kept?: FilterVariant[];
  dropped?: FilterOutput["dropped"];
  dictationBusy?: boolean;
  injectResult?: { pasted: boolean; reason?: string };
  preGate?: (lastMessage: string) => boolean;
  activateApp?: boolean;
  /** Deadline control: the promise returned for sleep(TOTAL_TIMEOUT_MS). */
  deadline?: Promise<void>;
}

function makeEnv(over: Over = {}) {
  const states: string[] = [];
  const flashes: string[] = [];
  const shown: SuggestionPayload[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const timers: Array<{ ms: number; cb: () => void; cancelled: boolean }> = [];
  const order: string[] = [];
  const seen: string[] = [];
  const logger = {
    info: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
    warn: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
    error: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
  };
  const front = typeof over.frontmostPid === "function" ? over.frontmostPid : () => over.frontmostPid ?? 4242;
  const reader = {
    isTrusted: vi.fn(() => over.trusted ?? true),
    frontmostPid: vi.fn(front),
    activateApp: vi.fn(() => over.activateApp ?? true),
    read: vi.fn(() => { order.push("read"); return over.read ?? READ_OK; }),
  };
  const overlay = {
    show: vi.fn(() => { order.push("show"); }),
    hide: vi.fn(() => { order.push("hide"); }),
    sendState: vi.fn((s: string) => { states.push(s); }),
    sendFlash: vi.fn((t: string) => { flashes.push(t); order.push("flash"); }),
    showSuggestions: vi.fn((p: SuggestionPayload) => { shown.push(p); order.push("suggest"); }),
    resetSize: vi.fn(),
  };
  const shortcuts = {
    register: vi.fn((a: string) => { registered.push(a); return true; }),
    unregister: vi.fn((a: string) => { unregistered.push(a); }),
  };
  const server = {
    isReady: () => (over.serverState ?? "ready") === "ready",
    getState: () => over.serverState ?? "ready",
    recover: vi.fn(async () => true),
  };
  const inject = vi.fn(async () => { order.push("inject"); return over.injectResult ?? { pasted: true }; });
  const copyToClipboard = vi.fn((_t: string) => { order.push("copy"); });
  const classify = vi.fn(async () => over.classify ?? CLASSIFIED);
  const generate = vi.fn(async () => over.generate ?? GENERATED);
  const filterVariants = vi.fn((input: FilterInput): FilterOutput => ({
    kept: over.kept ?? [...input.variants], dropped: over.dropped ?? [],
  }));
  const parse = vi.fn((_i: ParseInput): ParseResult => over.parse ?? CONVERSATION);
  const deps: ReplyCoordinatorDeps = {
    reader, overlay, shortcuts, server, inject, copyToClipboard, classify, generate, filterVariants, parse,
    loadPrefs: async () => ({ enabled: true, userDisplayName: "Danilo", appsMode: "allowlist", apps: [SLACK], ...over.prefs }),
    dictationBusy: () => over.dictationBusy ?? false,
    logger,
    onTrustRequired: vi.fn(),
    // Waits are injected: the flash delays, the 300 ms activation poll and the
    // 12 s deadline all go through here, so every test is deterministic.
    sleep: (ms: number) => (ms === TOTAL_TIMEOUT_MS && over.deadline ? over.deadline : Promise.resolve()),
    setTimer: (cb: () => void, ms: number) => {
      const t = { cb, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    ...(over.preGate ? { preGate: over.preGate } : {}),
  };
  return { c: new ReplyCoordinator(deps), deps, reader, overlay, shortcuts, server, inject, copyToClipboard,
           classify, generate, filterVariants, parse, states, flashes, shown, registered, unregistered, timers, order, seen, logger };
}

/** The reply flow logs through `logger`; nothing it passes may contain screen
 *  text or generated text (Global Constraint 10). */
function assertNoLeak(seen: readonly string[], ax: string): void {
  expect(seen.length).toBeGreaterThan(0);
  for (const line of seen) {
    expect(leaksScreenText(line, ax), line).toBe(false);
    expect(line.includes("ZQXV"), line).toBe(false);
  }
}
```

- [ ] **Step 2: Test che falliscono — le guardie e la sequenza**

```typescript
describe("ReplyCoordinator.onHotkey — guards (degradation L0/L2/L5)", () => {
  it("does nothing at all with the feature off: no read, no state, no flash", async () => {
    const e = makeEnv({ prefs: { enabled: false } });
    await e.c.onHotkey();
    expect(e.reader.read).not.toHaveBeenCalled();
    expect(e.states).toEqual([]);
    expect(e.flashes).toEqual([]);
    expect(e.seen.join(" ")).toContain('"reason":"disabled"');
  });

  it("ignores the hotkey while dictation is running (mutual exclusion with the PTT)", async () => {
    const e = makeEnv({ dictationBusy: true });
    await e.c.onHotkey();
    expect(e.reader.read).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"dictation-busy"');
  });

  it("ignores a second hotkey while it is already reading or thinking", async () => {
    let release: () => void = () => {};
    const pending = new Promise<ClassifyResult>((r) => { release = () => r(CLASSIFIED); });
    const e = makeEnv({ classify: pending });
    const first = e.c.onHotkey();
    await vi.waitFor(() => { expect(e.c.getState()).toBe("thinking"); });
    await e.c.onHotkey();
    expect(e.reader.read).toHaveBeenCalledTimes(1);
    expect(e.seen.join(" ")).toContain('"reason":"busy"');
    release();
    await first;
  });

  it("a second hotkey while suggesting closes the pill (toggle) and reads nothing new", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.c.getState()).toBe("suggesting");
    await e.c.onHotkey();
    expect(e.c.getState()).toBe("idle");
    expect(e.reader.read).toHaveBeenCalledTimes(1);
    expect(e.overlay.hide).toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"hotkey-toggle"');
  });

  it("flashes 'Modello in caricamento…' while the server is starting or downloading, and never reads", async () => {
    for (const state of ["starting", "downloading"] as const) {
      const e = makeEnv({ serverState: state });
      await e.c.onHotkey();
      expect(e.flashes, state).toEqual([FLASH_TEXT.modelLoading]);
      expect(e.reader.read, state).not.toHaveBeenCalled();
      expect(e.states.at(-1), state).toBe("idle");
    }
  });

  it("flashes 'Modello non disponibile' when the server failed, and stays silent when it is off", async () => {
    const failed = makeEnv({ serverState: "failed" });
    await failed.c.onHotkey();
    expect(failed.flashes).toEqual([FLASH_TEXT.modelFailed]);
    const off = makeEnv({ serverState: "off" });
    await off.c.onHotkey();
    expect(off.flashes).toEqual([]);
    expect(off.seen.join(" ")).toContain('"reason":"server-off"');
  });

  it("flashes the missing-name message when userDisplayName is empty (the parser cannot assign roles)", async () => {
    const e = makeEnv({ prefs: { userDisplayName: "   " } });
    await e.c.onHotkey();
    expect(e.flashes).toEqual([FLASH_TEXT.noUserName]);
    expect(e.reader.read).not.toHaveBeenCalled();
  });

  it("calls onTrustRequired without a flash when Accessibility is not granted (L5)", async () => {
    const e = makeEnv({ trusted: false });
    await e.c.onHotkey();
    expect(e.deps.onTrustRequired).toHaveBeenCalledTimes(1);
    expect(e.flashes).toEqual([]);
    expect(e.reader.read).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain("trust-required");
  });
});

describe("ReplyCoordinator.onHotkey — read stage", () => {
  it("passes the preferences' app filter to the reader, in the preference's mode", async () => {
    const e = makeEnv({ prefs: { appsMode: "blocklist", apps: ["com.apple.mail"] } });
    await e.c.onHotkey();
    expect(e.reader.read).toHaveBeenCalledWith({ mode: "blocklist", bundleIds: ["com.apple.mail"] });
  });

  it("never shows the overlay BEFORE the addon read: the pill must not become the element under the cursor", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.order.indexOf("read")).toBeGreaterThanOrEqual(0);
    expect(e.order.indexOf("read")).toBeLessThan(e.order.indexOf("show"));
  });

  it("app-not-allowed: L2 flash, the bundle id is remembered, nothing is parsed", async () => {
    const e = makeEnv({ read: readFail("app-not-allowed", "com.apple.Notes") });
    await e.c.onHotkey();
    expect(e.flashes).toEqual([FLASH_TEXT.appNotAllowed]);
    expect(e.c.lastBlockedBundleId()).toBe("com.apple.Notes");
    expect(e.parse).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"app-not-allowed"');
  });

  it("abstains with the neutral 'nothing' state on every other read failure", async () => {
    for (const reason of ["no-editable", "budget-exceeded", "timeout", "not-trusted"] as const) {
      const e = makeEnv({ read: readFail(reason) });
      await e.c.onHotkey();
      expect(e.states, reason).toEqual(["reading", "nothing", "idle"]);
      expect(e.flashes, reason).toEqual([]);   // the reason would describe the screen
      expect(e.seen.join(" "), reason).toContain(`"reason":"${reason}"`);
      expect(e.parse, reason).not.toHaveBeenCalled();
    }
  });

  it("abstains with not-frontmost when the element under the mouse belongs to another app", async () => {
    const e = makeEnv({ frontmostPid: 999 });
    await e.c.onHotkey();
    expect(e.states).toEqual(["reading", "nothing", "idle"]);
    expect(e.seen.join(" ")).toContain('"reason":"not-frontmost"');
    expect(e.parse).not.toHaveBeenCalled();
  });

  it("parses with the 2500-char tail budget and the userDisplayName of the preferences", async () => {
    const e = makeEnv({ prefs: { userDisplayName: "Danilo Franco" } });
    await e.c.onHotkey();
    expect(TAIL_BUDGET_CHARS).toBe(2_500);
    expect(e.parse).toHaveBeenCalledWith({
      fragments: CONTEXT.fragments, userDisplayName: "Danilo Franco", tailBudgetChars: 2_500,
    });
  });

  it("abstains on a parser abstention, with the reason as a code in the log", async () => {
    const e = makeEnv({ parse: { kind: "abstain", reason: "last-turn-is-user", stats: CONVERSATION.stats } });
    await e.c.onHotkey();
    expect(e.states).toEqual(["reading", "nothing", "idle"]);
    expect(e.classify).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"last-turn-is-user"');
  });
});

describe("ReplyCoordinator.onHotkey — model stages", () => {
  it("classifies with the parser's transcript, last message and counterpart", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.classify).toHaveBeenCalledWith({
      transcript: CONVERSATION.transcript, lastMessage: CONVERSATION.lastMessage, counterpart: CONVERSATION.counterpart,
    });
    expect(e.states.slice(0, 2)).toEqual(["reading", "thinking"]);
  });

  it("abstains without a pill when the classifier says not-answerable, and on invalid-classification", async () => {
    for (const reason of ["not-answerable", "invalid-classification"] as const) {
      const e = makeEnv({ classify: { ok: false, reason, durationMs: 180 } });
      await e.c.onHotkey();
      expect(e.generate, reason).not.toHaveBeenCalled();
      expect(e.shown, reason).toEqual([]);
      expect(e.states, reason).toEqual(["reading", "thinking", "nothing", "idle"]);
      expect(e.seen.join(" "), reason).toContain(`"reason":"${reason}"`);
    }
  });

  it("L4 on an llm-error: the error pill for 2 s and exactly one server recovery attempt", async () => {
    const e = makeEnv({ classify: { ok: false, reason: "llm-error", error: "reply LLM HTTP 503", durationMs: 40 } });
    await e.c.onHotkey();
    expect(e.states).toEqual(["reading", "thinking", "error", "idle"]);
    expect(e.server.recover).toHaveBeenCalledTimes(1);
    expect(ERROR_PILL_MS).toBe(2_000);
    expect(e.seen.join(" ")).toContain("reply LLM HTTP 503");   // a code, not a body
  });

  it("hands the generator the positions of the classified kind, the names, the subject and the language", async () => {
    const e = makeEnv({ parse: { ...CONVERSATION, subject: "Sopralluogo" }, prefs: { userDisplayName: "Danilo" } });
    await e.c.onHotkey();
    const arg = e.generate.mock.calls[0]![0] as { positions: Array<{ key: string }>; subject?: string; userDisplayName: string; counterpart: string; language: string };
    expect(arg.positions.map((p) => p.key)).toEqual(["first", "second", "defer"]);
    expect(arg.subject).toBe("Sopralluogo");
    expect(arg.userDisplayName).toBe("Danilo");
    expect(arg.counterpart).toBe("Marta");
    expect(arg.language).toBe("it");
  });

  it("uses the generic set when the classifier returned kind generic", async () => {
    const e = makeEnv({ classify: { ok: true, classification: { answerable: true, kind: "generic", language: "it" }, durationMs: 90 } });
    await e.c.onHotkey();
    const arg = e.generate.mock.calls[0]![0] as { positions: Array<{ key: string }> };
    expect(arg.positions.map((p) => p.key)).toEqual(["accept", "decline", "defer"]);
  });

  it("L4 on a generator llm-error, with one recovery attempt", async () => {
    const e = makeEnv({ generate: { ok: false, reason: "llm-error", error: "reply LLM request failed: TimeoutError", durationMs: 10_000 } });
    await e.c.onHotkey();
    expect(e.states).toEqual(["reading", "thinking", "error", "idle"]);
    expect(e.server.recover).toHaveBeenCalledTimes(1);
    expect(e.shown).toEqual([]);
  });

  it("filters with the parser's context and abstains with too-few-variants below MIN_KEPT", async () => {
    const e = makeEnv({ kept: [THREE[0]!], dropped: [{ key: "second", rule: "signature" }, { key: "defer", rule: "length" }] });
    await e.c.onHotkey();
    expect(MIN_KEPT).toBe(2);
    expect(e.shown).toEqual([]);
    expect(e.states).toEqual(["reading", "thinking", "nothing", "idle"]);
    const log = e.seen.join(" ");
    expect(log).toContain('"reason":"too-few-variants"');
    expect(log).toContain('"rule":"signature"');     // {key, rule} only
    expect(e.filterVariants).toHaveBeenCalledWith(expect.objectContaining({
      lastMessage: CONVERSATION.lastMessage, transcript: CONVERSATION.transcript,
      counterpart: "Marta", userDisplayName: "Danilo", language: "it",
    }));
  });

  it("shows three variants with the gist, numbered 1-3, and registers Command+1/2/3 plus Escape", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.shown).toEqual([{
      gist: CONVERSATION.gist,
      variants: [
        { id: 1, label: "Scelgo: la fai tu", text: THREE[0]!.text },
        { id: 2, label: "Scelgo: la giro a Paolo", text: THREE[1]!.text },
        { id: 3, label: "Rimando", text: THREE[2]!.text },
      ],
    }]);
    expect(e.registered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.c.getState()).toBe("suggesting");
    expect(e.states.at(-1)).toBe("thinking");   // showSuggestions owns the suggesting state
  });

  it("registers only as many Command+N as there are surviving variants", async () => {
    const e = makeEnv({ kept: [THREE[0]!, THREE[2]!] });
    await e.c.onHotkey();
    expect(e.shown[0]!.variants.map((v) => v.id)).toEqual([1, 2]);
    expect(e.registered).toEqual(["Command+1", "Command+2", ESCAPE_ACCELERATOR]);
  });

  it("keeps at most three variants even if the filter returned more", async () => {
    const e = makeEnv({ kept: [...THREE, { key: "extra", label: "Extra", text: "Una quarta variante che non deve arrivare alla pill." }] });
    await e.c.onHotkey();
    expect(e.shown[0]!.variants).toHaveLength(3);
  });

  it("abstains with timeout after TOTAL_TIMEOUT_MS and discards the late result", async () => {
    let expire: () => void = () => {};
    const deadline = new Promise<void>((r) => { expire = r; });
    let release: () => void = () => {};
    const slow = new Promise<GenerateResult>((r) => { release = () => r(GENERATED); });
    const e = makeEnv({ deadline, generate: slow });
    const run = e.c.onHotkey();
    expire();
    await run;
    expect(TOTAL_TIMEOUT_MS).toBe(12_000);
    expect(e.states).toEqual(["reading", "thinking", "nothing", "idle"]);
    expect(e.seen.join(" ")).toContain('"reason":"timeout"');
    release();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(e.shown).toEqual([]);   // the late generation must not raise a pill
  });
});
```

- [ ] **Step 3: Test che falliscono — ciclo di vita della pill e accettazione**

```typescript
describe("ReplyCoordinator — pill lifecycle", () => {
  it("Escape dismisses: every shortcut is unregistered, the size is reset, the pill hides", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    e.c.dismiss("esc");
    expect(e.unregistered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.overlay.resetSize).toHaveBeenCalled();
    expect(e.overlay.hide).toHaveBeenCalled();
    expect(e.c.getState()).toBe("idle");
    expect(e.seen.join(" ")).toContain('"reason":"esc"');
  });

  it("arms a 20 s auto-close timer; hover restarts it; dismissing cancels it", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.timers.filter((t) => t.ms === SUGGEST_TTL_MS)).toHaveLength(1);
    expect(SUGGEST_TTL_MS).toBe(20_000);
    e.c.onHover();
    expect(e.timers[0]!.cancelled).toBe(true);
    expect(e.timers.filter((t) => t.ms === SUGGEST_TTL_MS)).toHaveLength(2);
    e.c.dismiss("click");
    expect(e.timers[1]!.cancelled).toBe(true);
  });

  it("the 20 s timer dismisses the pill on its own", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    e.timers[0]!.cb();
    expect(e.c.getState()).toBe("idle");
    expect(e.unregistered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.seen.join(" ")).toContain('"reason":"timeout-ttl"');
  });

  it("a PTT arm while suggesting closes the pill and unregisters the temporary shortcuts", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    e.c.onDictationArm();
    expect(e.c.getState()).toBe("idle");
    expect(e.unregistered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.seen.join(" ")).toContain('"reason":"ptt-arm"');
  });

  it("a PTT arm during thinking aborts the run: no pill even when the model answers later", async () => {
    let release: () => void = () => {};
    const slow = new Promise<GenerateResult>((r) => { release = () => r(GENERATED); });
    const e = makeEnv({ generate: slow });
    const run = e.c.onHotkey();
    await vi.waitFor(() => { expect(e.c.getState()).toBe("thinking"); });
    e.c.onDictationArm();
    release();
    await run;
    expect(e.shown).toEqual([]);
    expect(e.c.getState()).toBe("idle");
  });

  it("hover and dismiss are no-ops when nothing is suggesting", () => {
    const e = makeEnv();
    e.c.onHover();
    e.c.dismiss("click");
    expect(e.unregistered).toEqual([]);
    expect(e.overlay.hide).not.toHaveBeenCalled();
  });
});

describe("ReplyCoordinator.accept", () => {
  it("Command+2 pastes the second variant: unregister → injecting → activateApp → inject", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    await e.c.accept(2);
    expect(e.unregistered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.reader.activateApp).toHaveBeenCalledWith(4242);
    expect(e.inject).toHaveBeenCalledWith(THREE[1]!.text);
    expect(e.copyToClipboard).not.toHaveBeenCalled();
    expect(e.states.slice(-2)).toEqual(["injecting", "idle"]);
    expect(e.order.indexOf("inject")).toBeGreaterThan(e.order.indexOf("suggest"));
    expect(e.c.getState()).toBe("idle");
    expect(e.seen.join(" ")).toContain('"result":"pasted"');
  });

  it("waits for the target app to come to the front before pasting (up to 300 ms)", async () => {
    // frontmostPid: the overlay stole the front on the click, then Slack returns.
    const answers = [4242, 777, 777, 4242];
    const e = makeEnv({ frontmostPid: () => answers.shift() ?? 4242 });
    await e.c.onHotkey();
    await e.c.accept(1);
    expect(e.inject).toHaveBeenCalledWith(THREE[0]!.text);
  });

  it("clipboard-only with the copy flash when the app never comes to the front (L3)", async () => {
    // 4242 for the initial frontmost check, then the overlay owns the front.
    let n = 0;
    const e = makeEnv({ frontmostPid: () => (n++ === 0 ? 4242 : 777), activateApp: false });
    await e.c.onHotkey();
    await e.c.accept(1);
    expect(e.copyToClipboard).toHaveBeenCalledWith(THREE[0]!.text);
    expect(e.inject).not.toHaveBeenCalled();
    expect(e.flashes).toEqual([FLASH_TEXT.copyOnly]);
    expect(e.seen.join(" ")).toContain('"reason":"activate-failed"');
  });

  it("clipboard-only when editableIsFocused was false: the ⌘V would land in an unverified field", async () => {
    const e = makeEnv({ read: { ok: true, context: { ...CONTEXT, editableIsFocused: false } } });
    await e.c.onHotkey();
    await e.c.accept(3);
    expect(e.copyToClipboard).toHaveBeenCalledWith(THREE[2]!.text);
    expect(e.inject).not.toHaveBeenCalled();
    expect(e.reader.activateApp).not.toHaveBeenCalled();
    expect(e.flashes).toEqual([FLASH_TEXT.copyOnly]);
    expect(e.seen.join(" ")).toContain('"reason":"editable-not-focused"');
  });

  it("shows the copy flash when the injector reports pasted:false (Accessibility lost mid-session)", async () => {
    const e = makeEnv({ injectResult: { pasted: false, reason: "osascript exited 1" } });
    await e.c.onHotkey();
    await e.c.accept(1);
    expect(e.flashes).toEqual([FLASH_TEXT.copyOnly]);   // TextInjector already left the text in the clipboard
    expect(e.copyToClipboard).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"paste-failed"');
  });

  it("ignores an unknown id and a choose that arrives when nothing is suggesting", async () => {
    const e = makeEnv();
    await e.c.accept(1);
    expect(e.inject).not.toHaveBeenCalled();
    await e.c.onHotkey();
    await e.c.accept(7);
    await e.c.accept(0);
    expect(e.inject).not.toHaveBeenCalled();
    expect(e.c.getState()).toBe("suggesting");
    expect(e.seen.join(" ")).toContain('"reason":"unknown-variant"');
  });

  it("a second accept after the first is ignored (the shortcuts are already gone)", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    await e.c.accept(1);
    await e.c.accept(2);
    expect(e.inject).toHaveBeenCalledTimes(1);
  });
});

describe("ReplyCoordinator — privacy (Global Constraint 10)", () => {
  it("logs codes, counts and timings only: never fragments, transcript, gist, names or variant text", async () => {
    const slack = CASES[0]!;   // slack-decisione
    const sentinel = (k: string, n: string): FilterVariant => ({ key: k, label: n, text: `ZQXV-VARIANT-TEXT ${n}` });
    const e = makeEnv({
      read: { ok: true, context: { ...CONTEXT, fragments: slack.ax.split("⋄").map((s) => s.trim()) } },
      parse: { ...CONVERSATION, transcript: `INTERLOCUTORE (Marta): ${slack.ax}`, lastMessage: slack.ax, gist: `Rispondi a Marta: ${slack.ax.slice(0, 60)}` },
      generate: { ok: true, variants: [sentinel("first", "uno"), sentinel("second", "due"), sentinel("defer", "tre")], durationMs: 1200, completionTokens: 88 },
    });
    await e.c.onHotkey();
    await e.c.accept(1);
    assertNoLeak(e.seen, slack.ax);
  });

  it("but the payload handed to the overlay DOES carry the text (so the test above discriminates)", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.shown[0]!.variants[0]!.text).toBe(THREE[0]!.text);
    expect(e.shown[0]!.gist).toBe(CONVERSATION.gist);
  });

  it("reads the screen only on the hotkey: no timer, no listener, ever calls read again", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    for (const t of e.timers) t.cb();
    e.c.onHover();
    e.c.onDictationArm();
    expect(e.reader.read).toHaveBeenCalledTimes(1);
  });
});

describe("hasExplicitProposal (deterministic scope pre-gate)", () => {
  it("recognizes modals, explicit alternatives and offer words", () => {
    for (const m of [
      "la review la fai tu o la giro a Paolo?",
      "ti va di fare un punto domani mattina?",
      "riusciamo a spostare il sopralluogo a venerdì?",
      "puoi dare un'occhiata al lockfile?",
      "Would you prefer Tuesday afternoon or Wednesday morning?",
      "le invio il preventivo aggiornato, resto a disposizione.",
      "Shall we go ahead with that proposal?",
    ]) expect(hasExplicitProposal(m), m).toBe(true);
  });
  it("rejects wh-questions that ask for information only the user has", () => {
    for (const m of [
      "a che ora arrivi domani in ufficio?",
      "dove hai messo il file con le misure?",
      "quante volte a settimana vai in palestra?",
      "What is the current status of the migration on your side?",
      "mi ricorda il nome dell'elettricista?",
    ]) expect(hasExplicitProposal(m), m).toBe(false);
  });
});

describe("ReplyCoordinator — pre-gate wiring", () => {
  it("abstains with no-explicit-proposal BEFORE the classifier when the pre-gate is wired and says no", async () => {
    const e = makeEnv({ preGate: () => false });
    await e.c.onHotkey();
    expect(e.classify).not.toHaveBeenCalled();
    expect(e.states).toEqual(["reading", "thinking", "nothing", "idle"]);
    expect(e.seen.join(" ")).toContain('"reason":"no-explicit-proposal"');
  });
  it("classifies normally when the pre-gate is absent, even on a message it would reject", async () => {
    const e = makeEnv({ parse: { ...CONVERSATION, lastMessage: "a che ora arrivi domani?" } });
    await e.c.onHotkey();
    expect(e.classify).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npx vitest run test/unit/reply-coordinator.test.ts` — Expected: FAIL, `Cannot find module '../../src/main/reply-coordinator.js'`.

- [ ] **Step 4: `src/main/reply-coordinator.ts`**

```typescript
import { positionsFor } from "./utils/reply-positions.js";
import { MIN_KEPT, toLogMeta as filterLogMeta, type FilterInput, type FilterOutput, type FilterVariant } from "./utils/variant-filter.js";
import { toLogMeta as parserLogMeta, type ParseInput, type ParseResult } from "./utils/conversation-parser.js";
import { toLogMeta as readerLogMeta, type BundleIdFilter, type ReadBudgets, type ReadContextResult } from "./ax-context-reader.js";
import type { ClassifyInput, ClassifyResult } from "./reply-classifier.js";
import type { GenerateInput, GenerateResult } from "./reply-generator.js";
import type { ReplyServerState, SuggestionPayload, SuggestionVariant } from "../shared/reply-types.js";
import type { Logger } from "./logger.js";

/** Budget handed to the parser (spec §3.8 / Global Constraint 15). */
export const TAIL_BUDGET_CHARS = 2_500;
/** Hotkey → pill. Beyond this the user has already started typing by hand. */
export const TOTAL_TIMEOUT_MS = 12_000;
/** The proposals are tied to a moment; after this the user has moved on. */
export const SUGGEST_TTL_MS = 20_000;
export const FLASH_NOTHING_MS = 1_000;
export const FLASH_INFO_MS = 1_500;
export const ERROR_PILL_MS = 2_000;
export const ACTIVATE_TIMEOUT_MS = 300;
export const ACTIVATE_POLL_MS = 50;
export const HIDE_DELAY_MS = 500;
export const MAX_VARIANTS = 3;

/** Registered on entering `suggesting`, unregistered on every exit. Command+N
 *  and not a bare 1/2/3: the pill is showInactive() so it receives no key
 *  events, the choice must be a global shortcut, and a global shortcut on a
 *  bare digit would eat the user's typing for the whole life of the pill. */
export const VARIANT_ACCELERATORS = ["Command+1", "Command+2", "Command+3"] as const;
export const ESCAPE_ACCELERATOR = "Escape";

/** Neutral, fixed strings. A flash NEVER carries the reason for an
 *  abstention: the reason would describe what was on screen (spec §Errori). */
export const FLASH_TEXT = {
  appNotAllowed: "App non abilitata — aggiungila nelle preferenze",
  modelLoading: "Modello in caricamento…",
  modelFailed: "Modello non disponibile",
  noUserName: "Imposta il tuo nome nelle preferenze",
  copyOnly: "Copiato — incolla con ⌘V",
} as const;

export type ReplyCoordinatorState = "idle" | "reading" | "thinking" | "suggesting" | "injecting";
export type DismissReason = "esc" | "click" | "hotkey-toggle" | "timeout-ttl" | "ptt-arm" | "quit";

export interface ReplyReaderLike {
  isTrusted(): boolean;
  frontmostPid(): number;
  activateApp(pid: number): boolean;
  read(filter: BundleIdFilter, overrides?: Partial<ReadBudgets>): ReadContextResult;
}
export interface ReplyOverlayLike {
  show(): void;
  hide(): void;
  sendState(state: string): void;
  sendFlash(text: string): void;
  showSuggestions(payload: SuggestionPayload): void;
  resetSize(): void;
}
export interface ReplyShortcutsLike {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
}
export interface ReplyServerStatusLike {
  isReady(): boolean;
  getState(): ReplyServerState;
  recover(): Promise<boolean>;
}
/** The five preferences the flow needs, read fresh at every hotkey so a change
 *  in the preferences window takes effect without a restart. */
export interface ReplyPrefsSnapshot {
  enabled: boolean;
  userDisplayName: string;
  appsMode: "allowlist" | "blocklist";
  apps: string[];
}

export interface ReplyCoordinatorDeps {
  reader: ReplyReaderLike;
  parse: (input: ParseInput) => ParseResult;
  classify: (input: ClassifyInput) => Promise<ClassifyResult>;
  generate: (input: GenerateInput) => Promise<GenerateResult>;
  filterVariants: (input: FilterInput) => FilterOutput;
  overlay: ReplyOverlayLike;
  shortcuts: ReplyShortcutsLike;
  server: ReplyServerStatusLike;
  /** TextInjector.inject: clipboard → ⌘V → restore (existing, untouched). */
  inject: (text: string) => Promise<{ pasted: boolean; reason?: string }>;
  /** Degradation L3: the text stays in the clipboard on purpose. */
  copyToClipboard: (text: string) => void;
  loadPrefs: () => Promise<ReplyPrefsSnapshot>;
  /** True while the dictation pipeline is not idle (mutual exclusion). */
  dictationBusy: () => boolean;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** L5: same dialog the PTT shows. */
  onTrustRequired?: () => void;
  /** Deterministic scope pre-gate, wired ONLY if the Task 1 experiment came
   *  out MITIGAZIONE. Absent means "the classifier is the only scope gate". */
  preGate?: (lastMessage: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Returns its own canceller, so tests need no fake timers. */
  setTimer?: (cb: () => void, ms: number) => () => void;
}

interface Pending {
  payload: SuggestionPayload;
  texts: string[];
  pid: number;
  editableIsFocused: boolean;
  accelerators: string[];
  cancelTtl: () => void;
}

async function raced<T>(work: Promise<T>, deadline: Promise<void>): Promise<{ ok: true; value: T } | { ok: false }> {
  return Promise.race([
    work.then((value) => ({ ok: true as const, value })),
    deadline.then(() => ({ ok: false as const })),
  ]);
}

/**
 * Deterministic pre-gate over the last message: does it contain an explicit
 * proposal (a modal, two explicit alternatives, an offer)? Regular
 * expressions cannot tell "ti va bene giovedì?" from "a che ora arrivi
 * giovedì?" in general — that is what the classifier is for — but they can
 * cheaply rule OUT messages that propose nothing. Wired only if the Task 1
 * experiment measured too many false positives on the "information only the
 * user has" cases; it costs false negatives, deliberately.
 */
const PROPOSAL_WORDS = /\b(puoi|riesci|te ne occupi|la fai|lo fai|ci pensi|confermi|va bene|d'accordo|ti va|possiamo|riusciamo|preferisci|preferisce|can you|could you|will you|would you|do you|are you|is it|shall we|preventivo|offerta|proposta|quotazione|quote|proposal|estimate)\b/iu;
const ALTERNATIVE_HINT = /\s(?:o|oppure|or)\s/iu;

export function hasExplicitProposal(lastMessage: string): boolean {
  if (PROPOSAL_WORDS.test(lastMessage)) return true;
  return lastMessage.includes("?") && ALTERNATIVE_HINT.test(lastMessage);
}

/**
 * The one production call site of AxContextReader.read (Global Constraint 5,
 * spec privacy 3): nothing else in the app reads the screen, and it happens
 * only inside onHotkey.
 */
export class ReplyCoordinator {
  private state: ReplyCoordinatorState = "idle";
  /** Bumped on every hotkey, dismiss, accept and PTT arm; an async step whose
   *  epoch no longer matches drops its result instead of raising a pill. */
  private epoch = 0;
  private pending: Pending | null = null;
  private blockedBundleId: string | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (cb: () => void, ms: number) => () => void;

  constructor(private readonly deps: ReplyCoordinatorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.setTimer = deps.setTimer ?? ((cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); });
  }

  getState(): ReplyCoordinatorState { return this.state; }
  isBusy(): boolean { return this.state !== "idle"; }
  /** For the preferences window's "Add <bundleId>" button (§Deviazioni 3). */
  lastBlockedBundleId(): string | null { return this.blockedBundleId; }

  async onHotkey(): Promise<void> {
    if (this.state === "suggesting") { this.dismiss("hotkey-toggle"); return; }
    if (this.state !== "idle") { void this.ignored("busy"); return; }

    const prefs = await this.deps.loadPrefs();
    if (!prefs.enabled) { void this.ignored("disabled"); return; }
    if (this.deps.dictationBusy()) { void this.ignored("dictation-busy"); return; }

    const serverState = this.deps.server.getState();
    if (!this.deps.server.isReady()) {
      if (serverState === "starting" || serverState === "downloading") return this.blocked("server-not-ready", FLASH_TEXT.modelLoading, { serverState });
      if (serverState === "failed") return this.blocked("server-failed", FLASH_TEXT.modelFailed, { serverState });
      void this.ignored("server-off");
      return;
    }
    if (prefs.userDisplayName.trim().length === 0) return this.blocked("no-user-name", FLASH_TEXT.noUserName);
    if (!this.deps.reader.isTrusted()) {
      void this.deps.logger.warn("reply trust-required", { reason: "trust-required" });
      this.deps.onTrustRequired?.();
      return;
    }

    const epoch = ++this.epoch;
    const deadline = this.sleep(TOTAL_TIMEOUT_MS);
    this.state = "reading";
    // `reading` is emitted but the window is NOT shown yet: the pill sits
    // bottom-center, and showing it before the addon call would put it under
    // the cursor — the addon would then read the overlay (bundle id of
    // open-flow → app-not-allowed) instead of the conversation. The read is
    // synchronous and ~150 ms measured; the wait worth showing is `thinking`.
    this.deps.overlay.sendState("reading");

    const frontBefore = this.deps.reader.frontmostPid();
    const filter: BundleIdFilter = { mode: prefs.appsMode, bundleIds: prefs.apps };
    const read = this.deps.reader.read(filter);
    if (!read.ok) {
      if (read.reason === "app-not-allowed") {
        this.blockedBundleId = read.bundleId;
        return this.blocked("app-not-allowed", FLASH_TEXT.appNotAllowed, { bundleId: read.bundleId });
      }
      return this.abstain(read.reason, epoch, readerLogMeta(read));
    }
    const ctx = read.context;
    if (ctx.pid !== frontBefore) {
      // Reading a background window and pasting into the active app would be
      // the worst possible mistake (spec §9.2).
      return this.abstain("not-frontmost", epoch, { pid: ctx.pid, frontmostPid: frontBefore, bundleId: ctx.bundleId });
    }

    const parsed = this.deps.parse({ fragments: ctx.fragments, userDisplayName: prefs.userDisplayName, tailBudgetChars: TAIL_BUDGET_CHARS });
    if (parsed.kind === "abstain") return this.abstain(parsed.reason, epoch, parserLogMeta(parsed));

    this.state = "thinking";
    this.deps.overlay.sendState("thinking");
    this.deps.overlay.show();

    if (this.deps.preGate && !this.deps.preGate(parsed.lastMessage)) {
      return this.abstain("no-explicit-proposal", epoch, parserLogMeta(parsed));
    }

    const cls = await raced(this.deps.classify({
      transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
    }), deadline);
    if (epoch !== this.epoch) return;
    if (!cls.ok) return this.abstain("timeout", epoch);
    if (!cls.value.ok) {
      if (cls.value.reason === "llm-error") return this.serverError(cls.value.error, epoch);
      return this.abstain(cls.value.reason, epoch, { durationMs: cls.value.durationMs });
    }
    const classification = cls.value.classification;

    const positions = positionsFor({
      kind: classification.kind, language: classification.language,
      ...(classification.alternatives ? { alternatives: classification.alternatives } : {}),
    });
    const genInput: GenerateInput = {
      transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
      userDisplayName: prefs.userDisplayName, subject: parsed.subject, positions, language: classification.language,
    };
    const gen = await raced(this.deps.generate(genInput), deadline);
    if (epoch !== this.epoch) return;
    if (!gen.ok) return this.abstain("timeout", epoch);
    if (!gen.value.ok) return this.serverError(gen.value.error, epoch);

    const filtered = this.deps.filterVariants({
      variants: gen.value.variants, lastMessage: parsed.lastMessage, transcript: parsed.transcript,
      counterpart: parsed.counterpart, userDisplayName: prefs.userDisplayName, language: classification.language,
    });
    void this.deps.logger.info("reply filter", { ...filterLogMeta(filtered), kind: classification.kind });
    if (filtered.kept.length < MIN_KEPT) {
      // One proposal is not a choice, and reads as an authoritative
      // suggestion: no pill at all (decision 6).
      return this.abstain("too-few-variants", epoch, filterLogMeta(filtered));
    }

    this.showSuggestions(filtered.kept.slice(0, MAX_VARIANTS), parsed.gist, ctx.pid, ctx.editableIsFocused, {
      kind: classification.kind, language: classification.language,
    });
  }

  private showSuggestions(kept: readonly FilterVariant[], gist: string, pid: number, editableIsFocused: boolean, meta: Record<string, unknown>): void {
    const variants: SuggestionVariant[] = kept.map((v, i) => ({ id: (i + 1) as 1 | 2 | 3, label: v.label, text: v.text }));
    const payload: SuggestionPayload = { gist, variants };
    const accelerators = [...VARIANT_ACCELERATORS.slice(0, variants.length), ESCAPE_ACCELERATOR];
    const cancelTtl = this.setTimer(() => this.dismiss("timeout-ttl"), SUGGEST_TTL_MS);
    this.pending = { payload, texts: kept.map((v) => v.text), pid, editableIsFocused, accelerators, cancelTtl };
    this.state = "suggesting";
    for (const [i, acc] of accelerators.entries()) {
      const ok = i < variants.length
        ? this.deps.shortcuts.register(acc, () => { void this.accept(i + 1); })
        : this.deps.shortcuts.register(acc, () => { this.dismiss("esc"); });
      if (!ok) void this.deps.logger.warn("reply shortcut not registered", { accelerator: acc });
    }
    this.deps.overlay.showSuggestions(payload);
    void this.deps.logger.info("reply suggesting", { ...meta, variants: variants.length, gistChars: gist.length, pid, editableIsFocused });
  }

  /** The user picked variant `id` (1-based), by mouse or by Command+N. */
  async accept(id: number): Promise<void> {
    const pending = this.pending;
    if (this.state !== "suggesting" || !pending) { void this.ignored("not-suggesting"); return; }
    const text = pending.texts[id - 1];
    if (text === undefined) { void this.ignored("unknown-variant"); return; }

    const epoch = ++this.epoch;
    this.releasePending("accept");
    this.state = "injecting";
    this.deps.overlay.resetSize();
    this.deps.overlay.sendState("injecting");

    if (!pending.editableIsFocused) {
      // The field was found through AXEditableAncestor and is NOT the focused
      // one: a ⌘V would land somewhere we never verified (spec §9.3).
      return this.degradeToClipboard(text, "editable-not-focused", epoch);
    }
    this.deps.reader.activateApp(pending.pid);
    if (!(await this.waitForFrontmost(pending.pid))) {
      return this.degradeToClipboard(text, "activate-failed", epoch);
    }
    const result = await this.deps.inject(text);
    if (!result.pasted) {
      // TextInjector already left the text in the clipboard on failure.
      void this.deps.logger.warn("reply inject failed", { reason: "paste-failed", chars: text.length });
      return this.flashThenIdle(FLASH_TEXT.copyOnly, FLASH_INFO_MS, epoch);
    }
    void this.deps.logger.info("reply accepted", { result: "pasted", variant: id, chars: text.length, pid: pending.pid });
    await this.toIdle(epoch, HIDE_DELAY_MS);
  }

  /** Closes the pill for any reason; always releases the shortcuts. */
  dismiss(reason: DismissReason): void {
    if (this.state !== "suggesting" || !this.pending) return;
    this.epoch += 1;
    this.releasePending(reason);
    this.state = "idle";
    this.deps.overlay.resetSize();
    this.deps.overlay.sendState("idle");
    this.deps.overlay.hide();
  }

  /** The mouse entered the pill: restart the 20 s auto-close (spec §7). */
  onHover(): void {
    if (this.state !== "suggesting" || !this.pending) return;
    this.pending.cancelTtl();
    this.pending.cancelTtl = this.setTimer(() => this.dismiss("timeout-ttl"), SUGGEST_TTL_MS);
  }

  /** The user pressed Option to dictate: dictation wins, always. */
  onDictationArm(): void {
    if (this.state === "suggesting") { this.dismiss("ptt-arm"); return; }
    if (this.state === "idle") return;
    this.epoch += 1;
    this.state = "idle";
    this.deps.overlay.resetSize();
    void this.deps.logger.info("reply ignored", { reason: "ptt-arm" });
  }

  private releasePending(reason: string): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    pending.cancelTtl();
    for (const acc of pending.accelerators) this.deps.shortcuts.unregister(acc);
    void this.deps.logger.info("reply dismissed", { reason });
  }

  private async waitForFrontmost(pid: number): Promise<boolean> {
    for (let waited = 0; waited <= ACTIVATE_TIMEOUT_MS; waited += ACTIVATE_POLL_MS) {
      if (this.deps.reader.frontmostPid() === pid) return true;
      await this.sleep(ACTIVATE_POLL_MS);
    }
    return this.deps.reader.frontmostPid() === pid;
  }

  private async degradeToClipboard(text: string, reason: string, epoch: number): Promise<void> {
    this.deps.copyToClipboard(text);
    void this.deps.logger.info("reply accepted", { result: "clipboard-only", reason, chars: text.length });
    await this.flashThenIdle(FLASH_TEXT.copyOnly, FLASH_INFO_MS, epoch);
  }

  private async abstain(reason: string, epoch: number, meta: Record<string, unknown> = {}): Promise<void> {
    void this.deps.logger.info("reply abstain", { reason, ...meta });
    if (epoch !== this.epoch) return;
    this.state = "idle";
    this.deps.overlay.sendState("nothing");
    this.deps.overlay.show();
    await this.toIdle(epoch, FLASH_NOTHING_MS);
  }

  private async blocked(reason: string, text: string, meta: Record<string, unknown> = {}): Promise<void> {
    void this.deps.logger.info("reply blocked", { reason, ...meta });
    const epoch = ++this.epoch;
    this.state = "idle";
    await this.flashThenIdle(text, FLASH_INFO_MS, epoch);
  }

  private async serverError(error: string, epoch: number): Promise<void> {
    void this.deps.logger.error("reply server error", { reason: "llm-error", error });
    void this.deps.server.recover();
    if (epoch !== this.epoch) return;
    this.state = "idle";
    this.deps.overlay.sendState("error");
    this.deps.overlay.show();
    await this.toIdle(epoch, ERROR_PILL_MS);
  }

  private async flashThenIdle(text: string, ms: number, epoch: number): Promise<void> {
    this.deps.overlay.sendFlash(text);
    await this.toIdle(epoch, ms);
  }

  private async toIdle(epoch: number, afterMs: number): Promise<void> {
    await this.sleep(afterMs);
    if (epoch !== this.epoch) return;
    this.state = "idle";
    this.deps.overlay.sendState("idle");
    this.deps.overlay.hide();
  }

  private async ignored(reason: string): Promise<void> {
    void this.deps.logger.info("reply ignored", { reason });
  }
}
```

Note sull'ordine degli stati: `abstain` manda `nothing` e poi `idle`; `blocked` manda solo il flash (lo stato `flash` lo manda `OverlayWindow.sendFlash`, che nei test è uno stub, quindi la sequenza asserita è `[…, "idle"]`); `showSuggestions` non manda `"suggesting"` — lo fa `OverlayWindow.showSuggestions` (Task 7).

Run: `npx vitest run test/unit/reply-coordinator.test.ts` — Expected: PASS (46 test).

- [ ] **Step 5: Se il Task 1 ha deciso `MITIGAZIONE`**

Il pre-cancello è già scritto (`hasExplicitProposal`) e già cablabile (`deps.preGate`). Non cambiare nulla qui: il Task 9 lo passa o non lo passa. Riporta nel messaggio di completamento **quale delle due strade** il commit del Task 1 impone, perché il Task 9 la deve leggere.

- [ ] **Step 6: Prove di rottura (vincolo 7), tutte da riportare**

1. In `onHotkey` sposta `this.deps.overlay.show()` prima di `this.deps.reader.read(filter)` → il test 11 (`"never shows the overlay BEFORE the addon read"`) fallisce.
2. Cambia `filtered.kept.length < MIN_KEPT` in `=== 0` → `"abstains with too-few-variants"` fallisce (comparirebbe una pill con una sola proposta).
3. In `releasePending` togli il ciclo di `unregister` → i test di `Escape`, del timer 20 s, del `ptt-arm` e dell'accettazione falliscono.
4. In `accept` togli il ramo `if (!pending.editableIsFocused)` → `"clipboard-only when editableIsFocused was false"` fallisce.
5. In `accept` sostituisci `await this.waitForFrontmost(...)` con `true` → `"clipboard-only when the app never comes to the front"` fallisce.
6. Rimuovi il controllo `if (epoch !== this.epoch) return;` dopo il generatore → `"a PTT arm during thinking aborts the run"` e `"discards the late result"` falliscono.
7. In `abstain` aggiungi `lastMessage` al meta → il test privacy fallisce.
8. In `showSuggestions` aggiungi `texts: payload.variants.map((v) => v.text)` al log → il test privacy fallisce sulla sentinella `ZQXV`.
9. Togli `if (this.deps.dictationBusy())` → il test di mutua esclusione fallisce.
Ripristina dopo ognuna.

- [ ] **Step 7: Verifiche di vincolo, lint, typecheck, test, commit**

```bash
grep -ln "from \"electron\"" src/main/reply-coordinator.ts ; echo "exit=$?"                 # atteso exit=1
grep -ln "node:fs\|writeFile\|appendFile" src/main/reply-coordinator.ts ; echo "exit=$?"    # atteso exit=1
grep -rn '\.read(' src/main/ | grep -v ax-context-reader.ts                                  # atteso: solo reply-coordinator.ts
grep -n "setInterval\|setImmediate" src/main/reply-coordinator.ts ; echo "exit=$?"           # atteso exit=1 (nessun polling dello schermo)
npm run lint && npm run typecheck && npm run test
git add src/main/reply-coordinator.ts test/unit/reply-coordinator.test.ts
git commit -m "feat(reply): coordinator with guards, temporary shortcuts and accept path

Abstention is the normal outcome: every stage can stop, and the pill never
appears with fewer than two variants. Command+1/2/3 and Escape are global
shortcuts registered on entering the suggesting state and released on every
exit, because the pill is showInactive() (it must not steal the focus the
final ⌘V needs) and therefore receives no key events. Dictation always
wins: the hotkey is ignored while the pipeline runs, and a PTT arm closes
the pill or aborts a run in flight through the epoch counter. Accepting
re-activates the target app and waits up to 300 ms for it; without a
verified focus the text is only copied, with the pill saying so.

The reading state is emitted but not shown: displaying the pill before the
addon call would put it under the cursor and make the addon read the
overlay instead of the conversation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** i 46 test verdi; `ReplyCoordinator` con `onHotkey`, `accept`, `dismiss`, `onHover`, `onDictationArm`, `getState`, `isBusy`, `lastBlockedBundleId`; tutte le costanti esportate con i valori indicati; `FLASH_TEXT` con le cinque stringhe esatte; `hasExplicitProposal` esportata e coperta; nessun import di `electron`, `node:fs`, `setInterval`; unico call site di produzione di `read`; le nove prove di rottura riportate; la decisione del Task 1 (`RILASCIABILE`/`MITIGAZIONE`) citata nel messaggio di completamento; lint/typecheck/test verdi.

---

## Task 9: Cablaggio in `index.ts`, UI delle preferenze, README e checklist

**Obiettivo:** rendere la feature raggiungibile da un utente: costruire i pezzi nel processo main con le dipendenze reali, registrare la hotkey solo a server pronto, esporre nelle preferenze l'interruttore, il tier, il nome, la hotkey e la lista di app, e documentare.

**Dipende da:** Task 8 (e quindi 1-7). **Leggi il corpo del commit del Task 1**: se dice `MITIGAZIONE`, il pre-cancello va passato al coordinatore (Step 2, punto 9).

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/preferences-window.ts`
- Modify: `src/preload/preferences-preload.ts`
- Modify: `src/renderer/preferences.html`, `src/renderer/preferences.js`
- Modify: `README.md`, `docs/electron-smoke-checklist.md`

**Nota sul TDD in questo task.** Questo task non produce logica nuova: è cablaggio di moduli già coperti da test (Global Constraint 6 parla dei task "che producono logica"). `index.ts` e `src/renderer/*.js` non hanno test unitari in questo repository e non se ne aggiungono qui (Global Constraint 1 non elenca file di test per il Task 9). La prova è quindi: **`npm run test` invariato** (nessuna regressione), `npm run lint`/`typecheck` verdi, le verifiche `grep`, e la **verifica manuale dello Step 6 riportata per punti**, che contiene i due controlli discriminanti (`lsof` sulla porta 18082 a feature accesa e spenta). Se durante l'esecuzione emerge logica che merita un test, va messa in un modulo già esistente del piano — non in un file nuovo, che violerebbe i vincoli 1-2.

- [ ] **Step 1: `src/main/preferences-window.ts`**

1. Import aggiuntivi:
   ```typescript
   import { WHISPER_MODELS, LLM_MODELS, REPLY_MODELS, REPLY_TIERS, getReplyTier } from "./model-catalog.js";
   import { validateReplyAccelerator } from "./utils/reply-hotkey.js";
   import type { ReplyServerState } from "../shared/reply-types.js";
   ```
2. Le dipendenze acquistano una funzione di stato e un hook di salvataggio (il main ne ha bisogno per applicare le preferenze senza riavvio):
   ```typescript
   export interface ReplyUiStatus {
     serverState: ReplyServerState;
     serverError: string | null;
     /** false when globalShortcut.register refused the accelerator. */
     hotkeyRegistered: boolean;
     /** false when the ax_context addon could not be loaded (degradation L6). */
     nativeOk: boolean;
     /** Bundle id of the last app the reader refused (§Deviazioni 3). */
     lastBlockedBundleId: string | null;
   }

   export interface PreferencesWindowDeps {
     modelManager: ModelManager;
     preferencesStore: PreferencesStore;
     /** Read-only snapshot for the reply section. */
     replyStatus: () => ReplyUiStatus;
   }
   ```
   e nella classe:
   ```typescript
     private readonly savedListeners: Array<(p: Preferences) => void> = [];

     /** Fires after prefs:save has written the file, so index.ts can apply the
      *  reply preferences (server, hotkey) without an app restart. */
     onSaved(cb: (p: Preferences) => void): void { this.savedListeners.push(cb); }
   ```
   e in fondo all'handler `prefs:save`, prima di `return next;`:
   ```typescript
       for (const l of this.savedListeners) l(next);
   ```
3. `prefs:list-models` restituisce anche i tier di risposta e lo stato:
   ```typescript
       const reply = await Promise.all(
         REPLY_TIERS.map(async (t) => {
           const desc = REPLY_MODELS.find((m) => m.id === t.replyModelId);
           return {
             id: t.id, label: t.label, description: t.description, modelId: t.replyModelId,
             sizeBytes: desc?.sizeBytes ?? 0,
             installed: desc ? await this.deps.modelManager.isInstalled(desc) : false,
           };
         }),
       );
       return { whisper, llm, replyTiers: reply, languages: LANGUAGES };
   ```
4. `prefs:download-model` e `prefs:delete-model` accettano `kind: "reply"`. Sostituisci in entrambe le lookup:
   ```typescript
       const list = args.kind === "whisper" ? WHISPER_MODELS : args.kind === "llm" ? LLM_MODELS : REPLY_MODELS;
   ```
   e in `prefs:delete-model` estendi la guardia del modello selezionato:
   ```typescript
       const selectedKey = args.kind === "whisper" ? prefs.whisperModelId : args.kind === "llm" ? prefs.llmModelId : prefs.replyModelId;
   ```
   (il tipo di `args.kind` diventa `"whisper" | "llm" | "reply"` in tutte e due.)
5. Tre handler nuovi, accanto agli altri:
   ```typescript
       ipcMain.handle("prefs:reply-status", (): ReplyUiStatus => this.deps.replyStatus());

       ipcMain.handle("prefs:validate-reply-hotkey", (_e, accelerator: string) => validateReplyAccelerator(accelerator));

       /** The addon does not expose the frontmost app's bundle id (only its
        *  pid), and native/ is out of scope: the UI offers the id of the last
        *  app the reader refused instead (§Deviazioni 3). */
       ipcMain.handle("prefs:reply-blocked-app", (): string | null => this.deps.replyStatus().lastBlockedBundleId);
   ```
6. Il progresso del download del modello di risposta viaggia sul canale già esistente `prefs:download-progress` (nessun canale nuovo).

- [ ] **Step 2: `src/main/index.ts`**

Import da aggiungere in testa:

```typescript
import { AxContextReader } from "./ax-context-reader.js";
import { parse as parseConversation } from "./utils/conversation-parser.js";
import { ReplyChatClient } from "./reply-chat-client.js";
import { ReplyClassifier } from "./reply-classifier.js";
import { ReplyGenerator, GENERATOR_PREFIX } from "./reply-generator.js";
import { filterVariants } from "./utils/variant-filter.js";
import { ReplyServerManager } from "./reply-server-manager.js";
import { ReplyCoordinator, hasExplicitProposal } from "./reply-coordinator.js";
import { HotkeyManager } from "./hotkey-manager.js";
import { validateReplyAccelerator } from "./utils/reply-hotkey.js";
import { IpcChannels } from "../shared/ipc-channels.js";
import { clipboard, globalShortcut } from "electron";   // added to the existing electron import
import type { ReplyUiStatus } from "./preferences-window.js";
```

Costanti, accanto a `LLAMA_SERVER_BIN`:

```typescript
// The reply model lives in its own llama-server: a different model, and the
// dictation cleanup stays untouched in the critical path (decision 5).
// 18080 = cleanup, 18081 = whisper-server fallback, 18082 = replies.
const REPLY_PORT = 18082;
const REPLY_ENDPOINT = `http://127.0.0.1:${REPLY_PORT}`;
const REPLY_CONTEXT_SIZE = 3072;
const REPLY_CLASSIFY_TIMEOUT_MS = 8_000;
const REPLY_GENERATE_TIMEOUT_MS = 10_000;
```

Blocco da inserire **dopo** la creazione di `injector` e `overlay` e **prima** di `const prefsWindow = …` (l'ordine conta: `prefsWindow` riceve `replyStatus`, e `ptt.on("arm")` deve poter chiamare il coordinatore):

```typescript
  // ── Reply suggestions (optional feature, off by default) ──
  // Degradation L6: if the addon cannot be loaded the feature disables itself
  // for the session and the rest of the app starts normally.
  let axReader: AxContextReader | null = null;
  try {
    axReader = new AxContextReader({ appRoot: APP_ROOT, isPackaged: app.isPackaged, logger });
    await logger.info("ax_context addon loaded");
  } catch (err) {
    await logger.error("ax_context addon not loadable — reply suggestions disabled for this session", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const replyServerManager = new ReplyServerManager({
    createServer: (modelPath) =>
      new LLMServer({
        binaryPath: LLAMA_SERVER_BIN,
        modelPath,
        port: REPLY_PORT,
        contextSize: REPLY_CONTEXT_SIZE,
        startupTimeoutMs: 90_000,
        // The generator's fixed instruction prefix, so it is already in the
        // KV cache when the first hotkey lands.
        warmupPrompt: GENERATOR_PREFIX,
        keepaliveMs: 20_000,
      }),
    modelManager,
    logger,
  });

  // The port is fixed, so one client is enough for the app's lifetime; the
  // manager's isReady() is what gates the calls.
  const replyClient = new ReplyChatClient({ endpoint: REPLY_ENDPOINT });
  const replyClassifier = new ReplyClassifier({ client: replyClient, timeoutMs: REPLY_CLASSIFY_TIMEOUT_MS, logger });
  const replyGenerator = new ReplyGenerator({ client: replyClient, timeoutMs: REPLY_GENERATE_TIMEOUT_MS, logger });

  let replyHotkeyRegistered = false;
  const replyCoordinator = axReader === null ? null : new ReplyCoordinator({
    reader: axReader,
    parse: parseConversation,
    classify: (input) => replyClassifier.classify(input),
    generate: (input) => replyGenerator.generate(input),
    filterVariants,
    overlay,
    shortcuts: {
      register: (accelerator, cb) => globalShortcut.register(accelerator, cb),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    server: {
      isReady: () => replyServerManager.isReady(),
      getState: () => replyServerManager.getState(),
      recover: () => replyServerManager.recover(),
    },
    inject: (text) => injector.inject(text),
    copyToClipboard: (text) => clipboard.writeText(text),
    loadPrefs: async () => {
      const p = await preferencesStore.load();
      return {
        enabled: p.replySuggestionsEnabled,
        userDisplayName: p.userDisplayName,
        appsMode: p.replyAppsMode,
        apps: p.replyApps,
      };
    },
    // Mutual exclusion in the other direction: no reply run while a dictation
    // is anywhere but idle.
    dictationBusy: () => pipelineBusy || coordinator.getState() !== "idle",
    logger,
    onTrustRequired: () => {
      dialog.showMessageBox({
        type: "warning",
        title: "open-flow needs Accessibility access",
        message: "Reply suggestions read the conversation under the mouse",
        detail: "Open System Settings → Privacy & Security → Accessibility and enable open-flow.",
        buttons: ["Open System Settings", "Close"],
        defaultId: 0,
        cancelId: 1,
      }).then((r) => {
        if (r.response === 0) {
          shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        }
      }).catch(() => undefined);
    },
    // Wired ONLY if the Task 1 experiment came out MITIGAZIONE — see step 9.
  });
```

`pipelineBusy` è dichiarato più in basso in `main()`: **spostane la dichiarazione** (`let pipelineBusy = false;` con il suo commento) **sopra** questo blocco, subito dopo `const orchestrator = …`. È l'unico riordino consentito in `index.ts`.

Poi, dopo il blocco:

```typescript
  // The reply hotkey is an impulse, not a toggle: HotkeyManager alternates
  // start/stop, so reset() right after 'start' makes every press a start.
  const replyAccelerator = validateReplyAccelerator(prefs.replySuggestionsHotkey).ok
    ? prefs.replySuggestionsHotkey
    : "Command+Control+R";
  const replyHotkey = new HotkeyManager({ accelerator: replyAccelerator });
  replyHotkey.on("start", () => {
    replyHotkey.reset();
    if (replyCoordinator) void replyCoordinator.onHotkey();
  });

  function applyReplyHotkey(): void {
    const wanted = replyServerManager.getState() === "ready" && replyCoordinator !== null;
    if (wanted && !replyHotkeyRegistered) {
      const r = replyHotkey.register();
      replyHotkeyRegistered = r.ok;
      void logger.info("reply hotkey", { accelerator: replyAccelerator, registered: r.ok });
    } else if (!wanted && replyHotkeyRegistered) {
      replyHotkey.unregister();
      replyHotkeyRegistered = false;
      void logger.info("reply hotkey released");
    }
  }
  replyServerManager.onStateChange((state) => {
    applyReplyHotkey();
    if (state !== "ready" && replyCoordinator) replyCoordinator.dismiss("quit");
  });
  replyServerManager.onDownloadProgress((p) => {
    void logger.debug("reply model download", { bytes: p.bytes, total: p.total });
  });

  // Overlay → main, same pattern as pipeline:cancel.
  ipcMain.on(IpcChannels.ReplyChoose, (_e, id: number) => {
    if (replyCoordinator) void replyCoordinator.accept(id);
  });
  ipcMain.on(IpcChannels.ReplyDismiss, () => { replyCoordinator?.dismiss("click"); });
  ipcMain.on(IpcChannels.ReplyHover, () => { replyCoordinator?.onHover(); });
```

Il resto delle modifiche a `index.ts`:

7. `const prefsWindow = new PreferencesWindow({ modelManager, preferencesStore, replyStatus: () => ({
     serverState: replyServerManager.getState(),
     serverError: replyServerManager.lastError(),
     hotkeyRegistered: replyHotkeyRegistered,
     nativeOk: axReader !== null,
     lastBlockedBundleId: replyCoordinator?.lastBlockedBundleId() ?? null,
   }) });`
8. Applicazione al salvataggio delle preferenze, subito dopo la creazione di `prefsWindow`:
   ```typescript
   prefsWindow.onSaved((next) => {
     void replyServerManager.apply({ enabled: next.replySuggestionsEnabled, replyModelId: next.replyModelId })
       .then(applyReplyHotkey)
       .catch((err: unknown) => logger.error("reply server apply failed", {
         message: err instanceof Error ? err.message : String(err),
       }));
   });
   ```
9. **Solo se il commit del Task 1 dice `MITIGAZIONE`**: aggiungi `preGate: hasExplicitProposal,` fra le dipendenze del coordinatore e togli il commento della riga finale. Se dice `RILASCIABILE`: **non** passare `preGate` e **rimuovi** `hasExplicitProposal` dall'import (altrimenti lint fallisce su `no-unused-vars`). Riporta quale delle due strade hai preso.
10. In `ptt.on("arm")`, come **prima** istruzione del gestore (prima del controllo `pipelineBusy`): `replyCoordinator?.onDictationArm();` — l'utente ha deciso di dettare, la pill si chiude sempre.
11. Avvio in background, subito dopo il blocco della hotkey:
    ```typescript
    if (prefs.replySuggestionsEnabled && replyCoordinator) {
      // Not awaited: the app must not wait for a 2.5-5 GB model to load.
      void replyServerManager.apply({ enabled: true, replyModelId: prefs.replyModelId })
        .then(applyReplyHotkey)
        .catch((err: unknown) => logger.error("reply server start failed", {
          message: err instanceof Error ? err.message : String(err),
        }));
    } else {
      await logger.info("reply suggestions off — no second llama-server", {
        enabled: prefs.replySuggestionsEnabled, nativeOk: axReader !== null,
      });
    }
    ```
12. In `app.on("will-quit")`, prima di `overlay.destroy()`:
    ```typescript
    replyCoordinator?.dismiss("quit");
    if (replyHotkeyRegistered) replyHotkey.unregister();
    for (const acc of ["Command+1", "Command+2", "Command+3", "Escape"]) globalShortcut.unregister(acc);
    replyServerManager.stop();
    ```
    (`globalShortcut.unregisterAll()` **no**: deregistrerebbe scorciatoie di cui questa feature non è proprietaria.)

- [ ] **Step 3: `src/preload/preferences-preload.ts`**

Aggiungi al bridge e alla `declare global` le quattro voci nuove, e allarga i due `kind`:

```typescript
  listModels: (): Promise<{
    whisper: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
    llm: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
    replyTiers: Array<{ id: string; label: string; description: string; modelId: string; sizeBytes: number; installed: boolean }>;
    languages: Array<{ id: string; label: string }>;
  }> => ipcRenderer.invoke("prefs:list-models"),
  downloadModel: (kind: "whisper" | "llm" | "reply", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:download-model", { kind, id }),
  deleteModel: (kind: "whisper" | "llm" | "reply", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:delete-model", { kind, id }),
  replyStatus: (): Promise<{ serverState: string; serverError: string | null; hotkeyRegistered: boolean; nativeOk: boolean; lastBlockedBundleId: string | null }> =>
    ipcRenderer.invoke("prefs:reply-status"),
  validateReplyHotkey: (accelerator: string): Promise<{ ok: boolean; reason?: string; accelerator?: string }> =>
    ipcRenderer.invoke("prefs:validate-reply-hotkey", accelerator),
  replyBlockedApp: (): Promise<string | null> => ipcRenderer.invoke("prefs:reply-blocked-app"),
```

- [ ] **Step 4: `src/renderer/preferences.html`**

Una sezione nuova, prima di `<section>` di "Launch open-flow at login". Usa **solo classi CSS già esistenti** (`muted`, `model-list`, `model-row`, `name`, `size`, `badge`, `row-actions`, `dict-add`, `dict-list`, `dict-term`, `danger`): `preferences.css` non è fra i file che questo piano modifica.

```html
      <section>
        <label><input type="checkbox" id="replyEnabled" /> Reply suggestions (leggi la conversazione sotto il mouse e proponi tre risposte)</label>
        <p class="muted">Spenta per default. Accesa carica un secondo modello: la RAM torna identica a oggi appena la spegni. Richiede il tuo nome e il modello del tier scelto.</p>
        <p class="muted" id="replyServerState">Stato del modello di risposta: —</p>

        <label for="userDisplayName">Il tuo nome nelle chat e nelle mail</label>
        <input id="userDisplayName" type="text" placeholder="es. Danilo Franco" />
        <p class="muted">Serve a capire quali messaggi sono tuoi. Confrontato su nome completo e su primo nome.</p>

        <label for="replyHotkey">Scorciatoia</label>
        <input id="replyHotkey" type="text" placeholder="Command+Control+R" />
        <p class="muted" id="replyHotkeyStatus">Non può contenere Option: la dettatura usa Hold Option.</p>

        <label>Qualità del modello di risposta</label>
        <div id="reply-tiers" class="model-list"></div>

        <label for="replyAppsMode">App in cui leggere</label>
        <select id="replyAppsMode">
          <option value="allowlist">Solo queste app (consigliato)</option>
          <option value="blocklist">Tutte tranne queste</option>
        </select>
        <div class="dict-add">
          <input id="replyAppInput" type="text" placeholder="bundle id, es. com.apple.mail" />
          <button id="replyAppAdd" type="button">Aggiungi</button>
        </div>
        <button id="replyAppAddBlocked" type="button" class="danger" hidden>Aggiungi l'ultima app rifiutata</button>
        <ul id="replyAppList" class="dict-list"></ul>
      </section>
```

- [ ] **Step 5: `src/renderer/preferences.js`**

Aggiungi dentro `init()`, dopo il blocco del dizionario. **Nessun campo della feature entra in `RESTART_REQUIRED_FIELDS`**: il server viene riconciliato da `ReplyServerManager.apply` all'atto del salvataggio, la hotkey viene ri-registrata da `applyReplyHotkey`, e nome/app/modalità vengono letti a ogni pressione della hotkey. Aggiungi questo commento sopra `RESTART_REQUIRED_FIELDS`.

```javascript
  // ── Reply suggestions ──
  let replyApps = Array.isArray(prefs.replyApps) ? [...prefs.replyApps] : [];
  let replyTierId = (catalog.replyTiers.find((t) => t.modelId === prefs.replyModelId) ?? catalog.replyTiers[0]).id;

  $("#replyEnabled").checked = prefs.replySuggestionsEnabled === true;
  $("#userDisplayName").value = prefs.userDisplayName ?? "";
  $("#replyHotkey").value = prefs.replySuggestionsHotkey ?? "Command+Control+R";
  $("#replyAppsMode").value = prefs.replyAppsMode ?? "allowlist";

  function renderReplyApps() {
    const list = $("#replyAppList");
    list.innerHTML = "";
    replyApps.forEach((id, i) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "dict-term";
      span.textContent = id;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "danger";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Remove ${id}`);
      rm.addEventListener("click", () => { replyApps.splice(i, 1); renderReplyApps(); });
      li.append(span, rm);
      list.appendChild(li);
    });
  }
  function addReplyApp(raw) {
    const id = (raw ?? "").trim();
    if (!id) return;
    replyApps = replyApps.filter((a) => a.toLowerCase() !== id.toLowerCase());
    replyApps.push(id);
    renderReplyApps();
  }
  $("#replyAppAdd").addEventListener("click", () => { addReplyApp($("#replyAppInput").value); $("#replyAppInput").value = ""; });
  $("#replyAppInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addReplyApp($("#replyAppInput").value); $("#replyAppInput").value = ""; }
  });
  renderReplyApps();

  function renderReplyTiers() {
    const container = $("#reply-tiers");
    container.innerHTML = "";
    for (const t of catalog.replyTiers) {
      const row = document.createElement("div");
      row.className = "model-row" + (t.id === replyTierId ? " selected" : "");
      row.dataset.id = t.id;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${t.label} — ${t.description}`;
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = `${(t.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
      const badge = document.createElement("span");
      badge.className = "badge" + (t.installed ? " installed" : "");
      badge.textContent = t.installed ? "installed" : "not installed";
      const actions = document.createElement("span");
      actions.className = "row-actions";
      if (!t.installed) {
        const dl = document.createElement("button");
        dl.textContent = "Download";
        dl.addEventListener("click", async (e) => {
          e.stopPropagation();
          dl.disabled = true;
          dl.textContent = "0%";
          const off = window.openFlowPrefs.onDownloadProgress((p) => {
            if (p.id === t.modelId && p.total > 0) dl.textContent = Math.floor((p.bytes / p.total) * 100) + "%";
          });
          try {
            await window.openFlowPrefs.downloadModel("reply", t.modelId);
            t.installed = true;
            renderReplyTiers();
            $("#status").textContent = `Scaricato ${t.label}. Seleziona il tier e salva.`;
          } catch (err) {
            dl.disabled = false;
            dl.textContent = "Retry";
            $("#status").textContent = "Download failed: " + err.message;
          } finally { off(); }
        });
        actions.appendChild(dl);
      }
      row.append(name, size, badge, actions);
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON") return;
        replyTierId = t.id;
        renderReplyTiers();
        refreshReplyGuards();
      });
      container.appendChild(row);
    }
  }
  renderReplyTiers();

  function selectedTier() {
    return catalog.replyTiers.find((t) => t.id === replyTierId) ?? catalog.replyTiers[0];
  }

  /** The feature cannot be switched on without a name and without the tier's
   *  model on disk: the parser cannot assign roles without the name, and the
   *  server cannot start without the file. */
  function refreshReplyGuards() {
    const tier = selectedTier();
    const nameOk = $("#userDisplayName").value.trim().length > 0;
    const box = $("#replyEnabled");
    const blockers = [];
    if (!nameOk) blockers.push("inserisci il tuo nome");
    if (!tier.installed) blockers.push(`scarica ${tier.label}`);
    if (blockers.length > 0 && box.checked) {
      box.checked = false;
      $("#status").textContent = `Per accendere le proposte di risposta: ${blockers.join(", ")}.`;
    }
    box.disabled = blockers.length > 0;
  }
  $("#userDisplayName").addEventListener("input", refreshReplyGuards);
  $("#replyEnabled").addEventListener("change", refreshReplyGuards);
  refreshReplyGuards();

  const HOTKEY_MESSAGES = {
    "contains-option": "Option è riservata alla dettatura (Hold Option): scegli un'altra combinazione.",
    "no-modifier": "Serve almeno un modificatore (Command, Control, Shift).",
    "no-key": "Serve un tasto oltre ai modificatori.",
    "reserved-key": "1, 2, 3 ed Esc sono le scorciatoie della pill mentre è visibile.",
  };
  async function validateHotkeyField() {
    const r = await window.openFlowPrefs.validateReplyHotkey($("#replyHotkey").value.trim());
    $("#replyHotkeyStatus").textContent = r.ok
      ? "Non può contenere Option: la dettatura usa Hold Option."
      : (HOTKEY_MESSAGES[r.reason] ?? "Acceleratore non valido.");
    $("#save").disabled = !r.ok;
    return r.ok;
  }
  $("#replyHotkey").addEventListener("input", () => { void validateHotkeyField(); });
  void validateHotkeyField();

  async function refreshReplyStatus() {
    const s = await window.openFlowPrefs.replyStatus();
    const parts = [`stato: ${s.serverState}`];
    if (s.serverError) parts.push(`errore: ${s.serverError}`);
    if (!s.nativeOk) parts.push("addon non caricabile: feature disattivata per questa sessione");
    if (s.serverState === "ready" && !s.hotkeyRegistered) parts.push("scorciatoia occupata da un'altra app");
    $("#replyServerState").textContent = `Modello di risposta — ${parts.join(" · ")}`;
    const btn = $("#replyAppAddBlocked");
    if (s.lastBlockedBundleId) {
      btn.hidden = false;
      btn.textContent = `Aggiungi ${s.lastBlockedBundleId}`;
      btn.onclick = () => addReplyApp(s.lastBlockedBundleId);
    } else {
      btn.hidden = true;
    }
  }
  void refreshReplyStatus();
  const replyStatusTimer = setInterval(() => { void refreshReplyStatus(); }, 2000);
  window.addEventListener("beforeunload", () => clearInterval(replyStatusTimer));
```

e in `buildNextPrefs()`, dentro l'oggetto restituito:

```javascript
      userDisplayName: $("#userDisplayName").value.trim(),
      replySuggestionsEnabled: $("#replyEnabled").checked,
      replySuggestionsHotkey: $("#replyHotkey").value.trim(),
      replyModelId: selectedTier().modelId,
      replyAppsMode: $("#replyAppsMode").value,
      replyApps,
```

- [ ] **Step 6: Verifica manuale (la prova di questo task)**

Le modifiche a `src/` non hanno effetto sull'app installata finché non la si ripacchetta: qui basta il guscio di sviluppo.

```bash
npm run build && npx electron dist/main/index.js
```

Con la feature **spenta** (stato iniziale):
1. `lsof -iTCP:18082 -sTCP:LISTEN` → **vuoto**. Nessun processo, nessuna RAM (decisione 3).
2. `Command+Control+R` → non accade nulla; nel log `reply ignored` con `"reason":"disabled"`.
3. La dettatura funziona come prima (Hold Option, paste).

Nelle preferenze:
4. La sezione "Reply suggestions" mostra l'interruttore **disabilitato** finché il nome è vuoto o il modello del tier non è installato, con il messaggio che dice cosa manca.
5. Scrivi `Alt+R` nel campo della scorciatoia → messaggio "Option è riservata alla dettatura…" e **Save disabilitato**. Scrivi `Command+1` → "1, 2, 3 ed Esc sono le scorciatoie della pill…". Torna a `Command+Control+R` → messaggio neutro e Save riabilitato.
6. Inserisci il nome, scarica il tier Standard (2,49 GB), seleziona il tier, accendi l'interruttore, **Save** (il pulsante resta "Save", non "Save & Restart").
7. La riga di stato passa `downloading` → `starting` → `ready` senza riavviare l'app.
8. `lsof -iTCP:18082 -sTCP:LISTEN` → **un processo `llama-server`**. In Activity Monitor annota la RAM residente prima e dopo l'accensione e riportala.
9. Spegni l'interruttore e salva → `lsof` di nuovo **vuoto** entro pochi secondi; la RAM torna al valore del punto 1.

Riporta i nove punti con l'esito. I punti 1, 8 e 9 sono i controlli discriminanti della decisione 3.

- [ ] **Step 7: `README.md`**

1. Riga della pipeline: aggiungi in fondo alla riga `**Pipeline:**` una frase separata:
   `**Reply suggestions (optional, off by default):** Command+Control+R → read the conversation under the mouse via the Accessibility API → local classifier → local generator → three proposals in the pill → Command+1/2/3 pastes the one you pick. Nothing leaves the machine here either.`
2. In `## Project layout`, dopo la riga di `pipeline-coordinator.ts`:
   `- `reply-coordinator.ts`, `reply-classifier.ts`, `reply-generator.ts`, `reply-server-manager.ts`, `ax-context-reader.ts` — the optional reply-suggestions feature: a second `llama-server` (port 18082) started only while the feature is on`
3. In `## Known limitations`, quattro righe nuove:
   - `Reply suggestions are off by default. On, they add a second model in RAM (~3.1 GB with the Standard tier, ~5.8 GB with Max, estimates); off, memory use is identical to before.`
   - `The feature reads only the apps you list (Slack, Mail and Brave by default) and only the window under the mouse, and only when it is frontmost. Nothing read or generated is written to disk or to the log.`
   - `While the proposals are on screen (at most 20 s) `Command+1/2/3` and `Esc` do not reach the app underneath — in browsers those switch tabs.`
   - `The reply hotkey cannot contain Option: dictation is Hold Option.`

- [ ] **Step 8: `docs/electron-smoke-checklist.md`**

Aggiungi una sezione dopo `## Edge cases` (strato 4 della strategia di test della spec):

```markdown
## Reply suggestions (optional feature)

Prerequisites: the tier's model downloaded, `userDisplayName` set, the feature
switched on and the state line showing `ready`.

14. **Slack, conversation where the other person wrote last.** Mouse over the
    messages, `Command+Control+R`. The pill shows "Preparo le risposte…" then
    the gist row and two or three proposals with `⌘1 ⌘2 ⌘3`.
15. **`⌘2`** pastes the second proposal into Slack's input field. Nothing is sent.
16. **Click on a row** pastes the same way, even though the click may activate
    the overlay: the app is re-activated first.
17. **`Esc`** closes the pill; `⌘1/2/3` then reach the app underneath again.
18. **Timeout:** raise the pill and wait 20 s without touching it — it closes.
    Move the mouse over it and wait: the timer restarts.
19. **Mail** on a received message with the reply window open, and **Brave** on
    a web conversation: same as 14.
20. **Out of scope:** hotkey on a document, on an empty field, on a thread where
    you wrote last, on a question asking for information ("a che ora arrivi?").
    The pill flashes "Nessuna proposta" for a second. The reason is never shown.
21. **App not allowed:** hotkey over an app that is not in the list → "App non
    abilitata — aggiungila nelle preferenze". The preferences now offer
    "Aggiungi <bundle id>".
22. **Two monitors:** cursor on the secondary → the pill appears on the
    secondary. With the target app NOT frontmost → "Nessuna proposta".
23. **Dictation wins:** raise the pill, then hold Option → the pill closes and
    the dictation starts; `⌘1/2/3` reach the app underneath again.
24. **Feature off:** switch it off, save, then `lsof -iTCP:18082 -sTCP:LISTEN`
    → empty. Check the resident memory in Activity Monitor before and after,
    on a 16 GB Mac.
25. **Privacy:** `grep -iE "review|preventivo|INTERLOCUTORE" ~/Library/Logs/open-flow/*.log`
    → no matches, with `debugLogging` on too.
```

- [ ] **Step 9: Verifiche di vincolo, lint, typecheck, test, commit**

```bash
grep -rn "readContextUnderCursor" src/                                    # atteso: solo ax-context-reader.ts
grep -rn '\.read(' src/main/ | grep -v ax-context-reader.ts               # atteso: solo reply-coordinator.ts
grep -n "globalShortcut.unregisterAll" src/main/ ; echo "exit=$?"         # atteso exit=1
git diff --name-only 2639447...HEAD | grep -E "preferences.css|text-injector|ptt-manager|hotkey-manager|pipeline-coordinator|llm-cleaner|llm-server|output-sanitizer|prompt-template|conversation-parser|native/|binding.gyp" ; echo "exit=$?"   # atteso exit=1
npm run lint && npm run typecheck && npm run test                          # atteso: ≥ 293 test, ≥ 27 file
git add src/main/index.ts src/main/preferences-window.ts src/preload/preferences-preload.ts src/renderer/preferences.html src/renderer/preferences.js README.md docs/electron-smoke-checklist.md
git commit -m "feat(prefs): wire the reply feature into the app and the preferences window

The second llama-server starts only while the preference is on, and the
hotkey is registered only once it is ready — so a press before the model is
loaded says 'Modello in caricamento…' instead of failing silently. Saving
the preferences reconciles the server and the hotkey without an app
restart, which is why none of the new fields is restart-required. The
accelerator is validated in the UI with the reason spelled out, Option
included: dictation holds Option. If the ax_context addon cannot be loaded
the feature disables itself for the session and the rest of the app starts
normally.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** a feature spenta nessun processo sulla 18082 (verificato con `lsof`, riportato); a feature accesa `ready` e hotkey registrata senza riavvio; le cinque preferenze modificabili dalla UI, con l'interruttore bloccato finché mancano nome o modello e la validazione della hotkey che spiega il motivo; "Aggiungi `<bundleId>`" comparsa dopo un `app-not-allowed`; `ptt.on("arm")` chiama `onDictationArm`; `will-quit` ferma il server e deregistra le quattro scorciatoie; README e checklist aggiornati; la strada del Task 1 (`preGate` sì/no) dichiarata; i nove punti della verifica manuale riportati; lint/typecheck/test verdi e **non peggiori del baseline 293/27**.

---

## Task 10: Integrazione end-to-end e strumento di lettura umana

**Obiettivo:** chiudere gli strati 2 e 3 della strategia di test della spec: un test di integrazione opt-in che fa girare la pipeline intera sui frammenti grezzi del corpus con il modello vero, e lo strumento che stampa il materiale della **lettura umana** — che la spec dichiara essere la metrica primaria, perché le metriche automatiche non discriminano la qualità (91-100% per tutti i modelli del benchmark).

**Dipende da:** Task 9 (e quindi tutti).

**Files:**
- Create: `test/integration/reply-pipeline.test.ts`
- Create: `tools/reply-pipeline-bench.ts`
- Modify: `package.json`

**Vincolo di CI.** `npm run test` esegue anche `test/integration/`. Il file nuovo va **interamente** dietro `describe.skipIf(!process.env.OPEN_FLOW_REPLY_MODEL)`: senza la variabile d'ambiente il file compare come *skipped* e i 293 test del baseline restano verdi e invariati. Gli integration test esistenti (`llm-cleaner`, `whisper-runner`) usano modelli fixture da 500 MB e possono lanciare in `beforeAll`; un GGUF da 2,5 GB no, e non entra in CI.

- [ ] **Step 1: Test di integrazione**

Crea `test/integration/reply-pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMServer } from "../../src/main/llm-server.js";
import { ReplyChatClient } from "../../src/main/reply-chat-client.js";
import { ReplyClassifier } from "../../src/main/reply-classifier.js";
import { ReplyGenerator, GENERATOR_PREFIX } from "../../src/main/reply-generator.js";
import { positionsFor } from "../../src/main/utils/reply-positions.js";
import { filterVariants, MIN_KEPT, toLogMeta as filterLogMeta } from "../../src/main/utils/variant-filter.js";
import { parse } from "../../src/main/utils/conversation-parser.js";
import { CASES, USER_NAME, axFragments, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";
import { CLASSIFIER_CASES } from "../fixtures/conversations/classifier-corpus.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SERVER_BIN = join(ROOT, "resources", "bin", "llama-server");
/** Set to the reply GGUF to run this file, e.g.
 *  OPEN_FLOW_REPLY_MODEL="$HOME/Library/Application Support/open-flow/models/gemma-3-4b-it-Q4_K_M.gguf" */
const MODEL = process.env.OPEN_FLOW_REPLY_MODEL ?? "";
const TEST_PORT = 18997;   // 18082 is the app's, 18089 the classifier bench's, 18999 the cleaner's

/** The five in-scope cases of the corpus and the kind each one must get. */
const EXPECTED_KIND: Record<string, "generic" | "alternative" | "offer"> = {
  "slack-decisione": "alternative",
  "slack-richiesta-aiuto": "generic",
  "mail-preventivo": "offer",
  "mail-thread-lungo": "alternative",
  "mail-inglese": "generic",
};

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe.skipIf(MODEL.length === 0)("reply pipeline (integration, opt-in)", () => {
  let server: LLMServer;
  let classifier: ReplyClassifier;
  let generator: ReplyGenerator;

  beforeAll(async () => {
    if (!(await exists(SERVER_BIN))) throw new Error(`Missing llama-server at ${SERVER_BIN}. Run: npm run fetch-binaries`);
    if (!(await exists(MODEL))) throw new Error(`OPEN_FLOW_REPLY_MODEL does not exist: ${MODEL}`);
    server = new LLMServer({
      binaryPath: SERVER_BIN, modelPath: MODEL, port: TEST_PORT, contextSize: 3072,
      startupTimeoutMs: 180_000, warmupPrompt: GENERATOR_PREFIX,
    });
    await server.start();
    const client = new ReplyChatClient({ endpoint: server.getEndpoint() });
    classifier = new ReplyClassifier({ client, timeoutMs: 30_000 });
    generator = new ReplyGenerator({ client, timeoutMs: 30_000 });
  }, 240_000);

  afterAll(() => { server?.stop(); });

  it("loads the GGUF and honours enable_thinking:false (non-empty content)", async () => {
    const r = await classifier.classify({
      transcript: "INTERLOCUTORE (Marta): ti va bene giovedì alle 9?",
      lastMessage: "ti va bene giovedì alle 9?", counterpart: "Marta",
    });
    // An empty `content` here means the chat template ignored
    // chat_template_kwargs and the reasoning ate the token budget: a blocker.
    expect(r.ok || (r.ok === false && r.reason !== "llm-error"), JSON.stringify(r)).toBe(true);
  }, 120_000);

  it("runs the whole pipeline on the RAW AX fragments of the five in-scope cases", async () => {
    const report: Array<Record<string, unknown>> = [];
    let pillsShown = 0;
    let kindHits = 0;
    for (const id of Object.keys(EXPECTED_KIND)) {
      const c = CASES.find((x) => x.id === id)!;   // ids come from EXPECTED_KIND's own keys
      const parsed = parse({ fragments: axFragments(c.ax), userDisplayName: USER_NAME, tailBudgetChars: 2_500 });
      expect(parsed.kind, id).toBe("conversation");
      if (parsed.kind !== "conversation") continue;

      const cls = await classifier.classify({
        transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
      });
      expect(cls.ok, `${id}: ${JSON.stringify(cls)}`).toBe(true);
      if (!cls.ok) continue;
      if (cls.classification.kind === EXPECTED_KIND[id]) kindHits += 1;

      const positions = positionsFor({
        kind: cls.classification.kind, language: cls.classification.language,
        ...(cls.classification.alternatives ? { alternatives: cls.classification.alternatives } : {}),
      });
      const gen = await generator.generate({
        transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
        userDisplayName: USER_NAME, subject: parsed.subject, positions, language: cls.classification.language,
      });
      expect(gen.ok, `${id}: ${JSON.stringify(gen)}`).toBe(true);
      if (!gen.ok) continue;
      // Format conformity must stay at 100%: the grammar fixes the three keys.
      expect(gen.variants.map((v) => v.key), id).toEqual(positions.map((p) => p.key));

      const filtered = filterVariants({
        variants: gen.variants, lastMessage: parsed.lastMessage, transcript: parsed.transcript,
        counterpart: parsed.counterpart, userDisplayName: USER_NAME, language: cls.classification.language,
      });
      if (filtered.kept.length >= MIN_KEPT) pillsShown += 1;
      expect(filtered.kept.length, `${id} kept 0`).toBeGreaterThan(0);
      report.push({ id, kind: cls.classification.kind, expectedKind: EXPECTED_KIND[id], ...filterLogMeta(filtered), classifyMs: cls.durationMs, generateMs: gen.durationMs });
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));   // codes and counts only
    expect(kindHits, "kind accuracy on the in-scope cases").toBeGreaterThanOrEqual(4);
    expect(pillsShown, "cases that would show a pill").toBeGreaterThanOrEqual(4);
  }, 300_000);

  it("shows no pill on the five out-of-scope cases of the corpus (the parser stops them)", async () => {
    for (const c of CASES.filter((x) => x.expect === "abstain")) {
      const parsed = parse({ fragments: axFragments(c.ax), userDisplayName: USER_NAME, tailBudgetChars: 2_500 });
      expect(parsed.kind, c.id).toBe("abstain");
    }
  });

  it("keeps the false-positive rate on 'information only the user has' at or below 1/8", async () => {
    const info = CLASSIFIER_CASES.filter((c) => c.expected.answerable === false);
    expect(info).toHaveLength(8);
    let falsePositives = 0;
    for (const c of info) {
      const r = await classifier.classify({ transcript: c.transcript, lastMessage: c.lastMessage, counterpart: c.counterpart });
      if (r.ok) falsePositives += 1;
    }
    // The release threshold of Task 1: this is the number that decides whether
    // the feature is shippable, re-measured at every prompt or model change.
    expect(falsePositives).toBeLessThanOrEqual(1);
  }, 300_000);

  it("leaks nothing into the logger along the whole pipeline", async () => {
    const seen: string[] = [];
    const spy = {
      info: async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); },
      warn: async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); },
    };
    const client = new ReplyChatClient({ endpoint: server.getEndpoint() });
    const c = CASES[0]!;   // slack-decisione
    const parsed = parse({ fragments: axFragments(c.ax), userDisplayName: USER_NAME, tailBudgetChars: 2_500 });
    if (parsed.kind !== "conversation") throw new Error("fixture regression");
    const cls = await new ReplyClassifier({ client, timeoutMs: 30_000, logger: spy }).classify({
      transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
    });
    if (cls.ok) {
      await new ReplyGenerator({ client, timeoutMs: 30_000, logger: spy }).generate({
        transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
        userDisplayName: USER_NAME, subject: parsed.subject,
        positions: positionsFor({ kind: cls.classification.kind, language: cls.classification.language, ...(cls.classification.alternatives ? { alternatives: cls.classification.alternatives } : {}) }),
        language: cls.classification.language,
      });
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) expect(leaksScreenText(line, c.ax), line).toBe(false);
  }, 180_000);
});
```

Run senza la variabile: `npx vitest run test/integration/reply-pipeline.test.ts` — Expected: `1 skipped`, esce con 0.
Run con la variabile (locale, non in CI):
```bash
OPEN_FLOW_REPLY_MODEL="$HOME/Library/Application Support/open-flow/models/gemma-3-4b-it-Q4_K_M.gguf" \
  npx vitest run test/integration/reply-pipeline.test.ts
```
— Expected: 5 test verdi. Se `"kind accuracy"` o `"cases that would show a pill"` scendono sotto 4, **non abbassare la soglia**: riporta i numeri e le regole di scarto stampate dal `console.log`, sono il materiale del Task 10 per la ritaratura (vedi Step 3).

- [ ] **Step 2: `tools/reply-pipeline-bench.ts` — lo strumento della lettura umana**

Gira con `tsx` (solo HTTP e file, nessun addon, nessun Electron). Avvia da sé un `LLMServer`, esegue la pipeline sui casi del corpus, **stampa il materiale da leggere** e le metriche di ritaratura. Stampa solo su stdout; non scrive nulla su disco.

Opzioni (`node:util.parseArgs`): `--model <path>` (obbligatorio), `--server-bin <path>` (default `resources/bin/llama-server`), `--port` (default `18096`), `--cases <id,id>` (default: i cinque casi in ambito + i cinque fuori ambito), `--repeats` (default `1`), `--user-name` (default `USER_NAME` del corpus), `--metrics-only` (nessun testo in output: si può eseguire davanti ad altri), `--context` (default `3072`).

Per ogni caso in ambito, in ordine, stampa:

```
── caso: slack-decisione (Slack)   ripetizione 1/1 ──
gist:      Rispondi a Marta: la review la fai tu o la giro a Paolo?
kind:      alternative (atteso: alternative)   lingua: it
alternative: «la fai tu» | «la giro a Paolo»
latenza:   classificatore 240 ms   generatore 1620 ms   totale 1860 ms
scartate:  second=signature
proposte mostrate: 2 di 3
  ⌘1  Scelgo: la fai tu        │ La faccio io, la chiudo entro oggi pomeriggio.
  ⌘2  Rimando                  │ Fammi controllare l'agenda e ti dico entro stasera.
rubrica (compila a mano, un voto binario per asse e per variante):
  ruoli  inventato  posizione  lingua  distinta
  ⌘1  [ ]    [ ]        [ ]      [ ]     [ ]
  ⌘2  [ ]    [ ]        [ ]      [ ]     [ ]
```

Per ogni caso fuori ambito stampa una riga sola: `── fuori ambito: <id> → <astensione o pill> (<motivo>)`, dove `pill` è un **fallimento** da segnalare.

In coda, il riepilogo:

```
=== RIEPILOGO ===
modello: <basename>   casi in ambito: N   fuori ambito: M   ripetizioni: R
pill mostrate: N/N   (soglia di rilascio: zero pill sui casi fuori ambito)
conformità di formato: N/N chiavi attese restituite
accuratezza kind: N/N
scarti per regola: unanchored-number 3, signature 2, question-echo 1, …
latenza p50: X ms   p95: Y ms
ritaratura Jaccard (§Deviazioni 5): eco max fra le TENUTE: 0.48   quasi-duplicato max fra le TENUTE: 0.61
  → se l'eco massima fra le tenute supera 0.6 o il quasi-duplicato massimo supera 0.75 le soglie sono da alzare;
    se nessuna variante buona è stata scartata per queste due regole, sono da lasciare come sono.
rubrica: da compilare a mano. Soglia di rilascio: ≥ 90% dei casi in ambito con
  TUTTE le varianti mostrate che passano TUTTI i cinque assi, e zero pill fuori ambito.
```

Requisiti di implementazione, non negoziabili:
- riusa `parse`, `ReplyClassifier`, `ReplyGenerator`, `positionsFor`, `filterVariants` **senza copiarne la logica**: se la lettura umana gira su un percorso diverso da quello dell'app, non misura l'app;
- `filterVariants` va chiamato una volta e i suoi `dropped` vanno stampati come `key=rule`, mai con il testo;
- per la ritaratura, calcola `jaccardWords` (esportata dal Task 4) fra ogni variante **tenuta** e `lastMessage` (eco) e fra ogni coppia di tenute (quasi-duplicato), e stampa i due massimi;
- nessun `logger`: come `ax-context-probe`, questo è il posto dove il testo si mostra, a chi l'ha chiesto;
- `--metrics-only` sopprime `gist`, `alternative`, le righe delle proposte e la rubrica, e lascia latenze, conteggi e regole di scarto;
- il server va fermato in `finally`.

- [ ] **Step 3: `package.json`**

Dopo lo script `reply-bench` aggiunto dal Task 1:

```json
    "reply-pipeline-bench": "tsx tools/reply-pipeline-bench.ts"
```

- [ ] **Step 4: Esegui la lettura umana e riporta**

```bash
npm run reply-pipeline-bench -- --model "$HOME/Library/Application Support/open-flow/models/gemma-3-4b-it-Q4_K_M.gguf"
npm run reply-pipeline-bench -- --model "$HOME/Library/Application Support/open-flow/models/gemma-4-E4B-it-Q4_K_M.gguf"
```

Leggi le proposte e compila la rubrica dei cinque assi (ruoli corretti; nessun fatto inventato; prende la posizione assegnata; lingua idiomatica; distinta dalle altre). Riporta nel corpo del commit, **senza testi**, solo voti e codici:

| Tier | Casi in ambito passati (tutti gli assi) | Pill fuori ambito | Conformità formato | Accuratezza kind | p50 | Asse più debole |
|---|---|---|---|---|---|---|

e la riga di ritaratura Jaccard con la raccomandazione (`lasciare 0,6/0,75` oppure `spostare a X/Y perché …`). La spec chiede **≥ 90% dei casi in ambito** con il tier default e **zero** pill fuori ambito: se il corpus da dieci casi non permette di dire 90% con precisione utile, dichiaralo — il target di rilascio della spec è ≥ 40 casi ed è **fuori dall'ambito di questo piano** (§Auto-revisione).

- [ ] **Step 5: Lint, typecheck, test, commit**

```bash
grep -n "writeFile\|appendFile" tools/reply-pipeline-bench.ts ; echo "exit=$?"      # atteso exit=1
npx vitest run test/integration/reply-pipeline.test.ts                              # atteso: 1 file skipped
npm run lint && npm run typecheck && npm run test                                   # atteso: ≥ 293 passati, 0 falliti
git add test/integration/reply-pipeline.test.ts tools/reply-pipeline-bench.ts package.json
git commit -m "test(reply): opt-in end-to-end integration and the human-reading bench

Layer 2 runs parser → classifier → generator → filters on the corpus's RAW
AX fragments, so the layers are proven to fit together and not just to work
in isolation; it is gated behind OPEN_FLOW_REPLY_MODEL because a 2.5 GB GGUF
does not belong in CI. Layer 3 is the primary metric per the spec: the
automatic numbers did not discriminate quality in the benchmark (91-100%
for every model), so the bench prints what a person has to read plus the
Jaccard recalibration figures the filter thresholds need.

<tabella della rubrica per entrambi i tier, raccomandazione sulle soglie>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Criteri di completamento:** il file di integrazione esiste, è interamente `skipIf`, e con la variabile d'ambiente esegue cinque test verdi sul tier default; `npm run test` senza la variabile riporta gli stessi 293 test passati del baseline più quelli dei task precedenti, con un file *skipped*; `tools/reply-pipeline-bench.ts` esegue la pipeline riusando i moduli di produzione, stampa il blocco per caso, il riepilogo e le due massime di Jaccard, e rispetta `--metrics-only`; `npm run reply-pipeline-bench` in `package.json`; rubrica compilata a mano per entrambi i tier e riportata nel commit con la raccomandazione sulle soglie; lint/typecheck/test verdi.

---

## Come verificare il Piano B a mano

Prerequisiti, in ordine:

1. `npm ci` fatto; `npm run rebuild-native` eseguito (vale il vincolo documentato: `electron-rebuild -f --arch arm64`, altrimenti sotto Rosetta si produce un `.node` incompatibile).
2. Accessibility concessa. In sviluppo la concede `Electron.app` di `node_modules/electron/dist` (già vero se `npm run dev` fa funzionare il PTT); nell'app installata la concede `open-flow.app`.
3. `npm run ax-probe -- --delay 5` funzionante: è il probe del Piano A e **gira già**. Dopo il Task 6 richiede un filtro, che per default è la lista delle tre app verificate. Usalo per confermare che l'addon legge la conversazione **prima** di cercare colpe altrove: se il probe non vede la conversazione, non la vedrà neanche la feature.
4. I due GGUF scaricati con i nomi di catalogo e gli sha256 del Task 1 Step 7.
5. `npm run lint && npm run typecheck && npm run test` verdi.

Poi, in sviluppo (`npm run build && npx electron dist/main/index.js`), esegui in quest'ordine — è la sequenza che riproduce il flusso utente della spec:

| # | Cosa fai | Cosa deve accadere |
|---|---|---|
| 1 | Apri le preferenze con la feature spenta; `lsof -iTCP:18082 -sTCP:LISTEN` | Vuoto. Nessun processo, RAM identica a prima del Piano B |
| 2 | Premi `Command+Control+R` | Nulla. Nel log `reply ignored` con `"reason":"disabled"` |
| 3 | Preferenze: scrivi `Command+Option+R` nel campo della scorciatoia | Messaggio "Option è riservata alla dettatura" e **Save disabilitato** |
| 4 | Metti il nome, scarica il tier Standard, seleziona il tier, accendi, Save | Il pulsante resta "Save" (nessun riavvio). Lo stato passa `downloading` → `starting` → `ready` |
| 5 | `lsof -iTCP:18082 -sTCP:LISTEN`; RAM in Activity Monitor | Un `llama-server`; ~3,1 GB in più (stima da confermare: annota il numero vero) |
| 6 | **Slack**, mouse sopra un DM in cui l'altra persona ha scritto per ultima, `Command+Control+R` | Pill sul monitor del cursore: "Preparo le risposte…" poi la riga del gist e due o tre proposte con `⌘1 ⌘2 ⌘3` |
| 7 | Leggi la riga del gist | Deve dire **la domanda che hai davanti**. Se dice un'altra cosa, `Esc`: è la funzione del gist (rifiuto a colpo d'occhio) |
| 8 | `⌘2` | Slack torna in primo piano se non lo era, il testo della seconda proposta compare nel campo di input. **Non viene inviato** |
| 9 | Ripeti il 6 e **clicca** una riga con il mouse | Stesso esito dell'8, anche se il click ha attivato l'overlay |
| 10 | Ripeti il 6 e premi `Esc` | La pill sparisce; `⌘1/2/3` tornano a raggiungere Slack (in un browser: tornano a cambiare tab) |
| 11 | Ripeti il 6 e non toccare nulla per 20 s | La pill si chiude da sola. Passandoci il mouse sopra il conto riparte |
| 12 | Ripeti il 6 e poi tieni premuto **Option** | La pill si chiude e parte la dettatura. Le due cose non si sovrappongono mai |
| 13 | **Mail**, sul corpo di una mail ricevuta con la risposta aperta | Come il 6, con `OGGETTO:` nel contesto quando c'era `Re:` |
| 14 | **Brave**, su una conversazione web | Come il 6 |
| 15 | Hotkey su un documento, su un campo vuoto, su un thread dove hai scritto tu per ultimo, e su una domanda che chiede un'informazione ("a che ora arrivi?") | Flash "Nessuna proposta" per un secondo. **Il motivo non compare mai** sullo schermo |
| 16 | Hotkey su un'app non in lista (es. Note) | Flash "App non abilitata — aggiungila nelle preferenze". Riapri le preferenze: c'è il pulsante "Aggiungi com.apple.Notes" |
| 17 | Due monitor: cursore sul secondario | La pill compare **sul secondario** (era il difetto: usciva sempre sul primario) |
| 18 | Due monitor, mouse sulla conversazione di un'app **non** in primo piano | Flash "Nessuna proposta": non si legge una finestra in secondo piano per incollare in un'altra app |
| 19 | Spegni la feature e salva; `lsof -iTCP:18082 -sTCP:LISTEN` | Vuoto entro pochi secondi; la RAM torna al valore del punto 1 |
| 20 | `grep -iE "review|preventivo|INTERLOCUTORE|Marta" ~/Library/Logs/open-flow/*.log` con `debugLogging` acceso | **Nessuna riga.** Né contesto letto, né testo generato |

Poi, sull'app **pacchettizzata** — necessario perché le modifiche a `src/` non hanno alcun effetto sull'app installata finché non la si ripacchetta e reinstalla:

```bash
npm run package
# installa il .dmg, poi ri-concedi Accessibility a open-flow.app se richiesto
```

e ripeti i punti 5, 6, 8, 16, 19: sono quelli sensibili al packaging (percorso del `.node` in `app.asar.unpacked`, percorso di `llama-server` in `Contents/Resources/bin`, cartella dei modelli).

Se un'app non produce nulla, annota `bundleId` e i conteggi per livello che il probe stampa: sono il materiale per ricalibrare `jumpRatio`/`jumpMinChars` (spec §Rischi 3). **Non cambiare quelle soglie in questo piano.**

---

## Auto-revisione

**Copertura della spec (Piano B).** Strato 3 → Task 1 (`ReplyClassifier` con `response_format` a schema, `temperature 0`, `max_tokens 64`, un solo turno utente, `enable_thinking: false`, degradazione `alternative`→`generic`) e l'esperimento che la spec chiede al §Rischi 1. Strato 4 → Task 3 (`ReplyPositions` con i tre set della tabella della spec §5, `ReplyGenerator` col prompt dello spike S3, sampling ufficiale Gemma, `max_tokens 320`, `cache_prompt`, timeout 10 s). Strato 5 → Task 4 (le regole della tabella §6 con le soglie 20/280, 0,6, 0,75, numerali in lettere, `MIN_KEPT = 2`, log con soli `{key, rule}`). Strato 6 → Task 7 (`SuggestionPayload`, stato `suggesting`, badge `⌘1/2/3`, gist sempre visibile, `getDisplayNearestPoint` a ogni `show()`, ridimensionamento, canali `reply:*`). §8 → Task 5 (porta 18082, `contextSize 3072`, `keepaliveMs 20 000`, `warmupPrompt` = `GENERATOR_PREFIX`, la tabella del ciclo di vita legata alla preferenza, un solo riavvio automatico, stati osservabili). §9 → Task 6 (il cancello sull'app **prima** della raccolta) e Task 8 (le guardie, la sequenza in otto passi, il timeout 12 s, la mutua esclusione con il PTT, la sequenza d'accettazione in cinque passi con la degradazione a clipboard). §Preferenze e §Catalogo → Task 2 e Task 9. §Gestione errori: L0 e L2 nelle guardie del Task 8, L1 come stato `nothing`, L3 nell'accettazione, L4 con `recover()`, L5 via `onTrustRequired`, L6 nel `try/catch` del Task 9. §Privacy 1-9: nessun endpoint remoto (Task 1), nessuna persistenza (vincoli 12 e 16, verificati per `grep`), nessuna lettura senza gesto (vincolo 13 e il test "reads the screen only on the hotkey"), allowlist per default e controllo prima della raccolta (Task 6), budget 2 500 (Task 8), una sola finestra (l'addon del Piano A), nessun contenuto negli errori (Task 1, `ReplyLLMError`), nessuna telemetria, corpus anonimizzato. §Strategia di test: strato 1 in tutti i task (ogni modulo del piano ha il suo file di test, `overlay-bounds` incluso, e ogni modulo che logga ha il suo logger-spia), strato 2 e 3 nel Task 10, strato 4 nella checklist del Task 9.

**Cosa resta fuori, per esplicita esclusione.**
- **Il corpus da ≥ 40 casi** che la spec pone come target di rilascio dello strato 3, di cui ≥ 10 fuori ambito e ≥ 8 in inglese: qui ci sono i 10 casi del Piano A più i 16 del classificatore (Task 1). L'ampliamento è lavoro di raccolta e anonimizzazione, non di codice, e va fatto prima del rilascio.
- **Il bump di `llama.cpp`**: prerequisito già in `resources/bin/` (v0.4.0), con la sua validazione della catena di dettatura. Nessun task lo rifà; il Task 1 Step 7 lo verifica di rimbalzo (i due GGUF devono caricarsi e restituire `content` non vuoto).
- **`native/**` e `binding.gyp`**: intoccati (Global Constraint 3). Ne conseguono le due deviazioni: il confronto case-insensitive nel wrapper (Task 6) e "aggiungi l'ultima app rifiutata" al posto di "aggiungi l'app in primo piano" (Task 9).
- **Il percorso dei text marker**: `textMarkers` resta a `false` e nessun task lo accende. Si accende solo con una misura che ne provi il beneficio, e lo strumento per farla è `npm run ax-probe -- --text-markers`.
- **La ritaratura delle soglie di Jaccard**: il Task 10 la **misura** e raccomanda; non la applica. Cambiare 0,6/0,75 richiede di rieseguire la lettura umana, quindi è un lavoro suo.
- **La calibrazione del prompt per tier** (§Rischi 2): il Task 10 la può rivelare (se il tier `max` passa e il default no sullo stesso prompt), ma un prompt diverso per tier non è in questo piano.
- **`ChatGPT` e simili**: fuori ambito già nel Piano A, attuato dal cancello `assistant-speaker` del parser.
- **Test unitari di `index.ts` e dei renderer**: il repository non ne ha e il Piano B non introduce l'infrastruttura per averne (Task 9, nota sul TDD). La prova è la verifica manuale, con i controlli `lsof` come parte discriminante.

**Coerenza dei tipi fra task.** `ReplyChatClient.completeJson` (1) è l'unico consumatore di `SamplingParams` e serve sia `ReplyClassifier` (1) sia `ReplyGenerator` (3). `Classification.kind`/`.language`/`.alternatives` (1) entrano in `PositionsInput` (3) e in `FilterInput.language` (4); `Position.key`/`.label` (3) diventano `RawVariant.key`/`.label` (3), poi `FilterVariant` (4), poi `SuggestionVariant.label` (2) nel payload (7). `positionsFor` è chiamata dal coordinatore (8), non dal generatore: è il codice a fissare le posizioni. `ParseResult.transcript`/`lastMessage`/`counterpart` (Piano A) alimentano `ClassifyInput` (1) e `GenerateInput` (3); `ParseResult.gist` va solo nel payload (7), mai al modello; `ParseResult.subject` va solo al generatore. `RawContext.fragments` (6) → `ParseInput.fragments`; `RawContext.pid`/`editableIsFocused` (6) → la sequenza d'accettazione (8). `ReplyServerState` (2) è prodotto da `ReplyServerManager` (5), consumato dalle guardie (8) e mostrato dalla preferences window (9). `BundleIdFilter` (Piano A, reso obbligatorio nel 6) è costruito dal coordinatore (8) dalle preferenze `replyAppsMode`/`replyApps` (2). `SuggestionPayload` (2) è l'unico tipo che attraversa il confine main → preload → renderer (7). `toLogMeta` esiste ora in quattro moduli (`ax-context-reader`, `conversation-parser`, `variant-filter` e, come metodo privato, la meta del coordinatore): il coordinatore li importa con alias distinti (`readerLogMeta`, `parserLogMeta`, `filterLogMeta`), come già fa il probe.

**Scostamenti dichiarati dentro i task nuovi** (in aggiunta ai sette di §Deviazioni): (a) `RawContext.timings` acquista `probeMs` e `read` cambia firma in `read(filter, overrides)` — Task 6; (b) `ReadOptions` si separa in `ReadBudgets` + filtro obbligatorio — Task 6; (c) `levelSummary` è vuoto sui rifiuti dello stadio 1 anche se l'addon restituisse livelli — Task 6; (d) lo stato `reading` è emesso ma **non mostrato**, perché mostrare la pill prima della chiamata all'addon la metterebbe sotto il cursore e farebbe leggere all'addon l'overlay stesso — Task 8; (e) `hasExplicitProposal` vive nel coordinatore e si attiva per iniezione (`deps.preGate`) anziché per costante di modulo, così entrambe le strade del Task 1 sono testate — Task 8; (f) i canali `reply:choose`/`reply:dismiss`/`reply:hover` sono ricevuti in `index.ts` e non in `OverlayWindow`, per coerenza con `pipeline:cancel` — Task 7 e 9; (g) `preferences.css` non viene toccato: la UI nuova riusa le classi esistenti — Task 9.

**Rischi aperti che questo piano non chiude.** Restano i dieci della spec. In particolare: il buco della classificazione dell'ambito è **misurato** dal Task 1 ma la mitigazione resta un compromesso (più falsi negativi); la latenza su Mac base resta **stimata** (2 s misurati su M5 Pro, 4-6 s stimati) e il Task 10 la misura solo sulla macchina di sviluppo; la contesa GPU fra i due keepalive non è misurata e la memoria del progetto documenta quanto la dettatura in streaming ne sia sensibile — se compare una regressione, il rimedio dichiarato è spegnere il keepalive del server di risposta accettando il cold-start alla prima hotkey; le stime di RAM (~3,1 / ~5,8 GB) diventano numeri veri solo al punto 5 della verifica manuale, e se il tier default sfonda su un Mac da 16 GB le opzioni dichiarate dalla spec (`contextSize` a 2048 con budget di coda a 1 600, oppure fermare il server di pulizia mentre quello di risposta lavora) sono da decidere con misure, non qui. Il costo delle scorciatoie globali temporanee (`⌘1/2/3` non raggiungono l'app sotto per ≤ 20 s) è accettato e visibile; l'alternativa scartata — pill focalizzabile con tasti nudi — richiederebbe di rubare il focus e restituirlo, che è esattamente la fragilità che `showInactive()` evita.

**Scansione dei placeholder.** Nessun "TBD" e nessuna sezione incompleta: ogni task porta firme, tipi, percorsi, soglie, nomi dei casi di test e messaggi alla lettera. Le uniche parti descritte come procedura anziché come codice sono i due tool di `tools/` (formato dell'output, opzioni e requisiti dati riga per riga) e i frammenti di `index.ts`/`preferences.js`, dove il codice nuovo è dato per intero ma il punto d'inserimento è indicato per riferimento al codice esistente.
