export interface SanitizedOutput {
  text: string;
  usedFallback: boolean;
}

const NOISY_PREFIX_PATTERNS: RegExp[] = [
  /^\s*sure[,!.]?\s*(here\s+is|here's|cleaned|corrected)\s*(the\s+)?(cleaned|corrected)?\s*(version|text)?\s*:\s*\n?/i,
  /^\s*here\s+(is|are)\s+the\s+cleaned\s+(text|version)\s*:\s*\n?/i,
  /^\s*cleaned\s+text\s*:\s*\n?/i,
  /^\s*cleaned\s*:\s*\n?/i,
];

// llama.cpp emits a literal "[end of text]" token at the end of generation
// when it hits the EOS token. Also catches related sentinels and trailing
// transcript-delimiter leakage from the prompt template — including
// variants the model invents like "<<</clean_transcript>>".
const NOISY_SUFFIX_PATTERNS: RegExp[] = [
  /\s*\[end of text\]\s*$/i,
  /\s*<<<\/?[a-z_]*transcript[a-z_]*>?>?>?\s*$/i,
  /\s*<<<[^>]*$/i,
  /\s*<\|im_end\|>\s*$/i,
  /\s*<\|endoftext\|>\s*$/i,
];

const SHORT_OUTPUT_THRESHOLD = 50; // chars

// Compute the fraction of words in `output` that don't appear anywhere in
// `input`. Words are runs of Unicode letters; case is normalized. Returns
// 0 when output is empty.
function outputWordDrift(input: string, output: string): number {
  const inWords = new Set((input.toLowerCase().match(/\p{L}+/gu) ?? []));
  const outWords = (output.toLowerCase().match(/\p{L}+/gu) ?? []);
  if (outWords.length === 0) return 0;
  let invented = 0;
  for (const w of outWords) {
    if (!inWords.has(w)) invented++;
  }
  return invented / outWords.length;
}

export function sanitizeLlmOutput(rawOutput: string, rawTranscript: string): SanitizedOutput {
  let text = rawOutput.trim();

  // HTML / Markdown leak from degenerated small-model output. Strip any
  // tag-shaped sequence completely. If the LLM output contains ANY tag we
  // also treat it as a strong signal of degeneration — even after stripping
  // the result is likely garbage — and prefer the raw transcript via the
  // length-ratio check downstream.
  const htmlTagRe = /<\/?[a-z][a-z0-9]*(?:\s[^>]*)?>/gi;
  if (htmlTagRe.test(text)) {
    text = text.replace(htmlTagRe, " ").replace(/\s{2,}/g, " ").trim();
    // If after stripping we lost most of the content, fall back to raw.
    if (text.length < rawTranscript.length * 0.5) {
      return { text: rawTranscript, usedFallback: true };
    }
  }

  for (const pattern of NOISY_PREFIX_PATTERNS) {
    text = text.replace(pattern, "");
  }
  for (const pattern of NOISY_SUFFIX_PATTERNS) {
    text = text.replace(pattern, "");
  }

  text = text.trim();

  // Strip wrapping quotes if both ends match
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  if (text.length === 0) {
    return { text: rawTranscript, usedFallback: true };
  }

  // Length sanity: only enforce ratio when output is non-trivially long
  if (text.length > SHORT_OUTPUT_THRESHOLD && text.length > rawTranscript.length * 2.5) {
    return { text: rawTranscript, usedFallback: true };
  }

  // Drift detector: small models sometimes paraphrase / invent vocabulary
  // even when explicitly told not to. Compare the set of words used in the
  // input vs in the output. If more than ~40% of the output's words don't
  // appear in the input, the model invented content — discard and use raw.
  if (rawTranscript.length > SHORT_OUTPUT_THRESHOLD) {
    const drift = outputWordDrift(rawTranscript, text);
    if (drift > 0.4) {
      return { text: rawTranscript, usedFallback: true };
    }
  }

  // Repetition guard: small LLMs sometimes lock into a loop and emit the
  // cleaned sentence two or more times. Detect by looking for any
  // substring of ≥20 chars from the start of the output that appears
  // again later in the same string.
  if (text.length >= 40) {
    const probeLen = Math.min(40, Math.floor(text.length / 2));
    const probe = text.slice(0, probeLen);
    const secondIdx = text.indexOf(probe, probeLen);
    if (secondIdx !== -1) {
      // Use the first occurrence only — it's a complete copy of what the
      // model meant to output before it started repeating.
      const single = text.slice(0, secondIdx).trim();
      if (single.length > 0) {
        return { text: single, usedFallback: false };
      }
    }
  }

  return { text, usedFallback: false };
}
