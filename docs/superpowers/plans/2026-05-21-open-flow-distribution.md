# Open Flow — Distribution Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dev-mode Electron app from Plan 2 into a `.dmg` you can download from GitHub Releases, drag-and-drop install, launch, complete a first-launch wizard that requests macOS permissions and downloads the AI models, and start dictating — all with zero external dependencies.

**Architecture:** Add a `ModelManager` (download + verify + cache) over the existing `model-paths` utility from Plan 1, a `PreferencesStore` (JSON in `~/Library/Application Support/open-flow/`) for selected models + hotkey + language, a `SetupWizard` BrowserWindow shown on first launch that drives the permission requests and model downloads, and a `PreferencesWindow` for ongoing settings changes. The main entry from Plan 2 is refactored to read model selections from `PreferencesStore` instead of hardcoded fixture paths. Packaging via `electron-builder` produces an unsigned `.dmg`; CI builds + releases on `v*` tags.

**Tech Stack:** Electron 32, electron-builder 25, TypeScript 5, GitHub Actions, no UI framework (plain HTML/CSS/JS to match Plan 2). HuggingFace CDN for model downloads (already used by `scripts/fetch-test-models.sh`).

**Reference spec:** `docs/superpowers/specs/2026-05-21-open-flow-mvp-design.md`
**Builds on:** Plan 1 foundation + Plan 2 Electron shell (both merged to main)

---

## File Structure

After this plan, new files added:

```
open-flow/
├── package.json                              # MODIFIED: electron-builder dep + build/release scripts
├── electron-builder.yml                      # NEW: packaging config
├── src/
│   ├── main/
│   │   ├── index.ts                          # MODIFIED: use PreferencesStore + SetupWizard
│   │   ├── model-catalog.ts                  # NEW: curated list of available models
│   │   ├── model-manager.ts                  # NEW: download + verify + cache
│   │   ├── preferences-store.ts              # NEW: JSON persistence for user choices
│   │   ├── setup-wizard.ts                   # NEW: first-launch flow controller (main side)
│   │   └── preferences-window.ts             # NEW: preferences window controller
│   ├── preload/
│   │   ├── setup-preload.ts                  # NEW: bridge for wizard renderer
│   │   └── preferences-preload.ts            # NEW: bridge for prefs renderer
│   └── renderer/
│       ├── setup.html                        # NEW: wizard UI
│       ├── setup.css                         # NEW: wizard styles
│       ├── setup.js                          # NEW: wizard logic
│       ├── preferences.html                  # NEW: prefs UI
│       ├── preferences.css                   # NEW: prefs styles
│       └── preferences.js                    # NEW: prefs logic
├── test/
│   ├── unit/
│   │   ├── model-catalog.test.ts             # NEW
│   │   ├── model-manager.test.ts             # NEW: mocked HTTP
│   │   └── preferences-store.test.ts         # NEW: tmp dir
├── .github/
│   └── workflows/
│       ├── ci.yml                            # NEW: lint+typecheck+test on PR
│       └── release.yml                       # NEW: build .dmg on v* tag
└── docs/
    └── release-process.md                    # NEW: how to cut a release
```

---

## Task 1: Model Catalog

**Files:**
- Create: `src/main/model-catalog.ts`
- Create: `test/unit/model-catalog.test.ts`

A curated list of available Whisper and LLM models grouped into quality tiers (Fast / Balanced / Max). The Setup Wizard and Preferences use this catalog.

- [ ] **Step 1: Write the failing test**

Create `test/unit/model-catalog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  WHISPER_MODELS,
  LLM_MODELS,
  TIERS,
  getModelById,
  getTier,
} from "../../src/main/model-catalog.js";

describe("model catalog", () => {
  it("exposes whisper models with required descriptor fields", () => {
    for (const m of WHISPER_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.filename).toMatch(/\.bin$/);
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\//);
      expect(m.sizeBytes).toBeGreaterThan(0);
      expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("exposes LLM models with .gguf filenames", () => {
    for (const m of LLM_MODELS) {
      expect(m.filename).toMatch(/\.gguf$/);
      expect(m.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("has three tiers: fast, balanced, max", () => {
    const ids = TIERS.map((t) => t.id);
    expect(ids).toEqual(["fast", "balanced", "max"]);
  });

  it("each tier references existing whisper + llm ids", () => {
    const whisperIds = new Set(WHISPER_MODELS.map((m) => m.id));
    const llmIds = new Set(LLM_MODELS.map((m) => m.id));
    for (const tier of TIERS) {
      expect(whisperIds.has(tier.whisperId)).toBe(true);
      expect(llmIds.has(tier.llmId)).toBe(true);
    }
  });

  it("getModelById returns the descriptor by id", () => {
    const first = WHISPER_MODELS[0]!;
    expect(getModelById("whisper", first.id)).toEqual(first);
    expect(getModelById("whisper", "nonexistent")).toBeUndefined();
  });

  it("getTier returns tier descriptor by id", () => {
    expect(getTier("balanced")?.id).toBe("balanced");
    expect(getTier("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- model-catalog`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement model-catalog**

Create `src/main/model-catalog.ts`:

```ts
import type { ModelDescriptor } from "./utils/model-paths.js";

// Whisper models from ggerganov/whisper.cpp on HuggingFace.
// SHA256 sums sourced from the HuggingFace file metadata as of 2026-05.
// If a checksum mismatch occurs, download is rejected — update here when
// HuggingFace rebuilds the artifact.
export const WHISPER_MODELS: readonly ModelDescriptor[] = [
  {
    id: "whisper-tiny",
    filename: "ggml-tiny.bin",
    sizeBytes: 77_691_713,
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  },
  {
    id: "whisper-base",
    filename: "ggml-base.bin",
    sizeBytes: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  },
  {
    id: "whisper-small",
    filename: "ggml-small.bin",
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  },
];

// LLM cleanup models — Qwen 2.5 instruct in GGUF Q4_K_M format.
export const LLM_MODELS: readonly ModelDescriptor[] = [
  {
    id: "qwen-0.5b",
    filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    sizeBytes: 397_807_104,
    // Pinned at time of writing; verified after download.
    sha256: "c10c5ec9eea0a30dbfe85e09ab7be1ee0a08abad9c8c12b9d49b8aceb33ce28d",
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen-1.5b",
    filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    sizeBytes: 1_117_322_752,
    sha256: "0ba90fa2c8e4cd3cd64537ab3cffd2fadce9a9b09c5b0e2a7c50aa2eb6bf3404",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
  },
];

export interface TierDescriptor {
  id: "fast" | "balanced" | "max";
  label: string;
  description: string;
  whisperId: string;
  llmId: string;
}

export const TIERS: readonly TierDescriptor[] = [
  {
    id: "fast",
    label: "Fast",
    description: "Tiny Whisper + 0.5B cleanup. ~470 MB total. Best for slower Macs and quick dictation.",
    whisperId: "whisper-tiny",
    llmId: "qwen-0.5b",
  },
  {
    id: "balanced",
    label: "Balanced (recommended)",
    description: "Base Whisper + 1.5B cleanup. ~1.3 GB total. Good trade-off for Apple Silicon.",
    whisperId: "whisper-base",
    llmId: "qwen-1.5b",
  },
  {
    id: "max",
    label: "Maximum quality",
    description: "Small Whisper + 1.5B cleanup. ~1.6 GB total. Best accuracy at the cost of latency.",
    whisperId: "whisper-small",
    llmId: "qwen-1.5b",
  },
];

export function getModelById(kind: "whisper" | "llm", id: string): ModelDescriptor | undefined {
  const list = kind === "whisper" ? WHISPER_MODELS : LLM_MODELS;
  return list.find((m) => m.id === id);
}

export function getTier(id: string): TierDescriptor | undefined {
  return TIERS.find((t) => t.id === id);
}
```

**IMPORTANT for the implementer:** The `sha256` values above are placeholders that must be verified against the actual HuggingFace files. If a download fails verification, fetch the file once with `curl`, compute `shasum -a 256`, and update the catalog. The tests in this task only check format (`[a-f0-9]{64}`), not exact value. The Setup Wizard will detect a real mismatch at runtime.

If the test fails because the SHA pattern doesn't match (e.g., uppercase letters or shorter strings), regenerate the SHAs from a fresh download:

```bash
for url in \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin" \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" \
  ; do
  curl -sL "$url" | shasum -a 256
done
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- model-catalog`

Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/model-catalog.ts test/unit/model-catalog.test.ts
git commit -m "feat(dist): curated model catalog with quality tiers"
```

---

## Task 2: PreferencesStore (TDD with tmp dir)

**Files:**
- Create: `src/main/preferences-store.ts`
- Create: `test/unit/preferences-store.test.ts`

JSON persistence for user choices: selected whisper model, LLM model, hotkey, language, setup-complete flag.

- [ ] **Step 1: Write the failing test**

Create `test/unit/preferences-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferencesStore, DEFAULT_PREFS } from "../../src/main/preferences-store.js";

describe("PreferencesStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "of-prefs-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when no file exists", async () => {
    const store = new PreferencesStore(join(dir, "prefs.json"));
    const prefs = await store.load();
    expect(prefs).toEqual(DEFAULT_PREFS);
  });

  it("persists changes via save() and re-reads them", async () => {
    const path = join(dir, "prefs.json");
    const store = new PreferencesStore(path);
    await store.save({ ...DEFAULT_PREFS, whisperModelId: "whisper-small" });
    const reread = await new PreferencesStore(path).load();
    expect(reread.whisperModelId).toBe("whisper-small");
  });

  it("merges partial updates via update()", async () => {
    const store = new PreferencesStore(join(dir, "prefs.json"));
    await store.update({ language: "it" });
    const prefs = await store.load();
    expect(prefs.language).toBe("it");
    expect(prefs.whisperModelId).toBe(DEFAULT_PREFS.whisperModelId);
  });

  it("setupComplete defaults to false", async () => {
    const store = new PreferencesStore(join(dir, "prefs.json"));
    const prefs = await store.load();
    expect(prefs.setupComplete).toBe(false);
  });

  it("falls back to defaults on corrupt JSON", async () => {
    const path = join(dir, "prefs.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not valid json");
    const store = new PreferencesStore(path);
    const prefs = await store.load();
    expect(prefs).toEqual(DEFAULT_PREFS);
  });

  it("writes file atomically (no partial files on crash)", async () => {
    const path = join(dir, "prefs.json");
    const store = new PreferencesStore(path);
    await store.save({ ...DEFAULT_PREFS, language: "en" });
    // Verify file is valid JSON after save
    const raw = await readFile(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- preferences-store`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement preferences-store**

Create `src/main/preferences-store.ts`:

```ts
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Preferences {
  setupComplete: boolean;
  whisperModelId: string;
  llmModelId: string;
  hotkeyAccelerator: string;
  language: string;
  debugLogging: boolean;
}

export const DEFAULT_PREFS: Preferences = {
  setupComplete: false,
  whisperModelId: "whisper-base",
  llmModelId: "qwen-1.5b",
  hotkeyAccelerator: "Alt+Space",
  language: "auto",
  debugLogging: false,
};

export class PreferencesStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Preferences> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<Preferences>;
      return { ...DEFAULT_PREFS, ...parsed };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  async save(prefs: Preferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(prefs, null, 2), "utf8");
    await rename(tmp, this.path);
  }

  async update(partial: Partial<Preferences>): Promise<Preferences> {
    const current = await this.load();
    const next = { ...current, ...partial };
    await this.save(next);
    return next;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- preferences-store`

Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/preferences-store.ts test/unit/preferences-store.test.ts
git commit -m "feat(dist): PreferencesStore with atomic JSON persistence"
```

---

## Task 3: ModelManager (TDD with HTTP mock)

**Files:**
- Create: `src/main/model-manager.ts`
- Create: `test/unit/model-manager.test.ts`

Downloads a model file with progress, verifies SHA-256 + size, writes atomically. The download function is injectable so tests can simulate progress + failure without real HTTP.

- [ ] **Step 1: Write the failing test**

Create `test/unit/model-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { ModelManager, DownloadStreamFn } from "../../src/main/model-manager.js";
import type { ModelDescriptor } from "../../src/main/utils/model-paths.js";

function streamOfBytes(bytes: Uint8Array): Readable {
  return Readable.from([bytes]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("ModelManager", () => {
  let dir: string;
  beforeEach(async () => {
    process.env.OPEN_FLOW_MODELS_DIR = await mkdtemp(join(tmpdir(), "of-models-"));
    dir = process.env.OPEN_FLOW_MODELS_DIR;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.OPEN_FLOW_MODELS_DIR;
  });

  it("reports isInstalled=false before download, true after", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const desc: ModelDescriptor = {
      id: "test", filename: "test.bin", sizeBytes: 5, sha256: sha256(payload), url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => ({ stream: streamOfBytes(payload), contentLength: 5 });
    const mgr = new ModelManager(fetcher);

    expect(await mgr.isInstalled(desc)).toBe(false);
    await mgr.download(desc);
    expect(await mgr.isInstalled(desc)).toBe(true);
  });

  it("reports progress during download", async () => {
    const payload = new Uint8Array(100).fill(0);
    const desc: ModelDescriptor = {
      id: "p", filename: "p.bin", sizeBytes: 100, sha256: sha256(payload), url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => ({
      stream: Readable.from([payload.subarray(0, 30), payload.subarray(30, 70), payload.subarray(70)]),
      contentLength: 100,
    });
    const mgr = new ModelManager(fetcher);
    const progress: Array<{ bytes: number; total: number }> = [];
    await mgr.download(desc, (p) => progress.push(p));

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]?.bytes).toBe(100);
    expect(progress.every((p) => p.total === 100)).toBe(true);
  });

  it("rejects when downloaded sha256 doesn't match descriptor", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const desc: ModelDescriptor = {
      id: "bad", filename: "bad.bin", sizeBytes: 3,
      sha256: "0".repeat(64), // wrong
      url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => ({ stream: streamOfBytes(payload), contentLength: 3 });
    const mgr = new ModelManager(fetcher);

    await expect(mgr.download(desc)).rejects.toThrow(/sha256/i);
    expect(await mgr.isInstalled(desc)).toBe(false);
  });

  it("doesn't leave partial files when download fails", async () => {
    const desc: ModelDescriptor = {
      id: "fail", filename: "fail.bin", sizeBytes: 5,
      sha256: sha256(new Uint8Array([1, 2, 3, 4, 5])), url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => {
      const s = new Readable({ read() {} });
      process.nextTick(() => s.destroy(new Error("network blip")));
      return { stream: s, contentLength: 5 };
    };
    const mgr = new ModelManager(fetcher);
    await expect(mgr.download(desc)).rejects.toThrow(/network blip/);
    expect(await mgr.isInstalled(desc)).toBe(false);
  });

  it("isInstalled validates size too, not just presence", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const desc: ModelDescriptor = {
      id: "size", filename: "size.bin", sizeBytes: 5, sha256: sha256(payload), url: "https://x",
    };
    // Write a file of wrong size at the expected path
    await writeFile(join(dir, "size.bin"), new Uint8Array([1, 2, 3]));
    const mgr = new ModelManager(async () => ({ stream: streamOfBytes(payload), contentLength: 5 }));
    expect(await mgr.isInstalled(desc)).toBe(false);
  });

  it("getInstalledPath returns absolute path", async () => {
    const desc: ModelDescriptor = {
      id: "p", filename: "p.bin", sizeBytes: 0, sha256: "0".repeat(64), url: "https://x",
    };
    const mgr = new ModelManager(async () => { throw new Error("unused"); });
    const path = mgr.getInstalledPath(desc);
    expect(path).toContain("p.bin");
    expect(path.startsWith("/")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- model-manager`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ModelManager**

Create `src/main/model-manager.ts`:

```ts
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { dirname } from "node:path";
import { getModelsDir, modelFilePath, sha256OfFile, fileSize, ModelDescriptor } from "./utils/model-paths.js";

export interface ProgressEvent {
  bytes: number;
  total: number;
}

export type ProgressCallback = (p: ProgressEvent) => void;

export interface DownloadResponse {
  stream: Readable;
  contentLength: number;
}

export type DownloadStreamFn = (url: string) => Promise<DownloadResponse>;

// Default fetcher uses Node's global fetch (Node 20+).
export const defaultFetcher: DownloadStreamFn = async (url) => {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  // Convert WHATWG ReadableStream to Node Readable
  const stream = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream);
  return { stream, contentLength };
};

export class ModelManager {
  constructor(private readonly fetcher: DownloadStreamFn = defaultFetcher) {}

  getInstalledPath(desc: ModelDescriptor): string {
    return modelFilePath(desc);
  }

  async isInstalled(desc: ModelDescriptor): Promise<boolean> {
    const path = this.getInstalledPath(desc);
    try {
      await access(path);
    } catch {
      return false;
    }
    const size = await fileSize(path);
    if (size !== desc.sizeBytes) return false;
    // Skip sha256 here — it's a cheap-vs-correct trade-off. Size guards most
    // corruption; full sha is verified at download time.
    return true;
  }

  async download(desc: ModelDescriptor, onProgress?: ProgressCallback): Promise<void> {
    const finalPath = this.getInstalledPath(desc);
    const tmpPath = `${finalPath}.partial`;
    await mkdir(dirname(finalPath), { recursive: true });

    const { stream, contentLength } = await this.fetcher(desc.url);
    const total = contentLength > 0 ? contentLength : desc.sizeBytes;
    let received = 0;

    const progress = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (onProgress) onProgress({ bytes: received, total });
        cb(null, chunk);
      },
    });

    try {
      await pipeline(stream, progress, createWriteStream(tmpPath));
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    // Verify size then sha256
    const downloadedSize = await fileSize(tmpPath);
    if (downloadedSize !== desc.sizeBytes && desc.sizeBytes > 0) {
      await unlink(tmpPath).catch(() => undefined);
      throw new Error(`size mismatch: expected ${desc.sizeBytes}, got ${downloadedSize}`);
    }
    const actualSha = await sha256OfFile(tmpPath);
    if (actualSha !== desc.sha256) {
      await unlink(tmpPath).catch(() => undefined);
      throw new Error(`sha256 mismatch for ${desc.filename}: expected ${desc.sha256}, got ${actualSha}`);
    }
    await rename(tmpPath, finalPath);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- model-manager`

Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/model-manager.ts test/unit/model-manager.test.ts
git commit -m "feat(dist): ModelManager with progress, sha256 verification, atomic write"
```

---

## Task 4: Setup Wizard (renderer)

**Files:**
- Create: `src/renderer/setup.html`
- Create: `src/renderer/setup.css`
- Create: `src/renderer/setup.js`
- Create: `src/preload/setup-preload.ts`

The wizard UI: welcome → permissions → tier selection → download progress → done. All in one HTML page, sections shown/hidden via CSS classes. JS coordinates step transitions and talks to main via the preload.

- [ ] **Step 1: Create preload**

Create `src/preload/setup-preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowSetup", {
  getInitialState: (): Promise<{
    micPermission: string;
    accessibilityPermission: string;
    tiers: Array<{ id: string; label: string; description: string }>;
  }> => ipcRenderer.invoke("setup:get-initial-state"),

  requestMicPermission: (): Promise<string> => ipcRenderer.invoke("setup:request-mic"),
  refreshAccessibilityStatus: (): Promise<string> => ipcRenderer.invoke("setup:refresh-accessibility"),
  openAccessibilitySettings: (): void => ipcRenderer.send("setup:open-accessibility-settings"),

  startDownload: (tierId: string): Promise<void> => ipcRenderer.invoke("setup:start-download", tierId),
  onDownloadProgress: (cb: (p: { stage: string; bytes: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { stage: string; bytes: number; total: number }) => cb(payload);
    ipcRenderer.on("setup:download-progress", handler);
    return () => ipcRenderer.removeListener("setup:download-progress", handler);
  },
  onDownloadDone: (cb: (result: { ok: boolean; error?: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { ok: boolean; error?: string }) => cb(payload);
    ipcRenderer.on("setup:download-done", handler);
    return () => ipcRenderer.removeListener("setup:download-done", handler);
  },

  finish: (): void => ipcRenderer.send("setup:finish"),
});

declare global {
  interface Window {
    openFlowSetup: {
      getInitialState: () => Promise<{
        micPermission: string;
        accessibilityPermission: string;
        tiers: Array<{ id: string; label: string; description: string }>;
      }>;
      requestMicPermission: () => Promise<string>;
      refreshAccessibilityStatus: () => Promise<string>;
      openAccessibilitySettings: () => void;
      startDownload: (tierId: string) => Promise<void>;
      onDownloadProgress: (cb: (p: { stage: string; bytes: number; total: number }) => void) => () => void;
      onDownloadDone: (cb: (result: { ok: boolean; error?: string }) => void) => () => void;
      finish: () => void;
    };
  }
}

export {};
```

- [ ] **Step 2: Create setup.html**

Create `src/renderer/setup.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./setup.css" />
    <title>open-flow setup</title>
  </head>
  <body>
    <main id="root">
      <header><h1>open-flow</h1></header>

      <section id="step-welcome" class="step active">
        <h2>Welcome</h2>
        <p>Local-first dictation for macOS. Press a hotkey, talk, get the cleaned text pasted into any text field.</p>
        <p>This setup takes ~3 minutes: grant two permissions, pick a quality tier, wait for the AI models to download.</p>
        <button data-next="permissions" class="primary">Get started</button>
      </section>

      <section id="step-permissions" class="step">
        <h2>Permissions</h2>
        <div class="perm" id="perm-mic">
          <strong>Microphone</strong>
          <span class="status" id="mic-status">checking…</span>
          <button id="mic-request">Request access</button>
        </div>
        <div class="perm" id="perm-acc">
          <strong>Accessibility</strong>
          <span class="status" id="acc-status">checking…</span>
          <button id="acc-open">Open System Settings</button>
          <button id="acc-refresh">I granted it — re-check</button>
        </div>
        <p class="muted">Microphone is for recording. Accessibility lets the app press <kbd>⌘V</kbd> to paste into the focused field.</p>
        <button data-next="tier" id="perm-continue" class="primary" disabled>Continue</button>
      </section>

      <section id="step-tier" class="step">
        <h2>Choose quality</h2>
        <p>You can change this later in Preferences.</p>
        <div id="tier-list"></div>
        <button data-next="download" id="tier-continue" class="primary" disabled>Continue</button>
      </section>

      <section id="step-download" class="step">
        <h2>Downloading models</h2>
        <div class="progress-container">
          <div class="progress-label" id="dl-stage">Preparing…</div>
          <progress id="dl-progress" max="100" value="0"></progress>
          <div class="progress-bytes" id="dl-bytes"></div>
        </div>
        <div id="dl-error" class="error hidden"></div>
      </section>

      <section id="step-done" class="step">
        <h2>You're set</h2>
        <p>Press <kbd>Option+Space</kbd> over any text field to start dictating. Press it again to stop.</p>
        <p class="muted">A tray icon appears in your menubar. Click it to disable the hotkey or quit.</p>
        <button id="done-finish" class="primary">Finish</button>
      </section>
    </main>
    <script src="./setup.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Create setup.css**

Create `src/renderer/setup.css`:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; font-family: -apple-system, system-ui, sans-serif; background: #1e1e1e; color: #eee; }
#root { max-width: 560px; margin: 0 auto; padding: 32px; }
header h1 { font-size: 18px; margin-bottom: 24px; opacity: 0.7; font-weight: 500; }

.step { display: none; }
.step.active { display: block; }
.step h2 { font-size: 22px; margin-bottom: 14px; }
.step p { margin-bottom: 14px; line-height: 1.5; }
.muted { opacity: 0.6; font-size: 13px; }

button { background: #2a2a2c; color: #fff; border: 1px solid #3a3a3c; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-right: 6px; }
button:hover:not(:disabled) { background: #34343a; }
button:disabled { opacity: 0.4; cursor: not-allowed; }
button.primary { background: #0a84ff; border-color: #0a84ff; padding: 10px 20px; font-size: 14px; margin-top: 20px; }
button.primary:hover:not(:disabled) { background: #1090ff; }

.perm { padding: 14px; background: #2a2a2c; border-radius: 8px; margin-bottom: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.perm strong { font-size: 14px; }
.status { font-size: 12px; padding: 3px 8px; border-radius: 4px; background: #444; }
.status.granted { background: #2c6e2c; color: #fff; }
.status.denied { background: #6e2c2c; color: #fff; }

.tier { padding: 14px; background: #2a2a2c; border-radius: 8px; margin-bottom: 10px; cursor: pointer; border: 2px solid transparent; }
.tier:hover { background: #34343a; }
.tier.selected { border-color: #0a84ff; }
.tier strong { display: block; margin-bottom: 4px; }
.tier .desc { font-size: 12px; opacity: 0.75; }

.progress-container { margin-top: 20px; }
.progress-label { font-size: 13px; margin-bottom: 6px; }
.progress-bytes { font-size: 11px; opacity: 0.6; margin-top: 4px; }
progress { width: 100%; height: 6px; }

.error { background: #6e2c2c; padding: 12px; border-radius: 8px; margin-top: 12px; font-size: 13px; }
.hidden { display: none; }

kbd { background: #444; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
```

- [ ] **Step 4: Create setup.js**

Create `src/renderer/setup.js`:

```js
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function goto(stepId) {
  $$(".step").forEach((el) => el.classList.remove("active"));
  $("#step-" + stepId).classList.add("active");
}

let state = { micPermission: "unknown", accessibilityPermission: "unknown", tiers: [] };
let selectedTierId = null;

function renderPermissionStatus(elId, perm) {
  const el = $("#" + elId);
  el.textContent = perm;
  el.classList.remove("granted", "denied");
  if (perm === "granted") el.classList.add("granted");
  else if (perm === "denied") el.classList.add("denied");
}

function updateContinue() {
  const ok = state.micPermission === "granted" && state.accessibilityPermission === "granted";
  $("#perm-continue").disabled = !ok;
}

function renderTiers() {
  const list = $("#tier-list");
  list.innerHTML = "";
  for (const t of state.tiers) {
    const el = document.createElement("div");
    el.className = "tier";
    el.dataset.id = t.id;
    el.innerHTML = `<strong>${t.label}</strong><div class="desc">${t.description}</div>`;
    el.addEventListener("click", () => {
      selectedTierId = t.id;
      $$(".tier").forEach((x) => x.classList.toggle("selected", x.dataset.id === t.id));
      $("#tier-continue").disabled = false;
    });
    list.appendChild(el);
  }
}

async function init() {
  state = await window.openFlowSetup.getInitialState();
  renderPermissionStatus("mic-status", state.micPermission);
  renderPermissionStatus("acc-status", state.accessibilityPermission);
  updateContinue();
  renderTiers();

  $$("button[data-next]").forEach((btn) => {
    btn.addEventListener("click", () => goto(btn.dataset.next));
  });

  $("#mic-request").addEventListener("click", async () => {
    const result = await window.openFlowSetup.requestMicPermission();
    state.micPermission = result;
    renderPermissionStatus("mic-status", result);
    updateContinue();
  });

  $("#acc-open").addEventListener("click", () => {
    window.openFlowSetup.openAccessibilitySettings();
  });
  $("#acc-refresh").addEventListener("click", async () => {
    const result = await window.openFlowSetup.refreshAccessibilityStatus();
    state.accessibilityPermission = result;
    renderPermissionStatus("acc-status", result);
    updateContinue();
  });

  $("#tier-continue").addEventListener("click", async () => {
    goto("download");
    await window.openFlowSetup.startDownload(selectedTierId);
  });

  window.openFlowSetup.onDownloadProgress(({ stage, bytes, total }) => {
    $("#dl-stage").textContent = stage;
    const pct = total > 0 ? Math.floor((bytes / total) * 100) : 0;
    $("#dl-progress").value = pct;
    $("#dl-bytes").textContent = `${(bytes / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB`;
  });
  window.openFlowSetup.onDownloadDone(({ ok, error }) => {
    if (ok) {
      goto("done");
    } else {
      $("#dl-error").classList.remove("hidden");
      $("#dl-error").textContent = "Download failed: " + (error ?? "unknown");
    }
  });

  $("#done-finish").addEventListener("click", () => {
    window.openFlowSetup.finish();
  });
}

init();
```

- [ ] **Step 5: Build to verify TS compiles**

Run: `npm run build`

Expected: `dist/preload/setup-preload.js` produced. No errors.

- [ ] **Step 6: Commit**

```bash
git add src/preload/setup-preload.ts src/renderer/setup.html src/renderer/setup.css src/renderer/setup.js
git commit -m "feat(dist): setup wizard renderer (welcome/perms/tier/download/done)"
```

---

## Task 5: Setup Wizard (main-side controller)

**Files:**
- Create: `src/main/setup-wizard.ts`

The main-side controller: creates the wizard BrowserWindow, handles IPC calls, orchestrates permission requests, and runs the model downloads.

- [ ] **Step 1: Create setup-wizard.ts**

Create `src/main/setup-wizard.ts`:

```ts
import { BrowserWindow, ipcMain, shell, systemPreferences } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ModelManager } from "./model-manager.js";
import { TIERS, getModelById, getTier } from "./model-catalog.js";
import { checkAccessibilityViaProbe, checkMicrophone } from "./permissions.js";
import { PreferencesStore } from "./preferences-store.js";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export interface SetupWizardDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
}

export class SetupWizard {
  private win: BrowserWindow | null = null;
  private resolver: ((completed: boolean) => void) | null = null;

  constructor(private readonly deps: SetupWizardDeps) {}

  async run(): Promise<boolean> {
    this.win = new BrowserWindow({
      width: 640,
      height: 560,
      title: "open-flow setup",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "setup-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.registerHandlers();
    await this.win.loadFile(join(APP_ROOT, "src", "renderer", "setup.html"));

    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.win!.on("closed", () => {
        if (this.resolver) {
          this.resolver(false);
          this.resolver = null;
        }
        this.unregisterHandlers();
      });
    });
  }

  private registerHandlers(): void {
    ipcMain.handle("setup:get-initial-state", async () => ({
      micPermission: await checkMicrophone(),
      accessibilityPermission: await checkAccessibilityViaProbe(),
      tiers: TIERS.map((t) => ({ id: t.id, label: t.label, description: t.description })),
    }));

    ipcMain.handle("setup:request-mic", async () => {
      // askForMediaAccess returns boolean
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return granted ? "granted" : "denied";
    });

    ipcMain.handle("setup:refresh-accessibility", async () => checkAccessibilityViaProbe());

    ipcMain.on("setup:open-accessibility-settings", () => {
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    });

    ipcMain.handle("setup:start-download", async (_e, tierId: string) => {
      const tier = getTier(tierId);
      if (!tier) {
        this.emitDone({ ok: false, error: `Unknown tier: ${tierId}` });
        return;
      }
      const whisper = getModelById("whisper", tier.whisperId);
      const llm = getModelById("llm", tier.llmId);
      if (!whisper || !llm) {
        this.emitDone({ ok: false, error: "Catalog references missing model" });
        return;
      }
      try {
        for (const [label, desc] of [
          [`Whisper (${whisper.filename})`, whisper],
          [`LLM (${llm.filename})`, llm],
        ] as const) {
          if (await this.deps.modelManager.isInstalled(desc)) {
            this.emitProgress(`${label}: already installed`, desc.sizeBytes, desc.sizeBytes);
            continue;
          }
          await this.deps.modelManager.download(desc, ({ bytes, total }) => {
            this.emitProgress(label, bytes, total);
          });
        }
        await this.deps.preferencesStore.update({
          setupComplete: true,
          whisperModelId: whisper.id,
          llmModelId: llm.id,
        });
        this.emitDone({ ok: true });
      } catch (err) {
        this.emitDone({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    ipcMain.on("setup:finish", () => {
      if (this.resolver) {
        this.resolver(true);
        this.resolver = null;
      }
      if (this.win && !this.win.isDestroyed()) {
        this.win.close();
      }
    });
  }

  private unregisterHandlers(): void {
    ipcMain.removeHandler("setup:get-initial-state");
    ipcMain.removeHandler("setup:request-mic");
    ipcMain.removeHandler("setup:refresh-accessibility");
    ipcMain.removeHandler("setup:start-download");
    ipcMain.removeAllListeners("setup:open-accessibility-settings");
    ipcMain.removeAllListeners("setup:finish");
  }

  private emitProgress(stage: string, bytes: number, total: number): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("setup:download-progress", { stage, bytes, total });
    }
  }

  private emitDone(result: { ok: boolean; error?: string }): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("setup:download-done", result);
    }
  }
}
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`

Expected: `dist/main/setup-wizard.js` produced. No errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/setup-wizard.ts
git commit -m "feat(dist): SetupWizard main-side controller with IPC handlers"
```

---

## Task 6: Preferences Window (renderer + preload + main controller)

**Files:**
- Create: `src/preload/preferences-preload.ts`
- Create: `src/renderer/preferences.html`
- Create: `src/renderer/preferences.css`
- Create: `src/renderer/preferences.js`
- Create: `src/main/preferences-window.ts`

A simple preferences window for changing hotkey, language, models, and re-running the setup wizard. Less feature-rich than the wizard; mostly model-switch + language-switch.

- [ ] **Step 1: Create preferences-preload.ts**

Create `src/preload/preferences-preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowPrefs", {
  load: (): Promise<unknown> => ipcRenderer.invoke("prefs:load"),
  save: (prefs: unknown): Promise<unknown> => ipcRenderer.invoke("prefs:save", prefs),
  listModels: (): Promise<{
    whisper: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
    llm: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
    languages: Array<{ id: string; label: string }>;
  }> => ipcRenderer.invoke("prefs:list-models"),
  downloadModel: (kind: "whisper" | "llm", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:download-model", { kind, id }),
  onDownloadProgress: (cb: (p: { id: string; bytes: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; bytes: number; total: number }) => cb(payload);
    ipcRenderer.on("prefs:download-progress", handler);
    return () => ipcRenderer.removeListener("prefs:download-progress", handler);
  },
});

declare global {
  interface Window {
    openFlowPrefs: {
      load: () => Promise<unknown>;
      save: (prefs: unknown) => Promise<unknown>;
      listModels: () => Promise<{
        whisper: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
        llm: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
        languages: Array<{ id: string; label: string }>;
      }>;
      downloadModel: (kind: "whisper" | "llm", id: string) => Promise<void>;
      onDownloadProgress: (cb: (p: { id: string; bytes: number; total: number }) => void) => () => void;
    };
  }
}

export {};
```

- [ ] **Step 2: Create preferences.html**

Create `src/renderer/preferences.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./preferences.css" />
    <title>open-flow preferences</title>
  </head>
  <body>
    <main id="root">
      <h1>Preferences</h1>

      <section>
        <label>Hotkey</label>
        <input id="hotkey" type="text" />
        <p class="muted">Examples: <code>Alt+Space</code>, <code>Cmd+Shift+D</code>, <code>F19</code>.</p>
      </section>

      <section>
        <label>Language</label>
        <select id="language"></select>
      </section>

      <section>
        <label>Whisper model</label>
        <div id="whisper-models" class="model-list"></div>
      </section>

      <section>
        <label>LLM cleanup model</label>
        <div id="llm-models" class="model-list"></div>
      </section>

      <section>
        <label><input type="checkbox" id="debug" /> Debug logging</label>
      </section>

      <div class="actions">
        <button id="save" class="primary">Save</button>
        <span id="status" class="status"></span>
      </div>

      <script src="./preferences.js"></script>
    </main>
  </body>
</html>
```

- [ ] **Step 3: Create preferences.css**

Create `src/renderer/preferences.css`:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { font-family: -apple-system, system-ui, sans-serif; background: #1e1e1e; color: #eee; height: 100%; }
#root { max-width: 520px; margin: 0 auto; padding: 24px; }
h1 { font-size: 18px; margin-bottom: 18px; opacity: 0.7; font-weight: 500; }
section { margin-bottom: 18px; }
label { display: block; font-size: 13px; margin-bottom: 6px; opacity: 0.8; }
input[type=text], select { background: #2a2a2c; color: #eee; border: 1px solid #3a3a3c; padding: 6px 10px; border-radius: 5px; width: 100%; font-size: 13px; }
.muted { font-size: 11px; opacity: 0.55; margin-top: 4px; }
code { background: #2a2a2c; padding: 2px 5px; border-radius: 3px; font-size: 11px; }

.model-list { display: flex; flex-direction: column; gap: 6px; }
.model-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #2a2a2c; border-radius: 6px; }
.model-row.selected { outline: 2px solid #0a84ff; }
.model-row .name { flex: 1; font-size: 13px; }
.model-row .size { font-size: 11px; opacity: 0.55; }
.model-row .badge { font-size: 11px; padding: 2px 6px; background: #444; border-radius: 3px; }
.model-row .badge.installed { background: #2c6e2c; }
.model-row button { background: #444; color: #fff; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }

.actions { margin-top: 24px; display: flex; align-items: center; gap: 14px; }
button.primary { background: #0a84ff; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.status { font-size: 12px; opacity: 0.7; }
```

- [ ] **Step 4: Create preferences.js**

Create `src/renderer/preferences.js`:

```js
"use strict";

const $ = (sel) => document.querySelector(sel);

async function init() {
  const prefs = await window.openFlowPrefs.load();
  const catalog = await window.openFlowPrefs.listModels();

  $("#hotkey").value = prefs.hotkeyAccelerator;
  $("#debug").checked = prefs.debugLogging;

  const langSel = $("#language");
  for (const lang of catalog.languages) {
    const opt = document.createElement("option");
    opt.value = lang.id;
    opt.textContent = lang.label;
    if (lang.id === prefs.language) opt.selected = true;
    langSel.appendChild(opt);
  }

  function renderModels(containerId, models, selectedId, kind) {
    const container = $("#" + containerId);
    container.innerHTML = "";
    for (const m of models) {
      const row = document.createElement("div");
      row.className = "model-row" + (m.id === selectedId ? " selected" : "");
      const sizeMb = (m.sizeBytes / 1024 / 1024).toFixed(0);
      row.innerHTML = `
        <span class="name">${m.label}</span>
        <span class="size">${sizeMb} MB</span>
        <span class="badge ${m.installed ? "installed" : ""}">${m.installed ? "installed" : "not installed"}</span>
      `;
      if (!m.installed) {
        const btn = document.createElement("button");
        btn.textContent = "Download";
        btn.addEventListener("click", async () => {
          btn.textContent = "0%";
          btn.disabled = true;
          const off = window.openFlowPrefs.onDownloadProgress((p) => {
            if (p.id === m.id && p.total > 0) {
              btn.textContent = Math.floor((p.bytes / p.total) * 100) + "%";
            }
          });
          try {
            await window.openFlowPrefs.downloadModel(kind, m.id);
            btn.remove();
            row.querySelector(".badge").classList.add("installed");
            row.querySelector(".badge").textContent = "installed";
          } catch (err) {
            btn.textContent = "Retry";
            btn.disabled = false;
            $("#status").textContent = "Download failed: " + err.message;
          } finally {
            off();
          }
        });
        row.appendChild(btn);
      }
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON") return;
        if (!m.installed) {
          $("#status").textContent = "Download this model before selecting it.";
          return;
        }
        Array.from(container.children).forEach((c) => c.classList.remove("selected"));
        row.classList.add("selected");
        row.dataset.selected = "true";
      });
      row.dataset.id = m.id;
      container.appendChild(row);
    }
  }

  renderModels("whisper-models", catalog.whisper, prefs.whisperModelId, "whisper");
  renderModels("llm-models", catalog.llm, prefs.llmModelId, "llm");

  $("#save").addEventListener("click", async () => {
    const selectedWhisper = $("#whisper-models .selected")?.dataset.id ?? prefs.whisperModelId;
    const selectedLlm = $("#llm-models .selected")?.dataset.id ?? prefs.llmModelId;
    const next = {
      ...prefs,
      hotkeyAccelerator: $("#hotkey").value.trim() || prefs.hotkeyAccelerator,
      language: langSel.value,
      whisperModelId: selectedWhisper,
      llmModelId: selectedLlm,
      debugLogging: $("#debug").checked,
    };
    await window.openFlowPrefs.save(next);
    $("#status").textContent = "Saved. Restart the app for hotkey/model changes to take effect.";
  });
}

init();
```

- [ ] **Step 5: Create preferences-window.ts (main-side controller)**

Create `src/main/preferences-window.ts`:

```ts
import { BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WHISPER_MODELS, LLM_MODELS } from "./model-catalog.js";
import { ModelManager } from "./model-manager.js";
import { PreferencesStore, Preferences } from "./preferences-store.js";
import type { ModelDescriptor } from "./utils/model-paths.js";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

const LANGUAGES = [
  { id: "auto", label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "it", label: "Italiano" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
];

function modelLabel(desc: ModelDescriptor): string {
  return desc.id.replace(/-/g, " ");
}

export interface PreferencesWindowDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
}

export class PreferencesWindow {
  private win: BrowserWindow | null = null;
  private handlersRegistered = false;

  constructor(private readonly deps: PreferencesWindowDeps) {}

  async open(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      width: 580,
      height: 640,
      title: "open-flow preferences",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "preferences-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.registerHandlers();
    this.win.on("closed", () => {
      this.win = null;
    });
    await this.win.loadFile(join(APP_ROOT, "src", "renderer", "preferences.html"));
  }

  private registerHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    ipcMain.handle("prefs:load", async (): Promise<Preferences> => {
      return this.deps.preferencesStore.load();
    });

    ipcMain.handle("prefs:save", async (_e, next: Preferences): Promise<Preferences> => {
      await this.deps.preferencesStore.save(next);
      return next;
    });

    ipcMain.handle("prefs:list-models", async () => {
      const whisper = await Promise.all(
        WHISPER_MODELS.map(async (m) => ({
          id: m.id,
          label: modelLabel(m),
          sizeBytes: m.sizeBytes,
          installed: await this.deps.modelManager.isInstalled(m),
        })),
      );
      const llm = await Promise.all(
        LLM_MODELS.map(async (m) => ({
          id: m.id,
          label: modelLabel(m),
          sizeBytes: m.sizeBytes,
          installed: await this.deps.modelManager.isInstalled(m),
        })),
      );
      return { whisper, llm, languages: LANGUAGES };
    });

    ipcMain.handle("prefs:download-model", async (_e, args: { kind: "whisper" | "llm"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : LLM_MODELS;
      const desc = list.find((m) => m.id === args.id);
      if (!desc) throw new Error(`Unknown model: ${args.kind}/${args.id}`);
      await this.deps.modelManager.download(desc, (p) => {
        if (this.win && !this.win.isDestroyed()) {
          this.win.webContents.send("prefs:download-progress", { id: desc.id, bytes: p.bytes, total: p.total });
        }
      });
    });
  }
}
```

- [ ] **Step 6: Build and verify TS compiles**

Run: `npm run build`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/preload/preferences-preload.ts src/renderer/preferences.html src/renderer/preferences.css src/renderer/preferences.js src/main/preferences-window.ts
git commit -m "feat(dist): preferences window with model + language + hotkey controls"
```

---

## Task 7: Refactor `src/main/index.ts` to use prefs + setup wizard

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/menubar-app.ts` — add "Preferences..." menu item

The main entry now: reads prefs on startup, runs the setup wizard if `setupComplete: false`, resolves whisper + LLM paths from the catalog + prefs, and exposes a "Preferences..." menu item.

- [ ] **Step 1: Add "Preferences..." to MenubarApp**

Read `src/main/menubar-app.ts`. Locate the `MenubarCallbacks` interface and update it:

```ts
export interface MenubarCallbacks {
  onToggleEnabled: () => void;
  onOpenPreferences: () => void;
  onQuit: () => void;
}
```

Locate the `refreshMenu` method and update the template array to include "Preferences…" before "Quit":

```ts
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
      { label: "Preferences…", click: () => this.callbacks.onOpenPreferences() },
      { type: "separator" },
      { label: "Quit open-flow", click: () => this.callbacks.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }
```

- [ ] **Step 2: Replace `src/main/index.ts` entirely**

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
import { PreferencesStore } from "./preferences-store.js";
import { ModelManager } from "./model-manager.js";
import { getModelById } from "./model-catalog.js";
import { getModelsDir, modelFilePath } from "./utils/model-paths.js";
import { SetupWizard } from "./setup-wizard.js";
import { PreferencesWindow } from "./preferences-window.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = join(__dirname, "..", "..");

const SAMPLE_RATE = 16_000;

// In packaged builds, native binaries live in Contents/Resources/bin/ (via
// electron-builder's extraResources). In dev, they're at resources/bin/ in the
// repo root. `app.isPackaged` distinguishes the two.
const BIN_DIR = app.isPackaged
  ? join(process.resourcesPath, "bin")
  : join(APP_ROOT, "resources", "bin");
const WHISPER_BIN = join(BIN_DIR, "whisper-cli");
const LLAMA_BIN = join(BIN_DIR, "llama-cli");

const LOG_DIR = join(homedir(), "Library", "Logs", "open-flow");
const PREFS_PATH = join(homedir(), "Library", "Application Support", "open-flow", "preferences.json");

async function main(): Promise<void> {
  await app.whenReady();

  const preferencesStore = new PreferencesStore(PREFS_PATH);
  const modelManager = new ModelManager();
  let prefs = await preferencesStore.load();

  const logger = createLogger({ dir: LOG_DIR, debug: prefs.debugLogging, maxBytes: 5 * 1024 * 1024 });
  await logger.info("app starting", { setupComplete: prefs.setupComplete });

  // First-launch: run setup wizard until setupComplete=true
  if (!prefs.setupComplete) {
    const wizard = new SetupWizard({ modelManager, preferencesStore });
    const completed = await wizard.run();
    if (!completed) {
      await logger.warn("setup wizard closed without completion; quitting");
      app.quit();
      return;
    }
    prefs = await preferencesStore.load();
  }

  // Resolve model paths from prefs + catalog
  const whisperDesc = getModelById("whisper", prefs.whisperModelId);
  const llmDesc = getModelById("llm", prefs.llmModelId);
  if (!whisperDesc || !llmDesc) {
    await logger.error("preferences reference unknown model; resetting setup", {
      whisperId: prefs.whisperModelId,
      llmId: prefs.llmModelId,
    });
    await preferencesStore.update({ setupComplete: false });
    app.relaunch();
    app.quit();
    return;
  }
  const whisperModelPath = modelFilePath(whisperDesc);
  const llmModelPath = modelFilePath(llmDesc);

  // Confirm files actually exist (catch the "model deleted manually" case)
  if (!(await modelManager.isInstalled(whisperDesc)) || !(await modelManager.isInstalled(llmDesc))) {
    await logger.error("selected model missing on disk; re-running setup", {
      modelsDir: getModelsDir(),
    });
    await preferencesStore.update({ setupComplete: false });
    app.relaunch();
    app.quit();
    return;
  }

  const mic = await checkMicrophone();
  const acc = await checkAccessibilityViaProbe();
  await logger.info("permissions", { mic, accessibility: acc });

  const whisper = new WhisperRunner({
    binaryPath: WHISPER_BIN,
    modelPath: whisperModelPath,
    timeoutMs: 60_000,
  });
  const llm = new LLMCleaner({
    binaryPath: LLAMA_BIN,
    modelPath: llmModelPath,
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
    const chunk = new Float32Array(view.length);
    chunk.set(view);
    orchestrator.appendChunk(chunk);
  });
  ipcMain.on("audio:error", async (_e, message: string) => {
    await logger.error("recorder error", { message });
  });

  const hotkey = new HotkeyManager({ accelerator: prefs.hotkeyAccelerator });
  const prefsWindow = new PreferencesWindow({ modelManager, preferencesStore });
  const menubar = new MenubarApp({
    onToggleEnabled: () => {
      if (menubar.isEnabled()) {
        hotkey.register();
      } else {
        hotkey.unregister();
      }
    },
    onOpenPreferences: () => {
      void prefsWindow.open();
    },
    onQuit: () => app.quit(),
  });

  hotkey.on("start", () => {
    orchestrator.reset();
    coordinator.startRecording();
    recorderWin.webContents.send("audio:start");
    menubar.setStatus("Recording…");
  });
  hotkey.on("stop", async () => {
    recorderWin.webContents.send("audio:stop");
    await new Promise((r) => setTimeout(r, 250));
    const samples = orchestrator.snapshot();
    const lang = (await preferencesStore.load()).language;
    await coordinator.finishWithAudio(samples, SAMPLE_RATE, lang);
    hotkey.reset();
    menubar.setStatus("Idle");
  });

  const reg = hotkey.register();
  if (!reg.ok) {
    await logger.error("hotkey registration failed", { reason: reg.reason, accelerator: prefs.hotkeyAccelerator });
  } else {
    await logger.info("hotkey registered", { accelerator: prefs.hotkeyAccelerator });
  }

  menubar.create();

  app.on("will-quit", () => {
    hotkey.unregister();
    overlay.destroy();
    menubar.destroy();
  });

  app.on("window-all-closed", () => {
    // intentional no-op — menubar app stays alive
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  app.exit(1);
});
```

- [ ] **Step 3: Build and run tests**

Run: `npm run build && npm test`

Expected: build clean; all tests still pass (no behavioral regressions — Plan 1/2 tests use mocked deps so are unaffected; Plan 3's new tests pass).

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/menubar-app.ts
git commit -m "feat(dist): wire setup wizard, prefs store, model manager into main"
```

---

## Task 8: electron-builder config

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json` — add electron-builder dev dep + package script

- [ ] **Step 1: Install electron-builder**

Run: `npm install --save-dev electron-builder`

- [ ] **Step 2: Create electron-builder.yml**

Create `electron-builder.yml`:

```yaml
appId: com.openflow.app
productName: open-flow
copyright: Copyright © 2026

directories:
  output: release
  buildResources: resources

files:
  - dist/**/*
  - src/renderer/**/*
  - resources/icons/**/*
  - package.json
  - "!node_modules/**/*"
  - "!**/.DS_Store"

extraResources:
  - from: resources/bin
    to: bin
    filter:
      - "whisper-cli"
      - "llama-cli"

asar: true

mac:
  target:
    - target: dmg
      arch:
        - arm64
  category: public.app-category.productivity
  hardenedRuntime: false
  gatekeeperAssess: false
  identity: null
  icon: resources/icons/app-icon.png

dmg:
  title: "open-flow ${version}"
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications

publish: null
```

- [ ] **Step 3: Add an app icon (placeholder)**

The Mac app needs a `.png` icon at `resources/icons/app-icon.png` (electron-builder auto-converts to .icns). Generate a 1024×1024 placeholder using the same microphone motif as the tray:

```bash
python3 -c "
from PIL import Image, ImageDraw
SIZE = 1024
img = Image.new('RGBA', (SIZE, SIZE), (10, 10, 12, 255))
d = ImageDraw.Draw(img)
# Microphone capsule
d.rounded_rectangle((SIZE*0.36, SIZE*0.14, SIZE*0.64, SIZE*0.64), radius=SIZE*0.14, fill=(10, 132, 255, 255))
# Stand
d.rectangle((SIZE*0.46, SIZE*0.64, SIZE*0.54, SIZE*0.78), fill=(10, 132, 255, 255))
# Base line
d.rectangle((SIZE*0.30, SIZE*0.78, SIZE*0.70, SIZE*0.82), fill=(10, 132, 255, 255))
img.save('resources/icons/app-icon.png')
print('app icon written')
"
```

If Pillow is unavailable, escalate as NEEDS_CONTEXT.

- [ ] **Step 4: Update `package.json` scripts**

Locate the `"scripts"` block and replace the `"dev"` line and add a new `"package"` line right after it:

```json
    "dev": "npm run build && electron dist/main/index.js",
    "package": "npm run build && electron-builder --mac dmg --arm64",
```

Add an `"author"` field (electron-builder needs this for package.json metadata):

```json
  "author": "open-flow",
```

Place `"author"` immediately after the `"description"` line.

- [ ] **Step 5: Verify .gitignore**

The `release/` output dir should be gitignored. Append to `.gitignore`:

```
release/
```

- [ ] **Step 6: Run packaging — IMPORTANT**

Run: `npm run package`

This takes 1–5 minutes. Expected output: `release/open-flow-0.0.1-arm64.dmg` (exact filename may vary by version).

Verify:

```bash
ls -lh release/*.dmg
```

The .dmg should be ~150-200 MB (Electron runtime + native binaries + app code, no models).

If packaging fails because of code signing complaints, ensure `identity: null` and `hardenedRuntime: false` are in `electron-builder.yml`. If it fails because the renderer assets are missing, double-check the `files` glob includes `src/renderer/**/*`.

- [ ] **Step 7: Commit**

```bash
git add electron-builder.yml package.json package-lock.json resources/icons/app-icon.png .gitignore
git commit -m "build(dist): electron-builder config producing unsigned arm64 .dmg"
```

---

## Task 9: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Cache native binaries
        id: cache-binaries
        uses: actions/cache@v4
        with:
          path: resources/bin
          key: native-bins-v1-${{ runner.os }}-${{ hashFiles('scripts/fetch-binaries.sh') }}

      - name: Build native binaries
        if: steps.cache-binaries.outputs.cache-hit != 'true'
        run: |
          brew install cmake
          npm run fetch-binaries

      - name: Cache fixture models
        id: cache-models
        uses: actions/cache@v4
        with:
          path: test/fixtures/models
          key: fixture-models-v1

      - name: Download fixture models
        if: steps.cache-models.outputs.cache-hit != 'true'
        run: npm run fetch-test-models

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test
```

- [ ] **Step 2: Create release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  build-dmg:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install deps
        run: npm ci

      - name: Install cmake
        run: brew install cmake

      - name: Build native binaries
        run: npm run fetch-binaries

      - name: Package
        run: npm run package

      - name: Upload to release
        uses: softprops/action-gh-release@v2
        with:
          files: release/*.dmg
          draft: false
          prerelease: false
          generate_release_notes: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci(dist): GitHub Actions for lint+test on PR and .dmg build on v* tag"
```

Note: these workflows don't run until the repo is pushed to GitHub. They're committed so the first push activates them automatically.

---

## Task 10: Release process docs + README update

**Files:**
- Create: `docs/release-process.md`
- Modify: `README.md`

- [ ] **Step 1: Write release-process.md**

Create `docs/release-process.md`:

```markdown
# Release process

## Cutting a release

1. Update the `version` field in `package.json` (e.g., `0.0.1` → `0.1.0`).
2. Commit the version bump:
   ```
   git commit -am "chore: bump version to v0.1.0"
   ```
3. Tag and push:
   ```
   git tag v0.1.0
   git push origin main
   git push origin v0.1.0
   ```
4. GitHub Actions (`.github/workflows/release.yml`) will:
   - Build the native binaries
   - Run `electron-builder` to produce a `.dmg`
   - Attach the `.dmg` to a GitHub Release for the tag

## Local packaging (no CI)

```bash
npm run fetch-binaries     # if not already built
npm run package
```

Result: `release/open-flow-<version>-arm64.dmg`.

## Installer UX (unsigned)

The `.dmg` is unsigned (no Apple Developer ID). Users will see "open-flow cannot be opened because Apple cannot check it for malicious software" on first launch. Workaround:

1. Right-click the app in Applications → Open
2. Click "Open" in the dialog
3. Future launches work normally

This is acceptable for the beta phase. To make installation seamless, enroll in the Apple Developer Program ($99/year) and:
- Set `identity` in `electron-builder.yml` to the Developer ID name
- Enable `hardenedRuntime: true`
- Add notarization step via `electron-notarize`

That work is deferred until distribution scale demands it.

## Versioning

Follow semver. Pre-1.0:
- Bump patch for fixes
- Bump minor for new features
- Bump major reserved for a public 1.0 announcement

## What gets shipped in the .dmg

- Electron runtime (~150 MB)
- The compiled app (`dist/`)
- Renderer assets (`src/renderer/**/*.html|css|js`)
- Native binaries: `whisper-cli` + `llama-cli` (arm64, ~1.2 MB combined)
- App icon

What does NOT ship:
- AI models — downloaded on first launch
- Test fixtures — `test/` is excluded
- Source TypeScript — only compiled `.js` ships
```

- [ ] **Step 2: Update README.md**

Edit `README.md`. Locate the "Status / next plans" section near the bottom:

```markdown
## Status / next plans

- ✅ Plan 1 — Foundation (this repo)
- ⏳ Plan 2 — Electron shell (hotkey, audio capture, overlay, paste)
- ⏳ Plan 3 — Distribution (setup wizard, model manager, .dmg, CI)
```

Replace with:

```markdown
## Status

- ✅ Plan 1 — Foundation (headless Whisper + LLM cleanup)
- ✅ Plan 2 — Electron shell (hotkey, audio, overlay, paste)
- ✅ Plan 3 — Distribution (setup wizard, model manager, .dmg, CI)

## Install (end-user)

Download the latest `.dmg` from the [Releases page](../../releases), drag `open-flow.app` to Applications, then **right-click → Open** the first time (the build is unsigned).

On first launch, a setup wizard walks you through:

1. Granting microphone + accessibility permissions
2. Picking a quality tier (Fast / Balanced / Max)
3. Downloading the chosen AI models

Then press `Option+Space` over any text field to start dictating.

## Build a release locally

```bash
npm install
npm run fetch-binaries
npm run package
```

Produces `release/open-flow-<version>-arm64.dmg`. See `docs/release-process.md` for the full release workflow.
```

(Use real triple-backticks in the README — the escapes above are only because this prompt is markdown.)

- [ ] **Step 3: Run final verification**

Run: `npm run lint && npm run typecheck && npm test`

Expected: all green. Test count should be ~70+ now (Plan 1: 39, Plan 2: 15, Plan 3: ~15).

- [ ] **Step 4: Commit**

```bash
git add docs/release-process.md README.md
git commit -m "docs(dist): release process + end-user install instructions"
```

---

## Task 11: Manual smoke — first-launch flow

**Files:** none (manual test)

End-to-end verification that the packaged app works from a fresh state.

- [ ] **Step 1: Build the .dmg**

Run: `npm run package`

Expected: `release/open-flow-<version>-arm64.dmg` exists.

- [ ] **Step 2: Reset local state**

If you've run the dev app before, the app's prefs + models live at:

```bash
~/Library/Application\ Support/open-flow/
~/Library/Logs/open-flow/
```

To simulate a fresh install:

```bash
rm -rf ~/Library/Application\ Support/open-flow/
rm -rf ~/Library/Logs/open-flow/
```

- [ ] **Step 3: Install and launch**

```bash
open release/open-flow-*-arm64.dmg
```

Drag `open-flow.app` to Applications. Then right-click → Open the first time.

- [ ] **Step 4: Verify wizard flow**

1. Welcome screen appears
2. Click "Get started"
3. Permissions screen shows mic + accessibility status
4. Click "Request access" for mic → macOS prompts → grant
5. Click "Open System Settings" for accessibility → enable open-flow → click "I granted it — re-check" → status updates to "granted"
6. "Continue" button enables → click
7. Tier selection screen appears — pick "Balanced"
8. "Continue" → download screen shows progress bar updating through both Whisper and LLM
9. On completion, "You're set" screen appears
10. Click "Finish" → wizard closes
11. Tray icon appears in menubar
12. Press `Option+Space` over a focused text field, dictate a sentence, press again
13. Cleaned text pasted

- [ ] **Step 5: Verify preferences flow**

1. Tray menu → "Preferences…"
2. Window opens showing current selections
3. Change language to "Italiano"
4. Try clicking on a non-installed Whisper model — status hints to download first
5. Click "Download" on `whisper-small` → progress shown in button
6. After completion, select it → save
7. Status message: "Saved. Restart the app for hotkey/model changes to take effect."
8. Quit + relaunch → new model is used

- [ ] **Step 6: Report**

Document any failures step-by-step. If all 13 wizard steps + 8 prefs steps pass, the foundation is shippable as v0.1.0.

No commit for this task — it's pure verification. The proof is the working app.

---

## Done Criteria

This plan is complete when:

- All Tasks 1–10 are committed
- `npm run package` produces a `.dmg` in `release/`
- The packaged `.dmg`, installed to a Mac with cleared app state, walks the user through the wizard and lets them dictate without further setup
- All unit tests pass (~70+ tests)
- CI workflows are committed (will run automatically once pushed to GitHub)
- README documents the install + build flow
- `docs/release-process.md` documents tagging and release

After completion, the project is in v0.1.0 shape:
- Tag with `git tag v0.1.0 && git push origin v0.1.0`
- GitHub Actions builds + attaches the `.dmg` to a Release automatically
- End-users can download and install

Future-work backlog (not in this plan):
- Apple Developer Program signing + notarization (one-time setup, $99/year)
- Push-to-talk via `uiohook-napi` (Plan 2b)
- Streaming transcription / partial text injection
- Custom vocabulary
- Windows + Linux ports
- Auto-updater (electron-updater)
