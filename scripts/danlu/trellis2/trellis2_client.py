"""Local CLI: call the TRELLIS.2 server through the SSH tunnel.

Assumes you have started a tunnel:
    ssh -i C:\\tmp\\DanLu_key -p 44304 -L 8766:127.0.0.1:8766 \
        root@apps-sl.danlu.netease.com

Usage:
    python scripts/danlu/trellis2/trellis2_client.py \
        --image input.png --out output.glb --warmup
"""

from __future__ import annotations

import argparse
import base64
import sys
import time
from pathlib import Path

import requests


def encode(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--server", default="http://127.0.0.1:8766")
    p.add_argument("--image", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--ss-steps", type=int, default=12)
    p.add_argument("--slat-steps", type=int, default=12)
    p.add_argument("--cfg", type=float, default=3.0)
    p.add_argument("--decimation", type=int, default=200_000)
    p.add_argument("--texture-size", type=int, default=2048)
    p.add_argument("--no-remesh", action="store_true")
    p.add_argument("--warmup", action="store_true",
                   help="Hit /warmup first (recommended on a cold server)")
    args = p.parse_args()

    if args.warmup:
        print("warming up server (cold start can take 1-3 minutes)...")
        r = requests.post(f"{args.server}/warmup", timeout=1800)
        r.raise_for_status()
        print("  ", r.json())

    body = {
        "image_b64": encode(args.image),
        "sparse_structure_steps": args.ss_steps,
        "slat_steps": args.slat_steps,
        "cfg_strength": args.cfg,
        "decimation_target": args.decimation,
        "texture_size": args.texture_size,
        "remesh": not args.no_remesh,
    }
    if args.seed is not None:
        body["seed"] = args.seed

    print(f"POST {args.server}/generate_b64  ss={args.ss_steps} "
          f"slat={args.slat_steps} cfg={args.cfg}")
    t0 = time.time()
    r = requests.post(f"{args.server}/generate_b64", json=body, timeout=1800)
    print(f"  -> {r.status_code} in {time.time() - t0:.1f}s")
    if r.status_code != 200:
        print(r.text, file=sys.stderr)
        return 1

    data = r.json()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(base64.b64decode(data["glb_b64"]))
    meta = {k: v for k, v in data.items() if k != "glb_b64"}
    print(f"saved: {args.out}  meta={meta}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
