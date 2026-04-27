#!/bin/bash
# Helper run from WSL2: launches download + setup on DanLu in background.
set -u
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes -o StrictHostKeyChecking=no \
    root@apps-sl.danlu.netease.com 'bash -s' <<'REMOTE'
set -u
mkdir -p /project/trellis2/logs
nohup bash /project/trellis2/download_trellis2.sh \
    > /project/trellis2/logs/download.out 2>&1 < /dev/null &
echo "DOWNLOAD_PID=$!"
nohup bash /project/trellis2/setup_env.sh \
    > /project/trellis2/logs/setup.out 2>&1 < /dev/null &
echo "SETUP_PID=$!"
sleep 3
ps -ef | grep -E 'setup_env|download_trellis2' | grep -v grep
REMOTE
