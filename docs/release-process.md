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
