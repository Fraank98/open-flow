import { describe, it, expect, vi } from "vitest";
import { MediaController, MediaScripter } from "../../src/main/media-control.js";

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
