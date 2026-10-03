// Builds browser-openable copies of the renderer pages with a mocked preload
// API injected, so the UI can be inspected without launching Electron.
// Usage: npx tsx tools/renderer-preview/build.ts
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const RENDERER = join(ROOT, "src", "renderer");
const OUT = join(HERE, "out");

const PAGES = [
  { page: "setup", mock: "mock-setup-api.js" },
  { page: "preferences", mock: "mock-prefs-api.js" },
] as const;

export function injectMock(html: string, mockFile: string): string {
  const tag = `<script src="./${mockFile}"></script>`;
  const idx = html.indexOf("<script");
  if (idx === -1) throw new Error("page has no <script> tag to inject before");
  return html.slice(0, idx) + tag + "\n    " + html.slice(idx);
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await cp(RENDERER, OUT, {
    recursive: true,
    filter: (src) => !src.endsWith(".html"),
  });

  for (const { page, mock } of PAGES) {
    await cp(join(HERE, mock), join(OUT, mock));
    const html = await readFile(join(RENDERER, `${page}.html`), "utf8");
    await writeFile(join(OUT, `${page}.html`), injectMock(html, mock), "utf8");
  }

  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  console.log(`Built ${OUT}\n`);
  console.log("Open in Chrome (scenario and theme via query string):");
  console.log(`  open -a "Google Chrome" "${OUT}/preferences.html?theme=dark&scenario=installed"`);
  console.log(`  open -a "Google Chrome" "${OUT}/setup.html?theme=light&scenario=fresh"\n`);
  console.log("Headless screenshots (640 px wide):");
  for (const [page, h] of [["setup", 700], ["preferences", 900]] as const) {
    for (const theme of ["light", "dark"]) {
      console.log(
        `  "${chrome}" --headless=new --window-size=640,${h} ` +
          `--screenshot=${OUT}/${page}-${theme}.png "file://${OUT}/${page === "setup" ? "setup" : "preferences"}.html?theme=${theme}"`,
      );
    }
  }
  console.log("\nNo Chrome? Use Safari: open -a Safari <file>.html (no headless screenshots).");
}

void main();
