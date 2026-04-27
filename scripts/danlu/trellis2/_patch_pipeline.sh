#!/usr/bin/env bash
set -e

# Patch pipeline.json: replace gated HF repo IDs with local paths.
PJ=/project/trellis2/models/TRELLIS.2-4B/pipeline.json
cp "$PJ" "${PJ}.bak.$(date +%s)" 2>/dev/null || true

python3 - <<'PY'
import json, pathlib
p = pathlib.Path("/project/trellis2/models/TRELLIS.2-4B/pipeline.json")
data = json.loads(p.read_text())
args = data["args"]

# Point the conditioning models to local on-disk dirs (transformers
# from_pretrained accepts an absolute path).
args["image_cond_model"]["args"]["model_name"] = (
    "/project/trellis2/models/dinov3-vitl16-pretrain-lvd1689m"
)
args["rembg_model"]["args"]["model_name"] = (
    "/project/trellis2/models/RMBG-2.0"
)

p.write_text(json.dumps(data, indent=4))
print("patched OK")
print("  image_cond_model.args.model_name =", args["image_cond_model"]["args"]["model_name"])
print("  rembg_model.args.model_name      =", args["rembg_model"]["args"]["model_name"])
PY

echo "===restart server==="
pkill -f trellis2_server.py 2>/dev/null
sleep 2
bash /project/trellis2/run_server.sh --bg
sleep 5
echo "---HEAD---"
head -20 /project/trellis2/logs/server.out
echo "---HEALTH---"
python3 - <<'PY'
import urllib.request
print(urllib.request.urlopen("http://127.0.0.1:8766/health", timeout=5).read().decode())
PY
