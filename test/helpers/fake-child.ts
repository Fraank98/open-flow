import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { vi, type Mock } from "vitest";

export type FakeChild = ChildProcess & {
  stderr: EventEmitter;
  kill: Mock<(signal?: NodeJS.Signals | number) => boolean>;
};

/**
 * Minimal ChildProcess stand-in: an emitter (for "exit"), a stderr emitter and
 * a recording kill(). The one cast lives here so tests stay cast-free.
 */
export function fakeChild(): FakeChild {
  const c = new EventEmitter() as unknown as FakeChild;
  (c as { stderr: EventEmitter }).stderr = new EventEmitter();
  c.kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);
  return c;
}
