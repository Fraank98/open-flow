import { clipboard } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * How long to give the ⌘V keystroke before giving up. System Events can go
 * unresponsive on its own (observed in production logs as `media-control
 * pause failed` WARNs at the same instants) and an un-timed-out osascript
 * call then never resolves — the exec callback simply never fires, so
 * `inject()` never settles and PipelineCoordinator.finishWithAudio awaits it
 * forever with the overlay stuck on "Pasting…". 3000ms matches the timeout
 * already used for AppleScript calls in media-control.ts. On timeout (or an
 * external abort, see `signal` below) Node kills the child process itself —
 * that unwedges US, the pipeline and the overlay, so they recover instead of
 * hanging forever. It does NOT recall the keystroke. `osascript` hands the
 * Apple Event to System Events over its Mach port and then blocks waiting
 * for the reply; SIGTERM only kills that waiting sender, it cannot un-send
 * an event that is already sitting in System Events' queue. If System
 * Events was merely wedged and later comes back on its own, it can still
 * execute that queued ⌘V into whatever app happens to be focused by then —
 * confirmed experimentally (SIGSTOP System Events, timeout-kill an
 * osascript call mid-flight, SIGCONT System Events: the command still
 * runs). So this timeout buys back a stuck pipeline/overlay, not a
 * guarantee that the paste never lands; that hazard predates this fix and
 * is unchanged by it.
 */
export const PASTE_TIMEOUT_MS = 3000;

/**
 * How long to wait for the prior clipboard value (read via `pbpaste` in a
 * child process, see `readClipboard` below) before giving up on the restore.
 *
 * Why this exists: `clipboard.readText()` used to be called directly on
 * Electron's main thread. It is a synchronous AppKit call, and when the
 * general pasteboard holds a *promised* item whose owner never delivers
 * (observed in production: Xcode's DeviceHub/CoreDevice clipboard sync,
 * active whenever an iOS simulator is booted), that call blocks the WHOLE
 * main thread — Node event loop, IPC, NSEvent monitor, everything — for as
 * long as AppKit is willing to wait on the promise (observed: 49s, 120.001s,
 * 49.04s in production logs), with the overlay frozen on "Pasting…" and no
 * way to recover.
 *
 * The fix reads the clipboard out-of-process instead, bounded by OUR OWN
 * AbortController/timer rather than `execFile`'s `timeout` option: verified
 * experimentally (both under system Node and Electron's bundled Node) that
 * `timeout` sends SIGTERM and only settles the promise once the child
 * actually EXITS — a `pbpaste` wedged in Mach IPC on an undelivered
 * pasteboard promise may never exit, leaving the promise pending forever
 * (i.e. the exact bug this is fixing, just moved one process over).
 * `signal.abort()` on that same still-alive child settles the promise
 * IMMEDIATELY with an AbortError, child still running. So we always abort
 * ourselves at this deadline and treat the read as failed — the child is
 * left orphaned, parked in Mach IPC; that's acceptable, it is idle and macOS
 * reaps it eventually.
 *
 * Electron 44 made `clipboard.readText()` async too, but we keep `pbpaste`:
 * the async call still runs on the main process and offers no timeout of its
 * own.
 */
export const CLIPBOARD_READ_TIMEOUT_MS = 500;

/**
 * How long to wait for `clipboard.writeText()` to resolve. Since Electron 44
 * it returns a Promise ("resolves once the text has been written"), and like
 * the read it could in principle be stuck on the pasteboard. We never paste
 * before the transcript write has settled (⌘V would paste the OLD clipboard),
 * so the wait is bounded: a timeout on the transcript write means "do not
 * paste"; a timeout on the restore is only logged.
 */
export const CLIPBOARD_WRITE_TIMEOUT_MS = 1000;

class ClipboardWriteTimeoutError extends Error {
  constructor() {
    super("clipboard write timed out");
    this.name = "ClipboardWriteTimeoutError";
  }
}

/** Races a clipboard write against CLIPBOARD_WRITE_TIMEOUT_MS; the timer is always cleared. */
async function writeBounded(write: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ClipboardWriteTimeoutError()), CLIPBOARD_WRITE_TIMEOUT_MS);
  });
  try {
    await Promise.race([write, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface InjectorLogger {
  info(msg: string, meta?: Record<string, unknown>): unknown;
  warn(msg: string, meta?: Record<string, unknown>): unknown;
}

export interface InjectorDeps {
  // Resolves with the current clipboard text, or rejects (including on
  // abort) if it couldn't be read in time. Must respect `signal`: aborting
  // it has to settle the returned promise right away even if the read is
  // otherwise stuck (see CLIPBOARD_READ_TIMEOUT_MS above).
  readClipboard: (signal: AbortSignal) => Promise<string>;
  writeClipboard: (text: string) => Promise<void>;
  runPaste: (signal?: AbortSignal) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  logger: InjectorLogger;
}

export interface InjectResult {
  pasted: boolean;
  // True when the transcript reached the clipboard (so the user can still
  // paste it by hand after a failed ⌘V); false when the transcript write
  // itself failed or timed out and the clipboard still holds the user's OLD
  // content. Set on every return path.
  clipboardWritten: boolean;
  reason?: string;
  // Diagnostic properties lifted off the underlying error, when there is
  // one, so a log reader can tell apart a timeout kill (killed: true,
  // signal: "SIGTERM", code: null), a cancel-triggered abort (errorName:
  // "AbortError", code: "ABORT_ERR"), and a genuine silent non-zero exit
  // (none of the above set) instead of grepping the message string.
  killed?: boolean;
  signal?: string | null;
  code?: string | number | null;
  errorName?: string;
}

export class TextInjector {
  constructor(private readonly deps: InjectorDeps) {}

  async inject(text: string, signal?: AbortSignal): Promise<InjectResult> {
    // Read the prior clipboard off the main thread, bounded by our own
    // timeout (see CLIPBOARD_READ_TIMEOUT_MS). `prior` stays `null` — meaning
    // "unknown, do not restore" — unless the read genuinely succeeds in
    // time; that is distinct from a legitimately empty clipboard (`""`),
    // which IS restorable.
    const readController = new AbortController();
    let prior: string | null = null;
    // Log BEFORE starting the read timer, not after: logger.info is awaited
    // (it may do real I/O), and starting the timer first would let that
    // await eat into the CLIPBOARD_READ_TIMEOUT_MS budget before the read
    // even begins.
    await this.deps.logger.info("text-injector: reading prior clipboard before paste");
    const readTimer = setTimeout(() => readController.abort(), CLIPBOARD_READ_TIMEOUT_MS);
    try {
      prior = await this.deps.readClipboard(readController.signal);
    } catch (err) {
      // Covers our own timeout firing above as well as any other read
      // failure (pbpaste missing, non-zero exit, RTF/PS sniff rejection,
      // maxBuffer, ...). Either way we don't know the real prior value, so
      // `prior` stays null and the restore below is skipped — never clobber
      // the clipboard with a guess. Log the diagnostics (same shape lifted
      // off paste errors below) so production logs can tell a genuine
      // CLIPBOARD_READ_TIMEOUT_MS firing apart from ENOENT/non-zero-exit/
      // maxBuffer/sniff-rejection instead of all collapsing into one
      // indistinguishable "restorable: false".
      const diag = err as {
        killed?: boolean;
        signal?: string | null;
        code?: string | number | null;
      };
      await this.deps.logger.warn("text-injector: failed to read prior clipboard", {
        errorName: err instanceof Error ? err.name : undefined,
        code: diag?.code,
        killed: diag?.killed,
        signal: diag?.signal,
      });
      prior = null;
    } finally {
      clearTimeout(readTimer);
    }
    await this.deps.logger.info("text-injector: prior clipboard read settled", {
      restorable: prior !== null,
      stdoutLength: prior?.length,
    });

    try {
      await writeBounded(Promise.resolve(this.deps.writeClipboard(text)));
    } catch (err) {
      // The transcript never reached the clipboard: pressing ⌘V would paste the
      // user's OLD clipboard into the target app. Do not paste; nothing to restore.
      const message = err instanceof Error ? err.message : String(err);
      return {
        pasted: false,
        clipboardWritten: false,
        reason: err instanceof ClipboardWriteTimeoutError ? message : `clipboard write failed: ${message}`,
        errorName: err instanceof Error ? err.name : undefined,
      };
    }
    try {
      await this.deps.runPaste(signal);
    } catch (err) {
      // Leave text in clipboard so the user can paste manually. Covers both
      // a genuine paste failure and a timeout/abort kill — either way the
      // transcript must NOT be clobbered by restoring `prior`.
      const diag = err as {
        killed?: boolean;
        signal?: string | null;
        code?: string | number | null;
      };
      return {
        pasted: false,
        clipboardWritten: true,
        reason: err instanceof Error ? err.message : String(err),
        killed: diag?.killed,
        signal: diag?.signal,
        code: diag?.code,
        errorName: err instanceof Error ? err.name : undefined,
      };
    }
    if (prior !== null) {
      // Wait long enough for the receiving app to actually READ the
      // clipboard before we restore. `runPaste` resolves when the ⌘V event
      // has been SENT (osascript exits), not when the target app has
      // processed it. Slow receivers (Electron/Chromium with async paste
      // handlers, or any app while the system is under whisper+llama load)
      // can lag 100-300ms before reading the clipboard. With 150ms we'd
      // intermittently restore `prior` first → the app would then read it
      // and paste the OLD clipboard content instead of the transcript.
      // 500ms gives generous headroom; the user doesn't perceive the extra
      // latency because the original clipboard is already overwritten
      // anyway. Skipped entirely when `prior` is null — there is nothing to
      // restore, so there's no race to protect against.
      await this.deps.sleep(500);
      try {
        await writeBounded(Promise.resolve(this.deps.writeClipboard(prior)));
      } catch (err) {
        // A failed restore must not turn a successful paste into pasted:false.
        await this.deps.logger.warn("text-injector: failed to restore prior clipboard", {
          errorName: err instanceof Error ? err.name : undefined,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { pasted: true, clipboardWritten: true };
  }
}

export function createDefaultTextInjector(logger: InjectorLogger): TextInjector {
  return new TextInjector({
    readClipboard: async (signal) => {
      // `pbpaste` in a child process, NOT `clipboard.readText()` — see
      // CLIPBOARD_READ_TIMEOUT_MS for why the synchronous AppKit call is
      // unsafe here. `signal` is our own bounded-timeout controller from
      // `inject()`, not the paste-cancel signal.
      const { stdout } = await execFileP("/usr/bin/pbpaste", ["-Prefer", "txt"], {
        signal,
        // `man pbpaste`: the encoding pbpaste decodes its output with comes
        // from locale env vars, else the "standard C encoding" — NOT
        // guaranteed UTF-8. Verified experimentally: with no locale env (or
        // even `LANG=C.UTF-8 LC_ALL=C`, since LC_ALL always wins over LANG)
        // pbpaste emits MacRoman, which Node then silently mis-decodes as
        // UTF-8 (accented characters become mojibake, no error, exit 0).
        // `LC_ALL` specifically (not `LANG`) is required here because it
        // overrides every other locale variable, including a `LANG` the app
        // or its environment may already set.
        env: { ...process.env, LC_ALL: "en_US.UTF-8" },
        // Default is 1MB; a copied log/JSON blob can plausibly exceed that,
        // which would otherwise reject with ERR_CHILD_PROCESS_STDIO_MAXBUFFER
        // and silently skip the restore. The buffer only lives for
        // milliseconds and CLIPBOARD_READ_TIMEOUT_MS still bounds the read.
        maxBuffer: 32 * 1024 * 1024,
      });
      // `-Prefer txt` does NOT guarantee plain text back: per `man pbpaste`,
      // "pbpaste looks for the other formats if the preferred one is not
      // found", and under BUGS, "there is no way to tell pbpaste to get only
      // a specified data type". Verified experimentally against a genuinely
      // RTF-only pasteboard: both `pbpaste` and `pbpaste -Prefer txt` return
      // the raw `{\rtf1...` source. `clipboard.readText()` never had this
      // problem (Chromium calls `string(forType:.string)`, which is nil for
      // RTF-only, so it returned ""). Sniff and reject rather than restoring
      // markup as if it were plain text — this throws, which the caller
      // treats as "read failed", leaving `prior` null and skipping restore;
      // that's the correct degradation since we genuinely don't know the
      // plain-text value.
      if (stdout.startsWith("{\\rtf") || stdout.startsWith("%!PS")) {
        throw new Error("pbpaste returned non-plain-text clipboard data (RTF/PS)");
      }
      return stdout;
    },
    writeClipboard: (text) => clipboard.writeText(text),
    runPaste: async (signal) => {
      await execFileP(
        "/usr/bin/osascript",
        ["-e", `tell application "System Events" to keystroke "v" using command down`],
        { timeout: PASTE_TIMEOUT_MS, signal },
      );
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    logger,
  });
}
