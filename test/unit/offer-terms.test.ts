import { describe, it, expect } from "vitest";
import { extractOfferTerms } from "../../src/main/utils/offer-terms.js";

describe("extractOfferTerms", () => {
  it("extracts an amount with a thousands separator and a deadline in words", () => {
    const msg = "il preventivo è di 4.850 euro IVA esclusa, con inizio lavori entro tre settimane dall'accettazione. Va bene procedere?";
    expect(extractOfferTerms(msg)).toEqual({ amount: "4.850 euro", deadline: "tre settimane" });
  });

  it("extracts a currency symbol amount with no separate currency word", () => {
    expect(extractOfferTerms("il costo del servizio è di €500, fatemi sapere")).toEqual({ amount: "€500" });
  });

  it("extracts a plain amount followed by the currency word, no symbol", () => {
    expect(extractOfferTerms("il totale è 1200 euro per tutto il lavoro")).toEqual({ amount: "1200 euro" });
  });

  it("extracts a deadline written in digits", () => {
    expect(extractOfferTerms("possiamo iniziare entro 3 settimane dalla firma")).toEqual({ deadline: "3 settimane" });
  });

  it("extracts a deadline written in words, unrelated to any amount", () => {
    expect(extractOfferTerms("i lavori dureranno circa due mesi in totale")).toEqual({ deadline: "due mesi" });
  });

  it("extracts the English case: comma-separated amount with a currency code", () => {
    expect(extractOfferTerms("the quote for the full renovation is 1,200 GBP, let us know")).toEqual({ amount: "1,200 GBP" });
  });

  it("extracts an English deadline in words", () => {
    expect(extractOfferTerms("we can start within three weeks of acceptance")).toEqual({ deadline: "three weeks" });
  });

  it("returns nothing when the message has no amount and no deadline", () => {
    expect(extractOfferTerms("grazie per il preventivo, ci penso e le faccio sapere")).toBeUndefined();
  });

  it("does not read a lone ambiguous numeral word as a deadline count", () => {
    // "una" alone is an article, not a numeral (same exclusion number-words.ts
    // already applies to "un"/"una"/"sei") — "una settimana" must not be
    // read as if it named a count.
    expect(extractOfferTerms("ci vediamo tra una settimana per fare il punto")).toBeUndefined();
  });
});
