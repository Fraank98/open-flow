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
  gate,
  buildTranscript,
  buildGist,
  guessLanguage,
  parse,
  toLogMeta,
  ASSISTANT_NAMES,
  type Turn,
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
  // Length alone measures the wrong thing: a chat message asking for a
  // decision is often short precisely BECAUSE it is direct ("la fai tu?" —
  // 10 chars). These four are real corpus shapes (`"Nome: testo HH:MM."`)
  // reduced to their post-parse Turn.text, all under LAST_MESSAGE_MIN_CHARS,
  // and all containing a hasExplicitProposal match — the gate must not
  // abstain on them. One `it` per message so a regression on any single one
  // shows up as its own failure, not folded into the first assertion hit.
  it("a short last message with an explicit proposal passes: \"la fai tu?\"", () => {
    expect(gate([T("Marta", "counterpart", "la fai tu?")])).toEqual({ ok: true });
  });
  it("a short last message with an explicit proposal passes: \"ci pensi tu?\"", () => {
    expect(gate([T("Marta", "counterpart", "ci pensi tu?")])).toEqual({ ok: true });
  });
  it("a short last message with an explicit proposal passes: \"riesci oggi?\"", () => {
    expect(gate([T("Marta", "counterpart", "riesci oggi?")])).toEqual({ ok: true });
  });
  it("a short last message with an explicit proposal passes: \"confermi?\"", () => {
    expect(gate([T("Marta", "counterpart", "confermi?")])).toEqual({ ok: true });
  });
  // Same shortness, but no proposal keyword: the gate must still abstain.
  // "ok" alone (2 chars) also checks the absolute floor kept for messages
  // that WOULD carry a proposal match but are too short to mean anything.
  it("a short last message without an explicit proposal still abstains as last-message-too-short", () => {
    expect(gate([T("Marta", "counterpart", "ok?")])).toEqual({ ok: false, reason: "last-message-too-short" });
    expect(gate([T("Marta", "counterpart", "ok grazie")])).toEqual({ ok: false, reason: "last-message-too-short" });
    expect(gate([T("Marta", "counterpart", "ok")])).toEqual({ ok: false, reason: "last-message-too-short" });
  });
  // 16 chars: already >= LAST_MESSAGE_MIN_CHARS on length alone, no proposal
  // needed. Kept here to document that the parser's gate is not where scope
  // is decided for a long-but-uninteresting message — that is the
  // coordinator's `preGate` (hasExplicitProposal), one step later. The two
  // responsibilities stay separate: this gate only ever looks at shortness.
  it("a long last message without a proposal still passes the parser's own gate", () => {
    expect(gate([T("Marta", "counterpart", "perfetto, grazie")])).toEqual({ ok: true });
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

  it("truncates a subject long enough to overflow the budget by itself", () => {
    // SUBJECT (`(.+)$`) is uncapped: nothing upstream limits how long a
    // subject line can be, so the OGGETTO line must be truncated like any
    // other line, not appended whole.
    const out = buildTranscript([marta], { tailBudgetChars: 100, subject: "S".repeat(500) });
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.startsWith("OGGETTO: ")).toBe(true);
    expect(out).toContain("…");
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
  it("truncates the first sentence one character above the 70-char threshold", () => {
    const s = "x".repeat(70) + "?"; // 71 chars: the first value that must be truncated
    expect(buildGist("M", s)).toBe(`Rispondi a M: ${"x".repeat(69)}…`);
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
  it("returns 'other' with exactly one function word (the threshold is two)", () => {
    expect(guessLanguage("il gatto salta sul tavolo")).toBe("other");
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
