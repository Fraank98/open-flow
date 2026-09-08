import { describe, it, expect, vi } from "vitest";
import { ReplyChatClient, ReplyLLMError } from "../../src/main/reply-chat-client.js";

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const ok = (content: string) => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { completion_tokens: 7, prompt_tokens: 100 } });

describe("ReplyChatClient.completeJson", () => {
  it("posts one user message to /v1/chat/completions with thinking off, cache on, stream off", async () => {
    const fetchImpl = fetchReturning(200, ok('{"a":1}'));
    const c = new ReplyChatClient({ endpoint: "http://127.0.0.1:18082", fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.completeJson({ prompt: "PROMPT", schema: { type: "object" }, sampling: { temperature: 0 }, maxTokens: 64, timeoutMs: 5000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!; // called once, asserted above
    expect(url).toBe("http://127.0.0.1:18082/v1/chat/completions");
    expect(JSON.parse(init!.body as string)).toEqual({
      messages: [{ role: "user", content: "PROMPT" }],
      max_tokens: 64,
      stream: false,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } },
      temperature: 0,
    });
  });

  it("never sends a system message", async () => {
    const fetchImpl = fetchReturning(200, ok("{}"));
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { messages: Array<{ role: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("returns the parsed JSON, the raw content length, the token count and the duration", async () => {
    const fetchImpl = fetchReturning(200, ok('{"answerable":true}'));
    const clock = [1000, 1250];
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock.shift() ?? 1250 });
    const r = await c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    expect(r).toEqual({ json: { answerable: true }, contentChars: 19, completionTokens: 7, durationMs: 250 });
  });

  it("throws ReplyLLMError 'reply LLM HTTP <status>' on non-2xx without reading the body into the message", async () => {
    const fetchImpl = fetchReturning(500, "SECRET-BODY-TEXT");
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    await expect(p).rejects.toBeInstanceOf(ReplyLLMError);
    await expect(p).rejects.toThrow("reply LLM HTTP 500");
    await expect(p).rejects.not.toThrow("SECRET");
  });

  it("throws 'reply LLM invalid JSON' when content is not JSON, without quoting the content", async () => {
    const fetchImpl = fetchReturning(200, ok("ZQXV-VARIANT-TEXT not json"));
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    await expect(p).rejects.toThrow("reply LLM invalid JSON");
    await expect(p).rejects.not.toThrow("ZQXV");
  });

  it("throws 'reply LLM invalid JSON' when the HTTP response body itself is not JSON, without quoting it (fix round 1)", async () => {
    // Distinct from the previous test: here res.json() itself fails (a
    // malformed envelope), not JSON.parse() on the inner `content` string.
    const fetchImpl = fetchReturning(200, "NOT-EVEN-JSON {{{ RQPL-BODY-TEXT");
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    await expect(p).rejects.toBeInstanceOf(ReplyLLMError);
    await expect(p).rejects.toThrow("reply LLM invalid JSON");
    await expect(p).rejects.not.toThrow("RQPL");
  });

  it("throws 'reply LLM empty content' when the model returned nothing (thinking swallowed the budget)", async () => {
    const fetchImpl = fetchReturning(200, { choices: [{ message: { content: "", reasoning_content: "thinking…" } }] });
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 })).rejects.toThrow("reply LLM empty content");
  });

  it("wraps a network failure as 'reply LLM request failed: <ErrorName>' with no other detail", async () => {
    const fetchImpl = vi.fn(async () => { const e = new Error("connect ECONNREFUSED 127.0.0.1:18082"); e.name = "TypeError"; throw e; });
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1000 });
    await expect(p).rejects.toThrow("reply LLM request failed: TypeError");
    await expect(p).rejects.not.toThrow("ECONNREFUSED");
  });

  it("passes the timeout as an AbortSignal", async () => {
    const fetchImpl = fetchReturning(200, ok("{}"));
    const c = new ReplyChatClient({ endpoint: "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.completeJson({ prompt: "P", schema: {}, sampling: {}, maxTokens: 8, timeoutMs: 1234 });
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
});
