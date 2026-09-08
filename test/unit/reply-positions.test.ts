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
