#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/test/fixtures/models"
mkdir -p "$DIR"

WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
WHISPER_DST="$DIR/ggml-tiny.bin"
LLM_URL="https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
LLM_DST="$DIR/qwen2.5-0.5b-instruct-q4_k_m.gguf"

if [[ ! -f "$WHISPER_DST" ]]; then
  echo "[dl] whisper tiny → $WHISPER_DST"
  curl -L --fail --progress-bar -o "$WHISPER_DST" "$WHISPER_URL"
else
  echo "[skip] $WHISPER_DST already present"
fi

if [[ ! -f "$LLM_DST" ]]; then
  echo "[dl] qwen 0.5b → $LLM_DST"
  curl -L --fail --progress-bar -o "$LLM_DST" "$LLM_URL"
else
  echo "[skip] $LLM_DST already present"
fi

echo "Done:"
ls -lh "$DIR"
