#!/usr/bin/env bash
# Resume TRELLIS.2 setup after CUDA_HOME bug fix.
# - Install conda-forge cuda-toolkit 12.4 into the trellis2 env (gives us nvcc).
# - Run upstream setup.sh for the CUDA extensions.
# - Install FastAPI server stack.
#
# Idempotent: re-runs are safe.
set -u
LOG="/project/trellis2/logs/setup.log"
mkdir -p "$(dirname "$LOG")"

source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2

PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"

# ----------------------------------------------------------------------------
# 1. Install CUDA toolkit 12.4 inside the env (provides nvcc + headers).
#    conda-forge mirrors the toolkit; no system-wide install needed.
# ----------------------------------------------------------------------------
if ! command -v nvcc >/dev/null 2>&1; then
  echo "[$(date)] === installing cuda-toolkit 12.4 from conda-forge ===" >> "$LOG"
  # Use Tsinghua conda-forge mirror for speed
  conda install -y -n trellis2 \
    -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge \
    -c conda-forge \
    cuda-toolkit=12.4 \
    >> "$LOG" 2>&1
fi

# Re-activate to pick up CONDA_PREFIX/bin nvcc
conda deactivate
conda activate trellis2

# Point CUDA_HOME at the conda env's CUDA install (where conda-forge puts it).
export CUDA_HOME="${CONDA_PREFIX}"
export PATH="${CUDA_HOME}/bin:${PATH}"
export LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${LD_LIBRARY_PATH:-}"
echo "[$(date)] CUDA_HOME=${CUDA_HOME}" >> "$LOG"
which nvcc >> "$LOG" 2>&1
nvcc --version >> "$LOG" 2>&1 || true

# ----------------------------------------------------------------------------
# 2. Run TRELLIS.2 official setup.sh for the CUDA extensions.
#    Skip --new-env (env already exists). Re-running --basic is harmless.
# ----------------------------------------------------------------------------
cd /project/trellis2/TRELLIS.2
echo "[$(date)] === running TRELLIS.2 setup.sh (basic + ext) ===" >> "$LOG"
. ./setup.sh --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh \
  --o-voxel --flexgemm >> "$LOG" 2>&1

# ----------------------------------------------------------------------------
# 3. Server-side extras
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

# ----------------------------------------------------------------------------
# 4. Verification
# ----------------------------------------------------------------------------
echo "[$(date)] === DONE. Verification: ===" >> "$LOG"
python - <<'PY' >> "$LOG" 2>&1
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
echo "[$(date)] === resume_setup.sh COMPLETE ===" >> "$LOG"
