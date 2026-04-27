#!/bin/bash
set -u
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key
ssh -i /tmp/DanLu_key -p 44304 -o BatchMode=yes -o StrictHostKeyChecking=no \
    root@apps-sl.danlu.netease.com 'bash -s' <<'REMOTE'
echo "=== nvcc / nvidia-smi ==="
which nvcc; nvcc --version 2>/dev/null | head -5
nvidia-smi | head -15
echo
echo "=== /usr/local/cuda* ==="
ls -la /usr/local/ 2>/dev/null | grep -i cuda
echo
echo "=== other common CUDA locations ==="
ls -la /opt/ 2>/dev/null | grep -i cuda
ls -la /data/ 2>/dev/null | grep -i cuda
echo
echo "=== inside trellis2 env: torch CUDA info ==="
source /root/miniconda3/etc/profile.d/conda.sh
conda activate trellis2
python -c "import torch; print('torch.version.cuda=', torch.version.cuda); print('torch.cuda.is_available=', torch.cuda.is_available())"
echo
echo "=== TRELLIS.2 repo state ==="
ls /project/trellis2/TRELLIS.2/ 2>/dev/null | head -20
ls /project/trellis2/TRELLIS.2/o-voxel/ 2>/dev/null | head
ls /project/trellis2/TRELLIS.2/trellis2/ 2>/dev/null | head
echo
echo "=== setup.sh contents preview ==="
head -80 /project/trellis2/TRELLIS.2/setup.sh
REMOTE
