#!/usr/bin/env bash
# Run on remote: warmup + generate, save GLB to /project/trellis2/outputs/.
set -e
mkdir -p /project/trellis2/inputs /project/trellis2/outputs

source /root/miniconda3/etc/profile.d/conda.sh 2>/dev/null
conda activate trellis2 2>/dev/null

echo "===WARMUP (loads ~16GB; first time 3-6 min)==="
python3 - <<'PY'
import urllib.request, time
t0 = time.time()
req = urllib.request.Request("http://127.0.0.1:8766/warmup", method="POST")
try:
    r = urllib.request.urlopen(req, timeout=900)
    print("warmup:", r.read().decode(), f"({time.time()-t0:.1f}s)")
except urllib.error.HTTPError as e:
    print("warmup HTTPError", e.code, e.read().decode()[:1000])
    raise
PY

echo
echo "===GENERATE==="
python3 - <<'PY'
import urllib.request, urllib.error, json, time, mimetypes, os, uuid

URL = "http://127.0.0.1:8766/generate"
IMG = "/project/trellis2/inputs/girl_orange_jacket.png"
OUT = "/project/trellis2/outputs/girl_orange_jacket.glb"

boundary = "----t2-" + uuid.uuid4().hex
def field(name, value):
    return (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode()
def file_field(name, fname, data, mime):
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{fname}\"\r\nContent-Type: {mime}\r\n\r\n").encode()
    return head + data + b"\r\n"

with open(IMG, "rb") as f: img_bytes = f.read()
mime = mimetypes.guess_type(IMG)[0] or "image/png"
payload = json.dumps({
    "image_b64": "x",
    "sparse_structure_steps": 12,
    "slat_steps": 12,
    "cfg_strength": 3.0,
    "decimation_target": 200000,
    "texture_size": 2048,
    "remesh": True,
})
body = file_field("image", os.path.basename(IMG), img_bytes, mime) + field("payload", payload) + f"--{boundary}--\r\n".encode()

req = urllib.request.Request(URL, data=body, method="POST")
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
t0 = time.time()
try:
    r = urllib.request.urlopen(req, timeout=1500)
    glb = r.read()
    with open(OUT, "wb") as f: f.write(glb)
    meta = {k: v for k, v in r.headers.items() if k.lower().startswith("x-meta-")}
    print(f"OK glb={len(glb)/1024/1024:.2f}MB elapsed={time.time()-t0:.1f}s")
    print("meta:", json.dumps(meta, indent=2))
    print("saved:", OUT)
except urllib.error.HTTPError as e:
    print("HTTPError", e.code, e.read().decode()[:2000])
    raise
PY
ls -la /project/trellis2/outputs/
