/**
 * Deterministic "does this message contain an explicit proposal?" predicate.
 *
 * Extracted from reply-coordinator.ts (its original home) so the parser's
 * `gate` (conversation-parser.ts, a pure module with no dependency on the
 * orchestrator) can use the SAME predicate the coordinator's pre-gate uses,
 * instead of re-implementing a second, drifting copy. The coordinator still
 * imports and re-exports `hasExplicitProposal` from here, unchanged from its
 * callers' point of view.
 *
 * Deterministic on purpose: a modal, two explicit alternatives, or an offer
 * word are things a regex can recognize reliably; whether a wh-question is
 * actually answerable ("a che ora arrivi?" vs "ti va bene giovedì?") is not,
 * and is left to the classifier.
 *
 * This gate is deliberately permissive, not strict: it is measured to let
 * through things that are not proposals at all — a plain statement
 * containing a keyword ("Il preventivo è pronto." → true, no proposal in
 * it) and English wh-questions that happen to contain an auxiliary the word
 * list also uses for yes/no questions ("do you"/"are you"/"is it"). That is
 * fine and intentional: ruling IN too much here is cheap, because whatever
 * runs after it (the coordinator's classifier, or the parser's own length
 * gate) is the one that actually decides. What this predicate must never do
 * is rule OUT a genuine proposal; it only ever narrows, never widens, what
 * gets through.
 *
 * Found missing from real usage (`.superpowers/sdd/2026-09-08-context-reply-suggestions-plan-b/gate-fix-report.md`):
 * the Italian conditional ("potresti", "riusciresti", "faresti", "te la
 * senti", "ce la fai") IS the polite request form, so it is the one most
 * likely to open a work chat message ("potresti farmi la review?"), yet the
 * list only had the present indicative ("puoi", "riesci"). Adding it was
 * measured, not assumed: against classifier-corpus.ts's eight `info-*`
 * cases (questions that ask for information only the user has, and must
 * keep being ruled OUT here) the list before this addition already let 2/8
 * through (info-howmany via "riesci", info-en-when via "could you"); none
 * of the five new words appears in any `info-*` case, so the addition
 * leaves that 6/8-blocked baseline unchanged while letting through the
 * conditional-request cases it was added for.
 */
const PROPOSAL_WORDS = /\b(puoi|potresti|riesci|riusciresti|faresti|te la senti|ce la fai|te ne occupi|la fai|lo fai|ci pensi|confermi|va bene|d'accordo|ti va|possiamo|riusciamo|preferisci|preferisce|can you|could you|will you|would you|do you|are you|is it|shall we|preventivo|offerta|proposta|quotazione|quote|proposal|estimate)\b/iu;
const ALTERNATIVE_HINT = /\s(?:o|oppure|or)\s/iu;

export function hasExplicitProposal(lastMessage: string): boolean {
  if (PROPOSAL_WORDS.test(lastMessage)) return true;
  return lastMessage.includes("?") && ALTERNATIVE_HINT.test(lastMessage);
}
