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
