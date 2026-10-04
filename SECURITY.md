# Security Policy

open-flow is a fully local macOS dictation app, maintained by a single person. Security reports are welcome and taken seriously.

## Supported versions

Only the latest release receives security fixes.

| Version        | Supported |
| -------------- | --------- |
| Latest release | ✅        |
| Older releases | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead: open the **Security** tab of the repository and click **Report a vulnerability**, or go directly to <https://github.com/Fraank98/open-flow/security/advisories/new>.

Please include:

- the open-flow version and your macOS version;
- steps to reproduce the problem;
- the impact you expect (what an attacker could achieve, and under which conditions).

This is a best-effort project with a single maintainer: you can usually expect an acknowledgement within a week. Fix timelines depend on severity and complexity, and I will keep you updated in the advisory thread. Coordinated disclosure is appreciated.

## Security model

Everything runs on your Mac. The only network connections open-flow makes are the one-time model downloads from Hugging Face and requests to its own local `whisper-server` and `llama-server` processes, which are bound to `127.0.0.1` only (no telemetry, no update checks).

## Scope

In scope: the app and its build/release process, for example:

- paste and clipboard handling;
- the Accessibility and Automation permissions the app requests;
- the local `llama-server` / `whisper-server` processes listening on `127.0.0.1`;
- model download and SHA-256 verification;
- build scripts and GitHub Actions workflows.

Out of scope:

- vulnerabilities in upstream projects (whisper.cpp, llama.cpp, Electron): please report them to those projects;
- the models themselves and their output;
- attacks that require an already compromised Mac or physical access;
- the fact that builds are not signed or notarised (documented in the [README](README.md#install)).
