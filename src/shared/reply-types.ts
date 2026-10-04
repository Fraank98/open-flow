/** Types shared by main (coordinator, overlay window), preload and renderer.
 *  No runtime code: this file is compiled by both tsconfig.main and
 *  tsconfig.preload. */

export interface SuggestionVariant {
  id: 1 | 2 | 3;
  /** Pill label of the position: "Accetto", "Declino", "Rimando", "Scelgo: …". */
  label: string;
  text: string;
}

export interface SuggestionPayload {
  /** "Rispondi a Marta: chi fa la review?" — deterministic, from the parser. */
  gist: string;
  /** 2 or 3 variants. */
  variants: SuggestionVariant[];
}

/** Overlay states added by the reply feature, sent on pipeline:state-change
 *  next to the dictation states. */
export type ReplyOverlayState = "reading" | "thinking" | "suggesting" | "nothing" | "flash";

export type ReplyServerState = "off" | "downloading" | "starting" | "ready" | "failed";
