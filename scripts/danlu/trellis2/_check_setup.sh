#!/bin/bash
set -u
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes -o StrictHostKeyChecking=no \
    root@apps-sl.danlu.netease.com 'bash -s' <<'REMOTE'
echo "=== SETUP log tail (last 100) ==="
tail -n 100 /project/trellis2/logs/setup.log
echo
echo "=== SETUP nohup stderr/stdout (last 60) ==="
tail -n 60 /project/trellis2/logs/setup.out 2>/dev/null
echo
echo "=== conda envs ==="
source /root/miniconda3/etc/profile.d/conda.sh
conda env list
echo
echo "=== running setup-related processes ==="
ps -ef | grep -E 'setup|pip|nvcc|gcc|c\+\+|conda|wget|cargo' | grep -v grep | head -30
REMOTE
