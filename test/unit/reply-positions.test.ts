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

  // The bug (measured live, three consecutive hotkey presses on a real
  // preventivo): with a poor lexical anchor, Gemma 3 4B copies the offer
  // voice's own canned example verbatim on all three positions, and the
  // filter correctly drops every copy (kept: 0). `alternative` never
  // collapses this way because its voice interpolates the two real
  // alternatives; this is the same fix applied to `offer` — an optional
  // `offerTerms` (amount and/or deadline, copied verbatim from the real
  // message by offer-terms.ts) interpolated into the descriptive clause,
  // never into the quoted "Nello spirito di: «…»" example itself, exactly
  // where `alternative` puts its own interpolation.
  describe("offer with offerTerms: anchors the voice on the real amount/deadline", () => {
    it("interpolates the amount into all three voices when only an amount is extracted", () => {
      const p = positionsFor({ kind: "offer", language: "it", offerTerms: { amount: "4.850 euro" } });
      for (const x of p) expect(x.voice, x.key).toContain("4.850 euro");
    });

    it("interpolates the deadline into all three voices when only a deadline is extracted", () => {
      const p = positionsFor({ kind: "offer", language: "it", offerTerms: { deadline: "tre settimane" } });
      for (const x of p) expect(x.voice, x.key).toContain("tre settimane");
    });

    it("interpolates both amount and deadline when both are extracted", () => {
      const p = positionsFor({ kind: "offer", language: "it", offerTerms: { amount: "4.850 euro", deadline: "tre settimane" } });
      for (const x of p) {
        expect(x.voice, x.key).toContain("4.850 euro");
        expect(x.voice, x.key).toContain("tre settimane");
      }
    });

    it("leaves the quoted voice example untouched — the anchor sits in the descriptive clause, not the example", () => {
      const withTerms = positionsFor({ kind: "offer", language: "it", offerTerms: { amount: "4.850 euro", deadline: "tre settimane" } });
      const without = positionsFor({ kind: "offer", language: "it" });
      for (let i = 0; i < without.length; i++) {
        const example = /nello spirito di:\s*«([^»]+)»/iu.exec(without[i]!.voice)?.[1];
        expect(example, without[i]!.key).toBeDefined();
        expect(withTerms[i]!.voice, withTerms[i]!.key).toContain(`«${example}»`);
      }
    });

    it("does not change the labels: the anchor is prompt-only, the pill UI is untouched", () => {
      const withTerms = positionsFor({ kind: "offer", language: "it", offerTerms: { amount: "4.850 euro", deadline: "tre settimane" } });
      const without = positionsFor({ kind: "offer", language: "it" });
      expect(withTerms.map((x) => x.label)).toEqual(without.map((x) => x.label));
    });

    it("without offerTerms (or with none extracted) the voice is exactly what it was before — today's behavior on a bare offer", () => {
      expect(positionsFor({ kind: "offer", language: "it" })).toEqual(positionsFor({ kind: "offer", language: "it", offerTerms: undefined }));
    });
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
