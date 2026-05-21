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

```
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
