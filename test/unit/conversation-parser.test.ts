import { describe, it, expect } from "vitest";
import {
  normalizeFragments,
  keepContentful,
  dedupeByContainment,
  SENTENCE_MIN,
  toTurns,
  speakerFromPrefix,
  isUserSpeaker,
  assignRoles,
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

  it("drops the short fragment when its trailing H.MM timestamp is what the strip must remove", () => {
    // The timestamp lives on the SHORT fragment: containment only succeeds if
    // stripTrailingTime actually removes it. A prefix-only construction (long
    // fragment carries the timestamp) would pass even with a broken strip.
    const full = "Marta: ci vediamo domani";
    const short = "ci vediamo domani 9.05";
    expect(dedupeByContainment([full, short])).toEqual([full]);
    expect(dedupeByContainment([short, full])).toEqual([full]);
  });

  it("drops the short fragment when its trailing AM/PM timestamp is what the strip must remove", () => {
    const full = "Marta: lets sync tomorrow";
    const short = "lets sync tomorrow 09:12 PM";
    expect(dedupeByContainment([full, short])).toEqual([full]);
    expect(dedupeByContainment([short, full])).toEqual([full]);
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
  it("matches when the preference extends the speaker by whole trailing tokens", () => {
    // Preference longer than the speaker: exercises u.startsWith(`${s} `),
    // the one branch the other cases never hit (they all resolve via
    // s === first or s.startsWith(`${u} `)).
    expect(isUserSpeaker("Danilo Franco", "Danilo Franco Rossi")).toBe(true);
  });
  it("does not match a different person or a prefix that is not a whole token", () => {
    expect(isUserSpeaker("Marta", "Danilo")).toBe(false);
    expect(isUserSpeaker("Daniloz", "Danilo")).toBe(false);
    expect(isUserSpeaker("Dan", "Danilo")).toBe(false);
  });
  it("never matches when the preference is empty", () => {
    expect(isUserSpeaker("Danilo", "")).toBe(false);
    expect(isUserSpeaker("Danilo", "   ")).toBe(false);
    // Both empty: without the guard, s === u ("" === "") would coincidentally
    // match. This is the only input the guard actually changes the outcome
    // for (see task-3-report.md, "Fix round 1").
    expect(isUserSpeaker("", "")).toBe(false);
    // Empty speaker with a real preference: exercises the s.length === 0
    // half of the guard's condition.
    expect(isUserSpeaker("", "Danilo")).toBe(false);
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
