import { describe, it, expect, vi, afterEach } from "vitest";
import { LLMCleaner, LLMError } from "../../src/main/llm-cleaner.js";

/** Build a fake `fetch` returning a configurable JSON response with `content`. */
function fakeFetchReturning(content: string) {
  return vi.fn<typeof fetch>(async (_input, _init) => {
    return new Response(JSON.stringify({ content }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("LLMCleaner fast-path skip", () => {
  it("skips the LLM when the transcript has no disfluency markers", async () => {
    const fetchImpl = fakeFetchReturning("never sent");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    const result = await cleaner.clean("No, lo scroll automatico non funziona ancora.", "it");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.text).toBe("No, lo scroll automatico non funziona ancora.");
  });

  it("calls the LLM when the transcript contains an Italian filler", async () => {
    const fetchImpl = fakeFetchReturning(" pensavo di andare al mare.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    const result = await cleaner.clean("Allora, pensavo di andare al mare.", "it");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBeFalsy();
  });

  it("calls the LLM on a false-start with em-dash repetition", async () => {
    const fetchImpl = fakeFetchReturning("io penso che è giusto.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean("io— io penso che è giusto.", "it");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls the LLM on a verbal 'uh' filler", async () => {
    const fetchImpl = fakeFetchReturning(" hello world.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean("uh, hello world.", "en");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls the LLM on `cioè` despite the accented final character (Unicode boundary)", async () => {
    const fetchImpl = fakeFetchReturning("vediamo se funziona.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean("Cioè, vediamo se funziona.", "it");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls the LLM on an English discourse-marker filler (well)", async () => {
    const fetchImpl = fakeFetchReturning(" I was thinking we should leave.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean("Well, I was thinking we should leave.", "en");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls the LLM on multi-word fillers (you know, o sea, en fait, tu sais)", async () => {
    for (const input of [
      "I think, you know, it works.",
      "Es importante, o sea, fundamental.",
      "C'est compliqué, en fait, très compliqué.",
      "Le ferai, tu sais, demain.",
    ]) {
      const fetchImpl = fakeFetchReturning("cleaned");
      const cleaner = new LLMCleaner({
        endpoint: "http://test",
        timeoutMs: 5000,
        fetchImpl,
      });
      await cleaner.clean(input, "auto");
      expect(fetchImpl, `expected LLM call for input: ${input}`).toHaveBeenCalledTimes(1);
    }
  });

  it("calls the LLM on a German discourse-marker filler (also)", async () => {
    const fetchImpl = fakeFetchReturning(" ich denke wir sollten gehen.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean("Also, ich denke wir sollten gehen.", "de");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls the LLM on a French discourse-marker filler (alors)", async () => {
    const fetchImpl = fakeFetchReturning(" je pense qu'on devrait partir.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean("Alors, je pense qu'on devrait partir.", "fr");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls the LLM on a Spanish discourse-marker filler (pues)", async () => {
    const fetchImpl = fakeFetchReturning(" vamos a empezar.");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean("Pues, vamos a empezar.", "es");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not match filler words embedded inside larger words", async () => {
    // "Cioèssimo" is not a real word but illustrates the boundary: the regex
    // must not match `cioè` as a substring of a longer Unicode-letter run.
    // Also "uhm" should not match inside "uhmistico".
    const fetchImpl = fakeFetchReturning("never sent");
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean("Cioèssimo uhmistico, niente da fare.", "it");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("LLMCleaner n_predict cap", () => {
  it("requests n_predict at most 1.2x the input token estimate", async () => {
    // The dynamicCap formula is `max(48, ceil(approxTokens * 1.2))`. Use a
    // long enough input so the 1.2x term dominates the 48-token floor —
    // otherwise this test would just verify the floor and miss any regression
    // in the multiplier.
    const inputText =
      "Ehm, hello world, this is intentionally long enough that the 1.2x " +
      "multiplier in the dynamic-cap formula dominates the 48-token floor — " +
      "so we actually verify the multiplier, not just the floor value.";
    // ~210 chars → ~70 tokens → ceil(70*1.2)=84 → cap = 84 (dominates floor 48).

    let capturedBody: { n_predict?: number } | null = null;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({ content: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const cleaner = new LLMCleaner({
      endpoint: "http://test",
      timeoutMs: 5000,
      fetchImpl,
    });
    await cleaner.clean(inputText, "en");
    const approxTokens = Math.ceil(inputText.length / 3);
    const expectedCap = Math.max(48, Math.ceil(approxTokens * 1.2));
    expect(expectedCap).toBeGreaterThan(48); // sanity: floor is NOT dominating
    expect(capturedBody!.n_predict).toBe(expectedCap);
  });
});

describe("LLMCleaner HTTP failures and request body", () => {
  afterEach(() => vi.restoreAllMocks());

  const make = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof LLMCleaner>[0]> = {}) =>
    new LLMCleaner({ endpoint: "http://test", timeoutMs: 5000, fetchImpl, ...extra });

  function captureBody() {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ content: "x" }), { status: 200 });
    });
    return { fetchImpl, calls, body: () => JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown> };
  }

  it("wraps a failing fetch in LLMError('LLM HTTP request failed') with the cause as detail", async () => {
    const cleaner = make(vi.fn<typeof fetch>(async () => { throw new Error("ECONNREFUSED"); }));
    const err = await cleaner.clean("uh, hello", "en").catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.name).toBe("LLMError");
    expect(err.message).toBe("LLM HTTP request failed");
    expect(err.detail).toBe("ECONNREFUSED");
  });

  it("stringifies a non-Error rejection into the detail", async () => {
    const cleaner = make(vi.fn<typeof fetch>(async () => { throw "weird"; }));
    await expect(cleaner.clean("uh, hello", "en")).rejects.toMatchObject({ message: "LLM HTTP request failed", detail: "weird" });
  });

  it("turns a non-ok status into LLMError('LLM HTTP 503') with the body truncated to 500 chars", async () => {
    const cleaner = make(vi.fn<typeof fetch>(async () => new Response("e".repeat(900), { status: 503 })));
    const err = await cleaner.clean("uh, hello", "en").catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.message).toBe("LLM HTTP 503");
    expect(err.detail).toBe("e".repeat(500));
  });

  it("uses an empty detail when the error body cannot be read", async () => {
    const res = new Response("x", { status: 500 });
    vi.spyOn(res, "text").mockRejectedValue(new Error("stream broke"));
    const cleaner = make(vi.fn<typeof fetch>(async () => res));
    await expect(cleaner.clean("uh, hello", "en")).rejects.toMatchObject({ message: "LLM HTTP 500", detail: "" });
  });

  it("returns an empty cleaned text when the response has no content field", async () => {
    const cleaner = make(vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })));
    const result = await cleaner.clean("uh, hello there", "en");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.skipped).toBeUndefined();
    // An empty completion is never accepted as the cleaned text: the raw transcript comes back.
    expect(result.text).toBe("uh, hello there");
    expect(result.usedFallback).toBe(true);
  });

  it("posts the completion request with the documented body fields", async () => {
    const { fetchImpl, calls, body } = captureBody();
    await make(fetchImpl).clean("uh, hello", "en");
    expect(calls[0]!.url).toBe("http://test/completion");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toEqual({ "Content-Type": "application/json" });
    const b = body();
    expect(b.stop).toEqual(["<<<", "<|im_end|>", "<|endoftext|>", "[end of text]", "\n\n"]);
    expect(b.cache_prompt).toBe(true);
    expect(b.repeat_penalty).toBe(1.1);
    expect(b.repeat_last_n).toBe(128);
    expect(b.temperature).toBe(0.2);
    expect(typeof b.prompt).toBe("string");
    expect(String(b.prompt)).toContain("uh, hello");
  });

  it("honours a custom temperature", async () => {
    const { fetchImpl, body } = captureBody();
    await make(fetchImpl, { temperature: 0 }).clean("uh, hello", "en");
    expect(body().temperature).toBe(0);
  });

  it("floors n_predict at 48 for very short inputs", async () => {
    const { fetchImpl, body } = captureBody();
    await make(fetchImpl).clean("uh hi", "en");
    expect(body().n_predict).toBe(48);
  });

  it("clamps n_predict to maxTokens when that is lower than the dynamic cap", async () => {
    const { fetchImpl, body } = captureBody();
    await make(fetchImpl, { maxTokens: 10 }).clean("uh hi", "en");
    expect(body().n_predict).toBe(10);
  });

  it("caps n_predict at the default 512 for a very long input", async () => {
    const { fetchImpl, body } = captureBody();
    await make(fetchImpl).clean("uh, " + "word ".repeat(1000), "en");
    expect(body().n_predict).toBe(512);
  });

  it("passes AbortSignal.timeout(timeoutMs) to fetch", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { fetchImpl, calls } = captureBody();
    await make(fetchImpl, { timeoutMs: 1234 }).clean("uh, hello", "en");
    expect(timeout).toHaveBeenCalledWith(1234);
    expect(calls[0]!.init?.signal).toBe(timeout.mock.results[0]!.value);
  });

  it("falls back to the global fetch when no fetchImpl is given", async () => {
    const g = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: "x" }), { status: 200 }));
    vi.stubGlobal("fetch", g);
    try {
      await new LLMCleaner({ endpoint: "http://g", timeoutMs: 1000 }).clean("uh, hello", "en");
      expect(g).toHaveBeenCalledTimes(1);
      expect(String(g.mock.calls[0]![0])).toBe("http://g/completion");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
