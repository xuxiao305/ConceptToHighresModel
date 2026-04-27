#!/usr/bin/env bash
# Resume v2: cuda-toolkit already installed; just run setup.sh extensions.
# NOTE: Deliberately no `set -u` because conda's activate/deactivate scripts
# reference CONDA_BACKUP_* vars that may be unbound.
set -e
LOG="/project/trellis2/logs/setup.log"
mkdir -p "$(dirname "$LOG")"

source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2

PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"

# nvcc lives at $CONDA_PREFIX/bin/nvcc after the cuda-toolkit install.
export CUDA_HOME="${CONDA_PREFIX}"
export PATH="${CUDA_HOME}/bin:${PATH}"
export LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}"

echo "[$(date)] === resume_v2 start; CUDA_HOME=${CUDA_HOME} ===" | tee -a "$LOG"
which nvcc | tee -a "$LOG"
nvcc --version | head -5 | tee -a "$LOG"

# ----------------------------------------------------------------------------
# Run TRELLIS.2 official setup.sh (pip-based; safe to re-run).
# Skip --new-env. --basic re-pins basic deps; remaining flags compile CUDA exts.
# ----------------------------------------------------------------------------
cd /project/trellis2/TRELLIS.2

# Use Tsinghua mirror for any pip installs the upstream script triggers
pip config set global.index-url "$PIP_INDEX"

echo "[$(date)] === setup.sh --basic + extensions ===" | tee -a "$LOG"
# `setup.sh` uses `return` instead of `exit` for help, so we must `source` it.
# It also runs many pip installs that take 20-40 min total.
. ./setup.sh --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh \
  --o-voxel --flexgemm 2>&1 | tee -a "$LOG"

# ----------------------------------------------------------------------------
# Server-side extras
# ----------------------------------------------------------------------------
echo "[$(date)] === installing FastAPI server deps ===" | tee -a "$LOG"
pip install --no-cache-dir --index-url "$PIP_INDEX" \
  fastapi \
  "uvicorn[standard]" \
  python-multipart \
  pillow \
  imageio \
  imageio-ffmpeg \
  2>&1 | tee -a "$LOG"

# ----------------------------------------------------------------------------
# Verification
# ----------------------------------------------------------------------------
echo "[$(date)] === DONE. Verification: ===" | tee -a "$LOG"
python - <<'PY' 2>&1 | tee -a "$LOG"
import importlib, torch
print("torch", torch.__version__, "cuda_avail", torch.cuda.is_available(),
      "cuda_ver", torch.version.cuda)
for m in ["trellis2", "o_voxel", "nvdiffrast", "flash_attn",
          "cumesh", "flexgemm",
          "fastapi", "uvicorn", "imageio"]:
    try:
        mod = importlib.import_module(m)
        v = getattr(mod, "__version__", "?")
        print(f"OK   {m} {v}")
    except Exception as e:
        print(f"FAIL {m}: {e}")
PY
echo "[$(date)] === resume_v2 COMPLETE ===" | tee -a "$LOG"
