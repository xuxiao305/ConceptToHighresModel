#!/usr/bin/env bash
# Run on server directly (no nested ssh).
echo "===net hf-mirror==="
wget -S -O /dev/null --timeout=10 --tries=1 https://hf-mirror.com/ 2>&1 | head -8
echo
echo "===net huggingface==="
wget -S -O /dev/null --timeout=10 --tries=1 https://huggingface.co/ 2>&1 | head -8
echo
echo "===dns==="
getent hosts hf-mirror.com huggingface.co
echo
echo "===env-of-server==="
PID=$(pgrep -f trellis2_server.py | head -1)
echo "PID=$PID"
[ -n "$PID" ] && tr '\0' '\n' < /proc/$PID/environ | grep -E 'HF_|HUGG|PROXY|TRANS|http_'
echo
echo "===tail server.out==="
tail -80 /project/trellis2/logs/server.out
