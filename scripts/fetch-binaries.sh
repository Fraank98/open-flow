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
WHISPER_TAG="v1.7.1"
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
  echo "[build] whisper.cpp @ $WHISPER_TAG (main + server)"
  local src="$BUILD_DIR/whisper.cpp"
  if [[ ! -d "$src" ]]; then
    git clone --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$src"
  fi
  # GGML_NATIVE=OFF disables -mcpu=native+nodotprod+noi8mm+nosve which Apple
  # clang 17 doesn't accept. Metal GPU acceleration is unaffected.
  cmake -S "$src" -B "$src/build" -DGGML_METAL=ON -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 >/dev/null
  # whisper.cpp v1.7.1: CLI target is "main", HTTP server target is "server".
  # Later versions renamed to whisper-cli / whisper-server.
  cmake --build "$src/build" -j --target main server
  cp "$src/build/bin/main" "$BIN_DIR/whisper-cli"
  cp "$src/build/bin/server" "$BIN_DIR/whisper-server"
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
  cmake -S "$src" -B "$src/build" -DGGML_METAL=ON -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DCMAKE_OSX_ARCHITECTURES=arm64 >/dev/null
  cmake --build "$src/build" -j --target llama-cli llama-server
  cp "$src/build/bin/llama-cli" "$BIN_DIR/llama-cli"
  cp "$src/build/bin/llama-server" "$BIN_DIR/llama-server"
  chmod +x "$BIN_DIR/llama-cli" "$BIN_DIR/llama-server"
  echo "[ok] llama-cli + llama-server → $BIN_DIR/"
}

copy_whisper_libs() {
  # Copy libwhisper + libggml dylibs to a stable location that ships with
  # the app (resources/bin/lib/). The native whisper_stream addon's rpath
  # points here.
  local lib_dst="$BIN_DIR/lib"
  mkdir -p "$lib_dst"
  local whisper_src="$BUILD_DIR/whisper.cpp/build/src"
  local ggml_src="$BUILD_DIR/whisper.cpp/build/ggml/src"
  if [[ -f "$whisper_src/libwhisper.1.7.1.dylib" ]]; then
    cp -p "$whisper_src/libwhisper.1.7.1.dylib" "$lib_dst/"
    (cd "$lib_dst" && ln -sf libwhisper.1.7.1.dylib libwhisper.1.dylib && ln -sf libwhisper.1.dylib libwhisper.dylib)
    echo "[ok] copied libwhisper → $lib_dst"
  fi
  if [[ -f "$ggml_src/libggml.dylib" ]]; then
    cp -p "$ggml_src/libggml.dylib" "$lib_dst/"
    echo "[ok] copied libggml → $lib_dst"
  fi
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
build_flag_monitor

echo ""
echo "Done. Binaries:"
ls -lh "$BIN_DIR"/whisper-cli "$BIN_DIR"/whisper-server "$BIN_DIR"/llama-cli "$BIN_DIR"/llama-server "$BIN_DIR"/flag-monitor
echo ""
echo "Tip: rm -rf $BUILD_DIR to reclaim disk after a successful build."
