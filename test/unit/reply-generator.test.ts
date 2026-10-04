import { describe, it, expect, vi } from "vitest";
import { ReplyGenerator, buildGeneratorPrompt, GENERATOR_PREFIX, GEMMA_SAMPLING } from "../../src/main/reply-generator.js";
import { positionsFor } from "../../src/main/utils/reply-positions.js";
import { ReplyChatClient } from "../../src/main/reply-chat-client.js";
import { CASES, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";

function clientReturning(content: string) {
  // Typed with the same (unused) params as reply-classifier.test.ts's
  // fetchImpl so `fetchImpl.mock.calls[0]![1]!.body` below has a real tuple
  // to index into (a bare `vi.fn(async () => …)` infers a zero-length
  // parameter tuple, which fails noUncheckedIndexedAccess at [1]).
  const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 90 } }), { status: 200 }));
  return { client: new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

const INPUT = {
  transcript: "INTERLOCUTORE (Marta): la review la fai tu o la giro a Paolo?",
  lastMessage: "la review la fai tu o la giro a Paolo?",
  counterpart: "Marta",
  userDisplayName: "Danilo",
  subject: undefined,
  positions: positionsFor({ kind: "alternative", language: "it", alternatives: ["la fai tu", "la giro a Paolo"] }),
  language: "it" as const,
};

describe("GEMMA_SAMPLING", () => {
  it("is the official Gemma profile with repetition penalty off", () => {
    expect(GEMMA_SAMPLING).toEqual({ temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0, repeat_penalty: 1.0 });
  });
});

describe("buildGeneratorPrompt", () => {
  it("starts with the fixed prefix and contains roles, the last message, the positions and the transcript", () => {
    const p = buildGeneratorPrompt(INPUT);
    expect(p.startsWith(GENERATOR_PREFIX)).toBe(true);
    expect(p).toContain("Tu scrivi come Danilo");
    expect(p).toContain("indirizzato a Marta");
    expect(p).toContain("«la review la fai tu o la giro a Paolo?»");
    for (const key of ["first", "second", "defer"]) expect(p).toContain(`"${key}"`);
    expect(p.endsWith(`${INPUT.transcript}\n</trascrizione>`)).toBe(true);
  });
  it("adds the subject line when present and the language instruction", () => {
    expect(buildGeneratorPrompt({ ...INPUT, subject: "Sopralluogo" })).toContain("Oggetto: Sopralluogo");
    expect(buildGeneratorPrompt(INPUT)).toContain("Lingua: italiano");
    expect(buildGeneratorPrompt({ ...INPUT, language: "en" })).toContain("Lingua: inglese");
    expect(buildGeneratorPrompt({ ...INPUT, language: "other" })).toContain("Lingua: la stessa della trascrizione");
  });
  it("forbids the four measured failure modes in words", () => {
    const p = buildGeneratorPrompt(INPUT);
    for (const s of ["Non affermare MAI di aver già svolto un'azione", "Non inventare impegni, riunioni o motivi", "Nessuna cifra, data o nome", "Nessuna firma finale", "non copiarli e non copiare queste istruzioni"]) expect(p).toContain(s);
  });
});

describe("ReplyGenerator.generate", () => {
  it("sends the Gemma sampling, max_tokens 320 and a schema with exactly the set's keys", async () => {
    const { client, fetchImpl } = clientReturning('{"first":"La faccio io.","second":"Girala a Paolo.","defer":"Ti dico entro stasera."}');
    await new ReplyGenerator({ client, timeoutMs: 10_000 }).generate(INPUT);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0, repeat_penalty: 1.0, max_tokens: 320, stream: false, cache_prompt: true, chat_template_kwargs: { enable_thinking: false } });
    expect((body.response_format as { json_schema: { schema: { required: string[] } } }).json_schema.schema.required).toEqual(["first", "second", "defer"]);
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["user"]);
  });

  it("returns the raw variants in set order with key and position label", async () => {
    const { client } = clientReturning('{"first":" La faccio io. ","second":"Girala a Paolo.","defer":"Ti dico entro stasera."}');
    const r = await new ReplyGenerator({ client, timeoutMs: 10_000 }).generate(INPUT);
    expect(r).toEqual({
      ok: true,
      variants: [
        { key: "first", label: "Scelgo: la fai tu", text: " La faccio io. " },
        { key: "second", label: "Scelgo: la giro a Paolo", text: "Girala a Paolo." },
        { key: "defer", label: "Rimando", text: "Ti dico entro stasera." },
      ],
      durationMs: expect.any(Number),
      completionTokens: 90,
    });
  });

  it("skips a key whose value is missing or not a string, keeping the others", async () => {
    const { client } = clientReturning('{"first":"La faccio io.","second":7,"defer":"Ti dico entro stasera."}');
    const r = await new ReplyGenerator({ client, timeoutMs: 10_000 }).generate(INPUT);
    expect(r.ok && r.variants.map((v) => v.key)).toEqual(["first", "defer"]);
  });

  it("returns ok:false llm-error with the error code on ReplyLLMError", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const client = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await new ReplyGenerator({ client, timeoutMs: 10_000 }).generate(INPUT);
    expect(r).toEqual({ ok: false, reason: "llm-error", error: "reply LLM HTTP 500", durationMs: expect.any(Number) });
  });

  it("logs metrics only: never transcript, last message, names or generated text", async () => {
    const slack = CASES[0]!;
    const { client } = clientReturning('{"first":"ZQXV-VARIANT-TEXT uno","second":"ZQXV-VARIANT-TEXT due","defer":"ZQXV-VARIANT-TEXT tre"}');
    const seen: string[] = [];
    const logger = { info: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
                     warn: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }) };
    await new ReplyGenerator({ client, timeoutMs: 10_000, logger }).generate({ ...INPUT, transcript: `INTERLOCUTORE (Marta): ${slack.ax}`, lastMessage: slack.ax });
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) {
      expect(leaksScreenText(line, slack.ax), line).toBe(false);
      expect(line.includes("ZQXV"), line).toBe(false);
    }
  });
});
