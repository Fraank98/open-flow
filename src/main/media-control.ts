import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * The system media play/pause key (NX_KEYTYPE_PLAY) used to be how we paused
 * other audio. It was wrong: that key is a TOGGLE, and `kAudioDevicePropertyDeviceIsRunningSomewhere`
 * is not a reliable proxy for "audio is audibly playing" — Spotify and Apple
 * Music hold their audio session open for minutes after pause to enable
 * instant resume. So a user who had manually paused music would press PTT and
 * see the toggle FLIP music back on. We now talk to the specific players via
 * AppleScript and check `player state is playing` first, so we never toggle
 * blindly.
 */

/** The macOS apps we know how to pause/resume via AppleScript. Keeping this
 *  closed prevents AppleScript injection from the resumePlayers argument.
 *
 *  Every entry must be <=15 characters: detection runs `pgrep -x`, which
 *  matches against the kernel's `p_comm`, itself truncated to 15 characters
 *  (real examples on this machine: `AdaptiveMusicCo`, `MusicRecognitio`). A
 *  player whose binary name is 16+ characters — e.g. `QuickTime Player` —
 *  can never match `-x` and would silently never be detected or paused. Every
 *  entry must also avoid ERE metacharacters, since the list is joined with
 *  `|` and passed to pgrep as an extended regular expression. */
export const KNOWN_PLAYERS = ["Spotify", "Music"] as const;
export type KnownPlayer = (typeof KNOWN_PLAYERS)[number];

/** Side-effecting runner — the thing the controller delegates to for both the
 *  per-app AppleScript pause/resume calls and pgrep-based player detection.
 *  Injected so tests can verify the controller's bookkeeping without spawning
 *  osascript or pgrep. */
export interface MediaScripter {
  /** Pauses every KNOWN_PLAYERS app whose `player state` is currently
   *  `playing` and returns the names of the apps that were paused. Apps not
   *  running are silently skipped (we never launch an app to pause it). */
  pauseRunningPlayers(): Promise<readonly string[]>;
  /** Resumes the given apps. Best-effort; apps that have since quit are
   *  skipped. The caller is responsible for passing only names previously
   *  returned by pauseRunningPlayers. */
  resumePlayers(apps: readonly string[]): Promise<void>;
}

/**
 * Pauses known media players when dictation starts and resumes them when the
 * pipeline ends. Tracks which apps it paused so resume only acts on those —
 * never resumes something it did not pause. Idempotent on both methods.
 */
export class MediaController {
  private pausedApps: readonly string[] = [];

  constructor(private readonly scripter: MediaScripter) {}

  async pauseIfPlaying(): Promise<void> {
    if (this.pausedApps.length > 0) return;
    this.pausedApps = await this.scripter.pauseRunningPlayers();
  }

  async resume(): Promise<void> {
    if (this.pausedApps.length === 0) return;
    const apps = this.pausedApps;
    this.pausedApps = [];
    await this.scripter.resumePlayers(apps);
  }
}

/** Memoized uid, filled in lazily by currentUid() below. Not computed at
 *  module load — see that function's comment for why. */
let cachedUid: number | undefined;

/** The current user's uid, used to scope pgrep to this user's processes only
 *  (see listRunningPlayersViaPgrep below). Deliberately NOT a module-level
 *  constant: src/main/index.ts statically imports this module, so a throw
 *  at module-eval time (e.g. no POSIX getuid() on this platform) would fail
 *  the whole app's launch instead of merely losing the pause feature. Doing
 *  the lookup lazily, inside the caller's existing try/catch, keeps that
 *  failure contained to "continue without audio pause" — the correct
 *  degradation, handled by swallowMcError("pause") in index.ts. It cannot
 *  change during the process's lifetime, so it's still safe to memoize once
 *  computed; this app is macOS-only, so the throw path never fires in
 *  practice. */
function currentUid(): number {
  if (cachedUid !== undefined) return cachedUid;
  const getuid = process.getuid;
  if (!getuid) throw new Error("pgrep-based media detection requires a POSIX getuid()");
  cachedUid = getuid();
  return cachedUid;
}

/**
 * This never touches a player's own scripting dictionary — the pause/resume
 * `tell` blocks below are still the only place we do that. macOS compiles an
 * AppleScript in full before running it, so a `tell application "Spotify"`
 * block fails to *compile* (not just fail at runtime) when Spotify is not
 * installed: the terms `player state`/`playing` can't resolve, raising error
 * -2741. The old design put both players' tell-blocks in one combined
 * script, so an absent Spotify took the Music block down with it and nothing
 * got paused even while Music was playing. By generating an app's tell-block
 * only after we know that app is running (below), every tell-block we ever
 * compile is backed by a loadable dictionary.
 *
 * Detection is `pgrep -xl -U <uid>`, not AppleScript's `application "X" is
 * running` or a System Events `exists process` check (the latter, via
 * `osascript`, costs ~3.3s when the queried app is NOT running, while
 * `pgrep` costs ~20ms regardless). Two properties of the invocation matter
 * and must be kept:
 *  - `-x` (exact match on the process' command name) so a background
 *    helper/daemon like `com.apple.Music.MusicLibraryService` does not match
 *    `Music`. AppleScript's `application "X" is running` does match such
 *    helpers, which would cause `tell application "Music"` to launch the GUI
 *    app — which on a fresh user pops the library-setup prompt. `-x` narrows
 *    matches to the real GUI process (verified: the only match for `Music`
 *    is `/System/Applications/Music.app/Contents/MacOS/Music`).
 *  - `-U <uid>` (current user only) so fast-user-switching does not surface
 *    another user's running player, which would make us `tell application
 *    "Music"` in a session where it isn't actually running for this user —
 *    launching it. Bare `pgrep` sees other users' processes.
 *
 * `pgrep` exits 1 (no stdout) when nothing matches. That is normal — not an
 * error — and is handled below by treating exit code 1 as "no players
 * running".
 */
async function listRunningPlayersViaPgrep(): Promise<readonly KnownPlayer[]> {
  try {
    const { stdout } = await execFileP(
      "pgrep",
      ["-xl", "-U", String(currentUid()), KNOWN_PLAYERS.join("|")],
      { timeout: 1000 },
    );
    return parsePgrepOutput(stdout);
  } catch (err) {
    if (isPgrepNoMatchError(err)) return [];
    throw err;
  }
}

/** pgrep exits 1 (and prints nothing) when no process matches — that is a
 *  normal "nothing running" result, not a failure. execFile rejects on any
 *  nonzero exit code, so callers must check this before treating a pgrep
 *  rejection as an error. Exported for direct unit testing (see
 *  media-control.test.ts) since the default pgrep implementation itself is
 *  not injectable — only its result-producing wrapper (listRunningPlayers) is. */
export function isPgrepNoMatchError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === 1;
}

/** Parses `pgrep -xl` output ("<pid> <name>" per line) into KNOWN_PLAYERS
 *  names, dropping anything pgrep matched that isn't one of ours. Exported
 *  for direct unit testing alongside isPgrepNoMatchError. */
export function parsePgrepOutput(stdout: string): readonly KnownPlayer[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Each line is "<pid> <name>" (from -l); the name is everything after the
    // first space.
    .map((line) => line.slice(line.indexOf(" ") + 1).trim())
    .filter(isKnownPlayer);
}

/** Self-contained pause script for ONE app. Only ever built for an app already
 *  confirmed running, so its `tell` block always compiles. Echoes the app name
 *  on stdout iff it was playing and got paused. */
function buildPauseScript(app: KnownPlayer): string {
  return `tell application "${app}"
  if player state is playing then
    pause
    return "${app}"
  end if
end tell
return ""`;
}

/** Self-contained resume script for ONE app. Same compile-safety contract as
 *  buildPauseScript: only call for an app known to be running. Callers must
 *  check liveness themselves (via listRunningPlayers) before calling this —
 *  see resumePlayers below — so resume never relaunches a closed player. */
function buildResumeScript(app: KnownPlayer): string {
  return `tell application "${app}" to play`;
}

async function runOsa(script: string): Promise<string> {
  const { stdout } = await execFileP("osascript", ["-e", script], { timeout: 3000 });
  return stdout.trim();
}

function isKnownPlayer(s: string): s is KnownPlayer {
  return (KNOWN_PLAYERS as readonly string[]).includes(s);
}

/**
 * Default scripter that shells out to /usr/bin/osascript for the per-app
 * pause/resume `tell` blocks, and to pgrep for detecting which players are
 * running. Both are injectable so the per-app fault-isolation logic and the
 * detection layer can be unit-tested without spawning real processes (see
 * media-control.test.ts).
 */
export function createDefaultScripter(
  run: (script: string) => Promise<string> = runOsa,
  listRunningPlayers: () => Promise<readonly KnownPlayer[]> = listRunningPlayersViaPgrep,
): MediaScripter {
  return {
    async pauseRunningPlayers(): Promise<readonly string[]> {
      const running = await listRunningPlayers();
      const paused: string[] = [];
      // One osascript spawn per running player. Each is isolated: if one app's
      // script throws (Automation denied, timeout, a dictionary hiccup), the
      // others still get paused — the whole point of dropping the combined
      // script. Sequential, but this is fire-and-forget and never blocks the
      // dictation pipeline (at most KNOWN_PLAYERS.length + 1 spawns: one
      // pgrep detection call, plus one osascript per running player).
      for (const app of running) {
        try {
          const out = await run(buildPauseScript(app));
          if (out.trim() === app) paused.push(app);
        } catch {
          // best-effort: a failure here must not stop us pausing other players
        }
      }
      return paused;
    },
    async resumePlayers(apps: readonly string[]): Promise<void> {
      let running: ReadonlySet<string>;
      try {
        running = new Set(await listRunningPlayers());
      } catch {
        // Best-effort, per the MediaScripter contract: a detection failure
        // here (spawn EAGAIN under process pressure, ENOMEM, a signal kill)
        // must not make resumePlayers reject. Skipping the resume is always
        // safe — it never relaunches a player that quit — even though it
        // means the paused apps stay paused until the user resumes them by
        // hand. There is no retry path, and deliberately no logging here:
        // this module stays dependency-free (no logger import), and
        // `console.warn` from Electron's main process in a packaged app
        // goes to a stdout nobody reads — it would only give the appearance
        // of observability. Real visibility already exists one layer up:
        // pauseRunningPlayers failures surface through the rejected promise
        // and swallowMcError("pause")/("resume") in index.ts, which logs via
        // logger.ts. This path can't use that route without also making
        // resumePlayers reject, which would break the "always safe to call"
        // contract above — so a real spike in detection failures here is
        // currently invisible unless the caller adds a signal of its own.
        return;
      }
      for (const app of apps) {
        if (!isKnownPlayer(app) || !running.has(app)) continue;
        try {
          await run(buildResumeScript(app));
        } catch {
          // best-effort: an app may have quit between pause and resume
        }
      }
    },
  };
}
