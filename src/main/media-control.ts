import { createRequire } from "node:module";
import { join } from "node:path";

export interface MediaControlNative {
  /** Returns true iff the system default output device is currently being
   *  driven by any process (i.e. some app is playing audio). */
  isAudioOutputRunning: () => boolean;
  /** Post a system Play/Pause media key event — toggles whatever the OS
   *  considers the current Now Playing app. */
  postMediaPlayPause: () => void;
}

/**
 * Loads the audio-control exports from the ptt_monitor native addon. The two
 * functions live there (rather than in their own .node) because that addon
 * already handles system event work and avoids a second native target.
 */
export function loadMediaControlNative(appRoot: string, isPackaged: boolean): MediaControlNative {
  const require_ = createRequire(import.meta.url);
  const candidates = isPackaged
    ? [
        join(appRoot, "..", "app.asar.unpacked", "build", "Release", "ptt_monitor.node"),
        join(appRoot, "build", "Release", "ptt_monitor.node"),
      ]
    : [join(appRoot, "build", "Release", "ptt_monitor.node")];
  let lastErr: unknown = null;
  for (const path of candidates) {
    try {
      const addon = require_(path) as Record<string, unknown>;
      if (typeof addon.isAudioOutputRunning !== "function" ||
          typeof addon.postMediaPlayPause !== "function") {
        throw new Error(
          "ptt_monitor.node is missing media-control exports — rebuild the native addon",
        );
      }
      return {
        isAudioOutputRunning: addon.isAudioOutputRunning as () => boolean,
        postMediaPlayPause: addon.postMediaPlayPause as () => void,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not load media-control native. Tried: ${candidates.join(", ")}. ` +
    `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/**
 * Pauses other media when dictation starts and resumes it when the pipeline
 * ends. Single piece of state (`pausedByUs`) makes both methods idempotent
 * and ensures we never resume something we did not pause.
 */
export class MediaController {
  private pausedByUs = false;

  constructor(private readonly native: MediaControlNative) {}

  pauseIfPlaying(): void {
    if (this.pausedByUs) return;
    if (!this.native.isAudioOutputRunning()) return;
    this.native.postMediaPlayPause();
    this.pausedByUs = true;
  }

  resume(): void {
    if (!this.pausedByUs) return;
    this.native.postMediaPlayPause();
    this.pausedByUs = false;
  }
}
