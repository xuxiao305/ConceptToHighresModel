PID=$(pgrep -f trellis2_server.py | head -1); echo "PID=$PID"
[ -n "$PID" ] && tr "\0" "\n" < /proc/$PID/environ | grep -E "HF_|HUGG|PROXY|TRANS|http_"
echo "===tail==="
tail -120 /project/trellis2/logs/server.out
