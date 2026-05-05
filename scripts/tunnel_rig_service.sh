#!/bin/bash
# 建立到丹炉 Rig 服务的 SSH 隧道
# 本地 8765 → 丹炉 localhost:8765
# Ctrl+C 即可关闭

KEY=/mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa
TMP_KEY=/tmp/DanLu_key

cp "$KEY" "$TMP_KEY"
chmod 600 "$TMP_KEY"

echo "建立 SSH 隧道: localhost:8765 → DanLu rig service"
echo "按 Ctrl+C 关闭"
echo ""

ssh -i "$TMP_KEY" \
    -L 8765:localhost:8765 \
    -p 44304 \
    -o StrictHostKeyChecking=no \
    -o ServerAliveInterval=60 \
    -N \
    root@apps-sl.danlu.netease.com
