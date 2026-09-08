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
LLAMA_TAG="b4404"

mkdir -p "$BIN_DIR" "$BUILD_DIR"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1 (try: brew install $2)"; exit 1; }
}

need cmake cmake
need git git
need swiftc xcode-select

build_whisper() {
  if [[ -x "$BIN_DIR/whisper-cli" && -x "$BIN_DIR/whisper-server" ]]; then
    echo "[skip] whisper-cli + whisper-server already present"
    return
  fi
  echo "[build] whisper.cpp @ $WHISPER_TAG (whisper-cli + whisper-server)"
  local src="$BUILD_DIR/whisper.cpp"
  if [[ ! -d "$src" ]]; then
    git clone --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$src"
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
  cmake -S "$src" -B "$src/build" -DGGML_METAL=ON -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON "-DCMAKE_INSTALL_RPATH=@executable_path/lib;@executable_path/../lib" >/dev/null
  # Targets are named whisper-cli / whisper-server from v1.7.2 onward (they
  # were "main" / "server" in v1.7.1).
  cmake --build "$src/build" -j --target whisper-cli whisper-server
  cp "$src/build/bin/whisper-cli" "$BIN_DIR/whisper-cli"
  cp "$src/build/bin/whisper-server" "$BIN_DIR/whisper-server"
  chmod +x "$BIN_DIR/whisper-cli" "$BIN_DIR/whisper-server"
  echo "[ok] whisper-cli + whisper-server → $BIN_DIR/"
}

build_llama() {
  if [[ -x "$BIN_DIR/llama-server" && -x "$BIN_DIR/llama-cli" ]]; then
    echo "[skip] llama-server + llama-cli already present"
    return
  fi
  echo "[build] llama.cpp @ $LLAMA_TAG (server + cli)"
  local src="$BUILD_DIR/llama.cpp"
  if [[ ! -d "$src" ]]; then
    git clone --depth 1 --branch "$LLAMA_TAG" "$LLAMA_REPO" "$src"
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
  cmake -S "$src" -B "$src/build" -DGGML_METAL=ON -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON "-DCMAKE_INSTALL_RPATH=@executable_path/lib-llama;@executable_path/../lib-llama" >/dev/null
  cmake --build "$src/build" -j --target llama-cli llama-server
  cp "$src/build/bin/llama-cli" "$BIN_DIR/llama-cli"
  cp "$src/build/bin/llama-server" "$BIN_DIR/llama-server"
  chmod +x "$BIN_DIR/llama-cli" "$BIN_DIR/llama-server"
  echo "[ok] llama-cli + llama-server → $BIN_DIR/"
}

copy_llama_libs() {
  # Copy llama's own dylibs to a dedicated resources/bin/lib-llama/ (kept
  # separate from whisper's resources/bin/lib/ — see the rpath comment in
  # build_llama for why sharing one directory is unsafe). At LLAMA_TAG=b4404,
  # llama-server links against libllama.dylib and its private
  # libggml/-base/-cpu/-blas/-metal.dylib; there is no libmtmd (added to
  # llama.cpp well after this tag) and no libllama-common /
  # libllama-server-impl split (that came with a later refactor too) — verify
  # against `otool -L` on the built binaries if this ever looks stale.
  #
  # Unlike whisper.cpp's build (which places every dylib under build/bin/),
  # b4404's dylibs land scattered across the build tree: build/src/,
  # build/ggml/src/, build/ggml/src/ggml-blas/, build/ggml/src/ggml-metal/ —
  # so this searches the whole build dir rather than assuming one directory.
  # `cp -a` preserves a version symlink chain where one exists (not the case
  # for these particular b4404 dylibs, which are unversioned, but is for
  # e.g. whisper's libwhisper.dylib → libwhisper.1.dylib → ...).
  local lib_dst="$BIN_DIR/lib-llama"
  mkdir -p "$lib_dst"
  local build_root="$BUILD_DIR/llama.cpp/build"
  if [[ ! -d "$build_root" ]]; then
    echo "[error] llama build output not found at $build_root"; exit 1
  fi
  local found=0
  while IFS= read -r -d '' f; do
    cp -a "$f" "$lib_dst/"
    found=1
  done < <(find "$build_root" \( -name "libllama*.dylib" -o -name "libmtmd*.dylib" -o -name "libggml*.dylib" \) \( -type f -o -type l \) -print0)
  if [[ $found -eq 0 ]]; then
    echo "[error] no llama/mtmd/ggml dylibs found under $build_root"; exit 1
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
  mkdir -p "$lib_dst"
  local bin_src="$BUILD_DIR/whisper.cpp/build/bin"
  if [[ ! -d "$bin_src" ]]; then
    echo "[error] whisper build output not found at $bin_src"; exit 1
  fi
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
  curl -fL --retry 3 -o "$BIN_DIR/$VAD_MODEL.part" "$VAD_URL"
  mv "$BIN_DIR/$VAD_MODEL.part" "$BIN_DIR/$VAD_MODEL"
  echo "[ok] $VAD_MODEL → $BIN_DIR/"
}

build_flag_monitor() {
  if [[ -x "$BIN_DIR/flag-monitor" ]]; then
    echo "[skip] flag-monitor already present at $BIN_DIR/flag-monitor"
    return
  fi
  local src="$ROOT/resources/native-src/flag-monitor.swift"
  if [[ ! -f "$src" ]]; then
    echo "[error] missing $src"
    exit 1
  fi
  echo "[build] flag-monitor (Swift NSEvent helper)"
  swiftc -O -o "$BIN_DIR/flag-monitor" "$src"
  chmod +x "$BIN_DIR/flag-monitor"
  echo "[ok] flag-monitor → $BIN_DIR/flag-monitor"
}

build_whisper
build_llama
copy_whisper_libs
copy_llama_libs
fetch_vad_model
build_flag_monitor

echo ""
echo "Done. Binaries:"
ls -lh "$BIN_DIR"/whisper-cli "$BIN_DIR"/whisper-server "$BIN_DIR"/llama-cli "$BIN_DIR"/llama-server "$BIN_DIR"/flag-monitor
echo ""
echo "Tip: rm -rf $BUILD_DIR to reclaim disk after a successful build."
