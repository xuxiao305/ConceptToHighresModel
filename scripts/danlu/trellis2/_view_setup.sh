#!/bin/bash
set -e
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes -o StrictHostKeyChecking=no \
    root@apps-sl.danlu.netease.com 'bash -s' <<'REMOTE'
sed -n '75,250p' /project/trellis2/TRELLIS.2/setup.sh
REMOTE
