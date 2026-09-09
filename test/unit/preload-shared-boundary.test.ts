import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IpcChannels } from "../../src/shared/ipc-channels.js";

/**
 * Guards the fix for a packaged-app startup crash: preload scripts compile to
 * CommonJS (tsconfig.preload.json) while the rest of the app is ESM
 * ("type": "module" + main built as ESM). src/shared/**\/*.ts used to be
 * compiled a second time — as CommonJS — into the same dist/shared/*.js path
 * that dist/main already emitted as ESM, and whichever build step ran last
 * won on disk. A runtime import of ../shared from a preload file (or an
 * "include" glob that drags src/shared into the preload tsconfig) makes that
 * corruption possible again, and Node fails at app launch with
 * "SyntaxError: The requested module '../shared/...' does not provide an
 * export named '...'". See build-fix-report.md
 * (.superpowers/sdd/2026-09-08-context-reply-suggestions-plan-b/) for the
 * full incident. Vitest exercises the TypeScript sources directly and never
 * touches the compiled dist/ bundle, so nothing else in the suite would have
 * caught this — these tests read the preload sources as text instead.
 */

const PRELOAD_DIR = join(process.cwd(), "src", "preload");

function preloadFiles(): string[] {
  return readdirSync(PRELOAD_DIR).filter((f) => f.endsWith(".ts"));
}

describe("preload / shared module boundary", () => {
  it("has at least one preload source file to check", () => {
    expect(preloadFiles().length).toBeGreaterThan(0);
  });

  for (const file of preloadFiles()) {
    it(`${file} does not import ../shared at runtime (type-only only)`, () => {
      const source = readFileSync(join(PRELOAD_DIR, file), "utf8");
      const runtimeSharedImports = source
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line))
        .filter((line) => /from\s+["']\.\.\/shared\//.test(line))
        .filter((line) => !/^\s*import\s+type\b/.test(line));

      expect(runtimeSharedImports).toEqual([]);
    });
  }
});

describe("preload reply channel literals stay in sync with IpcChannels", () => {
  it("every reply:* literal used in src/preload matches a value in IpcChannels", () => {
    const knownValues = new Set<string>(Object.values(IpcChannels));
    const found = new Set<string>();

    for (const file of preloadFiles()) {
      const source = readFileSync(join(PRELOAD_DIR, file), "utf8");
      for (const m of source.matchAll(/["'](reply:[a-z-]+)["']/g)) {
        if (m[1] !== undefined) found.add(m[1]);
      }
    }

    // Sanity: the overlay preload does use reply channels — an empty set here
    // would mean the extraction regex silently stopped matching anything.
    expect(found.size).toBeGreaterThan(0);

    for (const literal of found) {
      expect(knownValues, `"${literal}" used in a preload file is not a value of IpcChannels — the two copies have diverged`).toContain(literal);
    }
  });

  it("overlay-preload.ts's reply channel literals equal IpcChannels' reply entries exactly", () => {
    const source = readFileSync(join(PRELOAD_DIR, "overlay-preload.ts"), "utf8");
    const literals = new Set(
      [...source.matchAll(/["'](reply:[a-z-]+)["']/g)]
        .map((m) => m[1])
        .filter((s): s is string => s !== undefined),
    );

    const expected = new Set([
      IpcChannels.ReplySuggestions,
      IpcChannels.ReplyChoose,
      IpcChannels.ReplyDismiss,
      IpcChannels.ReplyFlash,
      IpcChannels.ReplyHover,
    ]);

    expect(literals).toEqual(expected);
  });
});
