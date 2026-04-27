#!/usr/bin/env bash
# Re-install qwen_edit deps using fast Chinese mirrors.
# Aliyun mirrors PyTorch wheels at full bandwidth; Tsinghua mirrors PyPI.
set -u
LOG="/project/qwen_edit/setup.log"
mkdir -p "$(dirname "$LOG")"

source /root/miniconda3/etc/profile.d/conda.sh
conda activate qwen_edit

PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
TORCH_INDEX="https://mirrors.aliyun.com/pytorch-wheels/cu121"

echo "[$(date)] === REINSTALL torch via Aliyun PyTorch mirror ===" >> "$LOG"

# Install torch + torchvision from Aliyun (cu121 wheels), fall back to Tsinghua PyPI
# for the nvidia-* dependencies (those manylinux wheels are on plain PyPI).
pip install --no-cache-dir \
  --index-url "$PIP_INDEX" \
  --extra-index-url "$TORCH_INDEX" \
  torch==2.4.1+cu121 torchvision==0.19.1+cu121 \
  >> "$LOG" 2>&1

echo "[$(date)] === installing remaining deps (diffusers/fastapi stack) ===" >> "$LOG"
pip install --no-cache-dir --index-url "$PIP_INDEX" \
  "diffusers>=0.32.0" \
  "transformers>=4.49.0" \
  "accelerate>=1.0.0" \
  "safetensors>=0.4.5" \
  sentencepiece \
  protobuf \
  pillow \
  fastapi \
  "uvicorn[standard]" \
  python-multipart \
  >> "$LOG" 2>&1

echo "[$(date)] === DONE. Versions: ===" >> "$LOG"
python -c "import torch, diffusers, transformers; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('diffusers', diffusers.__version__); print('transformers', transformers.__version__)" >> "$LOG" 2>&1
