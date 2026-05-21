# Open Flow — Electron Shell Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the headless pipeline from Plan 1 (Whisper → LLM cleanup) in a working Electron menubar app. End state: `npm run dev` launches a menubar tray icon; pressing `Right Option` (tap-to-toggle) records audio, runs it through the pipeline, and pastes the cleaned text into the currently focused text field on macOS. Overlay window shows pipeline state. Manual smoke test passes.

**Architecture:** Plain Electron + TypeScript. Main process orchestrates lifecycle, hotkey, audio orchestration, pipeline, and text injection. Renderer-side audio capture via Web Audio API streams 16 kHz mono Float32 chunks to main via IPC. A single Tray + frameless overlay BrowserWindow provide UX. Compilation: `tsc` produces `dist/main/`, `dist/preload/`. Renderer is static HTML loaded via `file://`. No build tool beyond `tsc` and `electron` for this plan; production packaging is Plan 3.

**Tech Stack:** Electron 32, TypeScript 5, Node 20, plain HTML/CSS for renderer (no React/Vue), `tsc` for compilation, `concurrently` for dev. macOS-only (uses `osascript`).

**Hotkey model for this plan:** Tap-to-toggle (press `Right Option` to start recording, press again to stop). True push-to-talk requires a native keyup listener (`uiohook-napi`) and is deferred to Plan 2b.

**Reference spec:** `docs/superpowers/specs/2026-05-21-open-flow-mvp-design.md`
**Builds on:** `docs/superpowers/plans/2026-05-21-open-flow-foundation.md`

---

## File Structure

After this plan, new files added:

```
open-flow/
├── package.json                                # MODIFIED: scripts + electron deps
├── tsconfig.json                               # MODIFIED: enable emit, add references
├── tsconfig.main.json                          # NEW: emit profile for main
├── tsconfig.preload.json                       # NEW: emit profile for preload
├── electron-builder.yml                        # NEW: skeleton for Plan 3 (unused now)
├── src/
│   ├── main/
│   │   ├── index.ts                           # NEW: Electron app entry
│   │   ├── pipeline-coordinator.ts            # NEW: state machine + orchestration
│   │   ├── hotkey-manager.ts                  # NEW: globalShortcut wrapper
│   │   ├── audio-orchestrator.ts              # NEW: main-side audio session (renderer ⇄ buffer ⇄ WAV)
│   │   ├── text-injector.ts                   # NEW: clipboard + osascript paste
│   │   ├── overlay-window.ts                  # NEW: frameless overlay BrowserWindow controller
│   │   ├── menubar-app.ts                     # NEW: Tray + menu
│   │   └── permissions.ts                     # NEW: mic + accessibility detection
│   ├── preload/
│   │   ├── recorder-preload.ts                # NEW: exposes IPC API for recorder.html
│   │   └── overlay-preload.ts                 # NEW: exposes IPC API for overlay.html
│   └── renderer/
│       ├── recorder.html                       # NEW: hidden window doing audio capture
│       ├── recorder.js                         # NEW: AudioWorklet wiring
│       ├── overlay.html                        # NEW: state display window
│       └── overlay.css                         # NEW: overlay styling
├── test/
│   ├── unit/
│   │   ├── pipeline-coordinator.test.ts        # NEW: state machine tests
│   │   ├── text-injector.test.ts               # NEW: with spawn mocked
│   │   └── audio-orchestrator.test.ts          # NEW: with WhisperRunner/LLMCleaner mocked
└── docs/
    └── electron-smoke-checklist.md             # NEW: manual e2e test plan
```

---

## Task 1: Electron Dev Setup

**Files:**
- Modify: `package.json` — add deps, scripts
- Modify: `tsconfig.json` — split into project references
- Create: `tsconfig.main.json`
- Create: `tsconfig.preload.json`
- Create: `src/main/index.ts` — minimal "Hello, Electron" entry

Goal: `npm run dev` launches Electron with a single blank window. No business logic yet — just verify the build pipeline works.

- [ ] **Step 1: Install new dependencies**

Run:

```bash
npm install --save-dev concurrently rimraf @types/node
```

(`@types/node` may already be present; `concurrently` and `rimraf` are new.)

- [ ] **Step 2: Update `package.json` scripts**

Replace the entire `"scripts"` block with:

```json
  "scripts": {
    "fetch-binaries": "bash scripts/fetch-binaries.sh",
    "fetch-test-models": "bash scripts/fetch-test-models.sh",
    "lint": "eslint --no-error-on-unmatched-pattern 'src/**/*.ts' 'test/**/*.ts' 'tools/**/*.ts'",
    "typecheck": "tsc --noEmit --project tsconfig.main.json && tsc --noEmit --project tsconfig.preload.json && tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "smoke": "tsx tools/pipeline-smoke.ts",
    "clean": "rimraf dist",
    "build:main": "tsc --project tsconfig.main.json",
    "build:preload": "tsc --project tsconfig.preload.json",
    "build": "npm run clean && npm run build:main && npm run build:preload",
    "dev": "npm run build && electron dist/main/index.js"
  },
```

- [ ] **Step 3: Create `tsconfig.main.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": false,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "sourceMap": true,
    "declaration": false
  },
  "include": ["src/main/**/*.ts", "src/shared/**/*.ts"],
  "exclude": ["node_modules", "dist", "resources", "test", "tools"]
}
```

- [ ] **Step 4: Create `tsconfig.preload.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": false,
    "module": "CommonJS",
    "moduleResolution": "Node",
    "sourceMap": true,
    "declaration": false,
    "isolatedModules": false
  },
  "include": ["src/preload/**/*.ts", "src/shared/**/*.ts"],
  "exclude": ["node_modules", "dist", "resources", "test", "tools"]
}
```

(Preload runs in a special Electron context — CommonJS keeps it simple. Renderer-loaded JS lives in `src/renderer/*.js` (plain JS, no transpile) for this plan.)

- [ ] **Step 5: Update `package.json`'s `main` field**

Locate this line:

```json
  "main": "dist/main/index.js",
```

Confirm it's correct (it should be — set in Plan 1 Task 1). No change needed if already set.

- [ ] **Step 6: Create the minimal `src/main/index.ts`**

```ts
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = join(__dirname, "..", "..");

async function createMainWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 480,
    height: 200,
    title: "open-flow (dev)",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        '<!DOCTYPE html><meta charset="utf-8">' +
          '<style>body{font-family:system-ui;padding:20px;background:#1e1e1e;color:#eee}</style>' +
          "<h2>open-flow</h2><p>Dev build alive. Main process orchestrates the dictation pipeline.</p>",
      ),
  );
}

app.whenReady().then(() => {
  void createMainWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
```

- [ ] **Step 7: Build and run**

Run: `npm run dev`

Expected: A 480×200 Electron window opens titled "open-flow (dev)" showing the message text. Close the window and the app exits.

Press `Ctrl+C` (or close the window) to stop.

- [ ] **Step 8: Verify tests still pass**

Run: `npm test`

Expected: 34/34 pass (Plan 1 tests should be unaffected by these scaffolding changes).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.main.json tsconfig.preload.json src/main/index.ts
git commit -m "feat(shell): minimal electron entry point that opens dev window"
```

---

## Task 2: TextInjector (TDD with mocked spawn)

**Files:**
- Create: `src/main/text-injector.ts`
- Create: `test/unit/text-injector.test.ts`

The TextInjector saves the current clipboard, writes the cleaned text, simulates `Cmd+V` via `osascript`, then restores the clipboard. Unit-tested by injecting fake clipboard and exec functions.

- [ ] **Step 1: Write the failing test**

Create `test/unit/text-injector.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextInjector, InjectorDeps } from "../../src/main/text-injector.js";

function makeDeps(overrides: Partial<InjectorDeps> = {}): InjectorDeps {
  const clip = { value: "prior-clipboard" };
  return {
    readClipboard: vi.fn(() => clip.value),
    writeClipboard: vi.fn((v: string) => { clip.value = v; }),
    runPaste: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("TextInjector", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the text to clipboard before invoking paste", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("Hello world.");
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(1, "Hello world.");
    expect(deps.runPaste).toHaveBeenCalledOnce();
  });

  it("restores prior clipboard contents after pasting", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("Hello.");
    // writeClipboard called twice: once with payload, once with restore
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(1, "Hello.");
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(2, "prior-clipboard");
  });

  it("returns success=true when paste completes", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    const result = await injector.inject("text");
    expect(result.pasted).toBe(true);
  });

  it("returns success=false and skips restore when paste fails", async () => {
    const deps = makeDeps({
      runPaste: vi.fn(async () => { throw new Error("osascript boom"); }),
    });
    const injector = new TextInjector(deps);
    const result = await injector.inject("text");
    expect(result.pasted).toBe(false);
    expect(result.reason).toContain("osascript boom");
    // payload still written
    expect(deps.writeClipboard).toHaveBeenCalledWith("text");
    // restore did NOT run on failure (so user can ⌘V manually later)
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1);
  });

  it("sleeps briefly between paste and restore", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("text");
    expect(deps.sleep).toHaveBeenCalledOnce();
    expect(deps.sleep).toHaveBeenCalledWith(150);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- text-injector`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement TextInjector**

Create `src/main/text-injector.ts`:

```ts
export interface InjectorDeps {
  readClipboard: () => string;
  writeClipboard: (text: string) => void;
  runPaste: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface InjectResult {
  pasted: boolean;
  reason?: string;
}

export class TextInjector {
  constructor(private readonly deps: InjectorDeps) {}

  async inject(text: string): Promise<InjectResult> {
    const prior = this.deps.readClipboard();
    this.deps.writeClipboard(text);
    try {
      await this.deps.runPaste();
    } catch (err) {
      // Leave text in clipboard so the user can paste manually
      return {
        pasted: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    await this.deps.sleep(150);
    this.deps.writeClipboard(prior);
    return { pasted: true };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- text-injector`

Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/text-injector.ts test/unit/text-injector.test.ts
git commit -m "feat(shell): TextInjector clipboard+osascript paste with mockable deps"
```

---

## Task 3: TextInjector Production Adapter

**Files:**
- Modify: `src/main/text-injector.ts` — add factory using Electron's clipboard + osascript exec
- No new tests (adapter is a thin wrapper around platform APIs)

- [ ] **Step 1: Add a factory function**

Append to `src/main/text-injector.ts`:

```ts
import { clipboard } from "electron";
import { exec } from "node:child_process";

export function createDefaultTextInjector(): TextInjector {
  return new TextInjector({
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    runPaste: () =>
      new Promise<void>((resolve, reject) => {
        exec(
          `osascript -e 'tell application "System Events" to keystroke "v" using command down'`,
          (err) => (err ? reject(err) : resolve()),
        );
      }),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  });
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`

Expected: typecheck passes for `tsconfig.main.json`. (The factory imports `electron`, which is only available when running under Electron — typecheck is fine because `electron` is a real package.)

- [ ] **Step 3: Verify unit tests still pass**

Run: `npm run test:unit -- text-injector`

Expected: 5 still pass. The factory isn't exercised by tests; the existing tests inject mocked deps directly.

- [ ] **Step 4: Commit**

```bash
git add src/main/text-injector.ts
git commit -m "feat(shell): default TextInjector factory using electron + osascript"
```

---

## Task 4: PipelineCoordinator State Machine (TDD)

**Files:**
- Create: `src/main/pipeline-coordinator.ts`
- Create: `test/unit/pipeline-coordinator.test.ts`

The coordinator owns the pipeline state. UI subscribes to state changes; hotkey/audio drive transitions. We unit-test the state machine with mocked WhisperRunner / LLMCleaner / TextInjector.

States and transitions:

```
idle → recording → transcribing → cleaning → injecting → idle
                                                       → error → idle (after notify)
At any non-idle state, "cancel" transitions to idle.
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/pipeline-coordinator.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PipelineCoordinator,
  PipelineState,
  CoordinatorDeps,
} from "../../src/main/pipeline-coordinator.js";

function makeDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    transcribe: vi.fn(async () => ({ text: "raw transcript", language: "en", durationMs: 100 })),
    clean: vi.fn(async () => ({ text: "Cleaned transcript.", usedFallback: false, durationMs: 50 })),
    inject: vi.fn(async () => ({ pasted: true })),
    logger: {
      info: vi.fn(async () => undefined),
      error: vi.fn(async () => undefined),
      warn: vi.fn(async () => undefined),
      debug: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

describe("PipelineCoordinator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts in 'idle' state", () => {
    const coord = new PipelineCoordinator(makeDeps());
    expect(coord.getState()).toBe<PipelineState>("idle");
  });

  it("transitions through full pipeline when audio is supplied", async () => {
    const deps = makeDeps();
    const coord = new PipelineCoordinator(deps);
    const states: PipelineState[] = [];
    coord.onStateChange((s) => states.push(s));

    coord.startRecording();
    expect(coord.getState()).toBe<PipelineState>("recording");

    const samples = new Float32Array(16000);
    await coord.finishWithAudio(samples, 16000, "auto");

    expect(states).toEqual<PipelineState[]>([
      "recording",
      "transcribing",
      "cleaning",
      "injecting",
      "idle",
    ]);
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(deps.clean).toHaveBeenCalledWith("raw transcript");
    expect(deps.inject).toHaveBeenCalledWith("Cleaned transcript.");
  });

  it("transitions to error when transcribe throws", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => { throw new Error("whisper crash"); }),
    });
    const coord = new PipelineCoordinator(deps);
    const states: PipelineState[] = [];
    coord.onStateChange((s) => states.push(s));

    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(8000), 16000, "auto");

    expect(states).toContain<PipelineState>("error");
    expect(deps.logger.error).toHaveBeenCalled();
    expect(deps.clean).not.toHaveBeenCalled();
    expect(deps.inject).not.toHaveBeenCalled();
  });

  it("skips inject and stays meaningful when transcript is empty", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: "", language: null, durationMs: 50 })),
    });
    const coord = new PipelineCoordinator(deps);
    const states: PipelineState[] = [];
    coord.onStateChange((s) => states.push(s));

    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(8000), 16000, "auto");

    expect(deps.clean).not.toHaveBeenCalled();
    expect(deps.inject).not.toHaveBeenCalled();
    expect(states).toContain<PipelineState>("idle");
  });

  it("can be cancelled while recording", () => {
    const deps = makeDeps();
    const coord = new PipelineCoordinator(deps);
    coord.startRecording();
    coord.cancel();
    expect(coord.getState()).toBe<PipelineState>("idle");
  });

  it("ignores startRecording while not idle", () => {
    const coord = new PipelineCoordinator(makeDeps());
    coord.startRecording();
    coord.startRecording();
    expect(coord.getState()).toBe<PipelineState>("recording");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- pipeline-coordinator`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the coordinator**

Create `src/main/pipeline-coordinator.ts`:

```ts
import { encodeWav } from "./utils/wav-encoder.js";

export type PipelineState =
  | "idle"
  | "recording"
  | "transcribing"
  | "cleaning"
  | "injecting"
  | "error";

export interface TranscribeFn {
  (input: { wavBytes: Uint8Array; language: string }): Promise<{
    text: string;
    language: string | null;
    durationMs: number;
  }>;
}

export interface CleanFn {
  (raw: string): Promise<{ text: string; usedFallback: boolean; durationMs: number }>;
}

export interface InjectFn {
  (text: string): Promise<{ pasted: boolean; reason?: string }>;
}

export interface CoordinatorLogger {
  info(msg: string, meta?: Record<string, unknown>): Promise<void>;
  warn(msg: string, meta?: Record<string, unknown>): Promise<void>;
  error(msg: string, meta?: Record<string, unknown>): Promise<void>;
  debug(msg: string, meta?: Record<string, unknown>): Promise<void>;
}

export interface CoordinatorDeps {
  transcribe: TranscribeFn;
  clean: CleanFn;
  inject: InjectFn;
  logger: CoordinatorLogger;
}

export class PipelineCoordinator {
  private state: PipelineState = "idle";
  private listeners: Array<(s: PipelineState) => void> = [];
  private cancelled = false;

  constructor(private readonly deps: CoordinatorDeps) {}

  getState(): PipelineState {
    return this.state;
  }

  onStateChange(cb: (s: PipelineState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private setState(next: PipelineState): void {
    this.state = next;
    for (const l of this.listeners) {
      l(next);
    }
  }

  startRecording(): void {
    if (this.state !== "idle") return;
    this.cancelled = false;
    this.setState("recording");
  }

  cancel(): void {
    if (this.state === "idle") return;
    this.cancelled = true;
    this.setState("idle");
  }

  async finishWithAudio(samples: Float32Array, sampleRate: number, language: string): Promise<void> {
    if (this.state !== "recording") return;

    try {
      this.setState("transcribing");
      const wavBytes = encodeWav(samples, sampleRate);
      const t = await this.deps.transcribe({ wavBytes, language });
      if (this.cancelled) {
        this.setState("idle");
        return;
      }
      if (t.text.trim().length === 0) {
        await this.deps.logger.info("empty transcript, skipping cleanup");
        this.setState("idle");
        return;
      }

      this.setState("cleaning");
      const c = await this.deps.clean(t.text);
      if (this.cancelled) {
        this.setState("idle");
        return;
      }

      this.setState("injecting");
      const r = await this.deps.inject(c.text);
      if (!r.pasted) {
        await this.deps.logger.warn("paste failed, text left in clipboard", { reason: r.reason });
      }
      this.setState("idle");
    } catch (err) {
      await this.deps.logger.error("pipeline failure", {
        message: err instanceof Error ? err.message : String(err),
      });
      this.setState("error");
      // auto-return to idle so user can try again
      setTimeout(() => {
        if (this.state === "error") this.setState("idle");
      }, 2000);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- pipeline-coordinator`

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/pipeline-coordinator.ts test/unit/pipeline-coordinator.test.ts
git commit -m "feat(shell): pipeline coordinator state machine with TDD"
```

---

## Task 5: AudioOrchestrator (TDD: main-side audio session)

**Files:**
- Create: `src/main/audio-orchestrator.ts`
- Create: `test/unit/audio-orchestrator.test.ts`

The orchestrator owns the in-memory PCM buffer assembled from renderer-sent chunks. It exposes `appendChunk`, `reset`, and `snapshot` (returns the concatenated Float32Array). State logic is pure and unit-testable.

- [ ] **Step 1: Write the failing test**

Create `test/unit/audio-orchestrator.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { AudioOrchestrator } from "../../src/main/audio-orchestrator.js";

describe("AudioOrchestrator", () => {
  let orch: AudioOrchestrator;
  beforeEach(() => {
    orch = new AudioOrchestrator({ maxDurationMs: 60_000, sampleRate: 16_000 });
  });

  it("starts empty", () => {
    expect(orch.totalSamples()).toBe(0);
    expect(orch.snapshot().length).toBe(0);
  });

  it("concatenates appended chunks in order", () => {
    orch.appendChunk(new Float32Array([0.1, 0.2]));
    orch.appendChunk(new Float32Array([0.3, 0.4, 0.5]));
    expect(orch.totalSamples()).toBe(5);
    expect(Array.from(orch.snapshot())).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it("reset() clears all chunks", () => {
    orch.appendChunk(new Float32Array([1, 2, 3]));
    orch.reset();
    expect(orch.totalSamples()).toBe(0);
  });

  it("truncates oldest samples beyond maxDurationMs (sliding window)", () => {
    const orch2 = new AudioOrchestrator({ maxDurationMs: 1, sampleRate: 1_000 });
    // 1 ms at 1000 Hz = 1 sample cap
    orch2.appendChunk(new Float32Array([1]));
    orch2.appendChunk(new Float32Array([2]));
    orch2.appendChunk(new Float32Array([3]));
    expect(orch2.totalSamples()).toBe(1);
    expect(orch2.snapshot()[0]).toBe(3);
  });

  it("rms() returns 0 for empty buffer", () => {
    expect(orch.rms()).toBe(0);
  });

  it("rms() returns positive value for non-silent buffer", () => {
    orch.appendChunk(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    expect(orch.rms()).toBeCloseTo(0.5, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- audio-orchestrator`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement AudioOrchestrator**

Create `src/main/audio-orchestrator.ts`:

```ts
export interface AudioOrchestratorOptions {
  maxDurationMs: number;
  sampleRate: number;
}

export class AudioOrchestrator {
  private chunks: Float32Array[] = [];
  private cachedTotal: number | null = 0;
  private readonly maxSamples: number;

  constructor(private readonly opts: AudioOrchestratorOptions) {
    this.maxSamples = Math.floor((opts.maxDurationMs / 1000) * opts.sampleRate);
  }

  appendChunk(chunk: Float32Array): void {
    this.chunks.push(chunk);
    this.cachedTotal = (this.cachedTotal ?? 0) + chunk.length;
    this.trimToMax();
  }

  reset(): void {
    this.chunks = [];
    this.cachedTotal = 0;
  }

  totalSamples(): number {
    if (this.cachedTotal === null) {
      let n = 0;
      for (const c of this.chunks) n += c.length;
      this.cachedTotal = n;
    }
    return this.cachedTotal;
  }

  snapshot(): Float32Array {
    const total = this.totalSamples();
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  rms(): number {
    let sum = 0;
    let count = 0;
    for (const c of this.chunks) {
      for (let i = 0; i < c.length; i++) {
        const v = c[i] ?? 0;
        sum += v * v;
        count++;
      }
    }
    if (count === 0) return 0;
    return Math.sqrt(sum / count);
  }

  private trimToMax(): void {
    while (this.totalSamples() > this.maxSamples) {
      const first = this.chunks[0];
      if (!first) break;
      const overflow = this.totalSamples() - this.maxSamples;
      if (overflow >= first.length) {
        this.chunks.shift();
        this.cachedTotal = null;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.cachedTotal = null;
        break;
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- audio-orchestrator`

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/audio-orchestrator.ts test/unit/audio-orchestrator.test.ts
git commit -m "feat(shell): AudioOrchestrator buffer with sliding-window trim"
```

---

## Task 6: HotkeyManager

**Files:**
- Create: `src/main/hotkey-manager.ts`
- No unit tests (thin wrapper around Electron's `globalShortcut` which can't be sensibly mocked at unit level)

Wraps `globalShortcut` to register/unregister a toggle hotkey. Emits `start` (first tap) and `stop` (second tap) events. Defaults to `Alt+Space` (Electron's `globalShortcut` doesn't expose Right-Option-alone — a follow-up pass with `uiohook-napi` will add real PTT support).

- [ ] **Step 1: Create the file**

Create `src/main/hotkey-manager.ts`:

```ts
import { globalShortcut } from "electron";
import { EventEmitter } from "node:events";

export interface HotkeyManagerOptions {
  accelerator: string;
}

export class HotkeyManager extends EventEmitter {
  private active = false;
  private registered = false;

  constructor(private readonly opts: HotkeyManagerOptions) {
    super();
  }

  register(): { ok: true } | { ok: false; reason: string } {
    const ok = globalShortcut.register(this.opts.accelerator, () => {
      this.active = !this.active;
      if (this.active) {
        this.emit("start");
      } else {
        this.emit("stop");
      }
    });
    if (!ok) {
      return { ok: false, reason: `Could not register hotkey ${this.opts.accelerator}` };
    }
    this.registered = true;
    return { ok: true };
  }

  unregister(): void {
    if (!this.registered) return;
    globalShortcut.unregister(this.opts.accelerator);
    this.registered = false;
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Force the manager back to inactive without firing 'stop'. Used after the
   * pipeline auto-completes (e.g., audio fully transcribed); the next hotkey
   * press should be treated as a fresh "start".
   */
  reset(): void {
    this.active = false;
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`

Expected: passes — `electron` resolves, `EventEmitter` is built-in.

- [ ] **Step 3: Commit**

```bash
git add src/main/hotkey-manager.ts
git commit -m "feat(shell): HotkeyManager wrapping electron globalShortcut (toggle mode)"
```

---

## Task 7: Recorder Renderer (audio capture)

**Files:**
- Create: `src/preload/recorder-preload.ts`
- Create: `src/renderer/recorder.html`
- Create: `src/renderer/recorder.js`

The recorder is a hidden BrowserWindow that captures audio via Web Audio API and streams 16 kHz mono Float32 chunks to the main process via IPC.

- [ ] **Step 1: Create preload script**

Create `src/preload/recorder-preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowRecorder", {
  onStart: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("audio:start", handler);
    return () => ipcRenderer.removeListener("audio:start", handler);
  },
  onStop: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("audio:stop", handler);
    return () => ipcRenderer.removeListener("audio:stop", handler);
  },
  sendChunk: (samples: Float32Array): void => {
    // Transfer the underlying buffer for zero-copy
    ipcRenderer.send("audio:chunk", samples.buffer, samples.byteOffset, samples.length);
  },
  reportError: (message: string): void => {
    ipcRenderer.send("audio:error", message);
  },
  reportReady: (): void => {
    ipcRenderer.send("audio:ready");
  },
});

declare global {
  interface Window {
    openFlowRecorder: {
      onStart: (cb: () => void) => () => void;
      onStop: (cb: () => void) => () => void;
      sendChunk: (samples: Float32Array) => void;
      reportError: (message: string) => void;
      reportReady: () => void;
    };
  }
}
```

- [ ] **Step 2: Create recorder.html**

Create `src/renderer/recorder.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>open-flow recorder</title>
  </head>
  <body>
    <p>Audio capture worker — keep this window alive.</p>
    <script src="./recorder.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Create recorder.js (plain JS, no transpile)**

Create `src/renderer/recorder.js`:

```js
// Audio capture loop. Listens for IPC start/stop, streams 16 kHz mono Float32
// to main. Downsamples from the hardware rate (typically 48 kHz).
"use strict";

const TARGET_SAMPLE_RATE = 16000;

let audioContext = null;
let mediaStream = null;
let processorNode = null;

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    window.openFlowRecorder.reportError("mic-permission-denied:" + (err && err.message ? err.message : String(err)));
    return;
  }
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  const inputRate = audioContext.sampleRate;
  const decimation = inputRate / TARGET_SAMPLE_RATE;

  // ScriptProcessor is deprecated but the simplest API for raw PCM here.
  // AudioWorklet is the modern alternative but requires more glue. For an MVP
  // dictation app where audio chunks are processed in main, this is acceptable.
  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  let accumulator = 0;
  let outBuffer = [];

  processorNode.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    // Naive linear-skip downsample. Good enough for speech recognition.
    for (let i = 0; i < inputData.length; i++) {
      accumulator++;
      if (accumulator >= decimation) {
        accumulator -= decimation;
        outBuffer.push(inputData[i]);
      }
    }
    if (outBuffer.length >= 1024) {
      const chunk = new Float32Array(outBuffer);
      outBuffer = [];
      window.openFlowRecorder.sendChunk(chunk);
    }
  };

  source.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

async function stopRecording() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
}

window.openFlowRecorder.onStart(() => { startRecording(); });
window.openFlowRecorder.onStop(() => { stopRecording(); });
window.openFlowRecorder.reportReady();
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck && npm run build`

Expected: preload compiles to `dist/preload/recorder-preload.js`. Build also re-emits main. No errors.

- [ ] **Step 5: Commit**

```bash
git add src/preload/recorder-preload.ts src/renderer/recorder.html src/renderer/recorder.js
git commit -m "feat(shell): hidden recorder window with web audio capture + IPC"
```

---

## Task 8: OverlayWindow

**Files:**
- Create: `src/preload/overlay-preload.ts`
- Create: `src/renderer/overlay.html`
- Create: `src/renderer/overlay.css`
- Create: `src/main/overlay-window.ts`

A frameless transparent always-on-top window that shows pipeline state. Auto-shows when state moves out of `idle`, fades on return to `idle`.

- [ ] **Step 1: Create overlay-preload.ts**

Create `src/preload/overlay-preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowOverlay", {
  onState: (cb: (state: string) => void): (() => void) => {
    const handler = (_e: unknown, state: string) => cb(state);
    ipcRenderer.on("pipeline:state-change", handler);
    return () => ipcRenderer.removeListener("pipeline:state-change", handler);
  },
  cancel: (): void => {
    ipcRenderer.send("pipeline:cancel");
  },
});

declare global {
  interface Window {
    openFlowOverlay: {
      onState: (cb: (state: string) => void) => () => void;
      cancel: () => void;
    };
  }
}
```

- [ ] **Step 2: Create overlay.html**

Create `src/renderer/overlay.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./overlay.css" />
    <title>open-flow</title>
  </head>
  <body>
    <div id="root" class="state-idle">
      <div class="dot"></div>
      <div class="label" id="label">Idle</div>
      <button id="cancel" type="button">✕</button>
    </div>
    <script>
      const labelEl = document.getElementById("label");
      const rootEl = document.getElementById("root");
      const cancelBtn = document.getElementById("cancel");

      const TEXT = {
        idle: "",
        recording: "Recording…",
        transcribing: "Transcribing…",
        cleaning: "Cleaning…",
        injecting: "Pasting…",
        error: "Error",
      };

      window.openFlowOverlay.onState((state) => {
        labelEl.textContent = TEXT[state] ?? state;
        rootEl.className = `state-${state}`;
      });

      cancelBtn.addEventListener("click", () => {
        window.openFlowOverlay.cancel();
      });
    </script>
  </body>
</html>
```

- [ ] **Step 3: Create overlay.css**

Create `src/renderer/overlay.css`:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  background: transparent;
  height: 100%;
  font-family: -apple-system, system-ui, sans-serif;
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
}
#root {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  margin: 8px;
  background: rgba(30, 30, 32, 0.92);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  color: #fff;
  font-size: 14px;
  height: 56px;
  transition: opacity 200ms ease;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #888;
}
.label { flex: 1; }
button#cancel {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  border: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 12px;
  cursor: pointer;
}
button#cancel:hover { background: rgba(255, 255, 255, 0.22); }

.state-idle { opacity: 0; pointer-events: none; }
.state-recording .dot { background: #ff3b30; animation: pulse 1s infinite; }
.state-transcribing .dot { background: #ffcc00; }
.state-cleaning .dot { background: #34c759; }
.state-injecting .dot { background: #007aff; }
.state-error .dot { background: #ff3b30; }

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.3); opacity: 0.6; }
}
```

- [ ] **Step 4: Create overlay-window.ts (main-side controller)**

Create `src/main/overlay-window.ts`:

```ts
import { BrowserWindow, screen } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export class OverlayWindow {
  private win: BrowserWindow | null = null;

  async create(): Promise<void> {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const w = 360;
    const h = 80;
    this.win = new BrowserWindow({
      width: w,
      height: h,
      x: Math.floor((width - w) / 2),
      y: height - h - 24,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    await this.win.loadFile(join(APP_ROOT, "src", "renderer", "overlay.html"));
  }

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
  }

  sendState(state: string): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("pipeline:state-change", state);
    }
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
      this.win = null;
    }
  }
}
```

- [ ] **Step 5: Build to verify TS compiles**

Run: `npm run build`

Expected: `dist/main/overlay-window.js` and `dist/preload/overlay-preload.js` produced. No errors.

- [ ] **Step 6: Commit**

```bash
git add src/preload/overlay-preload.ts src/renderer/overlay.html src/renderer/overlay.css src/main/overlay-window.ts
git commit -m "feat(shell): overlay window with state-driven UI"
```

---

## Task 9: MenubarApp (Tray)

**Files:**
- Create: `src/main/menubar-app.ts`
- Create: `resources/icons/tray-template.png` — 22×22 macOS template icon (will use a placeholder you generate)

- [ ] **Step 1: Create a placeholder tray icon**

macOS template icons are PNG, ideally 22×22 @1x and 44×44 @2x, with black-on-transparent (only alpha matters; macOS recolors).

Run this once to generate a minimal placeholder icon using Python's PIL (already available on most Macs via Homebrew Python, or use sips):

```bash
mkdir -p resources/icons
python3 -c "
from PIL import Image, ImageDraw
img = Image.new('RGBA', (44, 44), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# Simple microphone: vertical pill capsule + base line
d.rounded_rectangle((16, 6, 28, 28), radius=6, fill=(0, 0, 0, 255))
d.rectangle((19, 28, 25, 34), fill=(0, 0, 0, 255))
d.rectangle((12, 34, 32, 36), fill=(0, 0, 0, 255))
img.save('resources/icons/tray-template@2x.png')
img.resize((22, 22), Image.LANCZOS).save('resources/icons/tray-template.png')
print('icons written')
"
```

If `python3 -c 'from PIL import Image'` fails (Pillow missing), install with `python3 -m pip install --user Pillow` first. Or, as a fallback, create a 22×22 black-on-transparent PNG by any means and save as `resources/icons/tray-template.png` + `resources/icons/tray-template@2x.png`. Both files must exist.

- [ ] **Step 2: Create MenubarApp**

Create `src/main/menubar-app.ts`:

```ts
import { Tray, Menu, app, nativeImage } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export interface MenubarCallbacks {
  onToggleEnabled: () => void;
  onQuit: () => void;
}

export class MenubarApp {
  private tray: Tray | null = null;
  private enabled = true;
  private currentStatus = "Idle";

  constructor(private readonly callbacks: MenubarCallbacks) {}

  create(): void {
    const iconPath = join(APP_ROOT, "resources", "icons", "tray-template.png");
    const icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip("open-flow");
    this.refreshMenu();

    // Hide dock icon — this is a menubar app
    app.dock?.hide();
  }

  setStatus(status: string): void {
    this.currentStatus = status;
    this.refreshMenu();
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: `open-flow — ${this.currentStatus}`, enabled: false },
      { type: "separator" },
      {
        label: this.enabled ? "Disable hotkey" : "Enable hotkey",
        click: () => {
          this.enabled = !this.enabled;
          this.callbacks.onToggleEnabled();
          this.refreshMenu();
        },
      },
      { type: "separator" },
      { label: "Quit open-flow", click: () => this.callbacks.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
```

- [ ] **Step 3: Update .gitignore to keep icon assets tracked**

Verify `.gitignore` doesn't accidentally ignore PNGs. Quick check:

```bash
grep -E "\.png|resources/icons" .gitignore
```

Expected: no match (PNGs are not in .gitignore). If a match is found, do not modify .gitignore in this task — escalate.

- [ ] **Step 4: Build to verify**

Run: `npm run build`

Expected: `dist/main/menubar-app.js` produced.

- [ ] **Step 5: Commit**

```bash
git add src/main/menubar-app.ts resources/icons/
git commit -m "feat(shell): menubar tray with status + toggle + quit"
```

---

## Task 10: Permissions Module

**Files:**
- Create: `src/main/permissions.ts`
- Create: `test/unit/permissions.test.ts`

Detects whether microphone and accessibility permissions are granted. The mic check uses Electron's `systemPreferences.getMediaAccessStatus`. Accessibility is harder — we test by trying a no-op `osascript` keystroke and checking for permission errors.

- [ ] **Step 1: Write the failing test**

Create `test/unit/permissions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { checkAccessibilityViaProbe } from "../../src/main/permissions.js";

describe("checkAccessibilityViaProbe", () => {
  it("returns 'granted' when probe command succeeds", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const result = await checkAccessibilityViaProbe(exec);
    expect(result).toBe("granted");
    expect(exec).toHaveBeenCalledOnce();
  });

  it("returns 'denied' when probe rejects with accessibility error", async () => {
    const exec = vi.fn(async () => {
      const err: NodeJS.ErrnoException = new Error("not authorized to send keystrokes");
      throw err;
    });
    const result = await checkAccessibilityViaProbe(exec);
    expect(result).toBe("denied");
  });

  it("returns 'unknown' on unrelated exec failure", async () => {
    const exec = vi.fn(async () => {
      throw new Error("some other error");
    });
    const result = await checkAccessibilityViaProbe(exec);
    expect(result).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- permissions`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement permissions module**

Create `src/main/permissions.ts`:

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";

export type PermissionStatus = "granted" | "denied" | "unknown";

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

const execAsync = promisify(exec);

// Probe accessibility by running a no-op AppleScript that requires keystroke
// permission. macOS prompts the user OR throws a permission error.
export async function checkAccessibilityViaProbe(execFn: ExecFn = execAsync): Promise<PermissionStatus> {
  // A no-op System Events command requires Accessibility permission.
  const cmd = `osascript -e 'tell application "System Events" to get name of every process whose visible is true' 2>&1`;
  try {
    await execFn(cmd);
    return "granted";
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (msg.includes("not authorized") || msg.includes("accessibility") || msg.includes("not allowed")) {
      return "denied";
    }
    return "unknown";
  }
}

// Mic permission via Electron's systemPreferences. Only callable inside the
// Electron main process.
export async function checkMicrophone(): Promise<PermissionStatus> {
  // Lazy import so unit tests don't need Electron available
  const electron = await import("electron");
  const status = electron.systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (status === "denied" || status === "restricted") return "denied";
  return "unknown"; // "not-determined" — first launch
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- permissions`

Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/permissions.ts test/unit/permissions.test.ts
git commit -m "feat(shell): permission probes for mic + accessibility"
```

---

## Task 11: Main entry — wire everything together

**Files:**
- Modify: `src/main/index.ts` — replace blank window with full wiring

- [ ] **Step 1: Replace `src/main/index.ts` entirely**

Overwrite the contents:

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { PipelineCoordinator } from "./pipeline-coordinator.js";
import { AudioOrchestrator } from "./audio-orchestrator.js";
import { HotkeyManager } from "./hotkey-manager.js";
import { OverlayWindow } from "./overlay-window.js";
import { MenubarApp } from "./menubar-app.js";
import { createDefaultTextInjector } from "./text-injector.js";
import { createLogger } from "./logger.js";
import { WhisperRunner } from "./whisper-runner.js";
import { LLMCleaner } from "./llm-cleaner.js";
import { checkAccessibilityViaProbe, checkMicrophone } from "./permissions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = join(__dirname, "..", "..");

const HOTKEY_ACCELERATOR = "Alt+Space";
const SAMPLE_RATE = 16_000;
const LANGUAGE = "auto";

const WHISPER_BIN = join(APP_ROOT, "resources", "bin", "whisper-cli");
const LLAMA_BIN = join(APP_ROOT, "resources", "bin", "llama-cli");
const WHISPER_MODEL = join(APP_ROOT, "test", "fixtures", "models", "ggml-tiny.bin");
const LLM_MODEL = join(APP_ROOT, "test", "fixtures", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf");

const LOG_DIR = join(homedir(), "Library", "Logs", "open-flow");

async function main(): Promise<void> {
  await app.whenReady();

  const logger = createLogger({ dir: LOG_DIR, debug: !!process.env.OPEN_FLOW_DEBUG, maxBytes: 5 * 1024 * 1024 });
  await logger.info("app starting");

  // Permissions check (informational only; do not block)
  const mic = await checkMicrophone();
  const acc = await checkAccessibilityViaProbe();
  await logger.info("permissions", { mic, accessibility: acc });

  const whisper = new WhisperRunner({
    binaryPath: WHISPER_BIN,
    modelPath: WHISPER_MODEL,
    timeoutMs: 60_000,
  });
  const llm = new LLMCleaner({
    binaryPath: LLAMA_BIN,
    modelPath: LLM_MODEL,
    timeoutMs: 30_000,
  });
  const injector = createDefaultTextInjector();
  const orchestrator = new AudioOrchestrator({ maxDurationMs: 60_000, sampleRate: SAMPLE_RATE });

  const coordinator = new PipelineCoordinator({
    transcribe: async ({ wavBytes, language }) => {
      const tmp = join(app.getPath("temp"), `open-flow-${Date.now()}.wav`);
      const { writeFile, unlink } = await import("node:fs/promises");
      await writeFile(tmp, wavBytes);
      try {
        return await whisper.transcribe({ wavPath: tmp, language });
      } finally {
        unlink(tmp).catch(() => undefined);
      }
    },
    clean: async (raw) => llm.clean(raw),
    inject: async (text) => injector.inject(text),
    logger,
  });

  const overlay = new OverlayWindow();
  await overlay.create();
  coordinator.onStateChange((state) => {
    overlay.sendState(state);
    if (state === "idle") {
      setTimeout(() => overlay.hide(), 500);
    } else {
      overlay.show();
    }
  });

  // Recorder hidden window
  const recorderWin = new BrowserWindow({
    width: 320,
    height: 80,
    show: false,
    webPreferences: {
      preload: join(APP_ROOT, "dist", "preload", "recorder-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await recorderWin.loadFile(join(APP_ROOT, "src", "renderer", "recorder.html"));

  ipcMain.on("audio:chunk", (_e, arrayBuffer: ArrayBuffer, byteOffset: number, length: number) => {
    const view = new Float32Array(arrayBuffer, byteOffset, length);
    // Copy because the buffer is reused by IPC
    const chunk = new Float32Array(view.length);
    chunk.set(view);
    orchestrator.appendChunk(chunk);
  });
  ipcMain.on("audio:error", async (_e, message: string) => {
    await logger.error("recorder error", { message });
  });

  const hotkey = new HotkeyManager({ accelerator: HOTKEY_ACCELERATOR });
  hotkey.on("start", () => {
    orchestrator.reset();
    coordinator.startRecording();
    recorderWin.webContents.send("audio:start");
    menubar.setStatus("Recording…");
  });
  hotkey.on("stop", async () => {
    recorderWin.webContents.send("audio:stop");
    // Wait a moment for the last chunk to arrive
    await new Promise((r) => setTimeout(r, 250));
    const samples = orchestrator.snapshot();
    await coordinator.finishWithAudio(samples, SAMPLE_RATE, LANGUAGE);
    hotkey.reset();
    menubar.setStatus("Idle");
  });

  const reg = hotkey.register();
  if (!reg.ok) {
    await logger.error("hotkey registration failed", { reason: reg.reason, accelerator: HOTKEY_ACCELERATOR });
  } else {
    await logger.info("hotkey registered", { accelerator: HOTKEY_ACCELERATOR });
  }

  const menubar = new MenubarApp({
    onToggleEnabled: () => {
      if (menubar.isEnabled()) {
        hotkey.register();
      } else {
        hotkey.unregister();
      }
    },
    onQuit: () => app.quit(),
  });
  menubar.create();

  app.on("will-quit", () => {
    hotkey.unregister();
    overlay.destroy();
    menubar.destroy();
  });

  // Menubar app — stay alive even with no windows. macOS doesn't auto-quit
  // when all windows close, so no preventDefault is needed.
  app.on("window-all-closed", () => {
    // intentional no-op
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  app.exit(1);
});
```

- [ ] **Step 2: Build to verify TS compiles**

Run: `npm run build`

Expected: builds cleanly. No type errors.

- [ ] **Step 3: Run integration tests**

Run: `npm test`

Expected: all previous tests still pass (no new failures introduced by the entry point — pure config + wiring).

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(shell): wire pipeline coordinator + audio + hotkey + overlay + menubar"
```

---

## Task 12: Manual Smoke Checklist + Verify Locally

**Files:**
- Create: `docs/electron-smoke-checklist.md`

- [ ] **Step 1: Write the smoke checklist**

Create `docs/electron-smoke-checklist.md`:

```markdown
# Open Flow — Electron Smoke Checklist

Manual verification list for the dev-mode Electron shell. Run after any
non-trivial change to main process wiring, hotkey, audio, or overlay.

## Pre-flight

- Run `npm run fetch-binaries` and `npm run fetch-test-models` once if missing.
- macOS: System Settings → Privacy & Security → Microphone — open the panel so
  Electron can request access on first run.
- macOS: System Settings → Privacy & Security → Accessibility — same.

## Launch

1. `npm run dev`
2. Verify a tray icon appears in the menubar (microphone-shaped, dark/light theme aware).
3. Click the tray icon — context menu shows "open-flow — Idle", "Disable hotkey", "Quit open-flow".
4. Dock icon should NOT be visible (menubar-only app).

## First dictation

5. Focus a text field somewhere (TextEdit, Notes.app, browser address bar).
6. Press `Option+Space` (Alt+Space). Overlay window appears at bottom-center with red pulsing dot and "Recording…".
7. Speak for ~3 seconds: *"Hello, this is a test of the open flow dictation system."*
8. Press `Option+Space` again. Overlay updates through "Transcribing…" (yellow) → "Cleaning…" (green) → "Pasting…" (blue) → fades out.
9. The cleaned text should appear pasted into the focused text field.

## Edge cases

10. **Cancel via overlay:** Start recording, click the ✕ button on the overlay. Recording stops and pipeline does not run.
11. **Empty audio:** Press hotkey, immediately press again. Pipeline runs but transcript should be empty or near-empty; no paste occurs.
12. **Disable + re-enable:** Tray menu → "Disable hotkey". Hotkey now does nothing. Re-enable, dictation works again.
13. **Quit:** Tray menu → "Quit open-flow". App exits cleanly; no orphan processes (`ps -ef | grep -E "(open-flow|electron|whisper-cli|llama-cli)"` should show none).

## Known limitations (Plan 2 scope)

- Hotkey is tap-to-toggle, not push-to-talk. PTT requires `uiohook-napi` (Plan 2b).
- Models hard-coded to fixture paths (`test/fixtures/models/...`). Real model manager comes in Plan 3.
- No permission prompts UI; failures are logged only.
- Tray icon is a generated placeholder.

## If something fails

Logs live in `~/Library/Logs/open-flow/error.log`. Set `OPEN_FLOW_DEBUG=1` to also write `debug.log`.
```

- [ ] **Step 2: Update README.md to mention dev mode**

Edit `README.md`. Locate this section:

```markdown
## Try the pipeline

\`\`\`bash
npm run smoke -- --wav test/fixtures/audio/en-short-clean.wav
\`\`\`
```

Add right after it (still above "Project layout"):

```markdown
## Run the Electron dev app

\`\`\`bash
npm run dev
\`\`\`

Launches a menubar tray icon. Press `Option+Space` over any text field to start dictation; press again to stop. See `docs/electron-smoke-checklist.md` for the full manual test plan.
```

- [ ] **Step 3: Run unit + integration test suite one more time**

Run: `npm run lint && npm run typecheck && npm test`

Expected: all pass. The Electron-specific code isn't covered by automated tests, but everything that has tests still passes.

- [ ] **Step 4: Run the manual smoke checklist**

Run: `npm run dev`

Then execute steps 1–13 from the checklist above. If any step fails, stop and report — do NOT mark this task complete.

Note: the first launch will trigger macOS permission prompts for microphone and accessibility. Accept both. If accessibility was rejected, re-grant in System Settings and restart the app.

- [ ] **Step 5: Commit (only after smoke passes)**

```bash
git add docs/electron-smoke-checklist.md README.md
git commit -m "docs(shell): manual smoke checklist + README dev instructions"
```

---

## Done Criteria

This plan is complete when ALL of the following hold:

- `npm install` and `npm run build` produce a working dev build
- `npm run lint`, `npm run typecheck`, `npm test` all pass (Plan 1's 34 tests + this plan's ~20 new unit tests for TextInjector, PipelineCoordinator, AudioOrchestrator, Permissions)
- `npm run dev` launches a menubar app on macOS
- Pressing `Option+Space` over a text field, dictating, and pressing again results in cleaned text being pasted into that text field
- Overlay window appears at bottom-center showing pipeline state
- Tray menu can disable/enable hotkey and quit the app
- `docs/electron-smoke-checklist.md` is reproducible end-to-end on a fresh Mac
- All changes are committed in focused, sensible commits

After completion, Plan 3 will address: setup wizard, model manager (download progress UI), preferences UI for hotkey + model + language, code signing path, .dmg packaging via electron-builder, GitHub Actions release workflow.
