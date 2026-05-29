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
 * One AppleScript that checks each KNOWN_PLAYERS app's `player state`, pauses
 * the ones that are playing, and emits a comma-separated list of paused names
 * on stdout. Single osascript spawn per arm.
 *
 * Process check via System Events (not AppleScript's `application "X" is
 * running`): the latter can return true for background helpers/daemons like
 * `com.apple.Music.MusicLibraryService`, causing `tell application "Music"`
 * to launch the GUI app — which on a fresh user pops the library-setup
 * prompt. `exists process "X"` looks at the visible process list (Activity
 * Monitor's Applications section), so only a real GUI presence counts.
 */
const PAUSE_SCRIPT = `
tell application "System Events"
  set spotifyRunning to (exists process "Spotify")
  set musicRunning to (exists process "Music")
end tell
set out to ""
if spotifyRunning then
  tell application "Spotify"
    if player state is playing then
      pause
      set out to out & "Spotify"
    end if
  end tell
end if
if musicRunning then
  tell application "Music"
    if player state is playing then
      pause
      if out is not "" then set out to out & ","
      set out to out & "Music"
    end if
  end tell
end if
return out
`;

function buildResumeScript(apps: readonly string[]): string {
  const safeApps = apps.filter((a) => (KNOWN_PLAYERS as readonly string[]).includes(a));
  if (safeApps.length === 0) return "";
  // Same process-check rationale as PAUSE_SCRIPT: skip apps whose GUI is not
  // actually open, so resume never accidentally launches a quit player.
  const checks = safeApps
    .map((a) => `  set ${a.toLowerCase()}Running to (exists process "${a}")`)
    .join("\n");
  const tells = safeApps
    .map(
      (a) =>
        `if ${a.toLowerCase()}Running then tell application "${a as KnownPlayer}" to play`,
    )
    .join("\n");
  return `tell application "System Events"\n${checks}\nend tell\n${tells}`;
}

async function runOsa(script: string): Promise<string> {
  const { stdout } = await execFileP("osascript", ["-e", script], { timeout: 3000 });
  return stdout.trim();
}

/** Default scripter that shells out to /usr/bin/osascript. */
export function createDefaultScripter(): MediaScripter {
  return {
    async pauseRunningPlayers(): Promise<readonly string[]> {
      const out = await runOsa(PAUSE_SCRIPT);
      if (!out) return [];
      return out
        .split(",")
        .map((s) => s.trim())
        .filter((s) => (KNOWN_PLAYERS as readonly string[]).includes(s));
    },
    async resumePlayers(apps: readonly string[]): Promise<void> {
      const script = buildResumeScript(apps);
      if (!script) return;
      await runOsa(script);
    },
  };
}
