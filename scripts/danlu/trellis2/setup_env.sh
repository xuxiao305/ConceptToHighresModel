#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# TRELLIS.2 environment setup on DanLu (NetEase A30 24GB instance).
#
# Strategy mirrors the qwen_edit setup:
#   1. Create conda env `trellis2` (python 3.11).
#   2. Pre-download torch / torchvision wheels from a fast Chinese mirror so we
#      don't get throttled on download.pytorch.org.
#   3. Clone the TRELLIS.2 repo (with submodules) and run its official
#      setup.sh in *non-new-env* mode so it installs into our env.
#
# Usage:  bash /project/trellis2/setup_env.sh
# Logs:   /project/trellis2/logs/setup.log
# ----------------------------------------------------------------------------
set -u
LOG="/project/trellis2/logs/setup.log"
WHL_DIR="/project/trellis2/wheels"
REPO_DIR="/project/trellis2/TRELLIS.2"
mkdir -p "$(dirname "$LOG")" "$WHL_DIR"

source /root/miniconda3/etc/profile.d/conda.sh

PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
# CUDA 12.4 wheels — TRELLIS.2 docs recommend cu124 + torch 2.6
PT_CDN="https://mirror.sjtu.edu.cn/pytorch-wheels/cu124"
TORCH_WHL="torch-2.6.0%2Bcu124-cp311-cp311-linux_x86_64.whl"
TV_WHL="torchvision-0.21.0%2Bcu124-cp311-cp311-linux_x86_64.whl"

if conda env list | grep -q "/trellis2\b"; then
  echo "[$(date)] env trellis2 already exists" >> "$LOG"
else
  echo "[$(date)] creating env trellis2 (python=3.11)" >> "$LOG"
  conda create -y -n trellis2 python=3.11 >> "$LOG" 2>&1
fi

conda activate trellis2

pip config set global.index-url "$PIP_INDEX" >> "$LOG" 2>&1

echo "[$(date)] === downloading torch wheels (cu124) ===" >> "$LOG"
wget -c -nv -P "$WHL_DIR" "$PT_CDN/$TORCH_WHL"  >> "$LOG" 2>&1
wget -c -nv -P "$WHL_DIR" "$PT_CDN/$TV_WHL"     >> "$LOG" 2>&1
ls -lh "$WHL_DIR" >> "$LOG"

echo "[$(date)] === installing torch wheels ===" >> "$LOG"
pip install --no-cache-dir --index-url "$PIP_INDEX" \
  "$WHL_DIR/torch-2.6.0+cu124-cp311-cp311-linux_x86_64.whl" \
  "$WHL_DIR/torchvision-0.21.0+cu124-cp311-cp311-linux_x86_64.whl" \
  >> "$LOG" 2>&1

# ----------------------------------------------------------------------------
# Clone TRELLIS.2 repo
# ----------------------------------------------------------------------------
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[$(date)] === cloning TRELLIS.2 repo (with submodules) ===" >> "$LOG"
  # Use ghproxy mirror to bypass GFW for github clones
  git clone -b main https://ghproxy.net/https://github.com/microsoft/TRELLIS.2.git \
    --recursive "$REPO_DIR" >> "$LOG" 2>&1 || \
    git clone -b main https://github.com/microsoft/TRELLIS.2.git \
      --recursive "$REPO_DIR" >> "$LOG" 2>&1
else
  echo "[$(date)] repo exists, pulling latest" >> "$LOG"
  (cd "$REPO_DIR" && git pull --recurse-submodules) >> "$LOG" 2>&1
fi

# ----------------------------------------------------------------------------
# Pin CUDA_HOME for the compiled extensions (flash-attn / nvdiffrast / cumesh
# / o-voxel / flexgemm). Adjust if the server has a different toolkit path.
# ----------------------------------------------------------------------------
if [ -d /usr/local/cuda-12.4 ]; then
  export CUDA_HOME=/usr/local/cuda-12.4
elif [ -d /usr/local/cuda ]; then
  export CUDA_HOME=/usr/local/cuda
fi
echo "[$(date)] CUDA_HOME=$CUDA_HOME" >> "$LOG"
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"

# ----------------------------------------------------------------------------
# Run the official setup.sh against our existing env (no --new-env flag).
# Order: --basic must come first; the others build CUDA extensions and can
# take 20-40 minutes to compile.
# ----------------------------------------------------------------------------
cd "$REPO_DIR"
echo "[$(date)] === running TRELLIS.2 setup.sh ===" >> "$LOG"
. ./setup.sh --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh \
  --o-voxel --flexgemm >> "$LOG" 2>&1

# ----------------------------------------------------------------------------
# Server-side extras (FastAPI stack)
# ----------------------------------------------------------------------------
echo "[$(date)] === installing FastAPI server deps ===" >> "$LOG"
pip install --no-cache-dir --index-url "$PIP_INDEX" \
  fastapi \
  "uvicorn[standard]" \
  python-multipart \
  pillow \
  imageio \
  imageio-ffmpeg \
  >> "$LOG" 2>&1

echo "[$(date)] === DONE. Versions: ===" >> "$LOG"
python - <<'PY' >> "$LOG" 2>&1
import importlib, torch
print("torch", torch.__version__, "cuda_avail", torch.cuda.is_available(),
      "cuda_ver", torch.version.cuda)
for m in ["trellis2", "o_voxel", "nvdiffrast", "flash_attn",
          "fastapi", "uvicorn", "imageio"]:
    try:
        mod = importlib.import_module(m)
        v = getattr(mod, "__version__", "?")
        print(f"OK   {m} {v}")
    except Exception as e:
        print(f"FAIL {m}: {e}")
PY

echo "[$(date)] === setup_env.sh COMPLETE ===" >> "$LOG"
