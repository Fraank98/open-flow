import { formatGigabytes } from "./format-bytes.js";
import { InsufficientSpaceError } from "./disk-space.js";

export interface DownloadErrorInfo {
  title: string;
  hint: string;
  retryable: boolean;
  code: string;
}

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string") return e.code;
  return e.cause ? codeOf(e.cause) : undefined;
}

/**
 * Turns a download failure into UI-safe text. Raw messages (URLs, 64-char
 * hashes) never reach the UI except through the generic fallback hint, which
 * is stripped of anything that looks like a hash or URL.
 */
export function describeDownloadError(err: unknown): DownloadErrorInfo {
  if (err instanceof InsufficientSpaceError) {
    return {
      title: "Not enough disk space",
      hint: `You need ${formatGigabytes(err.needBytes)} free but only ${formatGigabytes(err.haveBytes)} is available. Free up space and try again.`,
      retryable: true,
      code: "no-space",
    };
  }
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === "AbortError") {
    return { title: "Download paused", hint: "", retryable: true, code: "aborted" };
  }
  const code = codeOf(err);
  if (code === "ENOSPC") {
    return {
      title: "Not enough disk space",
      hint: "Free up some space on this Mac and try again.",
      retryable: true,
      code: "no-space",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if ((code && NETWORK_CODES.has(code)) || /^fetch failed$/i.test(message)) {
    return {
      title: "No internet connection",
      hint: "Check your network and try again. Downloads resume where they left off.",
      retryable: true,
      code: "network",
    };
  }
  const http = /^HTTP (\d{3})\b/.exec(message);
  if (http) {
    const status = Number(http[1]);
    if (status === 503 || status === 429) {
      return {
        title: `The model server is busy (HTTP ${status})`,
        hint: "Try again in a few minutes.",
        retryable: true,
        code: "server-busy",
      };
    }
    if (status === 404 || status === 403) {
      return {
        title: `Model not found at its download address (HTTP ${status})`,
        hint: "This is an open-flow bug — please report it on GitHub.",
        retryable: false,
        code: "not-found",
      };
    }
  }
  if (/sha256 mismatch|size mismatch/i.test(message)) {
    return {
      title: "The download was corrupted",
      hint: "Trying again usually fixes it.",
      retryable: true,
      code: "corrupt",
    };
  }
  const safe = message.replace(/[0-9a-f]{64}/gi, "…").replace(/https?:\/\/\S+/g, "…");
  return { title: "Download failed", hint: safe, retryable: true, code: "unknown" };
}

/** One-line form for UI surfaces that only take a string. */
export function downloadErrorText(err: unknown): string {
  const { title, hint } = describeDownloadError(err);
  return hint ? `${title}. ${hint}` : title;
}
