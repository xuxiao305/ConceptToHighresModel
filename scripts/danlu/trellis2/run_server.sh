#!/usr/bin/env bash
# Start trellis2_server (foreground OR background).
#
# Usage:
#   bash run_server.sh           # foreground (Ctrl-C to stop)
#   bash run_server.sh --bg      # background, logs to /project/trellis2/logs/server.out
# NOTE: do NOT use `set -u`; the conda-forge gcc activate.d hook references
# unbound SYS_SYSROOT and will abort activation under nounset.
set -e

source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2

export TRELLIS2_MODEL_PATH=/project/trellis2/models/TRELLIS.2-4B
export TRELLIS2_HOST=127.0.0.1
export TRELLIS2_PORT=8766

# Make sure the trellis2 source tree is importable (`trellis2`, `o_voxel`).
# setup.sh installs them via `pip install -e .` from these subdirs, but we
# also add them to PYTHONPATH for safety.
export PYTHONPATH="/project/trellis2/TRELLIS.2:${PYTHONPATH:-}"

# Use HF mirror for any sub-model downloads (pipeline.json references the
# original `microsoft/TRELLIS-image-large` ckpts that are NOT in TRELLIS.2-4B
# and must be fetched on first warmup). Keep online so HF can resolve them.
export HF_ENDPOINT=https://hf-mirror.com
export HF_HOME=/project/trellis2/hf_cache
mkdir -p "$HF_HOME"

# CUDA tuning
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True"
export OPENCV_IO_ENABLE_OPENEXR=1
# If multiple CUDA toolkits installed, point at 12.4
if [ -d /usr/local/cuda-12.4 ]; then
  export CUDA_HOME=/usr/local/cuda-12.4
  export PATH="$CUDA_HOME/bin:$PATH"
  export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
fi

SERVER=/project/trellis2/trellis2_server.py
LOG=/project/trellis2/logs/server.out

if [ "${1:-}" = "--bg" ]; then
  mkdir -p "$(dirname "$LOG")"
  nohup python "$SERVER" > "$LOG" 2>&1 &
  echo "server PID $!  log: $LOG"
else
  python "$SERVER"
fi
