#!/usr/bin/env bash
pkill -f trellis2_server.py 2>/dev/null
sleep 2
bash /project/trellis2/run_server.sh --bg
sleep 6
echo "===PS==="
ps -ef | grep trellis2_server | grep -v grep
echo "===tail==="
tail -30 /project/trellis2/logs/server.out
