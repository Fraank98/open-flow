/**
 * Numerals written in words (Italian and English) → values. Exists because a
 * benchmarked model wrote "quattro mila ottocento cinquanta euro" and slipped
 * past the digit check of the variant filter (spec §Spike 3).
 *
 * Tokens are lower-cased, accent-stripped letter runs (hyphens split). Each
 * token is segmented greedily, longest vocabulary prefix first; a token is a
 * numeral only if it segments completely ("ottocento" → otto+cento,
 * "ventuno" → vent+uno). Consecutive numeral tokens, optionally joined by
 * "e"/"and", form one number. A run made of a single ambiguous token
 * (un/uno/una/one — articles; sei — "you are") is dropped.
 */
const IT: Record<string, number> = {
  zero: 0, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
  undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19,
  venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
  vent: 20, trent: 30, quarant: 40, cinquant: 50, sessant: 60, settant: 70, ottant: 80, novant: 90,
  cento: 100, mille: 1000, mila: 1000, milione: 1_000_000, milioni: 1_000_000,
};
const EN: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1_000_000,
};
const VOCAB: Record<string, number> = { ...EN, ...IT };
const VOCAB_KEYS_BY_LENGTH = Object.keys(VOCAB).sort((a, b) => b.length - a.length);
const CONNECTORS = new Set(["e", "and"]);
const LONE_AMBIGUOUS = new Set(["un", "uno", "una", "one", "sei"]);

function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Greedy longest-prefix segmentation; null when the token is not fully numeral. */
function segment(token: string): number[] | null {
  const out: number[] = [];
  let rest = token;
  while (rest.length > 0) {
    const piece = VOCAB_KEYS_BY_LENGTH.find((k) => rest.startsWith(k));
    if (!piece) return null;
    out.push(VOCAB[piece]!); // piece comes from VOCAB's own keys
    rest = rest.slice(piece.length);
  }
  return out;
}

function evaluate(pieces: readonly number[]): number {
  let total = 0;
  let group = 0;
  for (const v of pieces) {
    if (v === 100) group = (group === 0 ? 1 : group) * 100;
    else if (v >= 1000) { total += (group === 0 ? 1 : group) * v; group = 0; }
    else group += v;
  }
  return total + group;
}

/**
 * Whether a connector ("e"/"and") between two numeral segments is gluing one
 * compound number (2000 + 300 = "duemila e trecento") rather than naming two
 * separate counts ("due e tre persone" = 2 and 3, not 5). A magnitude marker
 * (>= 100, i.e. cento/mille/mila/…) on either side of the connector is what
 * tells the two apart: plain units summed via "e" are never a single number
 * in speech.
 */
function hasMagnitudeLink(run: readonly number[], nextSeg: readonly number[]): boolean {
  return run.some((v) => v >= 100) || nextSeg.some((v) => v >= 100);
}

export function parseNumberWords(text: string): number[] {
  const tokens = normalize(text).split(/[^\p{L}]+/u).filter((t) => t.length > 0);
  const numbers: number[] = [];
  let run: number[] = [];
  let runTokens: string[] = [];
  const flush = (): void => {
    if (runTokens.length > 0 && !(runTokens.length === 1 && LONE_AMBIGUOUS.has(runTokens[0]!))) numbers.push(evaluate(run)); // length checked
    run = [];
    runTokens = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!; // i < tokens.length
    const seg = segment(t);
    if (seg) { run.push(...seg); runTokens.push(t); continue; }
    const next = tokens[i + 1];
    if (CONNECTORS.has(t) && runTokens.length > 0 && next !== undefined) {
      const nextSeg = segment(next);
      if (nextSeg !== null && hasMagnitudeLink(run, nextSeg)) continue;
    }
    flush();
  }
  flush();
  return numbers;
}
