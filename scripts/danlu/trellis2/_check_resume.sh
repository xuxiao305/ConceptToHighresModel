#!/bin/bash
# Tail the resume_setup activity specifically.
set -u
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes -o StrictHostKeyChecking=no \
    root@apps-sl.danlu.netease.com 'bash -s' <<'REMOTE'
echo "=== running processes ==="
ps -ef | grep -E 'resume_setup|setup\.sh|pip|conda|nvcc|gcc|g\+\+|cargo|cmake|ninja' | grep -v grep | head -30
echo
echo "=== resume.out tail (last 80) ==="
tail -n 80 /project/trellis2/logs/resume.out 2>/dev/null
echo
echo "=== setup.log tail (last 80) ==="
tail -n 80 /project/trellis2/logs/setup.log 2>/dev/null
echo
echo "=== env disk usage ==="
du -sh /root/miniconda3/envs/trellis2 2>/dev/null
echo
echo "=== nvcc check (in env) ==="
source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2 2>/dev/null
which nvcc
nvcc --version 2>/dev/null | head -5
REMOTE
