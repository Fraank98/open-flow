import { describe, it, expect } from "vitest";
import { parseNumberWords } from "../../src/main/utils/number-words.js";

describe("parseNumberWords — Italian", () => {
  it("reads spaced and glued thousands/hundreds/tens", () => {
    expect(parseNumberWords("il totale è quattro mila ottocento cinquanta euro")).toEqual([4850]);
    expect(parseNumberWords("quattromila ottocentocinquanta euro")).toEqual([4850]);
    expect(parseNumberWords("quattromilaottocentocinquanta")).toEqual([4850]);
  });
  it("accepts the connector 'e' between numeral words only", () => {
    expect(parseNumberWords("duemila e trecento")).toEqual([2300]);
    expect(parseNumberWords("due e tre persone")).toEqual([2, 3]);
  });
  it("handles elided tens and accented units", () => {
    expect(parseNumberWords("ventuno")).toEqual([21]);
    expect(parseNumberWords("ventotto")).toEqual([28]);
    expect(parseNumberWords("trentatré")).toEqual([33]);
    expect(parseNumberWords("centocinquanta")).toEqual([150]);
    expect(parseNumberWords("mille")).toEqual([1000]);
    expect(parseNumberWords("due milioni")).toEqual([2_000_000]);
  });
  it("ignores lone 'un/uno/una' (articles) and lone 'sei' (the verb), but not 'tre' or 'nove'", () => {
    expect(parseNumberWords("una riunione con un collega")).toEqual([]);
    expect(parseNumberWords("sei d'accordo?")).toEqual([]);
    expect(parseNumberWords("entro tre settimane")).toEqual([3]);
    expect(parseNumberWords("alle nove")).toEqual([9]);
    expect(parseNumberWords("sei mila euro")).toEqual([6000]);
  });
  it("does not read ordinary words as numbers", () => {
    expect(parseNumberWords("confermo il sopralluogo di venerdì, secondo piano")).toEqual([]);
  });
});

describe("parseNumberWords — English", () => {
  it("reads hyphenated and 'and' forms", () => {
    expect(parseNumberWords("twenty-five thousand pounds")).toEqual([25_000]);
    expect(parseNumberWords("one hundred and twelve")).toEqual([112]);
    expect(parseNumberWords("twelve hundred")).toEqual([1200]);
  });
  it("ignores a lone 'one'", () => {
    expect(parseNumberWords("the first one works")).toEqual([]);
    expect(parseNumberWords("one thousand")).toEqual([1000]);
  });
});

/**
 * Fix round 1 (review): "cento"/"mille"/"milione" show up in idioms that
 * carry no quantity at all — a percent suffix or a thank-you turn of
 * phrase — and were previously read as literal hundreds/thousands/millions,
 * which then made the variant filter's number-anchoring rule reject
 * perfectly grounded replies (live case: "novanta per cento" against a
 * context that only ever said "90%").
 */
describe("parseNumberWords — idiomatic non-quantitative uses", () => {
  it("'<n> per cento' is the number alone, not the number plus a literal 100", () => {
    expect(parseNumberWords("Il novanta per cento del lavoro è già in review.")).toEqual([90]);
  });
  it("'cento per cento' (idiomatic for 'totally') carries no quantity", () => {
    expect(parseNumberWords("Va bene al cento per cento.")).toEqual([]);
  });
  it("'mille grazie'/'grazie mille' (both orders) and 'un milione di grazie' are gratitude, not counts", () => {
    expect(parseNumberWords("mille grazie per la segnalazione")).toEqual([]);
    expect(parseNumberWords("grazie mille per la segnalazione")).toEqual([]);
    expect(parseNumberWords("un milione di grazie")).toEqual([]);
  });
  it("does not eat a genuine count next to 'per' or 'grazie' out of context", () => {
    expect(parseNumberWords("cento euro per la cena")).toEqual([100]);
    expect(parseNumberWords("mille euro di danni")).toEqual([1000]);
  });
});
