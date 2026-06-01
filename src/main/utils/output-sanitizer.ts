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

// True when every word of `output` appears in `input` in the same relative
// order — i.e. `output` is a word-subsequence of `input`. Words are runs of
// Unicode letters; case is normalized. Empty output is trivially a subsequence.
function isWordSubsequence(input: string, output: string): boolean {
  const inWords = input.toLowerCase().match(/\p{L}+/gu) ?? [];
  const outWords = output.toLowerCase().match(/\p{L}+/gu) ?? [];
  let i = 0;
  for (const w of outWords) {
    while (i < inWords.length && inWords[i] !== w) i++;
    if (i >= inWords.length) return false;
    i++; // consume the matched input word
  }
  return true;
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

  // Markdown emphasis: Qwen 1.5B routinely bolds/italicizes words (**word**,
  // *word*) despite the prompt forbidding markdown — and the markers are often
  // unbalanced (e.g. "**fermo***.*"), so matching paired markers is fragile.
  // Asterisks never belong in cleaned dictation text, so just drop them all
  // and collapse the whitespace that "** **" leaves behind.
  if (text.includes("*")) {
    text = text.replace(/\*/g, "").replace(/\s{2,}/g, " ").trim();
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

  // Repetition guard: small LLMs sometimes lock into a loop and emit the
  // cleaned sentence two or more times. Detect by looking for a substring from
  // the start of the output that appears again later, and keep only the first
  // copy. This runs BEFORE the subsequence check below: a doubled output is not
  // a subsequence of the (single) input, so without de-duping first it would be
  // discarded as mangled instead of salvaged.
  if (text.length >= 40) {
    const probeLen = Math.min(40, Math.floor(text.length / 2));
    const probe = text.slice(0, probeLen);
    const secondIdx = text.indexOf(probe, probeLen);
    if (secondIdx !== -1) {
      // Use the first occurrence only — it's a complete copy of what the
      // model meant to output before it started repeating.
      const single = text.slice(0, secondIdx).trim();
      if (single.length > 0) {
        text = single;
      }
    }
  }

  // Removal-only contract: the cleaned output must be a word-subsequence of the
  // input — same words, same order, some deleted (fillers). The task never
  // substitutes, inserts, or reorders words, so anything that breaks the
  // subsequence is the model mangling content (e.g. finisci→finisco, or moving
  // a word mid-sentence). Discard and use raw. Case is normalized so
  // capitalizing the word after a removed sentence-initial filler still matches.
  // This subsumes the older fraction-based drift heuristic, which let a single
  // substitution in a short sentence through (1/6 = 17% < 35%) and was blind to
  // reordering (the word is still "present").
  if (rawTranscript.trim().length > 0 && !isWordSubsequence(rawTranscript, text)) {
    return { text: rawTranscript, usedFallback: true };
  }

  return { text, usedFallback: false };
}
