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
    // Fix round 2 (review): "per cento" was stripped unconditionally, even
    // when "cento" itself was the genuine count and "per" merely a
    // preposition ("te lo faccio per cento euro" = "I'll do it for a
    // hundred euros", not a percentage) — an invented amount then slipped
    // past the variant filter's number-anchoring check.
    expect(parseNumberWords("Te lo faccio per cento euro, se ti va bene procediamo.")).toEqual([100]);
    expect(parseNumberWords("Lo consegno per cento clienti entro la settimana prossima.")).toEqual([100]);
  });
});

/**
 * Fix round 2 (review): punctuation was not a token boundary, so removing an
 * idiom's tokens could weld the numerals on either side of it together
 * ("novanta" + "tre" → wrongly evaluated as 93), and stripping "mille" next
 * to "grazie" across a sentence break ate a genuine count that merely
 * happened to sit near a thank-you in a different sentence.
 */
describe("parseNumberWords — punctuation is a token boundary", () => {
  it("does not eat a genuine count separated from 'grazie' by sentence punctuation", () => {
    expect(parseNumberWords("Facciamo mille, grazie. Ci penso io alla consegna.")).toEqual([1000]);
    expect(parseNumberWords("Ti mando mille. Grazie! Ci penso io alla consegna.")).toEqual([1000]);
    expect(parseNumberWords("Ti mando mille euro appena posso, tranquilla.")).toEqual([1000]);
  });
  it("does not weld the numerals on either side of a removed percent idiom into one number", () => {
    expect(parseNumberWords("Il novanta per cento, tre giorni al massimo e chiudo.")).toEqual([90, 3]);
  });
});

/**
 * Fix round 3 (review): round 2 made every punctuation separator a hard
 * boundary, but a comma inside a compound numeral ("one thousand, two
 * hundred", "quattro mila, ottocento cinquanta") is the normal written form,
 * not a sentence break — the comma needs a SOFT barrier that glues the two
 * sides back together when they are magnitude-linked (same rule as the "e"
 * connector), while a hard barrier still applies to sentence punctuation and
 * to idiom removal.
 */
describe("parseNumberWords — a comma inside a compound numeral is not a hard boundary", () => {
  it("joins magnitude-linked numerals across a comma", () => {
    expect(parseNumberWords("duemila, trecento")).toEqual([2300]);
    expect(parseNumberWords("mille, cinquecento")).toEqual([1500]);
    expect(parseNumberWords("quattro mila, ottocento cinquanta")).toEqual([4850]);
    expect(parseNumberWords("centomila, duecento euro")).toEqual([100200]);
    expect(parseNumberWords("one thousand, two hundred pounds")).toEqual([1200]);
    expect(parseNumberWords("twenty-five thousand, eight hundred and fifty")).toEqual([25850]);
    expect(parseNumberWords("un milione, duecentomila euro")).toEqual([1200000]);
  });
  it("still treats a comma between two unrelated counts as a boundary", () => {
    expect(parseNumberWords("due, tre giorni")).toEqual([2, 3]);
    expect(parseNumberWords("tre, quattro settimane")).toEqual([3, 4]);
    expect(parseNumberWords("venti. Trenta")).toEqual([20, 30]);
  });
  it("does not regress the round 2 fixes that also rely on the comma being a boundary", () => {
    expect(parseNumberWords("Il novanta per cento, tre giorni al massimo e chiudo.")).toEqual([90, 3]);
    expect(parseNumberWords("Facciamo mille, grazie. Ci penso io alla consegna.")).toEqual([1000]);
    expect(parseNumberWords("Va bene al cento per cento.")).toEqual([]);
  });
});

/**
 * Fix round 3 (review): stripPercentIdioms ran BEFORE stripGratitudeIdioms,
 * so by the time it reached "per cento" the still-unremoved "mille" of
 * "grazie mille" was the preceding token — a numeral — and the percent
 * guard (round 2, point A) fired on it, stripping a genuine "cento" that
 * was never a percentage.
 */
describe("parseNumberWords — gratitude idioms are stripped before the percent guard runs", () => {
  it("does not let the 'mille' of a gratitude idiom anchor the percent guard", () => {
    expect(parseNumberWords("Grazie mille per cento euro di anticipo.")).toEqual([100]);
  });
  it("does not regress the already-correct order-independent cases", () => {
    expect(parseNumberWords("mille grazie per cento euro")).toEqual([100]);
    expect(parseNumberWords("grazie mille")).toEqual([]);
    expect(parseNumberWords("mille grazie")).toEqual([]);
    expect(parseNumberWords("Va bene al cento per cento.")).toEqual([]);
    expect(parseNumberWords("Il novanta per cento del lavoro è già in review.")).toEqual([90]);
  });
});
