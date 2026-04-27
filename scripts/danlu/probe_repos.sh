#!/usr/bin/env bash
set -u
export HF_ENDPOINT=https://hf-mirror.com
for repo in Qwen/Qwen-Image-Edit-2511 Qwen/Qwen-Image-Edit-2509 Qwen/Qwen-Image-Edit; do
  echo "=== $repo"
  wget -q -O /tmp/repo.json --tries=1 --timeout=15 "$HF_ENDPOINT/api/models/$repo"
  if [ -s /tmp/repo.json ]; then
    python3 - <<'PY'
import json
d = json.load(open('/tmp/repo.json'))
print('id=', d.get('id'), 'pipeline=', d.get('pipeline_tag'),
      'lib=', d.get('library_name'), 'gated=', d.get('gated'),
      'siblings=', len(d.get('siblings', [])))
for s in d.get('siblings', [])[:40]:
    print(' ', s['rfilename'])
PY
  else
    echo "  (no response)"
  fi
done
