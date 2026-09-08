/**
 * The one HTTP path of the reply-suggestions feature: a single-turn chat
 * completion with a JSON schema, against the reply llama-server.
 *
 * Privacy (spec §Privacy 7): errors carry status code and error type ONLY.
 * The response body would contain generated text, so it is never read into a
 * message and never logged. This is stricter than LLMError in llm-cleaner.ts,
 * which keeps 500 chars of the body.
 *
 * Gemma has no `system` role: the caller puts the instructions in the single
 * user message. Thinking is turned off explicitly: on the benchmarked GGUFs
 * it is on by default and eats the whole token budget (spec §Spike 3).
 */
export interface ReplyChatClientOptions {
  /** e.g. http://127.0.0.1:18082 */
  endpoint: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
}

export interface CompleteJsonInput {
  prompt: string;
  /** JSON schema passed to llama-server, which turns it into a grammar. */
  schema: Record<string, unknown>;
  sampling: SamplingParams;
  maxTokens: number;
  timeoutMs: number;
}

export interface CompleteJsonResult {
  json: unknown;
  /** Length of the raw content — a count, safe to log. */
  contentChars: number;
  completionTokens: number;
  durationMs: number;
}

export class ReplyLLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyLLMError";
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { completion_tokens?: number };
}

export class ReplyChatClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: ReplyChatClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async completeJson(input: CompleteJsonInput): Promise<CompleteJsonResult> {
    const t0 = this.now();
    const body = {
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: input.maxTokens,
      stream: false,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { schema: input.schema } },
      ...input.sampling,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      throw new ReplyLLMError(`reply LLM request failed: ${name}`);
    }
    if (!res.ok) throw new ReplyLLMError(`reply LLM HTTP ${res.status}`);
    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new ReplyLLMError("reply LLM invalid JSON");
    }
    const content = data.choices?.[0]?.message?.content ?? "";
    if (content.trim().length === 0) throw new ReplyLLMError("reply LLM empty content");
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new ReplyLLMError("reply LLM invalid JSON");
    }
    return {
      json,
      contentChars: content.length,
      completionTokens: data.usage?.completion_tokens ?? 0,
      durationMs: this.now() - t0,
    };
  }
}
