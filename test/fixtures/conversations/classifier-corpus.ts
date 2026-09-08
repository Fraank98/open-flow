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
