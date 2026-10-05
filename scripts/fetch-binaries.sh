#!/usr/bin/env bash
set -euo pipefail

# If we're on Apple Silicon hardware but running under Rosetta (x86_64 process,
# e.g. because the parent Node was installed as x86_64), re-exec natively. The
# arm64 binaries cannot be built reliably from an x86_64 shell because cmake's
# host feature detection picks the wrong toolchain triplet.
if [[ "$(uname -m)" == "x86_64" ]] && [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
  echo "[reexec] Apple Silicon detected but running as x86_64; re-executing under arch -arm64..."
  exec arch -arm64 bash "$0" "$@"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/resources/bin"
BUILD_DIR="$BIN_DIR/build-tmp"
WHISPER_REPO="https://github.com/ggerganov/whisper.cpp.git"
WHISPER_TAG="v1.9.2"
LLAMA_REPO="https://github.com/ggerganov/llama.cpp.git"
LLAMA_TAG="v0.4.0"

# Minimum macOS the engine binaries (libwhisper/libllama/ggml dylibs, whisper-server,
# llama-server, ...) are built to run on. cmake otherwise defaults to the BUILD HOST's
# SDK (minos 26.0 on a dev machine, 14.0 on the CI runner), which would make the shipped
# engines require a newer macOS than the app itself. Keep in sync with Electron 44's floor
# (macOS 13), MACOSX_DEPLOYMENT_TARGET in binding.gyp and minimumSystemVersion in
# electron-builder.yml.
DEPLOYMENT_TARGET="13.0"

mkdir -p "$BIN_DIR" "$BUILD_DIR"

# Print a UTC-timestamped marker before each major phase so a CI log shows where
# time goes (and where a stuck build stopped) instead of staying silent.
phase() {
  echo "[fetch-binaries $(date -u +%H:%M:%S)] $*"
}

# Cap build parallelism at the CPU count. A bare `cmake --build -j` becomes an
# unbounded `make -j` with the Unix Makefiles generator: one compiler per translation
# unit at once. On GitHub's macos-14 runner (3 vCPU, 7 GB RAM) llama.cpp's many sources
# exhausted memory and the VM stopped responding (no logs, and not even the step
# timeout-minutes could end the job). Override with FETCH_BINARIES_JOBS.
JOBS="${FETCH_BINARIES_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
phase "build parallelism: -j $JOBS"

# Shallow-clone $1 (repo) at tag $2 into $3, bounded and retried. A stalled
# connection aborts after GIT_HTTP_LOW_SPEED_TIME seconds below
# GIT_HTTP_LOW_SPEED_LIMIT bytes/s instead of hanging forever; the partial
# directory is removed between attempts.
clone_bounded() {
  local repo="$1" tag="$2" dst="$3" attempt
  for attempt in 1 2 3; do
    if GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60 \
        git clone --depth 1 --branch "$tag" "$repo" "$dst"; then
      return 0
    fi
    echo "[clone] attempt $attempt/3 failed for $repo"
    rm -rf "$dst"
    sleep 5
  done
  echo "[error] could not clone $repo after 3 attempts"
  return 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1 (try: brew install $2)"; exit 1; }
}

need cmake cmake
need git git
need swiftc xcode-select
need otool xcode-select

# True if binary $1 carries an LC_RPATH entry equal to $2. Used by the build
# guards below so a checkout that already has a binary from a *previous*
# build (baked with a different, non-relocatable rpath — e.g. the machine's
# own build-tmp/ absolute path, or a binary left over from a different
# LLAMA_TAG/WHISPER_TAG checkout) rebuilds instead of being waved through by
# a bare `-x` check.
# True when $1 carries EXACTLY the rpath $2. The match must be whole-line:
# `grep -q "path @executable_path/../lib"` also matches `../lib-llama`, which
# would let a llama binary satisfy the whisper guard.
rpath_ok() {
  otool -l "$1" 2>/dev/null \
    | awk '/LC_RPATH/ { want = 1; next } want && $1 == "path" { print $2; want = 0 }' \
    | grep -qxF "$2"
}

# True when every Mach-O file given carries a deployment target (LC_BUILD_VERSION
# `minos`, or `version` of the older LC_VERSION_MIN_MACOSX) equal to
# $DEPLOYMENT_TARGET. Binaries built before the pin default to the host's macOS
# (e.g. 26.0) and would make a local `npm run package` ship engines that refuse
# to run on older systems, so the guards below rebuild when this fails.
# On failure sets MINOS_MISMATCH to a description of the first offending file.
minos_ok() {
  local f got
  MINOS_MISMATCH=""
  for f in "$@"; do
    got="$(otool -l "$f" 2>/dev/null | awk '
      /LC_BUILD_VERSION/ { b = 1; next }
      /LC_VERSION_MIN_MACOSX/ { m = 1; next }
      b && $1 == "minos" { print $2; exit }
      m && $1 == "version" { print $2; exit }')"
    if [[ "$got" != "$DEPLOYMENT_TARGET" ]]; then
      MINOS_MISMATCH="$f (minos ${got:-unknown}, want $DEPLOYMENT_TARGET)"
      return 1
    fi
  done
}

build_whisper() {
  MINOS_MISMATCH=""
  if [[ -x "$BIN_DIR/whisper-cli" && -x "$BIN_DIR/whisper-server" ]] \
    && rpath_ok "$BIN_DIR/whisper-server" "@executable_path/../lib" \
    && minos_ok "$BIN_DIR/whisper-cli" "$BIN_DIR/whisper-server" "$BIN_DIR"/lib/*.dylib; then
    echo "[skip] whisper-cli + whisper-server already present"
    return
  fi
  [[ -n "${MINOS_MISMATCH:-}" ]] && phase "[rebuild] whisper: deployment target mismatch: $MINOS_MISMATCH"
  echo "[build] whisper.cpp @ $WHISPER_TAG (whisper-cli + whisper-server)"
  local src="$BUILD_DIR/whisper.cpp"
  if [[ ! -d "$src" ]]; then
    phase "clone whisper.cpp @ $WHISPER_TAG"
    clone_bounded "$WHISPER_REPO" "$WHISPER_TAG" "$src"
  fi
  # GGML_NATIVE=OFF disables -mcpu=native+nodotprod+noi8mm+nosve which Apple
  # clang 17 doesn't accept. Metal GPU acceleration is unaffected.
  #
  # CMAKE_BUILD_WITH_INSTALL_RPATH + CMAKE_INSTALL_RPATH: without this, cmake
  # bakes the *build-tree* absolute path (this machine's build-tmp/) into
  # whisper-cli/whisper-server's LC_RPATH — same defect as llama-server had
  # (see the rpath comment in build_llama). whisper-server is the fallback
  # transcription path (used only if the native streaming addon fails to
  # init, src/main/index.ts) and its dylibs are already shipped correctly to
  # Contents/Resources/lib/ — it was just missing the relative rpath to find
  # them there. Two entries cover both places the binary runs from:
  #   @executable_path/lib       dev:      resources/bin/{whisper-server,lib/}
  #   @executable_path/../lib    packaged: Contents/Resources/{bin/whisper-server,lib/}
  # Unlike llama, whisper's dylibs stay in the existing resources/bin/lib/ —
  # no new directory, no filter change, they already live there.
  phase "cmake configure $(basename "$src")"
  cmake -S "$src" -B "$src/build" -DGGML_METAL=ON -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON "-DCMAKE_INSTALL_RPATH=@executable_path/lib;@executable_path/../lib" >/dev/null
  # Targets are named whisper-cli / whisper-server from v1.7.2 onward (they
  # were "main" / "server" in v1.7.1).
  phase "cmake build whisper.cpp"
  cmake --build "$src/build" -j "$JOBS" --target whisper-cli whisper-server
  cp "$src/build/bin/whisper-cli" "$BIN_DIR/whisper-cli"
  cp "$src/build/bin/whisper-server" "$BIN_DIR/whisper-server"
  chmod +x "$BIN_DIR/whisper-cli" "$BIN_DIR/whisper-server"
  echo "[ok] whisper-cli + whisper-server → $BIN_DIR/"
}

build_llama() {
  MINOS_MISMATCH=""
  if [[ -x "$BIN_DIR/llama-server" && -x "$BIN_DIR/llama-cli" ]] \
    && rpath_ok "$BIN_DIR/llama-server" "@executable_path/../lib-llama" \
    && minos_ok "$BIN_DIR/llama-server" "$BIN_DIR/llama-cli" "$BIN_DIR"/lib-llama/*.dylib; then
    echo "[skip] llama-server + llama-cli already present"
    return
  fi
  [[ -n "${MINOS_MISMATCH:-}" ]] && phase "[rebuild] llama: deployment target mismatch: $MINOS_MISMATCH"
  echo "[build] llama.cpp @ $LLAMA_TAG (server + cli)"
  local src="$BUILD_DIR/llama.cpp"
  if [[ ! -d "$src" ]]; then
    phase "clone llama.cpp @ $LLAMA_TAG"
    clone_bounded "$LLAMA_REPO" "$LLAMA_TAG" "$src"
  fi
  # CMAKE_BUILD_WITH_INSTALL_RPATH + CMAKE_INSTALL_RPATH: without these, cmake
  # bakes this machine's build-tree absolute path into llama-cli/llama-server's
  # LC_RPATH, so they can never find their dylibs anywhere else — including
  # inside the packaged .app on another Mac. The published v0.1.0/v0.2.0 DMGs
  # ship exactly that: a llama-server whose four LC_RPATH entries point into a
  # build-tmp/ directory that exists only on the maintainer's machine, so the
  # LLM cleanup step cannot start for anyone else. Two entries cover both
  # layouts the binary actually runs from:
  #   @executable_path/lib-llama       dev:      resources/bin/{llama-server,lib-llama/}
  #   @executable_path/../lib-llama    packaged: Contents/Resources/{bin/llama-server,lib-llama/}
  #
  # A dedicated lib-llama/ (not the resources/bin/lib/ that whisper uses) is
  # deliberate, and it is the subtler half of the bug: llama.cpp and
  # whisper.cpp each vendor their own ggml build, at different versions but
  # with identical filenames (libggml-base.dylib and friends). Copying both
  # into one shared lib/ would have one silently overwrite the other's
  # same-named files — a corruption that surfaces as an inscrutable runtime
  # failure rather than a build error.
  # LLAMA_OPENSSL=OFF: from v0.4.0 llama-server's vendored cpp-httplib links
  # OpenSSL for HTTPS whenever cmake's find_package(OpenSSL) succeeds on the
  # build machine — e.g. Homebrew's openssl@3. The app only ever talks to
  # llama-server over plain HTTP on 127.0.0.1, and a dylib dependency on an
  # absolute /opt/homebrew path would break the packaged app on every machine
  # without that formula. Keep the binary free of it, as the pre-bump build was.
  phase "cmake configure $(basename "$src")"
  cmake -S "$src" -B "$src/build" -DGGML_METAL=ON -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON "-DCMAKE_INSTALL_RPATH=@executable_path/lib-llama;@executable_path/../lib-llama" >/dev/null
  phase "cmake build llama.cpp"
  cmake --build "$src/build" -j "$JOBS" --target llama-cli llama-server
  cp "$src/build/bin/llama-cli" "$BIN_DIR/llama-cli"
  cp "$src/build/bin/llama-server" "$BIN_DIR/llama-server"
  chmod +x "$BIN_DIR/llama-cli" "$BIN_DIR/llama-server"
  echo "[ok] llama-cli + llama-server → $BIN_DIR/"
}

copy_llama_libs() {
  # Copy llama's own dylibs to a dedicated resources/bin/lib-llama/ (kept
  # separate from whisper's resources/bin/lib/ — see the rpath comment in
  # build_llama for why sharing one directory is unsafe). The set is
  # tag-dependent and grew at v0.4.0: alongside libllama and its private
  # libggml/-base/-cpu/-blas/-metal, upstream now also ships libmtmd
  # (multimodal) and turns what used to be static code into libllama-common,
  # libllama-server-impl and libllama-cli-impl (the last one is a build
  # artifact of llama-cli, which isn't packaged, but it's harmless to copy).
  # The `libllama*` glob covers all three; the authoritative list is whatever
  # `otool -L` reports on the built binaries, so check it after any tag bump
  # rather than trusting this comment.
  #
  # Unlike whisper.cpp's build (which places every dylib under build/bin/),
  # b4404's dylibs land scattered across the build tree: build/src/,
  # build/ggml/src/, build/ggml/src/ggml-blas/, build/ggml/src/ggml-metal/ —
  # so this searches the whole build dir rather than assuming one directory.
  # `cp -a` preserves a version symlink chain where one exists (not the case
  # for these particular b4404 dylibs, which are unversioned, but is for
  # e.g. whisper's libwhisper.dylib → libwhisper.1.dylib → ...).
  local lib_dst="$BIN_DIR/lib-llama"
  local build_root="$BUILD_DIR/llama.cpp/build"
  if [[ ! -d "$build_root" ]]; then
    # No build tree to copy from. That's only an error if lib-llama/ isn't
    # already populated (e.g. from a prior run, before `rm -rf build-tmp`
    # per the Tip at the bottom of this script) — nothing to do otherwise.
    if compgen -G "$lib_dst"/*.dylib >/dev/null 2>&1; then
      echo "[skip] $lib_dst already populated, no build tree to copy from"
      return
    fi
    echo "[error] llama build output not found at $build_root, and $lib_dst is empty"; exit 1
  fi
  rm -rf "$lib_dst"
  mkdir -p "$lib_dst"
  local found=0
  while IFS= read -r -d '' f; do
    cp -a "$f" "$lib_dst/"
    found=1
  done < <(find "$build_root" \( -name "libllama*.dylib" -o -name "libmtmd*.dylib" -o -name "libggml*.dylib" \) \( -type f -o -type l \) -print0)
  if [[ $found -eq 0 ]]; then
    echo "[error] no llama/ggml dylibs found under $build_root"; exit 1
  fi
  echo "[ok] copied $(ls "$lib_dst" | wc -l | tr -d ' ') dylib entries → $lib_dst"
}

copy_whisper_libs() {
  # Copy libwhisper + every libggml* dylib to a stable location that ships with
  # the app (resources/bin/lib/). The native whisper_stream addon's rpath points
  # here.
  #
  # Two things changed in v1.9.2 and silently broke the old hardcoded copy:
  #   - the dylibs moved from build/src + build/ggml/src to build/bin;
  #   - ggml was split into libggml, libggml-base, libggml-cpu, libggml-metal
  #     and libggml-blas, all of which are loaded at runtime.
  # `cp -a` preserves the version symlink chain (libwhisper.dylib →
  # libwhisper.1.dylib → libwhisper.<version>.dylib).
  local lib_dst="$BIN_DIR/lib"
  local bin_src="$BUILD_DIR/whisper.cpp/build/bin"
  if [[ ! -d "$bin_src" ]]; then
    # No build tree to copy from. That's only an error if lib/ isn't already
    # populated (e.g. from a prior run, before `rm -rf build-tmp` per the Tip
    # at the bottom of this script) — nothing to do otherwise.
    if compgen -G "$lib_dst"/*.dylib >/dev/null 2>&1; then
      echo "[skip] $lib_dst already populated, no build tree to copy from"
      return
    fi
    echo "[error] whisper build output not found at $bin_src, and $lib_dst is empty"; exit 1
  fi
  rm -rf "$lib_dst"
  mkdir -p "$lib_dst"
  local found=0
  for f in "$bin_src"/libwhisper*.dylib "$bin_src"/libggml*.dylib; do
    [[ -e "$f" ]] || continue
    cp -a "$f" "$lib_dst/"
    found=1
  done
  if [[ $found -eq 0 ]]; then
    echo "[error] no whisper/ggml dylibs found in $bin_src"; exit 1
  fi
  echo "[ok] copied $(ls "$lib_dst" | wc -l | tr -d ' ') dylib entries → $lib_dst"
}

# Silero VAD model for whisper.cpp's built-in voice-activity detection. Ships
# next to the engines so the packaged app can point whisper_full at it. Without
# it, silence reaches the decoder and Whisper hallucinates its training-set
# filler ("Grazie.", "Thank you.") on empty audio.
VAD_MODEL="ggml-silero-v6.2.0.bin"
VAD_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/$VAD_MODEL"

fetch_vad_model() {
  if [[ -f "$BIN_DIR/$VAD_MODEL" ]]; then
    echo "[skip] $VAD_MODEL already present"
    return
  fi
  echo "[fetch] $VAD_MODEL"
  phase "download $VAD_MODEL"
  # Bounded: connect/total timeouts, retries on any error, and an abort when
  # throughput stays under 1 KiB/s for 60 s (a stalled transfer otherwise hangs).
  curl -fL --connect-timeout 30 --max-time 600 --retry 5 --retry-delay 5 --retry-max-time 900 --retry-all-errors \
    --speed-limit 1024 --speed-time 60 -o "$BIN_DIR/$VAD_MODEL.part" "$VAD_URL"
  mv "$BIN_DIR/$VAD_MODEL.part" "$BIN_DIR/$VAD_MODEL"
  echo "[ok] $VAD_MODEL → $BIN_DIR/"
}

build_flag_monitor() {
  MINOS_MISMATCH=""
  if [[ -x "$BIN_DIR/flag-monitor" ]] && minos_ok "$BIN_DIR/flag-monitor"; then
    echo "[skip] flag-monitor already present at $BIN_DIR/flag-monitor"
    return
  fi
  [[ -n "${MINOS_MISMATCH:-}" ]] && phase "[rebuild] flag-monitor: deployment target mismatch: $MINOS_MISMATCH"
  local src="$ROOT/resources/native-src/flag-monitor.swift"
  if [[ ! -f "$src" ]]; then
    echo "[error] missing $src"
    exit 1
  fi
  phase "build flag-monitor"
  echo "[build] flag-monitor (Swift NSEvent helper)"
  swiftc -O -target "arm64-apple-macosx$DEPLOYMENT_TARGET" -o "$BIN_DIR/flag-monitor" "$src"
  chmod +x "$BIN_DIR/flag-monitor"
  echo "[ok] flag-monitor → $BIN_DIR/flag-monitor"
}

build_whisper
build_llama
phase "copy engine libraries"
copy_whisper_libs
copy_llama_libs
fetch_vad_model
build_flag_monitor

echo ""
echo "Done. Binaries:"
ls -lh "$BIN_DIR"/whisper-cli "$BIN_DIR"/whisper-server "$BIN_DIR"/llama-cli "$BIN_DIR"/llama-server "$BIN_DIR"/flag-monitor
echo ""
echo "Tip: rm -rf $BUILD_DIR to reclaim disk after a successful build (but note binding.gyp also pulls headers from $BUILD_DIR/whisper.cpp/include, so do this after the native addon is built too, or you'll need to re-fetch before it can build again)."
