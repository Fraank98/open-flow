/**
 * Cosmetic touch-up for transcripts that we did NOT send through the LLM
 * (single short words, or LLM-skipped because no filler markers). Just
 * capitalizes the first letter and adds a trailing period if missing — never
 * changes the wording.
 */
export function lightTouchUp(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const head = trimmed[0]!.toUpperCase();
  const rest = trimmed.slice(1);
  const lastChar = trimmed[trimmed.length - 1] ?? "";
  const endsWithPunct = /[.!?…]/.test(lastChar);
  return head + rest + (endsWithPunct ? "" : ".");
}
