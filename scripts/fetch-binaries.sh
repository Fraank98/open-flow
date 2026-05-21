#!/usr/bin/env bash
set -euo pipefail

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

build_whisper() {
  if [[ -x "$BIN_DIR/whisper-cli" ]]; then
    echo "[skip] whisper-cli already present at $BIN_DIR/whisper-cli"
    return
  fi
  echo "[build] whisper.cpp @ $WHISPER_TAG"
  local src="$BUILD_DIR/whisper.cpp"
  if [[ ! -d "$src" ]]; then
    git clone --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$src"
  fi
  cmake -S "$src" -B "$src/build" -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release >/dev/null
  # whisper.cpp v1.7.1 names the CLI target "main"; later versions renamed it to "whisper-cli".
  cmake --build "$src/build" -j --target main
  cp "$src/build/bin/main" "$BIN_DIR/whisper-cli"
  chmod +x "$BIN_DIR/whisper-cli"
  echo "[ok] whisper-cli → $BIN_DIR/whisper-cli"
}

build_llama() {
  if [[ -x "$BIN_DIR/llama-cli" ]]; then
    echo "[skip] llama-cli already present at $BIN_DIR/llama-cli"
    return
  fi
  echo "[build] llama.cpp @ $LLAMA_TAG"
  local src="$BUILD_DIR/llama.cpp"
  if [[ ! -d "$src" ]]; then
    git clone --depth 1 --branch "$LLAMA_TAG" "$LLAMA_REPO" "$src"
  fi
  cmake -S "$src" -B "$src/build" -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF >/dev/null
  cmake --build "$src/build" -j --target llama-cli
  cp "$src/build/bin/llama-cli" "$BIN_DIR/llama-cli"
  chmod +x "$BIN_DIR/llama-cli"
  echo "[ok] llama-cli → $BIN_DIR/llama-cli"
}

build_whisper
build_llama

echo ""
echo "Done. Binaries:"
ls -lh "$BIN_DIR"/whisper-cli "$BIN_DIR"/llama-cli
echo ""
echo "Tip: rm -rf $BUILD_DIR to reclaim disk after a successful build."
