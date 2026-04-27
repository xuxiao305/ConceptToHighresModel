#!/usr/bin/env bash
# Start qwen_edit_server (foreground OR background).
#
# Usage:
#   bash run_server.sh           # foreground (Ctrl-C to stop)
#   bash run_server.sh --bg      # background, logs to /project/qwen_edit/logs/server.out
set -u

source /root/miniconda3/etc/profile.d/conda.sh
conda activate qwen_edit

export QWEN_EDIT_MODEL_PATH=/project/qwen_edit/models/Qwen-Image-Edit-2511
export QWEN_EDIT_HOST=127.0.0.1
export QWEN_EDIT_PORT=8765
# Set HF cache to avoid re-downloading anything diffusers might ask for
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

SERVER=/project/qwen_edit/qwen_edit_server.py
LOG=/project/qwen_edit/logs/server.out

if [ "${1:-}" = "--bg" ]; then
  mkdir -p "$(dirname "$LOG")"
  nohup python "$SERVER" > "$LOG" 2>&1 &
  echo "server PID $!  log: $LOG"
else
  python "$SERVER"
fi
