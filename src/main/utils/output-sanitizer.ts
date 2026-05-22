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
// transcript-delimiter leakage from the prompt template.
const NOISY_SUFFIX_PATTERNS: RegExp[] = [
  /\s*\[end of text\]\s*$/i,
  /\s*<<<\/?transcript>?>?>?\s*$/i,
  /\s*<\|im_end\|>\s*$/i,
  /\s*<\|endoftext\|>\s*$/i,
];

const SHORT_OUTPUT_THRESHOLD = 50; // chars

export function sanitizeLlmOutput(rawOutput: string, rawTranscript: string): SanitizedOutput {
  let text = rawOutput.trim();

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
  if (text.length > SHORT_OUTPUT_THRESHOLD && text.length > rawTranscript.length * 3) {
    return { text: rawTranscript, usedFallback: true };
  }

  return { text, usedFallback: false };
}
