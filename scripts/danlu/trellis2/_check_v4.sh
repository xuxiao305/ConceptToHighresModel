#!/usr/bin/env bash
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes root@apps-sl.danlu.netease.com 'bash -s' <<'EOF'
echo "===PS==="
ps -ef | grep -E 'resume_setup_v4|pip|wget|cicc|nvcc|setup.py|cmake' | grep -v grep | head -30
echo "===TAIL==="
tail -80 /project/trellis2/logs/resume4.out
echo "===WHL==="
ls -la /project/trellis2/wheels/ 2>/dev/null
echo "===SIZE==="
du -sh /root/miniconda3/envs/trellis2 2>/dev/null
EOF
