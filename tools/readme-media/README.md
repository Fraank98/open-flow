# readme-media
Renders the screenshots and the animated hero used by the top-level README from the real renderer pages
(setup, settings, overlay) with the mocked APIs of tools/renderer-preview, framed in a macOS-style window.
Run `npx tsx tools/readme-media/generate.ts`; output lands in docs/media/. Needs Google Chrome in /Applications.
The GIF encoder (gifenc + pngjs) is installed on first run into tools/readme-media/.deps/, not in package.json.
Regenerate whenever the setup, settings or overlay UI changes, on the branch whose UI you are documenting.

The current README uses static browser captures for `flow-{light,dark}.jpg`,
`pill-styles-{light,dark}.jpg` and `settings-general-{light,dark}.jpg`.
Prepare the actual renderer and mock APIs with `npx tsx tools/readme-media/generate.ts --prepare-only`,
then serve `tools/readme-media/out` locally. Capture the following pages in each theme:

- `hero.html?theme=light&state=recording&partial=Also%20check%20with%20Luca%20whether%20the%20API%20keys%20were%20rotated` — 960 × 520.
- `styles.html?theme=light` — 600 × 586.
- `frame.html?page=preferences.html&title=open-flow%20Settings&w=640&h=800&theme=light&q=tab%3Dgeneral` — 720 × 908; select Preview before capture.

Use `theme=dark` for the dark counterparts. The documentation mock freezes the clock at 00:12;
transcription text is illustrative. The existing GIF generator remains available for animated demos.
