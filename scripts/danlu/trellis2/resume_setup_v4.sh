#!/usr/bin/env bash
# Resume v4: install flash-attn from pre-built wheel (much faster than source),
# then compile the remaining 4 extensions (nvdiffrast/nvdiffrec/cumesh/flexgemm/o-voxel).
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
# Conservative parallel compile to avoid OOM on server
export MAX_JOBS=2

# Shadow sudo so any apt line in upstream becomes a noop
sudo() { echo "[shim sudo] skipping: $*"; return 0; }
export -f sudo

echo "[$(date)] === resume_v4 start ===" | tee -a "$LOG"

# ----------------------------------------------------------------------------
# 1. Pre-install build deps for source builds with --no-build-isolation.
# ----------------------------------------------------------------------------
echo "[$(date)] === pre-install build deps ===" | tee -a "$LOG"
pip install --no-cache-dir --index-url "$PIP_INDEX" \
  ninja packaging wheel setuptools "numpy<3" pybind11 cmake \
  2>&1 | tee -a "$LOG"

# ----------------------------------------------------------------------------
# 2. flash-attn 2.7.3 — try pre-built wheel first (via ghproxy), fall back
#    to source build (--no-build-isolation, MAX_JOBS=2; takes ~30-40 min).
# ----------------------------------------------------------------------------
mkdir -p /project/trellis2/wheels
WHL=/project/trellis2/wheels/flash_attn-2.7.3+cu12torch2.6cxx11abiFALSE-cp311-cp311-linux_x86_64.whl
if [ ! -s "$WHL" ]; then
  echo "[$(date)] === downloading flash-attn pre-built wheel ===" | tee -a "$LOG"
  for url in \
    "https://ghproxy.net/https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.3/flash_attn-2.7.3+cu12torch2.6cxx11abiFALSE-cp311-cp311-linux_x86_64.whl" \
    "https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.3/flash_attn-2.7.3+cu12torch2.6cxx11abiFALSE-cp311-cp311-linux_x86_64.whl" \
    "https://gh.api.99988866.xyz/https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.3/flash_attn-2.7.3+cu12torch2.6cxx11abiFALSE-cp311-cp311-linux_x86_64.whl"
  do
    echo "trying $url" | tee -a "$LOG"
    wget -q -O "$WHL" --tries=2 --timeout=60 "$url" && [ -s "$WHL" ] && break
    rm -f "$WHL"
  done
fi
if [ -s "$WHL" ]; then
  echo "[$(date)] installing flash-attn from $WHL" | tee -a "$LOG"
  pip install --no-cache-dir --no-deps "$WHL" 2>&1 | tee -a "$LOG"
else
  echo "[$(date)] === no prebuilt wheel; building flash-attn from source ===" | tee -a "$LOG"
  pip install --no-cache-dir --no-build-isolation \
    --index-url "$PIP_INDEX" flash-attn==2.7.3 2>&1 | tee -a "$LOG"
fi

# ----------------------------------------------------------------------------
# 3. nvdiffrast / nvdiffrec / cumesh / flexgemm / o-voxel
#    These use --no-build-isolation in setup.sh already and require git clones.
#    We replicate the steps directly to bypass any sudo line.
# ----------------------------------------------------------------------------
mkdir -p /tmp/extensions

clone_or_pull() {
  local url=$1; local dest=$2; local ref=$3
  if [ -d "$dest/.git" ]; then
    (cd "$dest" && git pull --recurse-submodules) || true
  else
    git clone --recursive "$url" "$dest"
  fi
  if [ -n "$ref" ]; then
    (cd "$dest" && git checkout "$ref")
  fi
}

# nvdiffrast v0.4.0
echo "[$(date)] === nvdiffrast ===" | tee -a "$LOG"
clone_or_pull https://github.com/NVlabs/nvdiffrast.git /tmp/extensions/nvdiffrast v0.4.0
pip install --no-cache-dir --no-build-isolation /tmp/extensions/nvdiffrast 2>&1 | tee -a "$LOG"

# nvdiffrec (renderutils branch, JeffreyXiang fork)
echo "[$(date)] === nvdiffrec ===" | tee -a "$LOG"
if [ ! -d /tmp/extensions/nvdiffrec/.git ]; then
  git clone -b renderutils --recursive https://github.com/JeffreyXiang/nvdiffrec.git /tmp/extensions/nvdiffrec
fi
pip install --no-cache-dir --no-build-isolation /tmp/extensions/nvdiffrec 2>&1 | tee -a "$LOG"

# CuMesh
echo "[$(date)] === CuMesh ===" | tee -a "$LOG"
clone_or_pull https://github.com/JeffreyXiang/CuMesh.git /tmp/extensions/CuMesh ""
pip install --no-cache-dir --no-build-isolation /tmp/extensions/CuMesh 2>&1 | tee -a "$LOG"

# FlexGEMM
echo "[$(date)] === FlexGEMM ===" | tee -a "$LOG"
clone_or_pull https://github.com/JeffreyXiang/FlexGEMM.git /tmp/extensions/FlexGEMM ""
pip install --no-cache-dir --no-build-isolation /tmp/extensions/FlexGEMM 2>&1 | tee -a "$LOG"

# o-voxel (lives inside the cloned repo)
echo "[$(date)] === o-voxel ===" | tee -a "$LOG"
rm -rf /tmp/extensions/o-voxel
cp -r /project/trellis2/TRELLIS.2/o-voxel /tmp/extensions/o-voxel
pip install --no-cache-dir --no-build-isolation /tmp/extensions/o-voxel 2>&1 | tee -a "$LOG"

# ----------------------------------------------------------------------------
# 4. Verification
# ----------------------------------------------------------------------------
echo "[$(date)] === verification ===" | tee -a "$LOG"
python - <<'PY' 2>&1 | tee -a "$LOG"
import importlib, torch
print("torch", torch.__version__, "cuda_avail", torch.cuda.is_available(),
      "cuda_ver", torch.version.cuda)
need = ["trellis2", "o_voxel", "nvdiffrast", "flash_attn",
        "cumesh", "flexgemm", "kornia", "timm",
        "fastapi", "uvicorn", "imageio"]
ok, fail = [], []
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
echo "[$(date)] === resume_v4 COMPLETE ===" | tee -a "$LOG"
