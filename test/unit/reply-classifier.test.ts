import { describe, it, expect, vi } from "vitest";
import { ReplyClassifier, CLASSIFIER_SCHEMA, buildClassifierPrompt, CLASSIFIER_PREFIX, toClassification } from "../../src/main/reply-classifier.js";
import { ReplyChatClient } from "../../src/main/reply-chat-client.js";
import { CASES, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";

function clientReturning(content: string) {
  // Typed with the same (unused) params as ReplyChatClientTest's fetchImpl so
  // `fetchImpl.mock.calls[0]![1]!.body` below has a real tuple to index into
  // (a bare `vi.fn(async () => …)` infers a zero-length parameter tuple,
  // which fails noUncheckedIndexedAccess at [1]).
  const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 12 } }), { status: 200 }));
  return { client: new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

const INPUT = { transcript: "INTERLOCUTORE (Marta): la review la fai tu o la giro a Paolo?", lastMessage: "la review la fai tu o la giro a Paolo?", counterpart: "Marta" };

describe("CLASSIFIER_SCHEMA", () => {
  it("fixes the four keys, the enum of kind, the two-string alternatives and the language enum", () => {
    expect(CLASSIFIER_SCHEMA).toEqual({
      type: "object",
      properties: {
        answerable: { type: "boolean" },
        kind: { type: "string", enum: ["generic", "alternative", "offer"] },
        alternatives: { type: "array", items: { type: "string", maxLength: 40 }, minItems: 0, maxItems: 2 },
        language: { type: "string", enum: ["it", "en", "other"] },
      },
      required: ["answerable", "kind", "alternatives", "language"],
      additionalProperties: false,
    });
  });
});

describe("buildClassifierPrompt", () => {
  it("starts with the fixed prefix (for the KV cache) and ends with the transcript", () => {
    const p = buildClassifierPrompt(INPUT);
    expect(p.startsWith(CLASSIFIER_PREFIX)).toBe(true);
    expect(p.endsWith(`${INPUT.transcript}\n</trascrizione>`)).toBe(true);
    expect(p).toContain("Marta");
  });
  it("describes the schema in words: the model cannot see it", () => {
    const p = buildClassifierPrompt(INPUT);
    for (const w of ['"answerable"', '"kind"', '"alternatives"', '"language"', "generic", "alternative", "offer"]) expect(p).toContain(w);
  });
});

describe("toClassification (Minor 8.1: alternatives maxLength)", () => {
  it("degrades to generic when an alternative exceeds the grammar's own maxLength: 40", () => {
    const tooLong = "x".repeat(200);
    const c = toClassification({ answerable: true, kind: "alternative", alternatives: ["ok", tooLong], language: "it" });
    expect(c).toEqual({ answerable: true, kind: "generic", language: "it" });
  });
  it("keeps two alternatives right at the boundary (40 chars)", () => {
    const forty = "x".repeat(40);
    const c = toClassification({ answerable: true, kind: "alternative", alternatives: ["ok", forty], language: "it" });
    expect(c).toEqual({ answerable: true, kind: "alternative", alternatives: ["ok", forty], language: "it" });
  });
});

describe("ReplyClassifier.classify", () => {
  it("sends temperature 0, max_tokens 64 and the classifier schema", async () => {
    const { client, fetchImpl } = clientReturning('{"answerable":true,"kind":"generic","alternatives":[],"language":"it"}');
    await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(64);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { schema: CLASSIFIER_SCHEMA } });
    expect(Object.keys(body).sort()).toEqual(["cache_prompt", "chat_template_kwargs", "max_tokens", "messages", "response_format", "stream", "temperature"]);
  });

  it("returns the classification with alternatives when kind is alternative and two are present", async () => {
    const { client } = clientReturning('{"answerable":true,"kind":"alternative","alternatives":["la faccio io","la giro a Paolo"],"language":"it"}');
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r).toEqual({ ok: true, classification: { answerable: true, kind: "alternative", alternatives: ["la faccio io", "la giro a Paolo"], language: "it" }, durationMs: expect.any(Number) });
  });

  it("degrades kind alternative to generic when fewer than two non-empty alternatives come back", async () => {
    for (const alts of ["[]", '["solo una"]', '["", "x"]']) {
      const { client } = clientReturning(`{"answerable":true,"kind":"alternative","alternatives":${alts},"language":"it"}`);
      const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
      expect(r.ok && r.classification.kind, alts).toBe("generic");
      expect(r.ok && r.classification.alternatives, alts).toBeUndefined();
    }
  });

  it("drops alternatives when kind is not alternative", async () => {
    const { client } = clientReturning('{"answerable":true,"kind":"generic","alternatives":["a","b"],"language":"en"}');
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r.ok && r.classification.alternatives).toBeUndefined();
  });

  it("returns ok:false reason not-answerable when the model says so", async () => {
    const { client } = clientReturning('{"answerable":false,"kind":"generic","alternatives":[],"language":"it"}');
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r).toEqual({ ok: false, reason: "not-answerable", durationMs: expect.any(Number) });
  });

  it("returns ok:false reason invalid-classification when the JSON has the wrong shape (grammar bypassed)", async () => {
    const { client } = clientReturning('{"answerable":"yes"}');
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r).toEqual({ ok: false, reason: "invalid-classification", durationMs: expect.any(Number) });
  });

  it("propagates ReplyLLMError as ok:false reason llm-error with the error message as code", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 503 }));
    const client = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await new ReplyClassifier({ client, timeoutMs: 5000 }).classify(INPUT);
    expect(r).toEqual({ ok: false, reason: "llm-error", error: "reply LLM HTTP 503", durationMs: expect.any(Number) });
  });

  it("logs metrics only: never the transcript, the last message or the counterpart", async () => {
    const slack = CASES[0]!; // slack-decisione
    const { client } = clientReturning('{"answerable":true,"kind":"alternative","alternatives":["tu","Paolo"],"language":"it"}');
    const seen: string[] = [];
    const logger = { info: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
                     warn: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }) };
    await new ReplyClassifier({ client, timeoutMs: 5000, logger }).classify({
      transcript: `INTERLOCUTORE (Marta): ${slack.ax}`, lastMessage: slack.ax, counterpart: "Marta",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) expect(leaksScreenText(line, slack.ax), line).toBe(false);
  });
});
