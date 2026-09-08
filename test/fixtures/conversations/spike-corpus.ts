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
