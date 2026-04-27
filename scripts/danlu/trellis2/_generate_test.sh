#!/usr/bin/env bash
# Upload concept image, run warmup + generate on server, download GLB.
set -e
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key

LOCAL_IMG="/mnt/d/AI/Prototypes/ConceptToHighresModel/Projects/GirlOrangeJacket/page1_concept_to_rough/01_concept/20260427_172536_907.png"
LOCAL_OUT_DIR="/mnt/d/AI/Prototypes/ConceptToHighresModel/Projects/GirlOrangeJacket/page1_concept_to_rough/02_rough"
mkdir -p "$LOCAL_OUT_DIR"

REMOTE_IMG="/project/trellis2/inputs/girl_orange_jacket.png"
REMOTE_OUT="/project/trellis2/outputs/girl_orange_jacket.glb"

ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes root@apps-sl.danlu.netease.com \
  'mkdir -p /project/trellis2/inputs /project/trellis2/outputs'

scp -i /tmp/DanLu_key -P 44304 -o BatchMode=yes "$LOCAL_IMG" \
  "root@apps-sl.danlu.netease.com:${REMOTE_IMG}"

ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes root@apps-sl.danlu.netease.com 'bash -s' <<EOF
source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2

echo "===WARMUP (loads ~16GB model into VRAM; first time ~3-6 min)==="
python - <<'PY'
import urllib.request, time
t0 = time.time()
req = urllib.request.Request("http://127.0.0.1:8766/warmup", method="POST")
try:
    r = urllib.request.urlopen(req, timeout=900)
    print("warmup:", r.read().decode(), f"({time.time()-t0:.1f}s)")
except Exception as e:
    print("warmup failed:", e)
    raise
PY

echo
echo "===GENERATE==="
python - <<'PY'
import urllib.request, json, time, mimetypes, os, uuid

URL  = "http://127.0.0.1:8766/generate"
IMG  = "${REMOTE_IMG}"
OUT  = "${REMOTE_OUT}"

# Build multipart manually (stdlib only)
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
    r = urllib.request.urlopen(req, timeout=1200)
    glb = r.read()
    with open(OUT, "wb") as f: f.write(glb)
    meta = {k: v for k, v in r.headers.items() if k.lower().startswith("x-meta-")}
    print(f"OK glb={len(glb)/1024/1024:.2f}MB elapsed={time.time()-t0:.1f}s")
    print("meta:", json.dumps(meta, indent=2))
    print("saved:", OUT)
except urllib.error.HTTPError as e:
    print("HTTPError", e.code, e.read().decode()[:500])
    raise
PY
ls -la /project/trellis2/outputs/
EOF

echo
echo "===Downloading GLB to local==="
TS=$(date +%Y%m%d_%H%M%S)
LOCAL_GLB="${LOCAL_OUT_DIR}/trellis2_${TS}.glb"
scp -i /tmp/DanLu_key -P 44304 -o BatchMode=yes \
  "root@apps-sl.danlu.netease.com:${REMOTE_OUT}" "$LOCAL_GLB"
ls -la "$LOCAL_GLB"
echo "Saved: $LOCAL_GLB"
