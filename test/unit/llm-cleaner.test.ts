import { describe, it, expect, vi } from "vitest";
import { LLMCleaner } from "../../src/main/llm-cleaner.js";

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
