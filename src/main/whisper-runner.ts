export interface WhisperRunnerOptions {
  /** Base URL of the whisper-server, e.g. http://127.0.0.1:18081 */
  endpoint: string;
  timeoutMs: number;
}

export interface TranscribeArgs {
  /** Raw bytes of a WAV file (16 kHz mono 16-bit PCM). */
  wavBytes: Uint8Array;
  language: string; // "auto" or ISO code like "en", "it"
}

export interface TranscribeResult {
  text: string;
  language: string | null;
  durationMs: number;
}

export class WhisperError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = "WhisperError";
  }
}

interface WhisperInferenceResponse {
  text?: string;
  language?: string;
}

/**
 * Transcribes WAV audio by posting to a whisper-server /inference endpoint.
 * The model stays warm across calls, so each transcription is just inference
 * (~400-800ms for 5s of audio) instead of the ~1.4-2.5s cold spawn of
 * whisper-cli.
 */
export class WhisperRunner {
  constructor(private readonly opts: WhisperRunnerOptions) {}

  async transcribe(args: TranscribeArgs): Promise<TranscribeResult> {
    const start = Date.now();

    const form = new FormData();
    // Wrap in a Blob so multipart sees a proper file-type field with a filename.
    // Slice into a real ArrayBuffer to avoid SharedArrayBuffer typing issues
    // when `wavBytes` is a Uint8Array view onto a SharedArrayBuffer.
    const buf = args.wavBytes.buffer.slice(
      args.wavBytes.byteOffset,
      args.wavBytes.byteOffset + args.wavBytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([buf], { type: "audio/wav" });
    form.append("file", blob, "audio.wav");
    form.append("temperature", "0.0");
    form.append("language", args.language);
    form.append("response_format", "json");

    let res: Response;
    try {
      res = await fetch(`${this.opts.endpoint}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new WhisperError(
        "Whisper HTTP request failed",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WhisperError(`Whisper HTTP ${res.status}`, text.slice(0, 500));
    }
    const data = (await res.json()) as WhisperInferenceResponse;
    const rawText = (data.text ?? "").trim();
    return {
      text: stripWhisperMarkers(rawText),
      language: data.language ?? null,
      durationMs: Date.now() - start,
    };
  }
}

// Whisper.cpp produces non-speech markers like "[Music]", "[Applause]",
// "[Multiple voices]" or simply nonsense placeholders ("[Oggigio]") when it
// hears silence, low SNR, or speech it can't confidently transcribe. Strip
// any [...] or (...) bracketed token that doesn't contain a colon (which
// would suggest legitimate user content like "[link: ...]").
export function stripWhisperMarkers(text: string): string {
  return text
    .replace(/\s*\[[^\]:]*\]\s*/g, " ")
    .replace(/\s*\([^):]*\)\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
