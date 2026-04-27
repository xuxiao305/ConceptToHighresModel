#!/usr/bin/env bash
# Background downloader for microsoft/TRELLIS.2-4B from hf-mirror.
# Resumable. Logs to /project/trellis2/logs/download.log
#
# Total size ≈ 16.2 GB (mostly the ckpts/ folder).
set -u
export HF_ENDPOINT=https://hf-mirror.com
REPO="microsoft/TRELLIS.2-4B"
DEST="/project/trellis2/models/TRELLIS.2-4B"
LOG="/project/trellis2/logs/download.log"

mkdir -p "$DEST"
mkdir -p "$(dirname "$LOG")"

echo "[$(date)] Start download $REPO -> $DEST" >> "$LOG"

# Get file list via HF API
wget -q -O /tmp/trellis2_repo.json --tries=3 --timeout=30 \
  "$HF_ENDPOINT/api/models/$REPO"
FILES=$(python3 -c "import json; d=json.load(open('/tmp/trellis2_repo.json')); [print(s['rfilename']) for s in d.get('siblings',[])]")

for f in $FILES; do
  url="$HF_ENDPOINT/$REPO/resolve/main/$f"
  out="$DEST/$f"
  mkdir -p "$(dirname "$out")"
  if [ -s "$out" ]; then
    echo "[$(date)] SKIP (exists) $f" >> "$LOG"
    continue
  fi
  echo "[$(date)] GET $f" >> "$LOG"
  wget -q -c -O "$out" --tries=5 --timeout=120 "$url" 2>>"$LOG"
  if [ $? -ne 0 ]; then
    echo "[$(date)] FAIL $f" >> "$LOG"
  else
    sz=$(stat -c%s "$out")
    echo "[$(date)] OK  $f ($sz bytes)" >> "$LOG"
  fi
done

echo "[$(date)] DONE. Total size:" >> "$LOG"
du -sh "$DEST" >> "$LOG"
