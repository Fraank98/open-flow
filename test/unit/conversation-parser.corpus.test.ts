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
