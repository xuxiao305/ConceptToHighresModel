#!/usr/bin/env bash
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key

# Re-upload server + run script (they may have changed)
scp -i /tmp/DanLu_key -P 44304 -o BatchMode=yes \
  /mnt/d/AI/Prototypes/ConceptToHighresModel/scripts/danlu/trellis2/trellis2_server.py \
  /mnt/d/AI/Prototypes/ConceptToHighresModel/scripts/danlu/trellis2/run_server.sh \
  root@apps-sl.danlu.netease.com:/project/trellis2/

ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes root@apps-sl.danlu.netease.com 'bash -s' <<'EOF'
chmod +x /project/trellis2/run_server.sh

# kill any prior instance
pkill -f trellis2_server.py 2>/dev/null
sleep 2

mkdir -p /project/trellis2/logs
bash /project/trellis2/run_server.sh --bg
sleep 3
echo "---PS---"
ps -ef | grep -E 'trellis2_server|uvicorn' | grep -v grep
echo "---HEAD---"
sleep 4
head -50 /project/trellis2/logs/server.out 2>/dev/null
echo "---HEALTH---"
python3 - <<'PY' 2>/dev/null || wget -qO- --timeout=5 http://127.0.0.1:8766/health || echo "(server not yet listening)"
import urllib.request, json
print(urllib.request.urlopen("http://127.0.0.1:8766/health", timeout=5).read().decode())
PY
EOF
