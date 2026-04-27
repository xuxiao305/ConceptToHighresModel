"""One-shot: regenerate the T-Pose and Multi-View nodes for a project page
using the deployed Qwen-Image-Edit server (via local SSH tunnel on :8765).

Prompts are mirrored from src/services/workflows.ts.
Outputs are written next to the existing node files and appended to index.json.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import sys
import time
from pathlib import Path

import requests

SERVER = "http://127.0.0.1:8765"

TPOSE_PROMPT = (
    "将图中角色转换为正面TPose, 两臂完全水平张开，双腿微张; "
    "正交视图，使用环境柔光，白色背景，白平衡5500k,美术风格保持和原图一致"
)

MULTIVIEW_PROMPT = (
    "Change the character to T-Pose, arm fully stretched horizontally, "
    "and create a professional character reference sheet based strictly on "
    "the uploaded reference image. Use a clean, neutral plain background and "
    "present the sheet as a technical model turnaround while matching the "
    "exact visual style of the reference (same realism level, rendering "
    "approach, texture, color treatment, and overall aesthetic). "
    "Arrange the composition into two horizontal rows.\n"
    "Top row column 1: front view full body\n"
    "Top row column 2: left profile character facing left\n"
    "Bottom row columan 1: right profile character facing right\n"
    "Bottom row column 2: back view\n"
    "Maintain perfect identity consistency across every panel. Keep the "
    "subject in a relaxed A-pose and with consistent scale and alignment "
    "between views, accurate anatomy, and clear silhouette; ensure even "
    "spacing and clean panel separation, with uniform framing and consistent "
    "head height across the full-body lineup and consistent facial scale "
    "across the portraits. Lighting should be consistent across all panels "
    "(same direction, intensity, and softness), with natural, controlled "
    "shadows that preserve detail without dramatic mood shifts."
)

PAGE_DIR = Path(
    r"D:\AI\Prototypes\ConceptToHighresModel\Projects\GirlOrangeJacket"
    r"\page1_concept_to_rough"
)


def latest_image(node_dir: Path) -> Path:
    idx = json.loads((node_dir / "index.json").read_text(encoding="utf-8"))
    return node_dir / idx["history"][-1]["file"]


def stamp_filename() -> tuple[str, str]:
    now_local = dt.datetime.now()
    now_utc = dt.datetime.utcnow()
    fname = now_local.strftime("%Y%m%d_%H%M%S_") + f"{now_local.microsecond // 1000:03d}.png"
    iso = now_utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now_utc.microsecond // 1000:03d}Z"
    return fname, iso


def _resize_for_edit(path: Path, max_side: int = 768) -> bytes:
    """Downscale to keep VRAM usage manageable on a single A30 24GB."""
    from io import BytesIO
    from PIL import Image

    img = Image.open(path).convert("RGB")
    w, h = img.size
    scale = max_side / max(w, h)
    if scale < 1.0:
        nw = int(round(w * scale)) // 8 * 8
        nh = int(round(h * scale)) // 8 * 8
        img = img.resize((nw, nh), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="PNG")
    print(f"  input {path.name} -> {img.size}")
    return buf.getvalue()


def edit(image_path: Path, prompt: str, *, steps: int, cfg: float, seed: int) -> bytes:
    body = {
        "image_b64": base64.b64encode(_resize_for_edit(image_path)).decode("ascii"),
        "prompt": prompt,
        "negative_prompt": " ",
        "num_inference_steps": steps,
        "true_cfg_scale": cfg,
        "seed": seed,
    }
    print(f"  POST /edit_b64  steps={steps} cfg={cfg} seed={seed} src={image_path.name}")
    t0 = time.time()
    r = requests.post(f"{SERVER}/edit_b64", json=body, timeout=1800)
    dt_s = time.time() - t0
    if r.status_code != 200:
        raise RuntimeError(f"server {r.status_code}: {r.text[:500]}")
    data = r.json()
    print(f"  -> 200 in {dt_s:.1f}s  meta={ {k: v for k, v in data.items() if k != 'image_b64'} }")
    return base64.b64decode(data["image_b64"])


def write_output(node_dir: Path, png_bytes: bytes) -> str:
    fname, iso = stamp_filename()
    out = node_dir / fname
    out.write_bytes(png_bytes)
    idx_path = node_dir / "index.json"
    idx = json.loads(idx_path.read_text(encoding="utf-8"))
    idx["history"].append({"file": fname, "timestamp": iso, "note": "qwen-image-edit-2511"})
    idx_path.write_text(json.dumps(idx, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  saved: {out}")
    return fname


def main() -> int:
    # health check
    h = requests.get(f"{SERVER}/health", timeout=10).json()
    print(f"server health: {h}")
    if not h.get("model_loaded"):
        print("model not loaded, calling /warmup ...")
        requests.post(f"{SERVER}/warmup", timeout=1800).raise_for_status()

    concept_dir = PAGE_DIR / "01_concept"
    tpose_dir = PAGE_DIR / "02_tpose"
    mv_dir = PAGE_DIR / "03_multiview"

    seed = 42

    print("\n=== [1/2] Concept -> T-Pose ===")
    src = latest_image(concept_dir)
    png = edit(src, TPOSE_PROMPT, steps=40, cfg=4.0, seed=seed)
    write_output(tpose_dir, png)

    print("\n=== [2/2] T-Pose -> Multi-View ===")
    src = latest_image(tpose_dir)  # use existing tpose as the multiview node's input
    # Per user: regenerate each node from its own existing input image. The
    # tpose node's input *was* the concept; the multiview node's input *was*
    # the previous tpose. So pull the previous tpose, not the one we just made.
    # But we just appended a new entry, so use index [-2] if available.
    idx = json.loads((tpose_dir / "index.json").read_text(encoding="utf-8"))
    if len(idx["history"]) >= 2:
        src = tpose_dir / idx["history"][-2]["file"]
    png = edit(src, MULTIVIEW_PROMPT, steps=40, cfg=4.0, seed=seed)
    write_output(mv_dir, png)

    print("\nDONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
