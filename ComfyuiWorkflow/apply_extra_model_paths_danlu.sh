#!/usr/bin/env bash
set -euo pipefail

# Apply DanLu model path mapping to ComfyUI.
# Default ComfyUI dir can be overridden by COMFYUI_DIR.
COMFYUI_DIR="${COMFYUI_DIR:-/project/ComfyUI}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/extra_model_paths.danlu.yaml"
DST="$COMFYUI_DIR/extra_model_paths.yaml"

if [ ! -d "$COMFYUI_DIR" ]; then
  echo "[ERROR] COMFYUI_DIR not found: $COMFYUI_DIR"
  echo "        Set COMFYUI_DIR and retry."
  exit 1
fi

cp -f "$SRC" "$DST"
echo "[OK] Wrote: $DST"

echo "[INFO] Please restart ComfyUI to reload model paths."
