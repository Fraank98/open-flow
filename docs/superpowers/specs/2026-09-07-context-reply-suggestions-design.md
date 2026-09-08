# Proposte di risposta dal contesto — design

**Date:** 2026-09-07
**Branch:** `context-reply-suggestions`
**Status:** approvato (tre spike + benchmark modelli eseguiti), pronto per il piano di implementazione
**Prerequisito bloccante:** bump di `llama.cpp` in `scripts/fetch-binaries.sh` (lavoro separato, vedi §Prerequisiti)

## Problema

Oggi `open-flow` fa una cosa sola: trasforma la voce in testo e lo incolla nel
campo attivo. L'utente decide *cosa* dire e lo detta. C'è però una classe di
messaggi in cui il costo non è scrivere, ma decidere: "ci vediamo giovedì o
venerdì?", "ti va bene il preventivo?", "chi fa la review?". La risposta è una
frase di due righe che esprime una posizione, e la parte lenta è formularla
nel tono giusto mentre si ha già la conversazione davanti.

La feature nuova: l'utente preme una hotkey, l'app legge il **contesto sotto il
puntatore del mouse** via Accessibility API, e se quel contesto è una
conversazione a cui si risponde con una decisione, mostra nella pill esistente
**tre proposte di risposta che esprimono posizioni diverse**. Accettandone una,
il testo viene incollato nel campo di input.

La feature è **spenta per default**. Si abilita dalle preferenze e finché è
spenta il consumo di RAM e il comportamento dell'app restano identici a oggi.

## Ambito

### In

- Un nuovo addon nativo Obj-C++ (`ax_context`) che, dato il puntatore del
  mouse, individua la finestra, trova il campo editabile e raccoglie il testo
  della conversazione con la strategia di risalita misurata nello spike 1.
- Un pre-processore deterministico in TypeScript (senza modello) che ricostruisce
  i turni `{speaker, text}`, distingue i turni dell'utente da quelli
  dell'interlocutore e applica i cancelli di astensione dello spike 2.
- Un **classificatore** a output vincolato che decide se il messaggio è
  "rispondibile con una decisione" e con quale set di posizioni.
- Un **generatore** che, date tre posizioni fissate dal codice, scrive solo la
  prosa di ciascuna, con output JSON vincolato dalla grammatica.
- **Filtri post-generazione** per singola variante, nello spirito di
  `output-sanitizer.ts`.
- Estensione della pill (`overlay-window.ts`) con uno stato "proposte": una
  riga che dichiara cosa è stato capito e tre varianti selezionabili col mouse
  o con `Command+1/2/3`, `Esc` per chiudere.
- Un **secondo `llama-server`** per il modello di generazione, avviato solo a
  feature accesa e fermato quando la si spegne.
- Due tier di modello di risposta (Gemma 3 4B default, Gemma 4 E4B "qualità
  massima") in `model-catalog.ts`, scaricabili on-demand dalle preferenze.
- Preferenze nuove: interruttore, hotkey, tier, nome dell'utente, lista di app
  consentite/bloccate.
- Correzione del posizionamento dell'overlay su multi-monitor
  (`screen.getDisplayNearestPoint` al posto di `screen.getPrimaryDisplay`).

### Out (non-ambito dichiarato)

- **Domande che chiedono un'informazione che solo l'utente possiede** ("a che
  ora arrivi?", "qual è il numero della pratica?"). Non si propone nulla: il
  modello non può saperlo e ogni proposta sarebbe un'invenzione.
- **Thread con più di due interlocutori.** Il ruolo "TU / INTERLOCUTORE" è
  binario; con tre o più parlanti il destinatario è ambiguo.
- **Qualsiasi generazione a freddo**: nessun polling dello schermo, nessuna
  proposta autonoma, nessuna lettura senza hotkey.
- **Assistenti conversazionali (ChatGPT e simili) come categoria.** Rispondere
  a un assistente con testo generato è concettualmente strano ed è il caso su
  cui tutti i modelli del benchmark hanno inventato fatti.
- **Persistenza su disco di qualunque contenuto letto dallo schermo**, log
  inclusi.
- L'utente che detta la propria posizione a voce e il modello la sviluppa
  (decisione 1: le tre varianti nascono dal solo contesto).
- Modifica del modello di pulizia della dettatura o del suo `llama-server`.
- Il bump di `llama.cpp` (è un prerequisito, non parte di questo lavoro).
- Windows / Linux.

## Vincoli acquisiti dagli spike

Quanto segue sono **misure**, non ipotesi. Dove un numero è una stima lo
dichiaro come tale. Tutte le latenze citate sono su un **M5 Pro**; su un Mac
base (M-series entry level, 16 GB) vanno moltiplicate per 2-3, e questo fattore
è **stimato, non misurato**.

### Spike 1 — acquisizione del contesto

- `CGEventGetLocation` restituisce la posizione del cursore già in coordinate
  con origine in alto a sinistra — il sistema di riferimento che vuole l'AX.
  Gestisce il multi-monitor, coordinate negative incluse. Nessuna conversione.
- `AXUIElementCopyElementAtPosition`: **28-49 ms**.
- L'elemento sotto il mouse **non coincide** con il campo che ha il focus in
  **11 casi su 13** misurati. Il mouse serve quindi a **scegliere la finestra**,
  non il campo. Il campo si trova con `AXEditableAncestor` (esposto da Slack,
  Brave, Mail), con fallback su `kAXFocusedUIElementAttribute`.
- `AXManualAccessibility` va impostato sull'elemento applicazione: accettato
  (ritorno 0) su Slack e sulle app Electron in genere; non necessario su Brave
  e Mail.
- **Strategia di raccolta vincente: partire dal campo editabile e risalire un
  livello alla volta**, raccogliendo il sottoalbero di ogni antenato e
  filtrando i ruoli di puro cromo. Il livello giusto si riconosce da un **salto
  netto del conteggio caratteri**, non da una crescita graduale:

  | App | Livelli 1-6 | Livello con il salto | Tempo |
  |---|---|---|---|
  | Slack | 20-93 char | livello 7: **3748 char** | 23 ms |
  | ChatGPT in Brave | 36 char | livello 7: **8291 char** | 98 ms |
  | Mail | — | livello 1: **1454 char** | 26 ms |

  Il salto è di **40-200×**. È il segnale su cui si ferma la risalita.
- Strategia scartata: raccogliere dall'alto (dalla finestra). Porta dentro barra
  laterale e cromo e **manca i messaggi**.
- Alternativa scartata come fonte primaria: i **text marker**
  (`AXStringForTextMarkerRange`). Sono fulminei (0-4 ms) ma non hanno ambito:
  su ChatGPT restituiscono l'intera cronologia laterale delle conversazioni
  passate (un problema di privacy in sé) e in Chromium incollano le parole
  senza spazi. Restano utili come **rete di sicurezza sulle app WebKit**, dove
  preservano gli a capo.
- Il testo AX arriva **attribuito** (`Marta: ... 09:12`, `X ha scritto:`,
  `ChatGPT ha detto:`) ma **rumoroso**: frammenti separati da ` ⋄ `, lo stesso
  testo ripetuto come `AXValue` e come `AXDescription`, timestamp in più
  formati, testo dei pulsanti.

### Spike 2 — livello deterministico

Un pre-processore in TypeScript, **senza modello**, ha ottenuto **10/10** sui
casi di prova. Componenti:

- **Criterio di sopravvivenza generale**, non una lista di parole d'interfaccia
  (fragile e specifica per app): sopravvive solo ciò che è **attribuito a
  qualcuno**, **marcato come discorso**, o **lungo almeno ~60 caratteri**
  (cioè ha forma di frase).
- **Deduplica per contenimento**: un frammento contenuto in un altro viene
  scartato, si tiene il più informativo.
- **Ricostruzione dei turni** `{speaker, text}` da due forme:
  `Nome: testo HH:MM.` (chat) e `X ha scritto:` + testo (mail, anche inline
  sulla stessa riga con prefissi di data lunghi: "Il giorno 4 set 2026, alle
  ore 11:20, Francesca Bianchi <x@y> ha scritto:").
- `Re:` / `Fwd:` / `Oggetto:` **non sono parlanti**: sono l'oggetto, che va
  estratto a parte.
- **Cancelli di astensione**, tutti deterministici e tutti **prima** di
  qualunque chiamata al modello: nessun turno attribuito a una persona →
  niente; tutti i turni sono dell'utente → niente; **l'ultimo turno è
  dell'utente** → niente (non c'è nulla a cui rispondere); ultimo messaggio
  più corto di ~15 caratteri → niente.
- Serve una **preferenza nuova con il nome dell'utente** per distinguere i suoi
  turni. Senza, l'inversione dei ruoli è inevitabile.
- La trascrizione va data al modello con i **ruoli espliciti**
  (`TU (Danilo):` / `INTERLOCUTORE (Marta):`), presa dalla **coda** con un
  budget di caratteri, non dalla testa.

### Spike 3 — generazione

- **Il fallimento centrale era la sottodeterminazione.** Chiedere al modello
  "tre risposte" produce tre riscritture della stessa cosa, o rigira la domanda
  al mittente, perché il modello non può sapere cosa l'utente vuole rispondere.
  Soluzione misurata: **le tre posizioni le decide il codice**, il modello
  scrive solo la prosa di una posizione data.
  - set generico: `accetto` / `declino` / `rimando`
  - alternativa esplicita nel messaggio ("X o Y?"): `scelgo la prima` /
    `scelgo la seconda` / `rimando`
  - offerta o preventivo: `accetto l'offerta` / `rifiuto` / `chiedo modifiche`
    — necessario perché con il set generico il modello **si scambiava per il
    fornitore** invece che per il cliente.
- Il `declino` **non deve inventare un motivo**: anche il motivo è
  sottodeterminato. Istruzione esplicita a declinare senza motivo.
- **Output vincolato**: JSON con le **chiavi fissate dalla grammatica** (una
  chiave per posizione); il modello riempie solo i testi. Conformità di formato
  da "mai rispettata" a **100%**. Due insidie: lo schema **non viene iniettato
  nel prompt** (il modello non lo vede, va comunque descritto a parole) e la
  grammatica garantisce la **sintassi, non la semantica**.
- Riferimento: *Let Me Speak Freely?* (arXiv 2408.02442) misura che il decoding
  vincolato **peggiora i compiti di ragionamento e migliora quelli di
  classificazione**. Da qui la scelta architetturale: **vincolare la
  classificazione, non vincolare il ragionamento della scrittura** — al
  generatore si vincola solo l'involucro (le tre chiavi), il contenuto delle
  stringhe resta libero.
- I **few-shot non risolvono** la conformità di formato sui modelli piccoli
  (nessun miglioramento statisticamente significativo in letteratura; i 3B
  degradano con l'accumularsi degli esempi). Il formato si ottiene vincolando
  il decoding, non aggiungendo esempi.
- Le **istruzioni astratte vengono copiate alla lettera** dai modelli piccoli
  ("verifichi e fai sapere a breve" ripetuto in seconda persona). Vanno
  sostituite da esempi di voce in prima persona. Rovescio misurato: quando il
  modello ha poco da dire **copia gli esempi**. Va calibrato (vedi §Rischi).
- **Buco noto**: decidere se un messaggio è "rispondibile con una decisione"
  **non funziona con le espressioni regolari** — una domanda che chiede
  informazioni che solo l'utente possiede continua a passare il filtro. Quel
  pezzo va fatto con una **chiamata classificatoria a output vincolato**,
  esattamente il compito in cui il decoding vincolato aiuta.
- **Filtri post-generazione** che scartano la **singola variante**, non
  l'intero risultato: azione già svolta dichiarata ("ho già corretto", "ho
  appena inviato"); impegno o motivo inventato; firma con il nome
  dell'interlocutore; numeri non ancorati al contesto — **anche scritti in
  lettere**, falla trovata quando un modello ha scritto "quattro mila ottocento
  cinquanta euro" sfuggendo al controllo sulle cifre; eco della domanda
  (Jaccard > 0.6 con l'ultimo messaggio); lingua diversa da quella del
  contesto; quasi-duplicati tra varianti (Jaccard > 0.75); lunghezza. Se
  sopravvivono **meno di due varianti, la pill non compare**.

### Benchmark dei modelli

5 modelli × 10 casi × 3 ripetizioni, stesso motore, parametri di sampling
ufficiali di ciascuno. Metriche automatiche: astensione, formato, varianti
senza difetti meccanici, latenza p50 su M5 Pro.

| Modello | Dimensione GGUF | Varianti pulite | p50 |
|---|---|---|---|
| Qwen2.5-3B (oggi in catalogo) | 2,10 GB | 91% | 1108 ms |
| Qwen3.5-2B | 1,28 GB | 100% | 850 ms |
| Qwen3.5-4B | 2,74 GB | 91% | 1518 ms |
| **Gemma 3 4B** | 2,67 GB | 94% | 1417 ms |
| **Gemma 4 E4B** | 4,98 GB | 94% | 1782 ms |

**Conclusione metodologica**: le metriche automatiche **non discriminano**
(tutti fra 91% e 100%). Intercettano difetti meccanici, e un modello che scrive
frasi corte e generiche non ne fa scattare nessuno. La classifica reale è
emersa solo dalla **lettura dei testi**:

1. **Gemma 4 E4B** — il migliore con margine netto. Zero difetti sui casi
   realmente in ambito (i suoi tre difetti segnalati sono tutti sul caso fuori
   ambito). Italiano corretto e idiomatico, prende posizione, ruoli corretti
   anche in inglese.
2. **Gemma 3 4B** — discreto, ma inventa motivi ("ho un carico di lavoro
   pesante") e produce qualche frase incoerente.
3. Qwen3.5-4B — buono in chat; dichiara azioni già svolte ("Ho già preso in
   carico la PR"); sbaglia i ruoli in inglese (parla dell'interlocutore in
   terza persona mentre gli scrive).
4. Qwen3.5-2B — notevole per la taglia, italiano impacciato.
5. Qwen2.5-3B — ultimo: su un thread in cui l'interlocutore annulla il giovedì
   e propone venerdì, **confermava il giovedì annullato**.

Questo ordina la strategia di test (§Strategia di test): la lettura umana su un
corpus non è un complemento, è la metrica primaria.

### Vincolo tecnico bloccante, verificato

`scripts/fetch-binaries.sh` pinna `llama.cpp` al tag **`b4404`** (fine 2024).
Quel binario **non conosce l'architettura `qwen35`** (errore verificato:
`unknown model architecture: 'qwen35'`) né Gemma 3 o successivi. **Qualunque**
modello più recente del 2024 richiede l'aggiornamento del binario. Il bump è
lavoro separato che precede questa feature (§Prerequisiti).

Trappola verificata: **sia Gemma 4 sia Qwen3.5 hanno la modalità di
ragionamento attiva per default** nei GGUF provati (contro quanto dice la
documentazione per la "Small series"). Senza
`chat_template_kwargs: {"enable_thinking": false}` consumano tutti i token nel
ragionamento e restituiscono `content` vuoto: **6,5-9,7 s per nulla**.

Parametri di sampling ufficiali Gemma: `temperature 1.0, top_p 0.95,
top_k 64, min_p 0`, penalità di ripetizione disattivata (`repeat_penalty 1.0`).
**Gemma non ha il ruolo `system`** nel suo template: le istruzioni vanno fuse
nel primo turno utente.

## Architettura

### Strati

La feature è una pipeline a sei strati, ognuno con un contratto stretto verso
il successivo e con la possibilità di **astenersi** (fermare tutto senza
mostrare nulla). L'astensione è il comportamento normale, non un errore: la
maggior parte delle pressioni della hotkey su uno schermo qualunque non deve
produrre una pill.

```
[hotkey Command+Control+R]
  │  ReplyCoordinator: guardie (feature accesa, pipeline dettatura idle,
  │  server pronto, app frontmost consentita)
  ▼
[1. ax_context (addon nativo)]                                ~150 ms misurati
  │  CGEventGetLocation → AXUIElementCopyElementAtPosition → AXEditableAncestor
  │  (fallback kAXFocusedUIElementAttribute) → risalita con rilevazione del salto
  │  → frammenti di testo grezzi + pid/bundleId + flag "campo focalizzato"
  ▼
[2. ConversationParser (TS, deterministico, senza modello)]    < 5 ms stimati
  │  sopravvivenza → dedup per contenimento → turni {speaker,text} → oggetto
  │  → ruoli TU/INTERLOCUTORE (pref userDisplayName) → cancelli di astensione
  │  → coda con budget → trascrizione con ruoli espliciti + gist deterministico
  ▼
[3. ReplyClassifier (llama-server #2, JSON vincolato)]         non misurato
  │  { answerable, kind: generic|alternative|offer, alternatives?, language }
  ▼  se !answerable → astensione
[4. ReplyGenerator (llama-server #2, chiavi JSON fissate)]     850-1782 ms p50 misurati
  │  set di posizioni scelto dal codice in base a `kind`; il modello scrive la prosa
  ▼
[5. VariantFilter (TS, per singola variante)]                  < 5 ms stimati
  │  ≥ 2 sopravvissute → avanti; altrimenti astensione
  ▼
[6. SuggestionOverlay (pill, stato "suggesting")]
  │  gist + 3 varianti; mouse o Command+1/2/3; Esc chiude; auto-chiusura 20 s
  ▼  accettazione
[TextInjector esistente]  attiva l'app di destinazione → clipboard → ⌘V → ripristino
```

### Flusso dei dati e cosa attraversa ogni confine

| Confine | Cosa passa | Cosa NON passa oltre |
|---|---|---|
| nativo → TS | `pid`, `bundleId`, `editableFound`, `editableIsFocused`, `levels[]` (`depth`, `chars`, `fragments[]`), `timings` | titolo finestra, titoli di tab, gerarchia AX, riferimenti `AXUIElement` |
| parser → classificatore | trascrizione a ruoli espliciti troncata dalla coda al budget (2 500 caratteri), oggetto se presente, nome interlocutore | i frammenti grezzi, tutto ciò che precede il budget |
| classificatore → generatore | `kind`, `alternatives`, `language`, la stessa trascrizione | — |
| generatore → filtri | le tre stringhe + le posizioni assegnate | — |
| filtri → overlay | `gist`, varianti sopravvissute `{id, position, text}` | varianti scartate, motivi di scarto (solo nel log, senza testo) |
| overlay → injector | il solo testo scelto | — |

Nulla di tutto questo tocca il disco. Il log riporta **solo metriche** (tempi,
conteggi caratteri per livello, motivo di astensione come codice, `bundleId`)
— mai testo letto dallo schermo né testo generato (§Privacy).

### Tabella dei componenti

| Componente | File | Responsabilità |
|---|---|---|
| `ax_context` | `native/ax-context/ax_context.mm` (+ target in `binding.gyp`) | Leggere il contesto AX sotto il mouse con budget rigidi; attivare l'app di destinazione all'accettazione |
| `AxContextReader` | `src/main/ax-context-reader.ts` | Wrapper TS dell'addon con DI (`native` iniettabile come in `PTTManager`), timeout, conversione in `RawContext` |
| `ConversationParser` | `src/main/utils/conversation-parser.ts` | Deterministico: turni, ruoli, oggetto, cancelli, coda con budget, gist |
| `ReplyClassifier` | `src/main/reply-classifier.ts` | Chiamata a output vincolato: rispondibile? con quale set? |
| `ReplyPositions` | `src/main/utils/reply-positions.ts` | I tre set di posizioni e la loro descrizione per il prompt (codice, non modello) |
| `ReplyGenerator` | `src/main/reply-generator.ts` | Prompt a ruoli espliciti, JSON con chiavi fissate, parametri Gemma |
| `VariantFilter` | `src/main/utils/variant-filter.ts` | Filtri per singola variante; soglia "almeno due" |
| `ReplyServerManager` | `src/main/reply-server-manager.ts` | Ciclo di vita del secondo `LLMServer` legato alla preferenza |
| `ReplyHotkey` | riuso di `HotkeyManager` (`globalShortcut`) | Hotkey configurabile, validazione "niente Option" |
| `SuggestionOverlay` | estensione di `src/main/overlay-window.ts` + `src/renderer/overlay.html` | Stato `suggesting`, scorciatoie temporanee, posizionamento sul display del cursore |
| `ReplyCoordinator` | `src/main/reply-coordinator.ts` | Orchestrazione, stati, mutua esclusione con la dettatura, degradazione |
| Catalogo | `src/main/model-catalog.ts` | `REPLY_MODELS`, `REPLY_TIERS` |
| Preferenze | `src/main/preferences-store.ts`, `src/renderer/preferences.html` | Sei chiavi nuove |
| IPC | `src/shared/ipc-channels.ts` | Canali `reply:*` |

### Componenti

#### 1. `ax_context` — addon nativo

**Responsabilità.** Tutto ciò che richiede le API Accessibility di macOS,
eseguito **nel processo main di Electron** (stesso motivo di `ptt_monitor`: TCC
vede una sola voce Accessibility, `open-flow.app`, e il permesso è già
concesso per la dettatura). Nessun nuovo permesso: la feature richiede la
stessa autorizzazione Accessibility che il PTT richiede già, verificata con
`AXIsProcessTrusted()` come oggi.

**API JS.**

```ts
interface AxContextNative {
  /** Legge il contesto sotto il puntatore. Sincrona, con budget interno. */
  readContextUnderCursor(opts: {
    maxDepth: number;        // 8
    maxTotalChars: number;   // 16_000
    timeBudgetMs: number;    // 300
    jumpRatio: number;       // 10
    jumpMinChars: number;    // 400
  }): NativeContextResult;
  /** Porta in primo piano l'app col pid dato. Ritorna true se accettato. */
  activateApp(pid: number): boolean;
  /** pid dell'app attualmente in primo piano. */
  frontmostPid(): number;
  isTrusted(): boolean;      // AXIsProcessTrusted, come ptt_monitor
}

interface NativeContextResult {
  ok: boolean;
  reason?: "no-element" | "no-editable" | "no-text" | "budget-exceeded" | "ax-error";
  pid: number;
  bundleId: string;
  editableFound: boolean;
  /** true se il campo trovato coincide con kAXFocusedUIElementAttribute. */
  editableIsFocused: boolean;
  /** Un elemento per livello di risalita visitato, in ordine. */
  levels: Array<{ depth: number; chars: number; fragments: string[] }>;
  /** Indice in `levels` del livello scelto (quello del salto), o -1. */
  chosenLevel: number;
  /** Testo dei text marker, solo su app WebKit e solo come rete di sicurezza. */
  webkitMarkerText?: string;
  timings: { elementAtPositionMs: number; collectMs: number; totalMs: number };
}
```

**Procedura** (tutto misurato nello spike 1, salvo dove indicato):

1. `CGEventGetLocation` su un evento creato al volo → punto in coordinate
   AX (origine in alto a sinistra, multi-monitor e negativi inclusi).
2. `AXUIElementCopyElementAtPosition` sull'elemento di sistema → elemento sotto
   il mouse (28-49 ms). Da questo si ricavano il pid (`AXUIElementGetPid`) e
   l'elemento applicazione.
3. Sull'elemento applicazione si imposta `AXManualAccessibility` = true. Il
   ritorno viene ignorato salvo che per il log: è accettato (0) su Slack ed
   Electron, non necessario su Brave e Mail.
4. Ricerca del campo editabile: `AXEditableAncestor` dall'elemento sotto il
   mouse; se assente, `kAXFocusedUIElementAttribute` dell'applicazione. Se
   nessuno dei due dà un elemento → `reason: "no-editable"`. Si registra se
   il campo trovato coincide con quello focalizzato (`editableIsFocused`).
5. **Risalita**: dal campo editabile si sale un antenato alla volta fino a
   `maxDepth`. Per ogni antenato si raccoglie il testo del sottoalbero
   (`AXValue`, `AXDescription`, `AXTitle` dei discendenti), saltando i ruoli
   di puro cromo (barre degli strumenti, barre di scorrimento, menu, pulsanti
   senza testo di contenuto) e rispettando `maxTotalChars` e `timeBudgetMs`.
6. **Rilevazione del salto**: se il livello corrente ha almeno `jumpMinChars`
   caratteri e almeno `jumpRatio` volte quelli del livello precedente, è il
   livello della conversazione: ci si ferma. I valori 10× e 400 caratteri sono
   **scelte di design**, derivate dalle misure (salto 40-200×, livelli
   pre-salto 20-93 caratteri, post-salto 1454-8291) con margine in entrambe le
   direzioni. Se nessun salto entro `maxDepth`, si restituiscono comunque tutti
   i livelli con `chosenLevel = -1`: decide il parser (che prenderà il livello
   più ricco), e il log registra il caso per calibrare le soglie su app non
   ancora misurate.
7. Dove i text marker restituiscono testo utile, in aggiunta e non in
   sostituzione: `AXStringForTextMarkerRange` sul campo editabile e sul suo
   antenato scelto, restituito come `webkitMarkerText`. Il parser lo usa
   unicamente per recuperare gli a capo che l'albero AX perde, mai come fonte
   di contenuto autonoma (sarebbe senza ambito, vedi spike 1).

   Il criterio è **per capacità, non per bundle id**: si tenta
   `AXStartTextMarker` e si prosegue solo se risponde. Identificare le app
   WebKit dal `bundleId` sarebbe sbagliato oltre che fragile — nello spike 1 i
   marker hanno prodotto testo pulito con gli a capo veri in **Mail**
   (`com.apple.mail`), che è WebKit ma non è un derivato di Safari, mentre in
   Chromium rispondono incollando le parole senza spazi. Il tentativo costa
   0-4 ms misurati, quindi provare è più economico che mantenere una lista.

**Budget.** `maxDepth 8` copre i due casi misurati con salto al livello 7 con
un livello di margine; `maxTotalChars 16 000` è il doppio del caso più grande
misurato (8291), serve al parser per lavorare e non è il budget dato al
modello (quello è 2 500, applicato dal parser); `timeBudgetMs 300` è circa il
doppio del totale misurato peggiore (49 + 98 ms). Superato un budget, il
risultato è `ok: false, reason: "budget-exceeded"`: si preferisce non proporre
nulla piuttosto che proporre su un contesto monco.

**Threading.** La chiamata è sincrona sul thread principale di Electron, come
tutte le chiamate dell'addon `ptt_monitor`. Blocca il main per ~150 ms
misurati (300 ms nel caso peggiore per budget). È accettabile perché avviene
prima che la pill compaia e la pill non ha animazioni in corso; la
dettatura è mutuamente esclusa (§9) quindi non c'è audio da servire in quel
momento.

**`activateApp` e `frontmostPid`.** Servono all'accettazione (§6): il paste
via `⌘V` arriva all'app in primo piano, e con due monitor o dopo un click
sulla pill (`focusable: true`) l'app in primo piano può non essere quella in
cui si è letto il contesto. Implementate con `NSRunningApplication`
(`runningApplicationWithProcessIdentifier:` + `activateWithOptions:`) e
`NSWorkspace.sharedWorkspace.frontmostApplication`. Sono API AppKit pubbliche,
non attributi AX.

**Dipendenze.** Nuovo target `ax_context` in `binding.gyp` con lo stesso
schema di `ptt_monitor` (`node-addon-api`, ARC, `MACOSX_DEPLOYMENT_TARGET`
11.0, framework `Cocoa`, `ApplicationServices`). Caricato con `createRequire`
dai due percorsi già usati da `loadNativeAddon` in `ptt-manager.ts`
(`build/Release/` in dev, `app.asar.unpacked/build/Release/` pacchettizzato).
Va ricordato il vincolo documentato in memoria e nel README: la rebuild va
fatta con `electron-rebuild -f --arch arm64`, altrimenti sotto Rosetta si
produce un `.node` incompatibile.

#### 2. `AxContextReader` — wrapper TypeScript

Stesso pattern di `PTTManager`: costruttore con `native?` iniettabile per i
test, caricamento del `.node` altrimenti. Converte `NativeContextResult` in un
`RawContext` con i frammenti già normalizzati (spazi, separatore ` ⋄ `
spezzato, `webkitMarkerText` allineato) e applica il timeout esterno di
sicurezza (500 ms) nel caso in cui l'addon non rispetti il proprio budget.
Non contiene logica di conversazione.

#### 3. `ConversationParser` — pre-processore deterministico

**Responsabilità.** Trasformare i frammenti grezzi in una trascrizione a ruoli
espliciti, oppure astenersi. Nessuna chiamata al modello. È il componente più
testabile della feature (10/10 nello spike 2) e la prima linea di privacy: solo
ciò che sopravvive qui arriva al modello.

**Interfaccia.**

```ts
interface ParseInput {
  fragments: string[];
  userDisplayName: string;       // pref, obbligatoria
  tailBudgetChars: number;       // 2_500
}

type ParseResult =
  | { kind: "abstain"; reason: AbstainReason }
  | {
      kind: "conversation";
      subject?: string;            // da Re:/Fwd:/Oggetto:
      turns: Turn[];               // tutti, in ordine
      counterpart: string;         // nome dell'interlocutore
      transcript: string;          // coda con ruoli espliciti, ≤ tailBudgetChars
      lastMessage: string;         // ultimo turno dell'interlocutore
      gist: string;                // "Rispondi a Marta: chi fa la review?"
      languageGuess: "it" | "en" | "other";
    };

type AbstainReason =
  | "no-attributed-turns" | "only-user-turns" | "last-turn-is-user"
  | "last-message-too-short" | "more-than-two-speakers" | "assistant-speaker";

interface Turn { speaker: string; role: "user" | "counterpart"; text: string; }
```

**Fasi**, nell'ordine:

1. **Normalizzazione**: split su ` ⋄ ` e a capo, trim, collasso spazi.
2. **Sopravvivenza**: resta un frammento se è attribuito (matcha una delle due
   forme di attribuzione), o è marcato come discorso (segue un'attribuzione
   sulla stessa riga), o è lungo ≥ 60 caratteri. Tutto il resto (etichette di
   pulsanti, timestamp isolati, contatori) cade.
3. **Deduplica per contenimento**: se `a ⊂ b` si tiene `b`. Copre la
   duplicazione `AXValue`/`AXDescription`.
4. **Estrazione dell'oggetto**: righe che iniziano con `Re:`, `Fwd:`, `Fw:`,
   `Oggetto:`, `Subject:` vanno in `subject` e non diventano turni.
5. **Ricostruzione dei turni** dalle due forme: `Nome: testo HH:MM` (il
   timestamp finale viene rimosso; accetta `HH:MM`, `HH:MM AM/PM`, `H.MM`) e
   `... Nome <email> ha scritto:` / `... Nome wrote:` con testo sulla stessa
   riga o nelle righe seguenti. Righe non attribuite che seguono un turno si
   accodano a quel turno.
6. **Assegnazione ruoli**: un turno è `user` se il suo speaker, normalizzato
   (case, accenti, spazi), coincide con `userDisplayName` o con il suo primo
   token (nome senza cognome); altrimenti `counterpart`.
7. **Cancelli**, tutti bloccanti e in questo ordine:
   - nessun turno attribuito a una persona → `no-attributed-turns`;
   - lo speaker dell'ultimo turno è in una lista fissa di nomi di assistenti
     (`ChatGPT`, `Claude`, `Gemini`, `Copilot`, `Assistant`, `Assistente`) →
     `assistant-speaker` (attua il non-ambito "ChatGPT e simili");
   - più di due speaker distinti negli ultimi 8 turni → `more-than-two-speakers`;
   - tutti i turni sono `user` → `only-user-turns`;
   - l'ultimo turno è `user` → `last-turn-is-user`;
   - ultimo messaggio < 15 caratteri → `last-message-too-short`.
8. **Coda con budget**: si prendono i turni dal più recente al più vecchio
   finché la trascrizione resta ≤ 2 500 caratteri; l'ultimo turno
   dell'interlocutore è sempre incluso integralmente anche se da solo supera il
   budget (viene troncato in testa, mai in coda). Formato:
   `TU (Danilo): ...` / `INTERLOCUTORE (Marta): ...`, un turno per riga.
9. **Gist deterministico**: `Rispondi a {counterpart}: {frase}`, dove `frase`
   è la prima frase dell'ultimo messaggio che termina con `?`, altrimenti la
   prima frase; troncata a 70 caratteri con `…`. Deterministico e non
   vincolato al modello: se il classificatore poi si astiene, il gist non
   viene mai mostrato; se genera, l'utente vede esattamente ciò che il codice
   ha identificato come la domanda, e può rifiutare a colpo d'occhio.
10. **Lingua**: euristica su parole funzionali frequenti (`it` / `en` /
    `other`). Serve solo ai filtri (§5) per lo scarto "lingua diversa".

Il budget di 2 500 caratteri è una scelta di design: tiene dentro gli ultimi
4-8 turni di una chat o l'ultimo scambio di una mail, e taglia la parte di
contesto che il modello non userebbe comunque ma che aumenterebbe latenza e
superficie di privacy. Va confermato sul corpus (§Strategia di test).

#### 4. `ReplyClassifier` — output vincolato

**Responsabilità.** Chiudere il buco dello spike 3: decidere se il messaggio
è rispondibile con una decisione e con quale set di posizioni, con un compito
di **classificazione** — quello in cui il decoding vincolato aiuta.

**Interfaccia.**

```ts
interface ClassifyInput { transcript: string; lastMessage: string; counterpart: string; }
interface Classification {
  answerable: boolean;              // false → astensione
  kind: "generic" | "alternative" | "offer";
  alternatives?: [string, string];  // solo per kind = alternative, ≤ 40 char ciascuna
  language: "it" | "en" | "other";
}
```

**Meccanica.** Una chiamata a `/v1/chat/completions` del server di risposta
(§8) con `response_format` a schema JSON: `llama-server` converte lo schema in
grammatica GBNF e vincola il decoding. Lo schema fissa le quattro chiavi, il
tipo booleano, l'enum di `kind`, l'array a due stringhe di `alternatives`.
Perché lo schema **non è visibile al modello**, il prompt lo descrive a
parole, con la definizione operativa di "rispondibile": *si risponde
scegliendo fra accettare, rifiutare, rimandare o scegliere fra opzioni
esplicite; NON è rispondibile se la risposta richiede un'informazione che solo
il destinatario conosce (orari, dati, opinioni tecniche, numeri, nomi)*.

Parametri: `temperature 0`, `n_predict 64`, `chat_template_kwargs:
{enable_thinking: false}`, istruzioni fuse nel primo turno utente (Gemma non
ha `system`). La temperatura zero è una scelta di design per avere una
classificazione ripetibile; non è il parametro ufficiale Gemma, che vale per
la generazione (§Rischi).

Il classificatore **non decide il gist** (deterministico, §3) e **non scrive
prosa**. La sua latenza **non è stata misurata** negli spike: la stima è di
poche centinaia di millisecondi su M5 Pro (output ≤ 30 token su un prompt di
~800 token con prefisso in cache), da confermare.

**Astensione** se `answerable === false`, se la risposta non è JSON valido
(non dovrebbe accadere con la grammatica: si logga come anomalia), o se
`kind === "alternative"` senza due alternative non vuote (in quel caso si
degrada a `generic`, non ci si astiene).

#### 5. `ReplyPositions` e `ReplyGenerator`

**`ReplyPositions`** (codice, non modello) mappa `kind` → tre posizioni con
chiave JSON, etichetta per la pill e istruzione di voce per il prompt:

| `kind` | chiave 1 | chiave 2 | chiave 3 |
|---|---|---|---|
| `generic` | `accept` — accetto | `decline` — declino **senza motivo** | `defer` — rimando |
| `alternative` | `first` — scelgo {alternatives[0]} | `second` — scelgo {alternatives[1]} | `defer` — rimando |
| `offer` | `accept_offer` — accetto l'offerta (parlo da cliente) | `reject_offer` — rifiuto | `request_changes` — chiedo modifiche |

Il set `offer` esiste perché con il set generico il modello si scambiava per
il fornitore; l'istruzione dichiara esplicitamente il ruolo di chi riceve
l'offerta.

**`ReplyGenerator`.** Una sola chiamata a `/v1/chat/completions` con
`response_format` a schema JSON le cui **tre chiavi sono quelle del set
scelto**, ciascuna una stringa. Il modello riempie solo i testi. Il prompt:

- fonde le istruzioni nel primo turno utente (Gemma senza `system`);
- descrive a parole il formato (le tre chiavi e il fatto che ogni valore è la
  sola risposta, senza saluto iniziale, senza firma, senza commenti);
- dichiara i ruoli: *tu sei {userDisplayName}; scrivi a {counterpart}; le
  righe `TU` sono tue, le righe `INTERLOCUTORE` sono sue*;
- passa la trascrizione a coda (§3) e, se presente, l'oggetto;
- per ogni chiave dà la posizione e un esempio di voce in prima persona, breve
  e generico, scelto per **non essere copiabile** nel contesto (nessun
  riferimento a giorni, nomi, cifre);
- vieta esplicitamente: inventare motivi per il rifiuto, dichiarare azioni già
  svolte, aggiungere numeri o date che non compaiono nel contesto, firmare.

Parametri: **quelli ufficiali Gemma** (`temperature 1.0, top_p 0.95,
top_k 64, min_p 0, repeat_penalty 1.0`), `n_predict 320` (tre varianti da
20-280 caratteri, circa 60-80 token ciascuna, con margine per il JSON),
`chat_template_kwargs: {enable_thinking: false}`, `cache_prompt: true` (il
prefisso di istruzioni è identico fra chiamate e va tenuto nel KV cache, come
fa oggi `LLMCleaner`). Timeout 10 s: il p50 misurato è 1,4-1,8 s su M5 Pro,
stimato 3-5 s su Mac base; oltre 10 s l'utente ha già perso interesse.

Il generatore restituisce le tre stringhe **grezze**: la pulizia è del filtro.

#### 6. `VariantFilter`

**Responsabilità.** Scartare la singola variante difettosa, non l'intero
risultato — lo spirito di `output-sanitizer.ts` applicato a tre testi
indipendenti. Restituisce le sopravvissute; se sono **meno di due**, il
coordinatore si astiene e la pill non compare (una sola proposta non è una
scelta ed è indistinguibile da un suggerimento autoritario).

**Interfaccia.**

```ts
interface FilterInput {
  variants: Array<{ key: string; position: string; text: string }>;
  lastMessage: string;
  transcript: string;
  counterpart: string;
  userDisplayName: string;
  language: "it" | "en" | "other";
}
interface FilterOutput {
  kept: Array<{ key: string; position: string; text: string }>;
  dropped: Array<{ key: string; rule: string }>;   // solo per il log, senza testo
}
```

**Regole**, applicate nell'ordine, ognuna con la sua soglia:

| Regola | Criterio | Motivazione misurata |
|---|---|---|
| Pulizia meccanica | strip di markdown (`*`, `_`), virgolette avvolgenti, prefissi tipo `Risposta:`; `trim` | come `sanitizeLlmOutput` |
| Lunghezza | 20 ≤ caratteri ≤ 280 | sotto è un "ok", sopra è un'email |
| Azione già svolta | pattern in prima persona al passato prossimo con verbi d'azione (`ho già`, `ho appena`, `ho inviato`, `ho corretto`, `I've already`, `I just sent`) | Qwen3.5-4B "Ho già preso in carico la PR" |
| Motivo inventato nel rifiuto | solo per `decline`/`reject_offer`: connettivi causali (`perché`, `in quanto`, `dato che`, `a causa`, `because`, `since`) seguiti da contenuto non presente nel contesto | Gemma 3 4B "ho un carico di lavoro pesante" |
| Firma | il testo termina con il nome dell'interlocutore o dell'utente su riga propria, o contiene `Cordiali saluti,` seguito da un nome | ruoli invertiti |
| Numeri non ancorati | ogni numero nella variante — **in cifre o in lettere** (parser numerale it/en: `quattro mila ottocento cinquanta` → 4850) — deve comparire nel contesto, in cifre o in lettere | la falla "quattro mila ottocento cinquanta euro" |
| Eco della domanda | Jaccard su insiemi di parole (minuscole, senza stopword) fra variante e `lastMessage` > 0.6 → scarto | il modello rigira la domanda |
| Lingua | lingua stimata della variante ≠ `language` del contesto (quando `language` ≠ `other`) → scarto | risposte in inglese a thread italiani |
| Quasi-duplicati | fra le sopravvissute, Jaccard > 0.75 a coppie → si tiene la prima nell'ordine del set, si scarta l'altra | tre riscritture della stessa cosa |
| Prima persona | almeno un indicatore di prima persona (`io`, verbi in `-o`, `I`, `I'll`, `I'd`) o l'assenza di seconda persona imperativa dominante | copiatura letterale delle istruzioni in seconda persona |

Le soglie 0.6 e 0.75 sono quelle usate nello spike 3. I range di lunghezza e
la lista di verbi d'azione sono scelte di design da tarare sul corpus. Il log
riporta solo `{key, rule}` degli scarti, mai il testo.

#### 7. `SuggestionOverlay` — la pill

**Responsabilità.** Mostrare in un colpo d'occhio cosa è stato capito e le
proposte; accettare una scelta senza rubare il focus all'app di destinazione;
sparire da sola.

**Nuovo stato** `suggesting`, accanto agli stati di pipeline esistenti, con un
payload:

```ts
interface SuggestionPayload {
  gist: string;                                         // "Rispondi a Marta: chi fa la review?"
  variants: Array<{ id: 1 | 2 | 3; label: string; text: string }>;  // 2 o 3
}
```

Stati intermedi visibili, perché l'attesa può arrivare a 4-6 s su Mac base
(stima): `reading` ("Leggo il contesto…"), `thinking` ("Preparo le
risposte…"), poi `suggesting`, oppure un flash `nothing` ("Nessuna proposta",
1 s) quando ci si astiene dopo la hotkey. Il flash esiste perché una hotkey
che non fa nulla è indistinguibile da una hotkey rotta; il motivo
dell'astensione **non** viene mostrato (finirebbe per descrivere il contenuto
dello schermo) ma va nel log come codice.

**Layout.** La pill esistente è 360×80 in una finestra 420×124. Lo stato
`suggesting` la estende in altezza (stimati 420×260, la finestra a 480×300 per
l'ombra) con: riga del gist in alto; tre righe cliccabili con a sinistra il
badge `⌘1` `⌘2` `⌘3` e l'etichetta della posizione ("Accetto", "Declino",
"Rimando"), a destra il testo troncato a due righe con il testo completo nel
`title`; `Esc` a fianco del `✕` esistente. La finestra viene ridimensionata
con `setBounds` all'ingresso in `suggesting` e ripristinata all'uscita.

**Perché `Command+1/2/3` e non `1/2/3`.** La pill è mostrata con
`showInactive()` per **non rubare il focus** all'app di destinazione: è una
necessità, perché il paste finale via `⌘V` deve arrivare lì. Una finestra
inattiva **non riceve eventi di tastiera**: un `1` premuto finisce nell'app
sotto, non nella pill. Le scelte da tastiera devono quindi essere
**scorciatoie globali** (`globalShortcut`), e una scorciatoia globale su un
tasto nudo come `1` intercetterebbe la digitazione normale dell'utente per
tutto il tempo in cui la pill è visibile. `Command+1/2/3` ed `Escape` vengono
**registrate quando la pill entra in `suggesting` e deregistrate all'uscita**,
qualunque sia il motivo dell'uscita (scelta, `Esc`, click su `✕`, timeout,
arm del PTT). Costo dichiarato: per la durata della pill (≤ 20 s) `⌘1/2/3`
non arrivano all'app sotto — nei browser sono il cambio di tab. Accettato e
limitato nel tempo (§Rischi).

**Mouse.** Il click su una riga invia `reply:choose` con l'`id`. La finestra è
già `focusable: true` + `acceptFirstMouse: true` (necessario al `✕`
esistente): il click **può** attivare la finestra dell'overlay. Per questo
l'accettazione **riattiva sempre** l'app di destinazione prima del paste (§9).

**Auto-chiusura** dopo 20 s senza interazione: le proposte sono legate a un
momento; dopo, l'utente ha probabilmente già risposto a mano. Il timer si
azzera se il mouse entra nella pill.

**Posizionamento.** `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`
al posto di `screen.getPrimaryDisplay()`, e la finestra viene riposizionata
**a ogni `show()`**, non solo in `create()`: l'utente cambia monitor fra una
dettatura e l'altra. La correzione vale anche per gli stati di dettatura
esistenti (oggi con due monitor la pill esce sistematicamente sul primario).
Coordinate: `x = workArea.x + (workArea.width − w) / 2`,
`y = workArea.y + workArea.height − h + 24`, con l'offset per l'ombra già
documentato nel file.

**IPC.** Nuovi canali in `ipc-channels.ts`: `reply:suggestions` (main →
overlay, payload), `reply:choose` (overlay → main, `id`), `reply:dismiss`
(overlay → main). Il preload dell'overlay espone `onSuggestions`, `choose`,
`dismiss` accanto a `onState` / `onPartial` / `cancel`.

#### 8. `ReplyServerManager` — il secondo `llama-server`

**Perché due server.** Il modello di pulizia della dettatura (Qwen2.5) è nel
percorso critico della latenza e resta com'è (decisione 5). Il modello di
risposta è un altro modello, quindi un altro processo `llama-server`: la
classe `LLMServer` esistente si riusa così com'è, istanziata due volte.

**Configurazione.** Porta **18082** (18080 è la pulizia, 18081 il
`whisper-server` di fallback). `contextSize 3072`: 2 500 caratteri di coda
(~800 token stimati) + istruzioni (~600 token) + output (320) + margine; è
quattro volte il `1536` della pulizia e pesa sul KV cache, che resta
quantizzato `q8_0` con `-fa` come oggi. `warmupPrompt` = il prefisso di
istruzioni del generatore, così è in cache alla prima hotkey. `keepaliveMs
20_000` come il server di pulizia: senza, ogni proposta pagherebbe il
cold-start Metal (~2,5 s misurati sulla pulizia); il costo è un secondo ping
periodico che contende la GPU con whisper (§Rischi).

**Ciclo di vita legato alla preferenza** (decisione 3):

| Evento | Azione |
|---|---|
| avvio app con `replySuggestionsEnabled = true` e modello installato | `start()` in background dopo il server di pulizia, senza bloccare l'avvio; la hotkey risponde "Modello in caricamento…" finché `isRunning()` è falso |
| avvio app con la feature spenta | nessun processo, nessuna RAM: identico a oggi |
| l'utente accende la feature | se il modello del tier non è installato → download via `ModelManager` con progresso nelle preferenze, poi `start()`; altrimenti `start()` subito. La hotkey viene registrata solo a server pronto |
| l'utente spegne la feature | `stop()` (SIGTERM), deregistrazione della hotkey, chiusura della pill se visibile |
| cambio tier | `stop()` del server corrente → download se serve → `start()` col nuovo modello |
| `will-quit` | `stop()` accanto al server di pulizia |

Il manager espone `getEndpoint()`, `isReady()`, `state: "off" | "downloading"
| "starting" | "ready" | "failed"` e la preferences window lo mostra.

**RAM.** Target: Mac base da 16 GB. Stime (non misurate) del residente a
feature accesa, oltre a quanto l'app usa oggi (whisper small + Qwen 1.5B
≈ 2,0-2,5 GB stimati):

| Tier | GGUF | Stima residente con KV 3072 q8_0 |
|---|---|---|
| default — Gemma 3 4B | 2,67 GB | ~3,3 GB |
| max — Gemma 4 E4B | 4,98 GB | ~5,8 GB |

A feature spenta: zero. La preferences window mostra queste cifre accanto al
tier, come già il wizard mostra le dimensioni dei modelli.

#### 9. `ReplyCoordinator` e hotkey

**Hotkey.** Riuso di `HotkeyManager` (`globalShortcut.register`) con
l'acceleratore della preferenza `replySuggestionsHotkey`, default
**`Command+Control+R`**. Il manager esistente è un toggle start/stop; qui
serve un impulso, quindi si usa solo l'evento `start` e si chiama `reset()`
subito dopo. **Validazione**: l'acceleratore non può contenere `Alt` /
`Option` — la dettatura usa "Hold Option" via il monitor nativo dei
modificatori, e Option in una combinazione farebbe partire `arm` sul PTT (e
poi un `CHORD` che lo cancella, con flicker della pill di registrazione). La
preferences window rifiuta l'acceleratore e spiega perché. Se
`globalShortcut.register` ritorna `false` (conflitto), la feature resta
attiva ma senza hotkey e la preferences window lo segnala, come già fa il
design MVP per il conflitto della hotkey di dettatura.

**Mutua esclusione con la dettatura.** La hotkey è ignorata se il
`PipelineCoordinator` non è `idle` o se `pipelineBusy` è vero. Viceversa, un
`arm` del PTT mentre la pill è in `suggesting` la **chiude** (l'utente ha
deciso di dettare) e deregistra le scorciatoie temporanee. Un secondo
`Command+Control+R` durante `reading`/`thinking` è ignorato; durante
`suggesting` chiude la pill (comportamento toggle, prevedibile).

**Sequenza all'hotkey** (ogni passo può astenersi; l'astensione va nel log
come codice e produce il flash `nothing`):

1. Guardie: feature accesa, server `ready`, dettatura idle,
   `AXIsProcessTrusted()`.
2. `frontmostPid()` e `readContextUnderCursor()`. L'app dell'elemento sotto il
   mouse deve essere quella in primo piano: se non lo è (secondo monitor con
   un'altra app attiva) → astensione `not-frontmost`. È un vincolo deliberato:
   leggere una finestra in secondo piano e poi incollare nell'app attiva
   sarebbe il peggiore degli errori possibili.
3. Il `bundleId` deve passare la lista di app (§Preferenze): altrimenti
   `app-not-allowed`.
4. `ConversationParser.parse` → astensione o trascrizione. Stato `reading` →
   `thinking`.
5. `ReplyClassifier.classify` → `answerable` o astensione.
6. `ReplyGenerator.generate` → tre testi.
7. `VariantFilter.filter` → `kept`; se `< 2` → astensione `too-few-variants`.
8. `SuggestionOverlay.showSuggestions({gist, variants})`, registrazione di
   `Command+1/2/3` + `Escape`, timer 20 s.

Timeout complessivo dalla hotkey alla pill: **12 s**, oltre il quale si
astiene con `timeout` (p50 atteso 2 s su M5 Pro; 4-6 s stimati su Mac base).

**Sequenza all'accettazione:**

1. Deregistrazione delle scorciatoie, pill in `injecting`.
2. `activateApp(pid)` con il pid catturato al passo 2 dell'hotkey; attesa fino
   a 300 ms che `frontmostPid() === pid`. Se non accade → il testo va in
   clipboard, pill "Copiato — incolla con ⌘V" per 1,5 s, nessun `⌘V`
   simulato.
3. Se `editableIsFocused` era falso (il campo trovato con `AXEditableAncestor`
   non è quello con il focus) → stesso comportamento: solo clipboard con
   avviso. Il `⌘V` arriva al campo focalizzato, e non abbiamo verificato che
   sia quello giusto: meglio un passaggio in più all'utente che un paste nel
   posto sbagliato. Coerente con il caso limite MVP "nessun campo
   focalizzato → solo clipboard + notifica".
4. Altrimenti `TextInjector.inject(text)` esistente (salva clipboard → scrive
   → `⌘V` → 500 ms → ripristina).
5. Pill in `idle`, hide dopo 500 ms come oggi.

## Preferenze nuove

Aggiunte a `Preferences` / `DEFAULT_PREFS`; la fusione `{...DEFAULT_PREFS,
...parsed}` di `PreferencesStore.load` copre gli utenti esistenti senza
migrazione.

| Chiave | Tipo | Default | Note |
|---|---|---|---|
| `replySuggestionsEnabled` | `boolean` | `false` | Spenta per default. Accenderla richiede `userDisplayName` non vuoto e il modello del tier installato (la UI guida il download) |
| `replySuggestionsHotkey` | `string` | `"Command+Control+R"` | Acceleratore Electron; rifiutato se contiene `Alt`/`Option` |
| `replyModelId` | `string` | `"gemma-3-4b"` | Id in `REPLY_MODELS`; selezionato via tier nella UI |
| `userDisplayName` | `string` | `""` | Il nome con cui l'utente compare nelle chat e nelle mail. Confronto normalizzato su nome completo e primo token |
| `replyAppsMode` | `"allowlist" \| "blocklist"` | `"allowlist"` | Allowlist per default: la feature legge solo dove l'utente l'ha permesso |
| `replyApps` | `string[]` | le tre app verificate nello spike: `com.tinyspeck.slackmacgap`, `com.apple.mail`, `com.brave.Browser` | Bundle id. In modalità `allowlist` è la lista delle app permesse; in `blocklist` di quelle escluse. La UI mostra il nome leggibile e permette di aggiungere l'app in primo piano con un pulsante |

La preferences window mostra inoltre, in sola lettura, lo stato del server di
risposta (`off / downloading / starting / ready / failed`) e la stima di RAM del
tier scelto.

## Catalogo modelli e tier

`model-catalog.ts` acquista una terza lista di modelli e una seconda tabella
di tier, separata da `TIERS` della dettatura perché la scelta è indipendente
(decisione 2):

```ts
export const REPLY_MODELS: readonly ModelDescriptor[] = [
  { id: "gemma-3-4b",  filename: "<GGUF Gemma 3 4B it, Q4>",  sizeBytes: <da HF al momento del piano>, sha256: <da HF>, url: <HF> },
  { id: "gemma-4-e4b", filename: "<GGUF Gemma 4 E4B it, Q4>", sizeBytes: <da HF al momento del piano>, sha256: <da HF>, url: <HF> },
];

export interface ReplyTierDescriptor {
  id: "default" | "max";
  label: string;
  description: string;
  replyModelId: string;
}

export const REPLY_TIERS: readonly ReplyTierDescriptor[] = [
  { id: "default", label: "Standard (consigliato)",
    description: "Gemma 3 4B. 2,67 GB su disco, ~3,3 GB di RAM a feature accesa (stima). Buona qualità, può inventare un motivo nel rifiuto.",
    replyModelId: "gemma-3-4b" },
  { id: "max", label: "Qualità massima",
    description: "Gemma 4 E4B. 4,98 GB su disco, ~5,8 GB di RAM a feature accesa (stima). Il migliore alla lettura: prende posizione, ruoli corretti anche in inglese. Consigliato da 24 GB di RAM.",
    replyModelId: "gemma-4-e4b" },
];
```

`getModelById` accetta il nuovo `kind: "reply"`. I file GGUF devono essere
**gli stessi usati nel benchmark**: la scoperta della modalità di ragionamento
attiva per default vale per quei file, e un GGUF diverso della stessa famiglia
potrebbe comportarsi diversamente sul template. Dimensioni misurate: 2,67 GB e
4,98 GB; `sizeBytes`, `sha256` e `url` esatti vanno letti da HuggingFace al
momento del piano, come fatto per `qwen-3b` nella spec v2.

Perché **Gemma 3 4B come default** e non Gemma 4 E4B, che è il migliore: il
target è il Mac base da 16 GB, e 5,8 GB stimati di residente in più — sopra
ai ~2,5 GB della dettatura e a un browser — sono il limite della macchina.
Gemma 3 4B è discreto alla lettura e i suoi difetti principali (motivo
inventato nel rifiuto) sono esattamente quelli che il `VariantFilter`
intercetta. Chi ha RAM sceglie `max`.

Nessun modello Qwen entra nel catalogo di risposta: Qwen2.5-3B è ultimo alla
lettura e Qwen3.5 richiede lo stesso bump di binario senza il vantaggio di
qualità di Gemma 4.

## Flusso utente tipico

1. L'utente legge un messaggio in Slack: "Chi fa la review della PR, tu o
   Luca?". Il mouse è sopra la conversazione.
2. Preme `Command+Control+R`. La pill compare sul monitor del cursore:
   "Leggo il contesto…" poi "Preparo le risposte…" (~2 s su M5 Pro misurati
   per la sola generazione, 4-6 s stimati su Mac base).
3. La pill mostra: **Rispondi a Marta: chi fa la review della PR, tu o Luca?**
   e tre righe — `⌘1 Scelgo io` / `⌘2 Scelgo Luca` / `⌘3 Rimando` — con la
   prosa di ciascuna.
4. Se il gist è sbagliato (ha capito un'altra domanda), l'utente preme `Esc` e
   scrive a mano. Se è giusto, preme `⌘1` o clicca la riga.
5. Slack torna in primo piano se non lo era, il testo compare nel campo di
   input. La pill svanisce. L'utente rilegge e invia (l'app **non invia mai**:
   incolla e basta).

Se la hotkey viene premuta su un documento, su una pagina web senza
conversazione, su un thread in cui l'ultimo a scrivere è l'utente, su una
domanda che chiede un'informazione ("a che ora hai il volo?"), la pill mostra
"Nessuna proposta" per un secondo e sparisce.

## Gestione errori e degradazione a livelli

Filosofia, come nell'MVP: mai incollare testo sbagliato in silenzio. Qui si
aggiunge: **mai mostrare una pill con una sola proposta**, e **mai spiegare
sullo schermo perché ci si è astenuti** (il motivo descriverebbe il contenuto
letto). I livelli sono ordinati dal meno al più visibile.

| Livello | Condizione | Comportamento visibile | Log (codice) |
|---|---|---|---|
| L0 — silenzio | feature spenta; dettatura in corso; hotkey durante `reading`/`thinking` | nulla | `ignored:<reason>` |
| L1 — flash "Nessuna proposta" (1 s) | astensione del parser; `answerable=false`; `< 2` varianti; `not-frontmost`; `no-editable`; `budget-exceeded`; timeout 12 s | flash e sparizione | `abstain:<reason>`, tempi, conteggi |
| L2 — flash informativo (1,5 s) | `app-not-allowed` ("App non abilitata — aggiungila nelle preferenze"); server `starting`/`downloading` ("Modello in caricamento…"); hotkey non registrata per conflitto | messaggio breve e neutro | `blocked:<reason>` |
| L3 — degradazione all'accettazione | `activateApp` fallisce; `editableIsFocused=false`; `runPaste` lancia (permesso Accessibility perso) | testo in clipboard + "Copiato — incolla con ⌘V" | `inject:<reason>` |
| L4 — errore del server | `LLMError` HTTP/rete; JSON non valido nonostante la grammatica; server `failed` | pill `error` esistente per 2 s; se il server è morto il manager tenta **un** riavvio automatico, poi passa a `failed` e la preferences window lo mostra | `error:<message>` |
| L5 — permesso mancante | `AXIsProcessTrusted()` falso alla hotkey | lo stesso dialogo del PTT (§`index.ts`) con deep link a Privacy & Security → Accessibility | `trust-required` |
| L6 — addon non caricabile | `require` del `.node` fallisce all'avvio | la feature si disabilita da sola per la sessione, la preferences window lo mostra; il resto dell'app parte normalmente | `native-load-failed` |

Ogni livello lascia l'app nello stato in cui la dettatura funziona: nessun
percorso di questa feature può bloccare il PTT, e il fallimento del server di
risposta non tocca il server di pulizia (processi distinti, porte distinte).

## Privacy

Durante gli spike, i **log della sonda** — che raccoglievano il testo per
studiarlo — hanno catturato: DM di lavoro, i titoli di tutte le tab aperte
(inclusi ambienti di produzione), **3363 messaggi** di una casella di posta,
un indirizzo personale, contenuti di code review. La feature tocca materiale
di questo tipo **a ogni lettura**. Il posizionamento del progetto nel README è
*local-first, nothing is sent to the cloud*; questa feature deve tenerlo vero
e aggiungere i vincoli che seguono, ognuno verificabile.

1. **Nessuna trasmissione fuori dalla macchina.** I due `llama-server`
   ascoltano su `127.0.0.1`. Non esiste alcun endpoint remoto nel codice di
   questa feature; l'unico traffico di rete resta il download dei modelli da
   HuggingFace, esplicito e mostrato all'utente.
2. **Nessuna persistenza su disco.** Il log (`logger.ts`, anche con
   `debugLogging` acceso) riceve **solo** metriche: tempi, conteggi caratteri
   per livello, `bundleId`, codici di astensione, `{key, rule}` degli scarti.
   **Mai** frammenti AX, trascrizione, gist, varianti, testo scelto. È un
   requisito di test: un test unitario alimenta il logger con un logger-spia
   e verifica che nessun argomento contenga sottostringhe della fixture. La
   clipboard viene sovrascritta e ripristinata come oggi; l'unica eccezione
   è la degradazione L3, dove il testo *resta* in clipboard di proposito
   perché l'utente deve incollarlo a mano, e la pill lo dice.
3. **Nessuna lettura senza gesto.** L'addon viene invocato solo dalla hotkey.
   Nessun timer, nessun listener di focus, nessun polling. Verificabile:
   `readContextUnderCursor` ha un solo call site, nel `ReplyCoordinator`, nel
   gestore della hotkey.
4. **Allowlist per default.** La feature legge solo le app che l'utente ha
   elencato; la lista iniziale contiene le tre app verificate. La modalità
   `blocklist` esiste per chi vuole il contrario, ma va scelta esplicitamente.
   Il controllo avviene **prima** della raccolta del testo (il `bundleId`
   arriva dall'elemento sotto il mouse, che si legge comunque; ma la risalita
   e la raccolta dei frammenti partono solo se l'app è permessa).
5. **Budget di contesto stretto.** Al modello arrivano al massimo 2 500
   caratteri dalla coda della conversazione. L'addon si ferma al livello del
   salto e non sale oltre; i text marker (che su ChatGPT restituivano l'intera
   cronologia laterale) si usano solo su WebKit e solo per gli a capo.
6. **Il mouse sceglie la finestra**: si legge una finestra sola, quella sotto
   il cursore, e solo se è in primo piano. Non si enumerano le altre finestre,
   né i titoli delle tab.
7. **Nessun contenuto negli errori.** I messaggi di `LLMError` includono al
   massimo 500 caratteri della risposta HTTP del server (come oggi in
   `llm-cleaner.ts`): per questa feature vengono **troncati a codice di stato
   e tipo di errore**, perché la risposta conterrebbe il JSON generato.
8. **Nessuna telemetria.** Il progetto non ne ha; questa feature non ne
   introduce.
9. **Il corpus di test è anonimizzato** (§Strategia di test) e i log della
   sonda degli spike **non entrano nel repository**.

## Strategia di test a strati

La lezione del benchmark: le metriche automatiche intercettano difetti
meccanici e **non discriminano la qualità** (91-100% per tutti i modelli).
Servono a bloccare le regressioni di forma; la qualità si misura **leggendo**.
Quindi tre strati, con pesi diversi.

### Strato 1 — unitario (Vitest, in CI, senza modelli né addon)

| Modulo | Cosa si verifica |
|---|---|
| `conversation-parser` | i 10 casi dello spike 2 come fixture (chat Slack con timestamp, mail con `ha scritto:` inline e su più righe, oggetto `Re:`/`Fwd:`, dedup `AXValue`/`AXDescription`, frammenti ` ⋄ `); ogni cancello di astensione con un caso positivo e uno negativo; l'ultimo turno dell'interlocutore mai troncato in coda; ruoli con nome completo e con solo primo nome; gist con e senza `?`; speaker assistente → astensione; tre speaker → astensione |
| `variant-filter` | una fixture per regola, incluse **"quattro mila ottocento cinquanta euro"** vs contesto senza 4850, l'eco a Jaccard 0.61 scartata e 0.59 tenuta, il quasi-duplicato a 0.76, il motivo inventato solo su `decline`; `kept.length < 2` propagato |
| `reply-positions` | i tre set, le alternative interpolate, il fallback `alternative` senza alternative → `generic` |
| `reply-classifier` / `reply-generator` | con `fetchImpl` mock (stesso pattern DI di `LLMCleaner`): il body contiene `chat_template_kwargs.enable_thinking === false`, il `response_format` ha esattamente le chiavi del set, i parametri di sampling sono quelli ufficiali Gemma per il generatore e `temperature 0` per il classificatore, nessun messaggio con ruolo `system`, timeout rispettato |
| `reply-server-manager` | con `LLMServer` finto: accendere la pref avvia, spegnere ferma, cambio tier ferma-e-riavvia, `will-quit` ferma; un solo riavvio automatico dopo `failed` |
| `reply-coordinator` | con tutte le dipendenze finte: le guardie (dettatura non idle → `ignored`), `not-frontmost`, `app-not-allowed` in entrambe le modalità, `< 2` varianti → `nothing`, timeout 12 s, il `PTT arm` chiude la pill e deregistra le scorciatoie, l'accettazione con `editableIsFocused=false` va in clipboard senza `runPaste` |
| overlay (funzione pura) | `computeOverlayBounds(displays, cursor, size)` sceglie il display del cursore, incluse coordinate negative |
| hotkey | l'acceleratore con `Alt`/`Option` viene rifiutato; `Command+Control+R` accettato |
| `preferences-store` | i nuovi default; un file di preferenze vecchio si carica con la feature spenta |
| `model-catalog` | `REPLY_TIERS` risolvono a modelli presenti in `REPLY_MODELS`; nessun id duplicato fra le tre liste |
| logger-spia | nessun argomento passato al logger contiene testo delle fixture (requisito privacy 2) |

### Strato 2 — integrazione (opt-in, richiede binario aggiornato e modello)

Come oggi gli integration test con Whisper/LLM reali: girano in locale, non in
CI, con `llama-server` sul GGUF del tier default.

- **Classificatore** sul corpus: ogni caso annotato a mano con `answerable` e
  `kind`; si misura accuratezza e, separatamente, il **tasso di falsi
  positivi sui casi "informazione che solo l'utente possiede"** — è il buco
  dichiarato, va misurato a ogni cambio di prompt o di modello.
- **Generatore**: conformità di formato (deve restare 100%), tasso di
  astensione a valle dei filtri, distribuzione delle regole di scarto,
  latenza p50/p95.
- **Pipeline completa** parser → classificatore → generatore → filtri sui
  frammenti grezzi del corpus (non sui turni già puliti), per verificare che
  gli strati si incastrino.

### Strato 3 — lettura umana sul corpus (la metrica primaria)

- **Corpus**: conversazioni **catturate da app reali** (Slack, Mail, Brave)
  con la sonda dello spike, poi **anonimizzate** con sostituzione sistematica
  di nomi, indirizzi, domini, importi, date e nomi di progetto; nessun
  frammento riconoscibile. Vive in `test/fixtures/conversations/` con, per
  ogni caso, i frammenti AX grezzi e le annotazioni attese. Il corpus dello
  spike (10 casi) è il nucleo; il target per il rilascio è **≥ 40 casi**, di
  cui almeno 10 fuori ambito (informazione richiesta, thread a tre, assistente,
  ultimo turno dell'utente) e almeno 8 in inglese.
- **Rubrica** per variante, compilata da una persona, con voto binario su
  cinque assi: ruoli corretti (parla come l'utente, all'interlocutore); nessun
  fatto inventato (motivi, azioni svolte, numeri, date); prende la posizione
  assegnata e non un'altra; lingua idiomatica; distinta dalle altre due. Un
  caso passa se **tutte** le varianti mostrate passano tutti gli assi.
- **Soglia di rilascio**: ≥ 90% dei casi in ambito passano con il tier
  default; **zero** pill mostrate sui casi fuori ambito annotati come tali.
- Si ripete a ogni cambio di prompt, di filtro o di modello. Il report
  (senza testi, solo voti e codici) si allega alla PR.

### Strato 4 — manuale sull'addon e sull'app (checklist pre-release)

Estensione di `docs/electron-smoke-checklist.md`: Slack, Mail, Brave (le tre
app misurate) con hotkey su conversazione, su documento, su campo vuoto; due
monitor con il cursore sul secondario e con l'app di destinazione non in primo
piano; `⌘1/2/3` ed `Esc`; click sulla pill e verifica che il paste arrivi
nell'app giusta; timeout 20 s; feature spenta → nessun processo `llama-server`
sulla porta 18082 (`lsof`); RAM residente a feature accesa e spenta (Activity
Monitor) su un Mac da 16 GB. Non automatizzabile, come i permessi macOS
nell'MVP.

## Prerequisiti

1. **Bump di `llama.cpp`** in `scripts/fetch-binaries.sh` da `b4404` a una
   release che carichi le architetture Gemma 3 e Gemma 4 (e `qwen35`, anche se
   non entra in catalogo). **È lavoro separato che precede questa feature** e
   ha la sua validazione: la catena di dettatura (whisper streaming, latenza
   della pulizia, qualità della pulizia con l'output sanitizer, flag `-fa`,
   `-ctk/-ctv q8_0`) deve risultare invariata sul nuovo binario prima che
   questa feature parta. Questa spec **richiede** che il binario aggiornato
   supporti inoltre: `chat_template_kwargs` (per `enable_thinking: false`),
   `response_format` a schema JSON su `/v1/chat/completions`, e il template
   chat Gemma senza ruolo `system`. Tre verifiche puntuali da fare nel lavoro
   di bump, non qui.
2. **Permesso Accessibility** già concesso (lo richiede il PTT): nessun nuovo
   permesso, nessuna nuova voce TCC.
3. **Toolchain nativa** già presente (`node-addon-api`, `electron-rebuild`,
   Xcode command line tools): il nuovo target si aggiunge a `binding.gyp`.
4. **Nome dell'utente** inserito nelle preferenze prima di poter accendere la
   feature.

## Rischi aperti dichiarati

1. **Il buco della classificazione dell'ambito.** Le espressioni regolari non
   distinguono "ti va bene giovedì?" da "a che ora arrivi giovedì?". Il
   classificatore a output vincolato è la soluzione architetturalmente
   corretta (classificazione = dove il decoding vincolato aiuta), ma **non è
   stato misurato**: né la sua accuratezza né la sua latenza. È il primo
   esperimento del piano di implementazione e il tasso di falsi positivi sui
   casi "informazione richiesta" è la metrica che decide se la feature è
   rilasciabile. Mitigazione se resta alto: restringere `answerable` con un
   secondo criterio deterministico a monte (presenza di una proposta esplicita
   nel messaggio: verbi modali, "ti va", "possiamo", alternative "o") accettando
   più falsi negativi.
2. **Calibrazione fra copiatura delle istruzioni e copiatura degli esempi.**
   Istruzioni astratte → il modello le ripete in seconda persona; esempi di
   voce → il modello li copia quando ha poco da dire. Il punto di equilibrio
   dipende dal modello e va trovato sul corpus, per tier. Il `VariantFilter`
   (regola "prima persona", regola "eco") è la rete, non la soluzione. Rischio
   che il tier default richieda un prompt diverso dal tier max.
3. **Eterogeneità AX fra app.** Tre app misurate. Le soglie del salto (10×,
   400 caratteri) e `maxDepth 8` sono derivate da quelle tre. Un'app che
   espone la conversazione in modo piatto (nessun salto) o oltre il livello 8
   produce `chosenLevel = -1` e il parser lavora sul livello più ricco: qualità
   non garantita. Le app Electron richiedono `AXManualAccessibility`; app che
   non espongono nulla via AX producono `no-editable` e la feature vi resta
   muta. Mitigazione: allowlist per default, log dei conteggi per livello per
   ricalibrare.
4. **RAM su 16 GB.** Le stime di residente (3,3 / 5,8 GB) non sono misure. Se
   Gemma 3 4B con KV 3072 sfonda su un Mac base con browser aperto, le opzioni
   sono ridurre `contextSize` a 2048 (e il budget della coda a 1 600
   caratteri) o fermare il server di pulizia mentre quello di risposta lavora
   — entrambe da decidere con misure, non ora.
5. **Contesa GPU con whisper.** Un secondo keepalive ogni 20 s e un secondo
   modello caldo sulla Metal. La memoria del progetto documenta quanto sia
   sensibile la latenza della dettatura in streaming alla contesa GPU. Se le
   misure mostrano regressione, il keepalive del server di risposta si spegne
   accettando il cold-start alla prima hotkey.
6. **Scorciatoie globali temporanee.** Per ≤ 20 s `⌘1/2/3` ed `Esc` non
   arrivano all'app sotto. Nei browser `⌘1/2/3` cambiano tab, `Esc` chiude
   popup. Il costo è limitato nel tempo e visibile (la pill è a schermo), ma è
   un costo. Alternativa scartata: rendere la pill focalizzabile e leggere
   `1/2/3` — richiederebbe rubare il focus e poi restituirlo, che è
   esattamente la fragilità che `showInactive()` evita.
7. **Latenza su Mac base.** 2 s stimati sul M5 Pro (AX + classificatore +
   generazione) diventano 4-6 s **stimati** con il fattore 2-3×. Sopra i 4 s
   l'utente inizia a scrivere a mano. Gli stati `reading`/`thinking` rendono
   l'attesa leggibile ma non la accorciano. Se la misura conferma, il tier
   default potrebbe dover scendere di taglia (nessun candidato più piccolo
   supera Gemma 3 4B alla lettura: Qwen3.5-2B ha italiano impacciato).
8. **Il gist deterministico può sbagliare frase.** Con più domande nel
   messaggio prende la prima con `?`; il modello può invece aver risposto
   all'ultima. L'utente lo vede e rifiuta con `Esc` — è la funzione del gist —
   ma è un'occasione persa. Alternativa futura: far estrarre il gist al
   classificatore (è estrazione, compatibile col vincolo), non ora perché
   allunga l'output vincolato.
9. **Lingue oltre it/en.** Il benchmark è in italiano con alcuni casi in
   inglese. Il parser riconosce le forme di attribuzione italiane e inglesi
   (`ha scritto:` / `wrote:`); altre lingue cadono nel cancello
   `no-attributed-turns`. Coerente con il progetto (utente primario italiano),
   ma da dichiarare.
10. **Il rilevamento della lingua nei filtri** è euristico: su risposte di 20
    caratteri può sbagliare e scartare una variante buona. Falso positivo
    innocuo (si perde una variante, e con `< 2` la pill non compare), ma
    riduce il tasso di proposte. Da misurare sul corpus.

## Decisioni prese (log)

| Decisione | Scelta | Motivo |
|---|---|---|
| Fonte delle tre varianti | **Solo il contesto**, l'utente non parla | Un gesto solo; le posizioni le fissa il codice, non la voce |
| Chi decide le posizioni | **Il codice**, tre set per `kind` | Sottodeterminazione misurata: senza, tre riscritture o domanda rigirata |
| Dove vincolare il decoding | **Classificazione vincolata, prosa libera dentro chiavi fissate** | arXiv 2408.02442: il vincolo aiuta la classificazione, danneggia il ragionamento |
| Tier di modello | **Gemma 3 4B default, Gemma 4 E4B max** | Gemma 4 migliore alla lettura; Gemma 3 sta in 16 GB |
| Caricamento del modello | **Solo a feature accesa**, liberato allo spegnimento | A feature spenta RAM identica a oggi |
| Server | **Due `llama-server`** | Modelli diversi; la pulizia resta nel percorso critico intatto |
| Binario | **Bump separato, prerequisito** | Ha la sua validazione della catena di dettatura |
| Hotkey | **`Command+Control+R`**, configurabile, mai con Option | Option è il PTT della dettatura |
| Selezione | **Mouse e `Command+1/2/3`**, `Esc` chiude | La pill è `showInactive()` → niente eventi tastiera → scorciatoie globali temporanee |
| Trasparenza | **Riga del gist** sempre visibile | Rifiuto a colpo d'occhio |
| Posizionamento | **`getDisplayNearestPoint(cursor)`**, a ogni `show()` | Oggi con due monitor la pill esce sul primario |
| Soglia minima | **≥ 2 varianti** o niente pill | Una proposta sola non è una scelta |
| Astensione | **Flash neutro, motivo solo nel log** | Il motivo descriverebbe lo schermo |
| App | **Allowlist per default** con le tre app verificate | Privacy: si legge solo dove permesso |
| Persistenza | **Nessuna** | Local-first, e i log degli spike hanno mostrato cosa c'è in gioco |
| Gist | **Deterministico** nel parser | Verificabile, non allunga l'output vincolato |
| Accettazione | **Riattiva sempre l'app di destinazione**; senza focus verificato solo clipboard | Il click sulla pill può attivare l'overlay; mai incollare nel posto sbagliato |

## File toccati

Nuovi:

- `native/ax-context/ax_context.mm` — addon (lettura contesto, attivazione app).
- `src/main/ax-context-reader.ts` — wrapper con DI.
- `src/main/utils/conversation-parser.ts` — pre-processore deterministico.
- `src/main/utils/reply-positions.ts` — i tre set.
- `src/main/reply-classifier.ts`, `src/main/reply-generator.ts` — le due chiamate.
- `src/main/utils/variant-filter.ts` — filtri per variante.
- `src/main/reply-server-manager.ts` — ciclo di vita del secondo server.
- `src/main/reply-coordinator.ts` — orchestrazione.
- `test/unit/conversation-parser.test.ts`, `variant-filter.test.ts`,
  `reply-positions.test.ts`, `reply-classifier.test.ts`,
  `reply-generator.test.ts`, `reply-server-manager.test.ts`,
  `reply-coordinator.test.ts`, `overlay-bounds.test.ts`.
- `test/fixtures/conversations/` — corpus anonimizzato.
- `test/integration/reply-pipeline.test.ts` — opt-in con modello reale.

Modificati:

- `binding.gyp` — target `ax_context`.
- `src/main/overlay-window.ts`, `src/renderer/overlay.html`, `overlay.css`,
  `src/preload/overlay-preload.ts` — stato `suggesting`, posizionamento sul
  display del cursore, ridimensionamento.
- `src/shared/ipc-channels.ts` — canali `reply:*`.
- `src/main/preferences-store.ts`, `src/renderer/preferences.html`,
  `preferences.js`, `src/main/preferences-window.ts` — sei preferenze, stato
  del server, download del modello di risposta.
- `src/main/model-catalog.ts` — `REPLY_MODELS`, `REPLY_TIERS`, `kind: "reply"`.
- `src/main/index.ts` — costruzione del coordinatore, del manager e della
  hotkey; mutua esclusione con il PTT; `will-quit`.
- `docs/electron-smoke-checklist.md` — checklist dello strato 4.
- `README.md` — una riga nella pipeline e nelle limitazioni note (feature
  opzionale, RAM aggiuntiva, app verificate).

Non toccati: `llm-server.ts` (riusato così com'è), `llm-cleaner.ts`,
`output-sanitizer.ts`, `prompt-template.ts`, `pipeline-coordinator.ts`,
`text-injector.ts` (riusato), `ptt-manager.ts`, `native/ptt-monitor/`,
`scripts/fetch-binaries.sh` (il bump è il prerequisito, non questo lavoro).
