export interface TrackedProgress {
  bytes: number;
  total: number;
}

interface ActiveDownload {
  abort: AbortController;
  promise: Promise<void>;
  progress: TrackedProgress | null;
}

/**
 * Downloads in flight, by model id. A second `start` for an id already running
 * returns the SAME promise instead of returning at once, so a caller that
 * attaches late (the Settings window closed and reopened mid-download) waits
 * for the real end and doesn't mistake "already running" for "done". Also keeps
 * the last progress so a reopened window can draw the card where it was.
 */
export class DownloadTracker {
  private readonly active = new Map<string, ActiveDownload>();

  start(
    id: string,
    run: (signal: AbortSignal, report: (p: TrackedProgress) => void) => Promise<void>,
  ): Promise<void> {
    const running = this.active.get(id);
    if (running) return running.promise;
    const abort = new AbortController();
    const entry: ActiveDownload = { abort, promise: Promise.resolve(), progress: null };
    this.active.set(id, entry);
    entry.promise = run(abort.signal, (p) => {
      entry.progress = p;
    }).finally(() => {
      if (this.active.get(id) === entry) this.active.delete(id);
    });
    return entry.promise;
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  progress(id: string): TrackedProgress | null {
    return this.active.get(id)?.progress ?? null;
  }

  cancel(id: string): void {
    this.active.get(id)?.abort.abort();
  }
}
