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
 *  closed prevents AppleScript injection from the resumePlayers argument. */
const KNOWN_PLAYERS = ["Spotify", "Music"] as const;
type KnownPlayer = (typeof KNOWN_PLAYERS)[number];

/** Side-effecting AppleScript runner — the thing the controller delegates to.
 *  Injected so tests can verify the controller's bookkeeping without spawning
 *  osascript. */
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

/**
 * Detect which KNOWN_PLAYERS are running. CRITICAL: this script talks ONLY to
 * System Events — it never names a player's scripting dictionary. macOS compiles
 * an AppleScript in full before running it, so a `tell application "Spotify"`
 * block fails to *compile* (not just fail at runtime) when Spotify is not
 * installed: the terms `player state`/`playing` can't resolve, raising error
 * -2741. The old design put both players' tell-blocks in one combined script, so
 * an absent Spotify took the Music block down with it and nothing got paused
 * even while Music was playing. By generating an app's tell-block only after we
 * know that app is running (below), every tell-block we ever compile is backed
 * by a loadable dictionary.
 *
 * Process check via System Events (not AppleScript's `application "X" is
 * running`): the latter can return true for background helpers/daemons like
 * `com.apple.Music.MusicLibraryService`, causing `tell application "Music"`
 * to launch the GUI app — which on a fresh user pops the library-setup
 * prompt. `exists process "X"` looks at the visible process list (Activity
 * Monitor's Applications section), so only a real GUI presence counts.
 */
function buildRunningPlayersScript(): string {
  const checks = KNOWN_PLAYERS.map((a) => `  if (exists process "${a}") then set out to out & "${a},"`).join(
    "\n",
  );
  return `tell application "System Events"\n  set out to ""\n${checks}\nend tell\nreturn out`;
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
 *  buildPauseScript: only call for an app known to be running. The System
 *  Events guard skips apps whose GUI has since quit, so resume never relaunches
 *  a closed player. */
function buildResumeScript(app: KnownPlayer): string {
  return `tell application "System Events"
  set isRunning to (exists process "${app}")
end tell
if isRunning then tell application "${app}" to play`;
}

async function runOsa(script: string): Promise<string> {
  const { stdout } = await execFileP("osascript", ["-e", script], { timeout: 3000 });
  return stdout.trim();
}

function isKnownPlayer(s: string): s is KnownPlayer {
  return (KNOWN_PLAYERS as readonly string[]).includes(s);
}

/**
 * Default scripter that shells out to /usr/bin/osascript. The osascript runner
 * is injectable so the per-app fault-isolation logic can be unit-tested without
 * spawning real processes (see media-control.test.ts).
 */
export function createDefaultScripter(run: (script: string) => Promise<string> = runOsa): MediaScripter {
  return {
    async pauseRunningPlayers(): Promise<readonly string[]> {
      const detected = await run(buildRunningPlayersScript());
      const running = detected
        .split(",")
        .map((s) => s.trim())
        .filter(isKnownPlayer);
      const paused: string[] = [];
      // One osascript spawn per running player. Each is isolated: if one app's
      // script throws (Automation denied, timeout, a dictionary hiccup), the
      // others still get paused — the whole point of dropping the combined
      // script. Sequential, but this is fire-and-forget and never blocks the
      // dictation pipeline (at most KNOWN_PLAYERS.length spawns).
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
      for (const app of apps) {
        if (!isKnownPlayer(app)) continue;
        try {
          await run(buildResumeScript(app));
        } catch {
          // best-effort: an app may have quit between pause and resume
        }
      }
    },
  };
}
