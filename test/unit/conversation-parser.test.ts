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

  it("drops a fragment contained in a longer one, ignoring a trailing H.MM timestamp", () => {
    const full = "Marta: possiamo risentirci domani alle 9.05";
    const body = "possiamo risentirci domani alle";
    expect(dedupeByContainment([full, body])).toEqual([full]);
    expect(dedupeByContainment([body, full])).toEqual([full]);
  });

  it("drops a fragment contained in a longer one, ignoring a trailing AM/PM timestamp", () => {
    const full = "Marta: lets sync tomorrow 09:12 PM";
    const body = "lets sync tomorrow";
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
