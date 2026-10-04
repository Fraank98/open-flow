import { ReplyChatClient, ReplyLLMError, type SamplingParams } from "./reply-chat-client.js";
import { generatorSchemaFor, type Position } from "./utils/reply-positions.js";
import type { Logger } from "./logger.js";

/** Official Gemma sampling (spec §Vincolo tecnico); repetition penalty off. */
export const GEMMA_SAMPLING: Readonly<SamplingParams> = { temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0, repeat_penalty: 1.0 };

const GENERATOR_MAX_TOKENS = 320;

/** Fixed prefix: identical across calls, so the KV cache keeps it; also the
 *  warmupPrompt of the reply server. Gemma has no system role. */
export const GENERATOR_PREFIX = `Scrivi, al posto di una persona, il messaggio che invierà in risposta a una conversazione. Non stai parlando con quella persona: stai scrivendo al posto suo, in prima persona.

Produci un oggetto JSON con esattamente tre chiavi, indicate sotto. In ognuna scrivi un solo messaggio, che esprime la posizione indicata per quella chiave. Ogni valore è solo il testo del messaggio: nessun saluto iniziale, nessuna firma, nessun commento, nessuna chiave in più.

Gli esempi fra virgolette «» servono solo a darti il tono: non copiarli e non copiare queste istruzioni. Scrivi un messaggio nuovo, riferito a ciò che l'interlocutore ha scritto.

Regole assolute:
- Non ripetere la domanda dell'interlocutore: rispondi.
- Nessuna cifra, data o nome che non sia già nella trascrizione.
- Non affermare MAI di aver già svolto un'azione: non sai cosa la persona ha fatto. Nessun "ho già corretto", "ho appena inviato", "ho rifatto".
- Non inventare impegni, riunioni o motivi che non sono nella trascrizione. Chi declina lo fa senza spiegare perché.
- Da una a tre frasi per messaggio. Nessuna firma finale.`;

export interface GenerateInput {
  transcript: string;
  lastMessage: string;
  counterpart: string;
  userDisplayName: string;
  subject: string | undefined;
  positions: readonly Position[];
  language: "it" | "en" | "other";
}

export interface RawVariant { key: string; label: string; text: string }

export type GenerateResult =
  | { ok: true; variants: RawVariant[]; durationMs: number; completionTokens: number }
  | { ok: false; reason: "llm-error"; error: string; durationMs: number };

const LANGUAGE_LINE: Record<GenerateInput["language"], string> = {
  it: "Lingua: italiano.",
  en: "Lingua: inglese.",
  other: "Lingua: la stessa della trascrizione.",
};

export function buildGeneratorPrompt(input: GenerateInput): string {
  const who = `Tu scrivi come ${input.userDisplayName}. Ogni messaggio è scritto da ${input.userDisplayName} e indirizzato a ${input.counterpart}. Mai firmarsi ${input.counterpart}, mai rivolgersi a ${input.userDisplayName}. Nella trascrizione le righe "TU" sono di ${input.userDisplayName}, le righe "INTERLOCUTORE" sono di ${input.counterpart}.`;
  const subject = input.subject !== undefined ? `\nOggetto: ${input.subject}` : "";
  const last = `${input.counterpart} ha scritto per ultimo: «${input.lastMessage}»`;
  const keys = input.positions.map((p) => `- "${p.key}": ${input.userDisplayName} ${p.voice}`).join("\n");
  return `${GENERATOR_PREFIX}

${who}${subject}
${last}
${LANGUAGE_LINE[input.language]}

Le tre chiavi e la posizione di ciascuna:
${keys}

<trascrizione>
${input.transcript}
</trascrizione>`;
}

export interface ReplyGeneratorOptions {
  client: ReplyChatClient;
  /** 10 000 in production (spec §5). */
  timeoutMs: number;
  logger?: Pick<Logger, "info" | "warn">;
}

export class ReplyGenerator {
  constructor(private readonly opts: ReplyGeneratorOptions) {}

  /** Returns the RAW strings: cleaning and filtering belong to VariantFilter. */
  async generate(input: GenerateInput): Promise<GenerateResult> {
    const t0 = Date.now();
    try {
      const r = await this.opts.client.completeJson({
        prompt: buildGeneratorPrompt(input),
        schema: generatorSchemaFor(input.positions),
        sampling: { ...GEMMA_SAMPLING },
        maxTokens: GENERATOR_MAX_TOKENS,
        timeoutMs: this.opts.timeoutMs,
      });
      const obj = typeof r.json === "object" && r.json !== null ? (r.json as Record<string, unknown>) : {};
      const variants: RawVariant[] = [];
      for (const p of input.positions) {
        const v = obj[p.key];
        if (typeof v === "string" && v.trim().length > 0) variants.push({ key: p.key, label: p.label, text: v });
      }
      void this.opts.logger?.info("reply generate", {
        variants: variants.length, keys: input.positions.map((p) => p.key), durationMs: r.durationMs,
        completionTokens: r.completionTokens, contentChars: r.contentChars, transcriptChars: input.transcript.length,
      });
      return { ok: true, variants, durationMs: Date.now() - t0, completionTokens: r.completionTokens };
    } catch (err) {
      const error = err instanceof ReplyLLMError ? err.message : "reply LLM request failed: Error";
      const durationMs = Date.now() - t0;
      void this.opts.logger?.warn("reply generate failed", { error, durationMs });
      return { ok: false, reason: "llm-error", error, durationMs };
    }
  }
}
