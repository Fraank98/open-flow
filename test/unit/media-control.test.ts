import { describe, it, expect, vi } from "vitest";
import { MediaController, MediaScripter, createDefaultScripter } from "../../src/main/media-control.js";

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
 * These exercise the REAL osascript layer (createDefaultScripter) with the
 * osascript runner injected, which the fake-scripter tests above deliberately
 * skip. This is where the "pressing Option no longer pauses music" regression
 * lived: a single combined AppleScript that named both Spotify and Music. macOS
 * compiles the whole script before running it, so a `tell application "Spotify"`
 * block fails to compile when Spotify is not installed (its dictionary terms
 * `player state`/`playing` can't resolve) — taking the Music block down with it
 * even though Music was playing. The runtime `if spotifyRunning` guard never got
 * a chance to run.
 */
describe("createDefaultScripter (real osascript layer)", () => {
  it("detects running players with a script that touches no app dictionary", async () => {
    const run = vi.fn(async (script: string) => {
      // The detection script must compile regardless of which players are
      // installed, so it may only talk to System Events — never an app whose
      // dictionary might be absent.
      expect(script).not.toContain("player state");
      expect(script).not.toContain('tell application "Spotify"');
      expect(script).not.toContain('tell application "Music"');
      return "";
    });
    const scripter = createDefaultScripter(run);
    await scripter.pauseRunningPlayers();
    expect(run).toHaveBeenCalledTimes(1); // detection only; nothing running
  });

  it("pauses a running player even when another player's script fails", async () => {
    const run = vi.fn(async (script: string) => {
      if (!script.includes("player state")) return "Spotify,Music"; // detection
      if (script.includes('"Spotify"')) throw new Error("221:226: syntax error (-2741)");
      if (script.includes('"Music"')) return "Music";
      return "";
    });
    const scripter = createDefaultScripter(run);
    const paused = await scripter.pauseRunningPlayers();
    // Spotify's pause script blew up, but Music — which was playing — still got
    // paused. The old combined-script design would have returned nothing here.
    expect(paused).toEqual(["Music"]);
  });

  it("never asks an app to pause when no known player is running", async () => {
    const run = vi.fn(async () => ""); // detection returns empty
    const scripter = createDefaultScripter(run);
    const paused = await scripter.pauseRunningPlayers();
    expect(paused).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1); // only the detection round-trip
  });
});
