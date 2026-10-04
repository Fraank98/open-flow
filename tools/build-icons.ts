/**
 * Regenerates every raster icon from the SVG sources in resources/icons/src/.
 *
 *   npx tsx tools/build-icons.ts
 *
 * Needs macOS: headless Google Chrome renders the SVGs, `iconutil` builds the .icns.
 * The squircle is already baked into the SVGs as a path, so nothing is computed here.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "resources", "icons", "src");
const OUT = join(ROOT, "resources", "icons");
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Renders `svg` at size x size px on a transparent background into `out`. */
async function render(tmp: string, svg: string, size: number, out: string): Promise<void> {
  const page = join(tmp, `p-${size}-${Math.random().toString(36).slice(2)}.html`);
  await writeFile(
    page,
    `<!doctype html><html><body style="margin:0;background:transparent">` +
      `<img src="file://${svg}" style="width:${size}px;height:${size}px;display:block"></body></html>`,
  );
  const r = spawnSync(
    CHROME,
    [
      "--headless=new",
      "--hide-scrollbars",
      "--disable-gpu",
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      `file://${page}`,
    ],
    { stdio: "ignore", timeout: 60_000 },
  );
  if (r.status !== 0 || !existsSync(out)) throw new Error(`Chrome failed rendering ${out}`);
}

async function main(): Promise<void> {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  const tmp = await mkdtemp(join(tmpdir(), "open-flow-icons-"));
  const big = join(SRC, "app-icon.svg");
  const small = join(SRC, "app-icon-small.svg");
  const tray = join(SRC, "tray-template.svg");
  try {
    await render(tmp, big, 1024, join(OUT, "app-icon.png"));
    await render(tmp, tray, 22, join(OUT, "tray-template.png"));
    await render(tmp, tray, 44, join(OUT, "tray-template@2x.png"));

    const iconset = join(tmp, "app-icon.iconset");
    await mkdir(iconset);
    // [file name, pixel size, use the small-size variant]
    const sizes: Array<[string, number, boolean]> = [
      ["icon_16x16.png", 16, true],
      ["icon_16x16@2x.png", 32, true],
      ["icon_32x32.png", 32, true],
      ["icon_32x32@2x.png", 64, true],
      ["icon_128x128.png", 128, false],
      ["icon_128x128@2x.png", 256, false],
      ["icon_256x256.png", 256, false],
      ["icon_256x256@2x.png", 512, false],
      ["icon_512x512.png", 512, false],
      ["icon_512x512@2x.png", 1024, false],
    ];
    for (const [name, px, useSmall] of sizes) {
      await render(tmp, useSmall ? small : big, px, join(iconset, name));
    }
    const r = spawnSync("iconutil", ["-c", "icns", iconset, "-o", join(OUT, "app-icon.icns")], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("iconutil failed");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
