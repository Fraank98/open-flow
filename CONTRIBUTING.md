# Contributing to open-flow

Thanks for your interest. Issues and pull requests are welcome.

## Licensing of contributions

open-flow is released under the [MIT License](LICENSE). Contributions are
accepted under the same terms (inbound = outbound): by submitting a pull
request you agree that your contribution is licensed under the MIT License.

- There is no copyright assignment and no CLA. You keep the copyright on your
  contributions.
- A DCO sign-off (`git commit -s`) is appreciated but not required.
- Do not submit code you cannot license under MIT (for example code copied
  from a project with an incompatible license).

## Development setup

You need an Apple Silicon Mac with macOS 13 or later, Node 22+, the Xcode
Command Line Tools, and:

```bash
brew install cmake git
```

`ffmpeg` is only needed to regenerate test audio fixtures. Budget about 2 GB
of disk for the engine build, `node_modules` and the test models.

Run the commands in this order:

```bash
git clone https://github.com/Fraank98/open-flow.git && cd open-flow
npm run fetch-binaries      # builds whisper.cpp and llama.cpp (5-15 min)
npm install                 # compiles the native addons
npm run fetch-test-models   # tiny models used by the tests
npm run dev                 # launches the menubar app
```

`npm run fetch-binaries` must come BEFORE `npm install`. Installing compiles
the `whisper_stream` addon, which includes `whisper.h` from
`resources/bin/build-tmp/whisper.cpp/include`, and that directory is produced
by `fetch-binaries`. Done the other way round the install fails with
`'whisper.h' file not found`. CI uses the same order.

Electron 42 and later no longer download their binary on `npm install`: the
first `npm run dev` fetches it (about 110 MB), and `npm run package` runs
`npx install-electron --no` for you.

### Native addons and arm64

If your `node` runs under Rosetta, `npm install` builds the addons for
x86_64 and the arm64 Electron cannot load them. Rebuild for arm64:

```bash
npx electron-rebuild -f --arch arm64
```

Run it again after editing `native/**/*.mm` or `binding.gyp`. If you bump
`WHISPER_TAG` or `LLAMA_TAG` in `scripts/fetch-binaries.sh`, delete
`resources/bin/build-tmp` first so the engines are rebuilt from the new tag.

## Before opening a PR

```bash
npm run lint && npm run typecheck && npm test
```

CI runs the same checks on `macos-14`. Unit tests (`npm run test:unit`) are
fast and need nothing else; integration tests (`npm run test:integration`)
use the fixture models from `npm run fetch-test-models`.

If your change touches the hotkey, audio, overlay or paste behaviour, also
walk through [docs/electron-smoke-checklist.md](docs/electron-smoke-checklist.md)
and run the pipeline smoke test:

```bash
npm run smoke -- --wav test/fixtures/audio/en-short-clean.wav
```

Keep PRs small and focused, add or update tests, and write comments that
explain *why* the code does something rather than what it does.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`.

- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`.
- Scopes in use: `shell`, `core`, `dist`, `streaming`, `streaming-whisper`,
  `ptt`, `paste`, `overlay`, `media-control`, `dictionary`, `prefs`,
  `cleaner`, `native`, `ci`, `build`, `release`.

## How releases work

A release is triggered by the version in `package.json`. The PR that should
ship bumps `version`; once it is merged to `main`, `release.yml` builds the
DMG, tags `v<version>` and publishes it. No bump means no release.
Contributors should not bump the version unless asked. Details in
[docs/release-process.md](docs/release-process.md).

## Reporting bugs

Please include:

- macOS version and Mac model
- open-flow version
- the quality tier you use (Fast, Balanced or Max)
- the relevant lines from `~/Library/Logs/open-flow/error.log`
- for hard-to-reproduce problems, turn on *Debug logging* in Preferences, relaunch, and
  attach the relevant part of `debug.log` from the same folder

Warning: the logs can contain transcript text, that is, things you said.
Read them and remove anything private before pasting them into an issue.
