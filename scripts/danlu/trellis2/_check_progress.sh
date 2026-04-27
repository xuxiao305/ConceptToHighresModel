#!/bin/bash
# Check progress of background jobs on DanLu.
set -u
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes -o StrictHostKeyChecking=no \
    root@apps-sl.danlu.netease.com 'bash -s' <<'REMOTE'
echo "=== DOWNLOAD log (last 40) ==="
tail -n 40 /project/trellis2/logs/download.log 2>/dev/null || echo "(no log yet)"
echo
echo "=== SETUP log (last 60) ==="
tail -n 60 /project/trellis2/logs/setup.log 2>/dev/null || echo "(no log yet)"
echo
echo "=== Disk usage ==="
du -sh /project/trellis2/models 2>/dev/null
du -sh /project/trellis2/TRELLIS.2 2>/dev/null
du -sh /project/trellis2/wheels 2>/dev/null
echo
echo "=== Active processes ==="
ps -ef | grep -E 'setup_env|download_trellis2|wget|pip|conda|nvcc|gcc' | grep -v grep | head -n 25
REMOTE
