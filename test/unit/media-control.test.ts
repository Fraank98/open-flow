import { describe, it, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import {
  MediaController,
  MediaScripter,
  KnownPlayer,
  KNOWN_PLAYERS,
  createDefaultScripter,
  isPgrepNoMatchError,
  parsePgrepOutput,
} from "../../src/main/media-control.js";

// Only the "createDefaultScripter (process integration)" describe block below
// touches real execFile (via the default, non-injected listRunningPlayers
// and run implementations) — every other test in this file drives
// createDefaultScripter/MediaController through injected fakes. The mock
// callback hands back a single `{ stdout, stderr }` object rather than two
// separate string args: node:util's generic promisify fallback resolves with
// just the callback's first non-error argument, so this shape is what
// execFileP (media-control.ts's promisified wrapper) actually receives —
// mirrors the same trick already used in test/unit/text-injector.test.ts.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: readonly string[],
      _options: unknown,
      callback: (err: unknown, result?: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: "", stderr: "" });
    },
  ),
}));

/**
 * Fake scripter — captures what the controller asks it to do without spawning
 * a real osascript process. The behavior under test is the controller's state
 * machine (pause/resume bookkeeping), not the AppleScript itself.
 */
function makeFakeScripter(playing: readonly string[] = []) {
  return {
    pauseRunningPlayers: vi.fn(async (): Promise<readonly string[]> => playing),
    resumePlayers: vi.fn(async (_apps: readonly string[]): Promise<void> => {}),
  };
}

describe("MediaController.pauseIfPlaying", () => {
  it("asks the scripter and remembers which apps it paused", async () => {
    const scripter: MediaScripter = makeFakeScripter(["Spotify"]);
    const m = new MediaController(scripter);
    await m.pauseIfPlaying();
    expect(scripter.pauseRunningPlayers).toHaveBeenCalledTimes(1);
  });

  it("does nothing else when no known app is playing", async () => {
    const scripter = makeFakeScripter([]); // scripter returns empty: nothing was playing
    const m = new MediaController(scripter);
    await m.pauseIfPlaying();
    expect(scripter.pauseRunningPlayers).toHaveBeenCalledTimes(1);
    // ...and resume on this state must be a no-op
    await m.resume();
    expect(scripter.resumePlayers).not.toHaveBeenCalled();
  });

  it("is idempotent — does not call the scripter again if already paused", async () => {
    const scripter = makeFakeScripter(["Spotify"]);
    const m = new MediaController(scripter);
    await m.pauseIfPlaying();
    await m.pauseIfPlaying();
    expect(scripter.pauseRunningPlayers).toHaveBeenCalledTimes(1);
  });

  it("supports multiple apps paused at once", async () => {
    const scripter = makeFakeScripter(["Spotify", "Music"]);
    const m = new MediaController(scripter);
    await m.pauseIfPlaying();
    await m.resume();
    expect(scripter.resumePlayers).toHaveBeenCalledWith(["Spotify", "Music"]);
  });
});

describe("MediaController.resume", () => {
  it("resumes only the apps we previously paused, then clears state", async () => {
    const scripter = makeFakeScripter(["Spotify"]);
    const m = new MediaController(scripter);
    await m.pauseIfPlaying();
    await m.resume();
    expect(scripter.resumePlayers).toHaveBeenCalledTimes(1);
    expect(scripter.resumePlayers).toHaveBeenCalledWith(["Spotify"]);
    // Calling resume again is a no-op
    await m.resume();
    expect(scripter.resumePlayers).toHaveBeenCalledTimes(1);
  });

  it("does nothing if we did not pause anything", async () => {
    const scripter = makeFakeScripter(["Spotify"]);
    const m = new MediaController(scripter);
    await m.resume(); // never paused
    expect(scripter.resumePlayers).not.toHaveBeenCalled();
  });

  it("survives a pause → resume → pause → resume sequence", async () => {
    const scripter = makeFakeScripter(["Spotify"]);
    const m = new MediaController(scripter);
    await m.pauseIfPlaying();
    await m.resume();
    await m.pauseIfPlaying();
    await m.resume();
    expect(scripter.pauseRunningPlayers).toHaveBeenCalledTimes(2);
    expect(scripter.resumePlayers).toHaveBeenCalledTimes(2);
  });
});

/**
 * These exercise the REAL osascript layer (createDefaultScripter) with both
 * the osascript runner AND the player-detection step injected, which the
 * fake-scripter tests above deliberately skip. This is where the "pressing
 * Option no longer pauses music" regression lived: a single combined
 * AppleScript that named both Spotify and Music. macOS compiles the whole
 * script before running it, so a `tell application "Spotify"` block fails to
 * compile when Spotify is not installed (its dictionary terms
 * `player state`/`playing` can't resolve) — taking the Music block down with
 * it even though Music was playing. The runtime `if spotifyRunning` guard
 * never got a chance to run.
 *
 * Detection itself used to be a `System Events` AppleScript too (`exists
 * process "X"`), which cost ~3.3s per absent player and blew the 3s osascript
 * timeout. It is now pgrep-based, injected here as `listRunningPlayers`, so
 * none of these tests spawn a real process, and the very first test below
 * asserts detection makes no osascript call at all.
 */
describe("createDefaultScripter (real osascript layer)", () => {
  it("detection issues no osascript call — only per-app pause scripts do", async () => {
    const run = vi.fn(async () => "");
    const listRunningPlayers = vi.fn(async (): Promise<readonly KnownPlayer[]> => []);
    const scripter = createDefaultScripter(run, listRunningPlayers);
    const paused = await scripter.pauseRunningPlayers();
    expect(paused).toEqual([]);
    expect(listRunningPlayers).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled(); // no players running, so no osascript at all
  });

  it("a running-but-not-playing player results in no paused apps", async () => {
    // Assertions on the script content live OUTSIDE this mock body, not
    // inside it: pauseRunningPlayers wraps `run` in try/catch, so a throw
    // from an `expect` in here would be swallowed by the SUT and this test
    // would pass regardless of what script was actually sent.
    const run = vi.fn(async (_script: string) => ""); // "player state is playing" was false; nothing echoed back
    const listRunningPlayers = vi.fn(async (): Promise<readonly KnownPlayer[]> => ["Music"]);
    const scripter = createDefaultScripter(run, listRunningPlayers);
    const paused = await scripter.pauseRunningPlayers();
    expect(paused).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.stringContaining('tell application "Music"'));
  });

  it("pauses a running player even when another player's script fails", async () => {
    const run = vi.fn(async (script: string) => {
      if (script.includes('"Spotify"')) throw new Error("221:226: syntax error (-2741)");
      if (script.includes('"Music"')) return "Music";
      return "";
    });
    const listRunningPlayers = vi.fn(async (): Promise<readonly KnownPlayer[]> => ["Spotify", "Music"]);
    const scripter = createDefaultScripter(run, listRunningPlayers);
    const paused = await scripter.pauseRunningPlayers();
    // Spotify's pause script blew up, but Music — which was playing — still got
    // paused. The old combined-script design would have returned nothing here.
    expect(paused).toEqual(["Music"]);
  });

  it("resumePlayers skips an app that is no longer running, and never runs a resume script for it", async () => {
    // As above: no `expect` inside this mock body — resumePlayers wraps
    // `run` in try/catch too, so an assertion failure in here would be
    // swallowed and this test would pass even if Spotify's resume script
    // were (wrongly) sent.
    const run = vi.fn(async (_script: string) => "");
    // Spotify quit between pause and resume; only Music is still running.
    const listRunningPlayers = vi.fn(async (): Promise<readonly KnownPlayer[]> => ["Music"]);
    const scripter = createDefaultScripter(run, listRunningPlayers);
    await scripter.resumePlayers(["Spotify", "Music"]);
    // Only Music should ever reach the osascript layer for resume.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.stringContaining('tell application "Music"'));
  });

  it("resumePlayers resolves (never rejects) when detection fails, and runs no resume script", async () => {
    // Why resolving matters: MediaController.resume clears this.pausedApps
    // BEFORE awaiting the scripter (see media-control.ts). By the time
    // resumePlayers runs, that state is already gone — so if this rejected,
    // there would be no retry path and the user's music would stay paused
    // forever. resumePlayers must swallow a detection failure, not propagate it.
    const run = vi.fn(async (_script: string) => "");
    const listRunningPlayers = vi.fn(async (): Promise<readonly KnownPlayer[]> => {
      throw new Error("spawn EAGAIN");
    });
    const scripter = createDefaultScripter(run, listRunningPlayers);
    await expect(scripter.resumePlayers(["Music"])).resolves.toBeUndefined();
    // Detection failed, so liveness is unknown for every app — skipping is
    // the only safe choice, since running the script anyway risks relaunching
    // a player that has since quit.
    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * The pgrep parsing/error-classification layer used by the default
 * (non-injected) detection implementation. Exported as pure functions so
 * they're testable without spawning a real pgrep process.
 */
describe("pgrep-based detection (parsing layer)", () => {
  it("parses '<pid> <name>' lines into known player names", () => {
    expect(parsePgrepOutput("15293 Music\n42 Spotify\n")).toEqual(["Music", "Spotify"]);
  });

  it("filters out names pgrep matched that are not known players", () => {
    // Defense in depth: even if the pgrep pattern ever widened, only
    // KNOWN_PLAYERS names should ever come back.
    expect(parsePgrepOutput("100 Music\n200 SomeOtherApp\n")).toEqual(["Music"]);
  });

  it("treats empty output as nothing running", () => {
    expect(parsePgrepOutput("")).toEqual([]);
    expect(parsePgrepOutput("\n")).toEqual([]);
  });

  it("treats pgrep exit code 1 as 'nothing running', not an error", () => {
    const noMatchError = Object.assign(new Error("Command failed"), { code: 1 });
    expect(isPgrepNoMatchError(noMatchError)).toBe(true);
  });

  it("does not misclassify other execFile failures as 'nothing running'", () => {
    const spawnError = Object.assign(new Error("spawn pgrep ENOENT"), { code: "ENOENT" });
    const exitCode2 = Object.assign(new Error("Command failed"), { code: 2 });
    expect(isPgrepNoMatchError(spawnError)).toBe(false);
    expect(isPgrepNoMatchError(exitCode2)).toBe(false);
    expect(isPgrepNoMatchError(new Error("plain error"))).toBe(false);
  });
});

/**
 * Pins the actual pgrep invocation (via the mocked node:child_process at the
 * top of this file) that the default, non-injected detection implementation
 * makes. Nothing above this point exercises it — every other test injects
 * `listRunningPlayers` directly. A regression where someone drops `-x` or
 * `-U` (see the doc comment on listRunningPlayersViaPgrep for why both
 * matter) would keep every other test in this file green.
 */
describe("createDefaultScripter (process integration)", () => {
  it("invokes pgrep with the exact required argv, and a {code:1} rejection yields no running players", async () => {
    const mockedExecFile = vi.mocked(execFile);
    mockedExecFile.mockImplementationOnce(((..._args: unknown[]) => {
      const callback = _args[_args.length - 1] as (err: unknown) => void;
      callback(Object.assign(new Error("Command failed"), { code: 1 }));
    }) as typeof execFile);

    const scripter = createDefaultScripter();
    const paused = await scripter.pauseRunningPlayers();

    expect(paused).toEqual([]);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile).toHaveBeenCalledWith(
      "pgrep",
      ["-xl", "-U", String(process.getuid!()), "Spotify|Music"],
      expect.objectContaining({ timeout: 1000 }),
      expect.any(Function),
    );
  });

  it("propagates a pgrep spawn failure (ENOENT) rather than swallowing it as 'nothing running'", async () => {
    const mockedExecFile = vi.mocked(execFile);
    mockedExecFile.mockImplementationOnce(((..._args: unknown[]) => {
      const callback = _args[_args.length - 1] as (err: unknown) => void;
      callback(Object.assign(new Error("spawn pgrep ENOENT"), { code: "ENOENT" }));
    }) as typeof execFile);

    const scripter = createDefaultScripter();
    await expect(scripter.pauseRunningPlayers()).rejects.toThrow("ENOENT");
  });
});

/**
 * `pgrep -x` matches against the kernel's `p_comm`, truncated to 15
 * characters, and KNOWN_PLAYERS is joined with `|` and handed to pgrep as an
 * extended regular expression (see the doc comment on KNOWN_PLAYERS). This
 * guards both properties directly against the real list, so it fails the
 * moment someone adds an entry that would silently never match.
 */
describe("KNOWN_PLAYERS", () => {
  it("has no entry over pgrep's 15-character p_comm limit", () => {
    for (const player of KNOWN_PLAYERS) {
      expect(player.length).toBeLessThanOrEqual(15);
    }
  });

  it("has no entry containing an extended-regex metacharacter", () => {
    // The list is joined with "|" into a single pgrep -x pattern, so any of
    // these would change what the pattern matches instead of being taken
    // literally.
    const ereMetacharacters = /[.^$*+?()[\]{}|\\]/;
    for (const player of KNOWN_PLAYERS) {
      expect(player).not.toMatch(ereMetacharacters);
    }
  });
});
