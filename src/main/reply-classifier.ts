import { ReplyChatClient, ReplyLLMError } from "./reply-chat-client.js";
import type { Logger } from "./logger.js";

export interface ClassifyInput { transcript: string; lastMessage: string; counterpart: string }

export interface Classification {
  answerable: boolean;
  kind: "generic" | "alternative" | "offer";
  /** Only for kind = alternative, exactly two non-empty strings. */
  alternatives?: [string, string];
  language: "it" | "en" | "other";
}

export type ClassifyResult =
  | { ok: true; classification: Classification; durationMs: number }
  | { ok: false; reason: "not-answerable" | "invalid-classification"; durationMs: number }
  | { ok: false; reason: "llm-error"; error: string; durationMs: number };

/** The grammar llama-server derives from this fixes keys, enum values and the
 *  0-or-2 alternatives. `alternatives` is always present (possibly empty) so
 *  the grammar has one shape; classify() maps [] to undefined. */
export const CLASSIFIER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answerable: { type: "boolean" },
    kind: { type: "string", enum: ["generic", "alternative", "offer"] },
    alternatives: { type: "array", items: { type: "string", maxLength: 40 }, minItems: 0, maxItems: 2 },
    language: { type: "string", enum: ["it", "en", "other"] },
  },
  required: ["answerable", "kind", "alternatives", "language"],
  additionalProperties: false,
};

/** Fixed instruction prefix, identical across calls so llama-server keeps it
 *  in the KV cache (cache_prompt). Gemma has no system role: this IS the
 *  start of the single user turn. The schema is described in words because
 *  the model never sees it (spec §4). */
export const CLASSIFIER_PREFIX = `Sei un classificatore. Leggi una conversazione e decidi se all'ULTIMO messaggio dell'INTERLOCUTORE si può rispondere con una DECISIONE, cioè scegliendo fra: accettare, rifiutare, rimandare, oppure scegliere fra opzioni esplicite proposte nel messaggio.

NON è rispondibile con una decisione se la risposta richiede un'informazione che solo il destinatario conosce: orari, date, luoghi, numeri, nomi, dati, stato di un lavoro, opinioni o pareri tecnici. In quel caso "answerable" è false.

Rispondi SOLO con un oggetto JSON con esattamente queste chiavi:
- "answerable": true oppure false.
- "kind": "offer" se il messaggio propone un preventivo, un'offerta, un prezzo o una proposta commerciale da accettare o rifiutare; "alternative" se il messaggio chiede di scegliere fra due opzioni esplicite ("X o Y?"); altrimenti "generic".
- "alternatives": se "kind" è "alternative", le due opzioni così come compaiono nel messaggio, brevi (al massimo 40 caratteri ciascuna), nell'ordine in cui compaiono; altrimenti una lista vuota.
- "language": "it" se la conversazione è in italiano, "en" se in inglese, "other" altrimenti.

Non aggiungere altre chiavi, commenti o testo.`;

export function buildClassifierPrompt(input: ClassifyInput): string {
  return `${CLASSIFIER_PREFIX}

L'interlocutore si chiama ${input.counterpart}. Le righe "TU" sono del destinatario, le righe "INTERLOCUTORE" sono sue. Classifica l'ultima riga INTERLOCUTORE.

<trascrizione>
${input.transcript}
</trascrizione>`;
}

export interface ReplyClassifierOptions {
  client: ReplyChatClient;
  timeoutMs: number;
  logger?: Pick<Logger, "info" | "warn">;
}

const KINDS = new Set(["generic", "alternative", "offer"]);
const LANGS = new Set(["it", "en", "other"]);

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

/** Validates the parsed JSON against the shape the grammar should have
 *  enforced. Returns null when the shape is wrong: it should not happen with
 *  the grammar, so the caller logs it as an anomaly (spec §4). */
export function toClassification(json: unknown): Classification | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.answerable !== "boolean") return null;
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return null;
  if (typeof o.language !== "string" || !LANGS.has(o.language)) return null;
  const kind = o.kind as Classification["kind"];
  const language = o.language as Classification["language"];
  const alts = Array.isArray(o.alternatives) ? o.alternatives.filter(isNonEmptyString).map((s) => s.trim()) : [];
  if (kind === "alternative" && alts.length === 2) {
    return { answerable: o.answerable, kind, alternatives: [alts[0]!, alts[1]!], language }; // length checked
  }
  // "alternative" without two usable alternatives degrades to generic (spec §4).
  return { answerable: o.answerable, kind: kind === "alternative" ? "generic" : kind, language };
}

export class ReplyClassifier {
  constructor(private readonly opts: ReplyClassifierOptions) {}

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const t0 = Date.now();
    let json: unknown;
    let completionTokens = 0;
    try {
      const r = await this.opts.client.completeJson({
        prompt: buildClassifierPrompt(input),
        schema: CLASSIFIER_SCHEMA,
        sampling: { temperature: 0 },
        maxTokens: 64,
        timeoutMs: this.opts.timeoutMs,
      });
      json = r.json;
      completionTokens = r.completionTokens;
    } catch (err) {
      const error = err instanceof ReplyLLMError ? err.message : "reply LLM request failed: Error";
      const durationMs = Date.now() - t0;
      void this.opts.logger?.warn("reply classify failed", { error, durationMs, transcriptChars: input.transcript.length });
      return { ok: false, reason: "llm-error", error, durationMs };
    }
    const durationMs = Date.now() - t0;
    const c = toClassification(json);
    if (!c) {
      void this.opts.logger?.warn("reply classify anomaly: invalid shape despite grammar", { durationMs, completionTokens });
      return { ok: false, reason: "invalid-classification", durationMs };
    }
    void this.opts.logger?.info("reply classify", {
      answerable: c.answerable, kind: c.kind, language: c.language, hasAlternatives: c.alternatives !== undefined,
      durationMs, completionTokens, transcriptChars: input.transcript.length,
    });
    if (!c.answerable) return { ok: false, reason: "not-answerable", durationMs };
    return { ok: true, classification: c, durationMs };
  }
}
