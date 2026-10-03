/** Dictation languages offered in Settings; "auto" lets Whisper detect it. */
export const LANGUAGES = [
  { id: "auto", label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "it", label: "Italiano" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
] as const;

export function isSupportedLanguage(id: string): boolean {
  return LANGUAGES.some((l) => l.id === id);
}
