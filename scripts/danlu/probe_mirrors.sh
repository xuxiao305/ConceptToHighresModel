#!/usr/bin/env bash
# Probe download speed for torch wheel from multiple mirrors.
set -u

URLS=(
  "https://mirrors.aliyun.com/pytorch-wheels/cu121/torch-2.4.1%2Bcu121-cp311-cp311-linux_x86_64.whl"
  "https://mirror.sjtu.edu.cn/pytorch-wheels/cu121/torch-2.4.1%2Bcu121-cp311-cp311-linux_x86_64.whl"
  "https://download.pytorch.org/whl/cu121/torch-2.4.1%2Bcu121-cp311-cp311-linux_x86_64.whl"
)

for url in "${URLS[@]}"; do
  echo "=== $url"
  rm -f /tmp/probe.bin
  timeout 8 wget -q -O /tmp/probe.bin "$url"
  sz=$(stat -c%s /tmp/probe.bin 2>/dev/null || echo 0)
  echo "  got $sz bytes in 8s ( $(( sz / 8 / 1024 )) KB/s )"
done
rm -f /tmp/probe.bin
