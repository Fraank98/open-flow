# Icon sources

- `app-icon.svg`: the "Flow" app icon (1024 px, Big Sur grid squircle baked in as a path, with drop shadow).
- `app-icon-small.svg`: simplified variant (one wave + text caret, thicker stroke) used for 16/32 px and their @2x.
- `tray-template.svg`: menubar template image, pure black on transparent (22 px, rendered at 1x and 2x).

Regenerate everything (needs macOS with Google Chrome and `iconutil`):

    npx tsx tools/build-icons.ts

This rewrites `app-icon.png`, `app-icon.icns`, `tray-template.png` and `tray-template@2x.png` in `resources/icons/`.
Then refresh the README icon with `npx tsx tools/readme-media/generate.ts`.
