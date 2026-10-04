// Generates the README media (docs/media/*) from the real renderer pages.
// Usage: npx tsx tools/readme-media/generate.ts [--only hero|states|frames|icon] [--keep-frames]
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const PREVIEW_OUT = join(ROOT, "tools", "renderer-preview", "out");
const OUT = join(HERE, "out");
const DEPS = join(HERE, ".deps");
const MEDIA = join(ROOT, "docs", "media");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MAX_PNG_BYTES = 400 * 1024;
const MAX_GIF_BYTES = 2 * 1024 * 1024;

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Target = "hero" | "states" | "frames" | "icon";

const PARTIAL_FULL = "Also check with Luca whether the API keys were rotated after the audit";
const HERO_FRAMES: { query: string; delay: number }[] = [
  { query: "state=recording&partial=Also check", delay: 500 },
  { query: "state=recording&partial=Also check with Luca whether", delay: 500 },
  { query: "state=recording&partial=Also check with Luca whether the API keys were", delay: 500 },
  { query: `state=recording&partial=${PARTIAL_FULL}`, delay: 900 },
  { query: "state=transcribing", delay: 700 },
  { query: "state=cleaning", delay: 700 },
  { query: "state=injecting", delay: 700 },
  { query: "hide=1&pasted=1", delay: 2500 },
];

const FRAME_SHOTS = [
  { name: "setup-permissions", title: "open-flow Setup", page: "setup.html", w: 640, h: 620, q: "step=permissions&scenario=mixed" },
  { name: "setup-quality", title: "open-flow Setup", page: "setup.html", w: 640, h: 620, q: "step=tier" },
  { name: "settings-dictation", title: "open-flow Settings", page: "preferences.html", w: 640, h: 600, q: "scenario=installed&tab=dictation" },
  { name: "settings-models", title: "open-flow Settings", page: "preferences.html", w: 640, h: 600, q: "scenario=installed&tab=models" },
  { name: "settings-reply", title: "open-flow Settings", page: "preferences.html", w: 640, h: 600, q: "scenario=reply-on&tab=reply" },
];

// Copy of injectMock() from tools/renderer-preview/build.ts (that module runs main() on import).
function injectMock(html: string, mockFile: string): string {
  const tag = `<script src="./${mockFile}"></script>`;
  const idx = html.indexOf("<script");
  if (idx === -1) throw new Error("page has no <script> tag to inject before");
  return html.slice(0, idx) + tag + "\n    " + html.slice(idx);
}

function shot(out: string, page: string, query: string, w: number, h: number, transparent = false): void {
  const args = [
    "--headless=new",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--force-device-scale-factor=2",
    "--virtual-time-budget=2500",
    `--window-size=${w},${h}`,
    `--screenshot=${out}`,
  ];
  if (transparent) args.push("--default-background-color=00000000");
  args.push(`file://${OUT}/${page}?${query}`);
  // Chrome occasionally hangs in headless mode: kill after 30 s and retry once.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(CHROME, args, { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
    if (r.status === 0 && existsSync(out)) return;
    console.warn(`Chrome failed (attempt ${attempt}) for ${page}?${query}`);
  }
  throw new Error(`Chrome failed for ${page}?${query}`);
}

async function prepareOut(): Promise<void> {
  const built = spawnSync("npx", ["tsx", "tools/renderer-preview/build.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 60_000,
  });
  if (built.status !== 0) throw new Error("renderer-preview build failed");
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await cp(PREVIEW_OUT, OUT, { recursive: true });
  await cp(join(ROOT, "src", "renderer", "overlay.css"), join(OUT, "overlay.css"));
  const overlay = await readFile(join(ROOT, "src", "renderer", "overlay.html"), "utf8");
  await writeFile(join(OUT, "overlay.html"), injectMock(overlay, "mock-overlay-api.js"), "utf8");
  for (const f of ["mock-overlay-api.js", "hero.html", "states.html", "frame.html", "icon.html"]) {
    await cp(join(HERE, f), join(OUT, f));
  }
  await cp(join(ROOT, "resources", "icons", "app-icon.png"), join(OUT, "app-icon.png"));
}

function frameQuery(theme: Theme, s: (typeof FRAME_SHOTS)[number]): string {
  return (
    `page=${s.page}&title=${encodeURIComponent(s.title)}&w=${s.w}&h=${s.h}&theme=${theme}` +
    `&q=${encodeURIComponent(s.q)}`
  );
}

// --- GIF encoding -----------------------------------------------------------
// gifenc and pngjs are installed on demand into .deps/, never into package.json.
/* eslint-disable @typescript-eslint/no-explicit-any */
function loadDeps(): { gifenc: any; PNG: any } {
  if (!existsSync(join(DEPS, "node_modules", "gifenc"))) {
    const r = spawnSync(
      "npm",
      ["install", "--prefix", DEPS, "--no-save", "--silent", "gifenc@1.0.3", "pngjs@7"],
      { stdio: "inherit", timeout: 120_000 },
    );
    if (r.status !== 0) throw new Error("npm install of gifenc/pngjs failed");
  }
  const req = createRequire(join(DEPS, "package.json"));
  return { gifenc: req("gifenc"), PNG: req("pngjs").PNG };
}

// Ordered 8x8 Bayer matrix: breaks the rings that smooth shadows produce with a 255-colour palette.
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30,
  54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
  61, 29, 53, 21,
];

function dither(data: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = ((BAYER[(y & 7) * 8 + (x & 7)] ?? 0) / 64 - 0.5) * 8;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) d[o + c] = (data[o + c] ?? 0) + t;
    }
  }
  return d;
}

// Nearest-colour mapping at full 8-bit precision (cached per 6-bit-per-channel key). gifenc's own
// applyPalette truncates to rgb565 first, which turns pure white into the nearest light grey.
function mapToPalette(data: Uint8ClampedArray, palette: number[][], transparentIndex: number): Uint8Array {
  const out = new Uint8Array(data.length / 4);
  const cache = new Map<number, number>();
  for (let i = 0; i < out.length; i++) {
    const r = data[i * 4] ?? 0, g = data[i * 4 + 1] ?? 0, b = data[i * 4 + 2] ?? 0;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let best = cache.get(key);
    if (best === undefined) {
      let bestDist = Infinity;
      best = 0;
      for (let p = 0; p < palette.length; p++) {
        if (p === transparentIndex) continue;
        const [pr = 0, pg = 0, pb = 0] = palette[p] ?? [];
        const dr = pr - r, dg = pg - g, db = pb - b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      cache.set(key, best);
    }
    out[i] = best;
  }
  return out;
}

async function encodeGif(framesDir: string, out: string, delays: number[]): Promise<void> {
  const { gifenc, PNG } = loadDeps();
  const { GIFEncoder, quantize } = gifenc;
  const files = (await readdir(framesDir)).filter((f) => f.endsWith(".png")).sort();
  const frames = await Promise.all(files.map(async (f) => PNG.sync.read(await readFile(join(framesDir, f)))));
  const { width, height } = frames[0];

  // One shared palette (254 colours + pure white + 1 transparent) from every 4th pixel of every frame.
  // The rgb565 quantizer has no exact white, which would turn the editor page grey.
  const sample: number[] = [];
  for (const f of frames) {
    for (let i = 0; i < f.data.length; i += 16) sample.push(f.data[i], f.data[i + 1], f.data[i + 2], 255);
  }
  const palette: number[][] = quantize(new Uint8ClampedArray(sample), 254, { format: "rgb565" });
  palette.push([255, 255, 255]);
  palette.push([255, 0, 255]);
  const T = palette.length - 1;

  const gif = GIFEncoder();
  let prev: Uint8Array | null = null;
  frames.forEach((f: { data: Uint8Array }, n: number) => {
    const idx = mapToPalette(dither(f.data, width, height), palette, palette.length - 1);
    const keep = Uint8Array.from(idx);
    if (prev) {
      // Frame differencing: pixels unchanged since the previous frame become transparent.
      for (let i = 0; i < idx.length; i++) if (idx[i] === prev[i]) idx[i] = T;
    }
    gif.writeFrame(idx, width, height, {
      palette,
      delay: delays[n] ?? 500,
      transparent: prev !== null,
      transparentIndex: T,
      dispose: 1,
      repeat: 0,
      first: n === 0,
    });
    prev = keep;
  });
  gif.finish();
  await writeFile(out, gif.bytes());
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function renderHero(theme: Theme, keepFrames: boolean): Promise<void> {
  const dir = join(OUT, `frames-${theme}`);
  await mkdir(dir, { recursive: true });
  HERO_FRAMES.forEach((f, i) => {
    const name = String(i + 1).padStart(2, "0");
    shot(join(dir, `${name}.png`), "hero.html", `theme=${theme}&${encodeURI(f.query)}`, 960, 520);
  });
  await encodeGif(dir, join(MEDIA, `flow-${theme}.gif`), HERO_FRAMES.map((f) => f.delay));
  if (!keepFrames) await rm(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] as Target) : undefined;
  const keepFrames = args.includes("--keep-frames");
  const want = (t: Target): boolean => !only || only === t;

  await prepareOut();
  await mkdir(MEDIA, { recursive: true });
  const written: string[] = [];

  if (want("icon")) {
    shot(join(MEDIA, "icon.png"), "icon.html", "", 256, 256, true);
    written.push("icon.png");
  }
  if (want("frames")) {
    for (const theme of THEMES) {
      for (const s of FRAME_SHOTS) {
        const file = `${s.name}-${theme}.png`;
        shot(join(MEDIA, file), "frame.html", frameQuery(theme, s), s.w + 80, s.h + 108, true);
        written.push(file);
      }
    }
  }
  if (want("states")) {
    shot(join(MEDIA, "overlay-states.png"), "states.html", "", 420, 500, true);
    written.push("overlay-states.png");
  }
  if (want("hero")) {
    for (const theme of THEMES) {
      await renderHero(theme, keepFrames);
      written.push(`flow-${theme}.gif`);
    }
  }

  let failed = false;
  console.log("\nFile                              Size");
  for (const f of written) {
    const bytes = (await stat(join(MEDIA, f))).size;
    const limit = f.endsWith(".gif") ? MAX_GIF_BYTES : MAX_PNG_BYTES;
    const over = bytes > limit;
    if (over) failed = true;
    console.log(`${f.padEnd(33)} ${(bytes / 1024).toFixed(0).padStart(5)} KB${over ? "  OVER BUDGET" : ""}`);
  }
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
