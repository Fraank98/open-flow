# Release process

## Cutting a release

Bump the version and merge. That's the whole procedure.

1. In the PR that should ship, update the `version` field in `package.json`
   (e.g. `0.2.0` → `0.2.1`).
2. Merge the PR into `main`.

On every push to `main`, `.github/workflows/release.yml` compares
`package.json`'s version against the existing tags:

- **Version has no tag yet** → it builds the `.dmg`, creates the `v<version>`
  tag at that commit and publishes a GitHub Release with the `.dmg` attached
  and auto-generated notes.
- **Version already tagged** → it stops after a few seconds. Ordinary merges
  that don't bump the version cost one cheap ubuntu job and never produce a
  release.

So the version bump *is* the release decision, and it is reviewable in the
diff like any other change.

### Still supported

- **Tag by hand.** Pushing a `v*` tag releases that tag, exactly as before:
  ```
  git tag v0.2.1 && git push origin v0.2.1
  ```
  Use this to release a commit that is not the tip of `main`.
- **Dry run.** A manual `workflow_dispatch` run builds the `.dmg` and uploads
  it as a build artifact without publishing anything — for checking that the
  build is healthy without cutting a release.

### Why the tag is created by the release job

Not by a separate "tag the commit" workflow: a tag pushed using the default
`GITHUB_TOKEN` does not trigger further workflow runs, so a split design
would create the tag and then sit there, never building the `.dmg`. The
release job therefore creates the tag itself, through
`softprops/action-gh-release`'s `tag_name`.

## Local packaging (no CI)

```
npm run fetch-binaries     # if not already built
npm run package
```

Result: `release/open-flow-<version>-arm64.dmg`.

## Installer UX (unsigned)

The `.dmg` is unsigned (no Apple Developer ID). Users will see "Apple could not verify "open-flow" is free of malware" (older macOS: "cannot be opened because Apple cannot check it for malicious software") on first launch. Workarounds:

1. **macOS 15 and later:** double-click the app once (it is blocked), open System Settings → Privacy & Security, scroll to *Security* and click **Open Anyway** next to the open-flow message, then confirm. This is the only GUI route on these versions.
2. **macOS 14 and earlier:** right-click the app in Applications → Open, then click "Open" in the dialog.
3. **Any version, Terminal:** `xattr -dr com.apple.quarantine /Applications/open-flow.app`, then launch normally.

Future launches work normally.

The release workflow adds these instructions to every GitHub Release automatically (the `body` of the `softprops/action-gh-release` step in `.github/workflows/release.yml`, with `append_body: true`), above the generated changelog. If you change the wording here, change it there and in the README too, so the three stay consistent.

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

- Electron runtime (~230 MB, `Contents/Frameworks/`)
- The compiled app (`dist/`)
- Renderer assets (`src/renderer/**/*.html|css|js`)
- Native engines in `Contents/Resources/bin/` (arm64): `whisper-server`, `llama-server`, and the Silero VAD model `ggml-silero-v6.2.0.bin`
- Their dylibs: `libwhisper*` / `libggml*` in `lib/` and `libllama*` / `libggml*` in `lib-llama/` (separate directories because the two engines vendor different ggml builds under the same filenames)
- The two native addons, `ptt_monitor.node` and `whisper_stream.node` (unpacked from the asar)
- `licenses/`: `LICENSE.txt`, `THIRD_PARTY_NOTICES.md`, and Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` (electron-builder strips Electron's own license files on macOS, so `extraResources` copies them back)
- App icon

What does NOT ship:
- AI models — downloaded on first launch
- Test fixtures — `test/` is excluded
- Source TypeScript — only compiled `.js` ships

After `npm run package`, check the bundle with
`ls release/mac-arm64/open-flow.app/Contents/Resources/licenses/`.
