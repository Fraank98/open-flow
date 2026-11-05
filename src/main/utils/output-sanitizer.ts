import { VERBAL_FILLERS, DISCOURSE_FILLERS } from "./filler-words.js";

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

// Validate deletions, not just the surviving subsequence. A model summary is
// also a subsequence, but must never replace the user's full dictation.
// Keep numbers as tokens too: dropping/changing quantities is content loss.
function hasOnlyAllowedDeletions(input: string, output: string): boolean {
  const tokens = [...input.matchAll(/[\p{L}\p{N}]+/gu)];
  const words = tokens.map((t) => t[0].toLowerCase());
  const outWords = output.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const verbal = new Set<string>(VERBAL_FILLERS);
  const discourse = Object.values(DISCOURSE_FILLERS).flat()
    .map((phrase) => phrase.toLowerCase().match(/\p{L}+/gu)!);

  // Reachable output positions at each input position. Explore both keeping
  // and removing a filler so repeated words cannot cause a greedy mismatch.
  const reachable = Array.from({ length: words.length + 1 }, () => new Set<number>());
  reachable[0]!.add(0);
  for (let i = 0; i < words.length; i++) {
    if (reachable[i]!.size === 0) continue;
    const end = tokens[i]!.index! + tokens[i]![0].length;
    const previousEnd = i === 0 ? 0 : tokens[i - 1]!.index! + tokens[i - 1]![0].length;
    const before = input.slice(previousEnd, tokens[i]!.index);
    const after = input.slice(end, tokens[i + 1]?.index ?? input.length);
    const skipEnds: number[] = [];
    if (verbal.has(words[i]!)) skipEnds.push(i + 1);

    // Be conservative with ambiguous discourse words ("like", "well", ...).
    // Accept only sentence-initial markers explicitly separated by a comma.
    if (i === 0 || /[.!?]\s*$/.test(before)) {
      for (const phrase of discourse) {
        const last = i + phrase.length - 1;
        if (phrase.every((w, k) => words[i + k] === w) &&
            /^\s*,/.test(input.slice(tokens[last]!.index! + tokens[last]![0].length))) {
          skipEnds.push(last + 1);
        }
      }
    }
    // Only dash-marked repetitions/partial-word starts, never bare duplicates.
    if (/^\s*[—-]\s*$/.test(after) && words[i + 1]?.startsWith(words[i]!)) {
      skipEnds.push(i + 1);
    }
    for (const j of reachable[i]!) {
      if (j < outWords.length && words[i] === outWords[j]) reachable[i + 1]!.add(j + 1);
      for (const next of skipEnds) reachable[next]!.add(j);
    }
  }
  return reachable[words.length]!.has(outWords.length);
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

  // Reject any edit that cannot be explained solely by supported disfluency
  // removal. On uncertainty, retain the complete original transcript.
  if (rawTranscript.trim().length > 0 && !hasOnlyAllowedDeletions(rawTranscript, text)) {
    return { text: rawTranscript, usedFallback: true };
  }

  return { text, usedFallback: false };
}
