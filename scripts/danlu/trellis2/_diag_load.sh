#!/usr/bin/env bash
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes root@apps-sl.danlu.netease.com 'bash -s' <<'EOF'
echo "===tail server.out==="
tail -120 /project/trellis2/logs/server.out
echo
echo "===model dir listing==="
ls -la /project/trellis2/models/TRELLIS.2-4B/
echo
echo "===example.py how-to-load==="
grep -n -E 'from_pretrained|Trellis2ImageTo3DPipeline|pipeline' /project/trellis2/TRELLIS.2/example.py | head -30
echo
echo "===inspect pipeline.from_pretrained signature==="
source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2
export PYTHONPATH=/project/trellis2/TRELLIS.2:${PYTHONPATH:-}
python - <<'PY'
import inspect, os
os.environ.pop("HF_HUB_OFFLINE", None)
os.environ.pop("TRANSFORMERS_OFFLINE", None)
from trellis2.pipelines import Trellis2ImageTo3DPipeline
print("class:", Trellis2ImageTo3DPipeline)
sig = inspect.signature(Trellis2ImageTo3DPipeline.from_pretrained)
print("from_pretrained signature:", sig)
PY
EOF
