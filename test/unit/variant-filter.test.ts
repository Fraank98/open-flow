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
    // GOOD_B/GOOD_C are unambiguously Italian (guessLanguage confidently
    // returns "it" on them: 3 function-word hits each), so under a
    // genuine "en" context they are correctly flagged too — that is the
    // rule working, not a false positive. To isolate "the English variant
    // is not wrongly dropped when the context is English", the other two
    // fillers here are language-neutral (guessLanguage returns "other":
    // each has only a single, non-decisive function-word hit) rather than
    // confidently Italian.
    const neutral1 = V("b", "Verificherò l'agenda giovedì mattina prima di rispondere.");
    const neutral2 = V("c", "Ripasserò i documenti prima di lunedì mattina.");
    expect(run([V("accept", en), neutral1, neutral2], { language: "en" }).dropped.map((d) => d.rule)).not.toContain("language");
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

/**
 * Task 3 spike (Gemma 3, 2026-09-08): with a poor input ("ok?") on the
 * `offer` position set, all three generated variants came back IDENTICAL to
 * the canned voice examples baked into reply-positions.ts ("Per me va bene,
 * procediamo.", etc.) — three boxed sentences that never engage with the
 * real message. The reviewer's structural explanation: `alternative` gets a
 * lexical anchor (the two concrete alternatives are interpolated into the
 * prompt text), but `offer` and `generic` don't — so with poor input the
 * abstract voice is the only content a small model has to draw from, and it
 * echoes it verbatim. Extended here to `generic` too (not just `offer`,
 * where it was observed): the structural cause applies equally to both.
 * `alternative` is deliberately excluded — it has the anchor the other two
 * lack, per the reviewer's explanation above.
 */
describe("instruction-echo: verbatim copies of the canned generic/offer voice examples (Task 3 Gemma 3 regression)", () => {
  it("drops every offer-set variant that reproduces its canned example verbatim", () => {
    const poor = { ...CTX, lastMessage: "ok?", transcript: "INTERLOCUTORE (Marta): ok?" };
    const r = run(
      [
        V("accept_offer", "Per me va bene, procediamo."),
        V("reject_offer", "Per ora lascio stare, grazie."),
        V("request_changes", "Prima di confermare avrei bisogno di un dettaglio."),
      ],
      poor,
    );
    expect(r.dropped).toEqual([
      { key: "accept_offer", rule: "instruction-echo" },
      { key: "reject_offer", rule: "instruction-echo" },
      { key: "request_changes", rule: "instruction-echo" },
    ]);
    expect(r.kept).toEqual([]);
  });

  it("drops a generic-set variant that reproduces its canned example verbatim too", () => {
    expect(run([V("accept", "Ci penso io, confermo."), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "instruction-echo" }]);
  });

  it("does not drop a legitimate variant that merely shares ordinary words with a canned example", () => {
    // GOOD_A shares "ci penso io" with the accept example but is not a copy of it.
    expect(run([GOOD_A, GOOD_B, GOOD_C]).dropped).toEqual([]);
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

/**
 * Fix round 1 (review, verified by running the real modules): two Critical
 * findings (numbers anchored by substring; a typographic apostrophe
 * disabling done-action/invented-reason) and three Important ones (a dead
 * causal alternative; instruction-echo muting the feature; idiomatic
 * numbers). See task-4-report.md §Fix round 1 for the before/after proof.
 */
describe("Fix round 1 (review)", () => {
  const quote = {
    ...CTX,
    lastMessage: "Il totale è 4.850 euro IVA esclusa, con inizio lavori entro tre settimane.",
    transcript: "OGGETTO: Preventivo\nINTERLOCUTORE (Francesca Bianchi): Il totale è 4.850 euro IVA esclusa, con inizio lavori entro tre settimane.",
    counterpart: "Francesca",
  };

  it("Critical 1 — unanchored-number: a substring of an anchored number is not itself anchored", () => {
    // "4.850" contains "850", "485", "48", "8", "5" as substrings, and word
    // numerals for some of them, but none of these was ever said.
    for (const bad of ["850 euro", "485 euro", "48 ore", "5 giorni", "85 euro", "8 giorni", "otto giorni", "cinque giorni"]) {
      expect(run([V("accept_offer", `Confermo, direi ${bad} circa.`), GOOD_B, GOOD_C], quote).dropped, bad).toEqual([{ key: "accept_offer", rule: "unanchored-number" }]);
    }
  });

  it("Critical 2 — done-action and invented-reason fire through a typographic apostrophe (U+2019)", () => {
    expect(run([V("accept", "I’ve already sent the payment yesterday."), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "done-action" }]);
    expect(run([V("accept", "I’m in a meeting all afternoon."), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "invented-reason" }]);
  });

  it("Important — 'a causa del …' is recognized as causal, and grounds it against the context like 'perché'", () => {
    const invented = "Non riesco a prenderla, a causa del blocco totale del mio sprint interno.";
    expect(run([V("decline", invented), GOOD_A, GOOD_C]).dropped).toEqual([{ key: "decline", rule: "invented-reason" }]);
  });

  it("Important — instruction-echo no longer drops ordinary second-person replies", () => {
    for (const t of [
      "Puoi contare su di me, la review la faccio oggi pomeriggio.",
      "Puoi girarla a Paolo, io questa settimana non ce la faccio.",
      "Scegli tu come preferisci, per me vanno bene entrambe.",
      "Fai sapere a Paolo che la review la faccio io.",
    ]) {
      expect(run([V("accept", t), GOOD_B, GOOD_C]).dropped, t).toEqual([]);
    }
    // The two instruction-shaped phrasings it exists to catch still fire.
    expect(run([V("accept", "Verifichi e fai sapere a breve se riesci a occupartene."), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "instruction-echo" }]);
    expect(run([V("accept", "Rispondi in senso affermativo alla richiesta della review."), GOOD_B, GOOD_C]).dropped).toEqual([{ key: "accept", rule: "instruction-echo" }]);
  });

  it("Important — idiomatic 'per cento'/'grazie' numbers don't trip unanchored-number", () => {
    const pctCtx = { ...CTX, lastMessage: "siamo al 90%?", transcript: "INTERLOCUTORE (Marta): siamo al 90%?" };
    expect(run([V("accept", "Il novanta per cento del lavoro è già in review."), GOOD_B, GOOD_C], pctCtx).dropped).toEqual([]);
    expect(run([V("accept", "Grazie mille per la segnalazione, la guardo subito."), GOOD_B, GOOD_C]).dropped).toEqual([]);
  });

  it("legitimate — signature: a formal closing with no name is not a signature", () => {
    expect(run([V("accept", "Confermo la revisione per venerdì. Cordiali saluti."), GOOD_B, GOOD_C]).dropped).toEqual([]);
  });

  it("legitimate — question-echo: a realistic reply that reuses some of the question's words is kept", () => {
    const realistic = "La review della PR sul login la faccio io, non serve girarla a Paolo.";
    expect(jaccardWords(realistic, CTX.lastMessage)).toBeLessThanOrEqual(0.6);
    expect(run([V("accept", realistic), GOOD_B, GOOD_C]).dropped).toEqual([]);
  });
});
