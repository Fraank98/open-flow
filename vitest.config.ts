import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      // Relative globs (vitest >= 4 removed `coverage.all`; `include` is what makes untested files show up).
      include: ["src/**/*.{ts,js}"],
      exclude: [
        "src/main/index.ts", // Electron entry: one 1000-line main(), needs a live app
        "src/preload/**", // contextBridge glue; guarded as text by preload-shared-boundary.test.ts
        "src/renderer/{preferences,setup,recorder}.js", // DOM wiring; no jsdom in the repo, lib/*.js stays included
        "src/**/*.d.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Pre-PR measured numbers minus 3; raised in the last step of the coverage PR.
      thresholds: { lines: 75, branches: 70, functions: 70, statements: 74 },
    },
  },
});
