import { describe, it, expect, vi } from "vitest";
import { MediaController } from "../../src/main/media-control.js";

function makeFakeNative(isRunning: boolean) {
  return {
    isAudioOutputRunning: vi.fn(() => isRunning),
    postMediaPlayPause: vi.fn(),
  };
}

describe("MediaController.pauseIfPlaying", () => {
  it("posts a media key when audio output is running", () => {
    const native = makeFakeNative(true);
    new MediaController(native).pauseIfPlaying();
    expect(native.postMediaPlayPause).toHaveBeenCalledTimes(1);
  });

  it("does nothing when nothing is playing", () => {
    const native = makeFakeNative(false);
    new MediaController(native).pauseIfPlaying();
    expect(native.postMediaPlayPause).not.toHaveBeenCalled();
  });

  it("is idempotent — never double-pauses", () => {
    const native = makeFakeNative(true);
    const m = new MediaController(native);
    m.pauseIfPlaying();
    m.pauseIfPlaying();
    expect(native.postMediaPlayPause).toHaveBeenCalledTimes(1);
  });
});

describe("MediaController.resume", () => {
  it("posts a media key after a successful pause", () => {
    const native = makeFakeNative(true);
    const m = new MediaController(native);
    m.pauseIfPlaying();
    m.resume();
    expect(native.postMediaPlayPause).toHaveBeenCalledTimes(2);
  });

  it("does nothing if we did not pause anything", () => {
    const native = makeFakeNative(true);
    new MediaController(native).resume();
    expect(native.postMediaPlayPause).not.toHaveBeenCalled();
  });

  it("does not double-resume — only the first resume after a pause fires", () => {
    const native = makeFakeNative(true);
    const m = new MediaController(native);
    m.pauseIfPlaying();
    m.resume();
    m.resume();
    expect(native.postMediaPlayPause).toHaveBeenCalledTimes(2);
  });
});
