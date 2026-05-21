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
