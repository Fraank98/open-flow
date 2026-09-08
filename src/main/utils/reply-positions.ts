/**
 * The three positions the code assigns for each classification kind. The
 * model writes only the prose (spec §Spike 3: the task is underdetermined —
 * asked for "three replies" a small model rewrites the same one three times).
 * `voice` is what the prompt says about the position: a first-person example
 * chosen to be non-copyable (no days, names or figures), because small models
 * copy abstract instructions verbatim and copy examples when they have little
 * to say (both measured).
 */
export type PositionKey = "accept" | "decline" | "defer" | "first" | "second" | "accept_offer" | "reject_offer" | "request_changes";

export interface Position {
  key: PositionKey;
  /** Pill label, in the conversation's language. */
  label: string;
  /** Instruction for the prompt, always in Italian (the prompt is Italian). */
  voice: string;
}

export interface PositionsInput {
  kind: "generic" | "alternative" | "offer";
  language: "it" | "en" | "other";
  alternatives?: [string, string];
}

export const POSITION_LABELS: Record<"it" | "en", Record<PositionKey, string>> = {
  it: { accept: "Accetto", decline: "Declino", defer: "Rimando", first: "Scelgo: ", second: "Scelgo: ",
        accept_offer: "Accetto l'offerta", reject_offer: "Rifiuto", request_changes: "Chiedo modifiche" },
  en: { accept: "Accept", decline: "Decline", defer: "Defer", first: "Choose: ", second: "Choose: ",
        accept_offer: "Accept the offer", reject_offer: "Reject", request_changes: "Request changes" },
};

const LABEL_ALT_MAX = 40;

function altLabel(prefix: string, alt: string): string {
  return alt.length > LABEL_ALT_MAX ? `${prefix}${alt.slice(0, LABEL_ALT_MAX - 1)}…` : `${prefix}${alt}`;
}

export function positionsFor(input: PositionsInput): Position[] {
  const L = POSITION_LABELS[input.language === "en" ? "en" : "it"];
  if (input.kind === "offer") {
    return [
      { key: "accept_offer", label: L.accept_offer, voice: "accetta l'offerta come cliente che la riceve e dà il via ai lavori. Nello spirito di: «per me va bene, procediamo»" },
      { key: "reject_offer", label: L.reject_offer, voice: "non accetta l'offerta, da cliente, senza inventare motivi. Nello spirito di: «per ora lascio stare, grazie»" },
      { key: "request_changes", label: L.request_changes, voice: "chiede una modifica o un chiarimento prima di accettare. Nello spirito di: «prima di confermare avrei bisogno di un dettaglio»" },
    ];
  }
  if (input.kind === "alternative" && input.alternatives) {
    const [a, b] = input.alternatives;
    return [
      { key: "first", label: altLabel(L.first, a), voice: `sceglie la prima alternativa (${a}). Nello spirito di: «per me va bene la prima, confermo»` },
      { key: "second", label: altLabel(L.second, b), voice: `sceglie la seconda alternativa (${b}). Nello spirito di: «preferisco la seconda»` },
      { key: "defer", label: L.defer, voice: "non si impegna ora. Nello spirito di: «devo controllare, ti faccio sapere a breve»" },
    ];
  }
  return [
    { key: "accept", label: L.accept, voice: "accetta e se ne fa carico. Nello spirito di: «ci penso io, confermo»" },
    { key: "decline", label: L.decline, voice: "non se ne fa carico, senza inventare motivi. Nello spirito di: «io non riesco, meglio se lo prende qualcun altro»" },
    { key: "defer", label: L.defer, voice: "non si impegna ora. Nello spirito di: «devo controllare, ti faccio sapere a breve»" },
  ];
}

/** Keys fixed by the grammar; the model fills only the strings (spec §5). */
export function generatorSchemaFor(positions: readonly Position[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(positions.map((p) => [p.key, { type: "string", maxLength: 400 }])),
    required: positions.map((p) => p.key),
    additionalProperties: false,
  };
}
