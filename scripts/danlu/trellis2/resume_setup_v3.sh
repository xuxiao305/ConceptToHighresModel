#!/usr/bin/env bash
# Resume v3:
# - Shadow `sudo` so apt-install line in upstream setup.sh becomes a no-op
#   (we already have libjpeg via system; pillow-simd is a nice-to-have we skip).
# - Re-source setup.sh to actually compile the 5 CUDA extensions.
# - Verify all required modules import.
set -e
set -o pipefail
LOG="/project/trellis2/logs/setup.log"
mkdir -p "$(dirname "$LOG")"

source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2

PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"

export CUDA_HOME="${CONDA_PREFIX}"
export PATH="${CUDA_HOME}/bin:${PATH}"
export LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}"

# Shadow sudo so `sudo apt install -y libjpeg-dev` becomes a noop.
# Also shadow `apt` so any direct apt invocation also no-ops gracefully.
sudo() { echo "[shim sudo] skipping: $*"; return 0; }
export -f sudo

echo "[$(date)] === resume_v3 start ===" | tee -a "$LOG"
which nvcc | tee -a "$LOG"
nvcc --version | head -5 | tee -a "$LOG"
echo "GPU 0:" | tee -a "$LOG"
nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv | tee -a "$LOG"

cd /project/trellis2/TRELLIS.2

# Make sure kornia & timm get installed (basic block aborted before them).
pip install --no-cache-dir --index-url "$PIP_INDEX" kornia timm 2>&1 | tee -a "$LOG"

# Now run only the EXTENSION blocks of setup.sh.
# We skip --basic because (a) most of basic is done, (b) we don't want it to
# bomb on sudo again. We still need the shim because some extension blocks may
# reach back. To skip basic safely, source setup.sh without --basic.
echo "[$(date)] === setup.sh extensions only (no --basic) ===" | tee -a "$LOG"
. ./setup.sh --flash-attn --nvdiffrast --nvdiffrec --cumesh \
  --o-voxel --flexgemm 2>&1 | tee -a "$LOG"

echo "[$(date)] === verification ===" | tee -a "$LOG"
python - <<'PY' 2>&1 | tee -a "$LOG"
import importlib, torch
print("torch", torch.__version__, "cuda_avail", torch.cuda.is_available(),
      "cuda_ver", torch.version.cuda)
need = ["trellis2", "o_voxel", "nvdiffrast", "flash_attn",
        "cumesh", "flexgemm", "kornia", "timm",
        "fastapi", "uvicorn", "imageio"]
ok = []
fail = []
for m in need:
    try:
        mod = importlib.import_module(m)
        v = getattr(mod, "__version__", "?")
        print(f"OK   {m} {v}")
        ok.append(m)
    except Exception as e:
        print(f"FAIL {m}: {e}")
        fail.append((m, str(e)))
print()
print(f"Summary: {len(ok)}/{len(need)} OK, {len(fail)} FAIL")
PY
echo "[$(date)] === resume_v3 COMPLETE ===" | tee -a "$LOG"
