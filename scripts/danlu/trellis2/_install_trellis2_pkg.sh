#!/usr/bin/env bash
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes root@apps-sl.danlu.netease.com 'bash -s' <<'EOF'
source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2

echo "===check trellis2 repo layout==="
ls /project/trellis2/TRELLIS.2/ | head -40
echo
echo "===pyproject/setup==="
ls /project/trellis2/TRELLIS.2/setup.py /project/trellis2/TRELLIS.2/pyproject.toml 2>/dev/null
echo
echo "===existing trellis2 dir==="
ls -d /project/trellis2/TRELLIS.2/trellis* 2>/dev/null
echo
echo "===install trellis2 (editable) ==="
cd /project/trellis2/TRELLIS.2
if [ -f setup.py ] || [ -f pyproject.toml ]; then
  pip install --no-cache-dir --no-build-isolation --no-deps -e . 2>&1 | tail -20
else
  echo "No setup.py/pyproject.toml — trellis2 imported via sys.path; will set PYTHONPATH instead"
fi

echo
echo "===re-verify==="
python - <<'PY'
import sys
sys.path.insert(0, "/project/trellis2/TRELLIS.2")
import importlib, torch
print("torch", torch.__version__, "cuda_avail", torch.cuda.is_available())
need = ["trellis2", "o_voxel", "nvdiffrast", "flash_attn",
        "cumesh", "flex_gemm", "kornia", "timm",
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
print(f"\nSummary: {len(ok)}/{len(need)} OK, {len(fail)} FAIL")
PY
EOF
