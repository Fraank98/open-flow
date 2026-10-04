# readme-media
Renders the screenshots and the animated hero used by the top-level README from the real renderer pages
(setup, settings, overlay) with the mocked APIs of tools/renderer-preview, framed in a macOS-style window.
Run `npx tsx tools/readme-media/generate.ts`; output lands in docs/media/. Needs Google Chrome in /Applications.
The GIF encoder (gifenc + pngjs) is installed on first run into tools/readme-media/.deps/, not in package.json.
Regenerate whenever the setup, settings or overlay UI changes, on the branch whose UI you are documenting.
