# renderer-preview
Opens `setup.html` / `preferences.html` in a browser with a mocked preload API (no Electron needed).
Run `npx tsx tools/renderer-preview/build.ts`, then use the printed `open` / headless Chrome commands.
Select data with `?scenario=...` and the theme with `?theme=light|dark`; keep the mocks in sync with the preload files.
