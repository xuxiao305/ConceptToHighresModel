"""
RMBG-2.0 standalone worker (background removal, white-composite output).

Mirrors the inference + post-processing of ComfyUI's
`comfyui-rmbg/py/AILab_RMBG.py` (RMBGModel + RMBG.process_image's `Color`
background branch) but without depending on ComfyUI's runtime — loads the
RMBG-2.0 model directly from its local cache directory via
`transformers.AutoModelForImageSegmentation`.

Invoked by the Vite dev plugin `rmbg-bridge` (vite.config.ts) over a
subprocess; reads one input image and writes one output PNG with the
foreground composited onto a solid background.

CLI:
  python rmbg_worker.py
    --input <path/to/in.png>
    --output <path/to/out.png>
    [--model-dir <D:/AI/.../models/RMBG/RMBG-2.0>]
    [--process-res 1024]
    [--sensitivity 1.0]
    [--mask-blur 0]
    [--mask-offset 0]
    [--background-color #ffffff]

Defaults match the BananaExtractJacket.json workflow's RMBG node
(model=RMBG-2.0, sensitivity=1, process_res=1024, background=Color/#ffffff,
mask_blur=0, mask_offset=0, refine_foreground=false).

Exit codes:
  0   success
  2   bad CLI / missing model
  3   inference error
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import types
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter
import torch.nn.functional as F
from torchvision import transforms


DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# ---------------------------------------------------------------------------
# Model loading — replicates comfyui-rmbg's "modern transformers" path.
# ---------------------------------------------------------------------------

def load_rmbg_model(model_dir: Path):
    """
    Load RMBG-2.0 BiRefNet from a local cache directory.

    The cache directory must contain (matches huggingface 1038lab/RMBG-2.0):
        config.json
        model.safetensors
        birefnet.py
        BiRefNet_config.py
    """
    if not model_dir.is_dir():
        raise FileNotFoundError(f"RMBG model dir not found: {model_dir}")

    config_path = model_dir / "config.json"
    birefnet_path = model_dir / "birefnet.py"
    birefnet_config_path = model_dir / "BiRefNet_config.py"
    weights_path = model_dir / "model.safetensors"

    for p in (config_path, birefnet_path, birefnet_config_path, weights_path):
        if not p.is_file():
            raise FileNotFoundError(f"Missing RMBG asset: {p}")

    # 1. Load BiRefNet_config.py as a module
    cfg_spec = importlib.util.spec_from_file_location("BiRefNetConfig", birefnet_config_path)
    cfg_module = importlib.util.module_from_spec(cfg_spec)
    sys.modules["BiRefNetConfig"] = cfg_module
    cfg_spec.loader.exec_module(cfg_module)
    BiRefNetConfig = getattr(cfg_module, "BiRefNetConfig")

    # 2. Load birefnet.py — patch the relative import so the bare-source path works.
    src = birefnet_path.read_text(encoding="utf-8")
    src = src.replace(
        "from .BiRefNet_config import BiRefNetConfig",
        "from BiRefNetConfig import BiRefNetConfig",
    )
    module_name = f"custom_birefnet_model_{abs(hash(str(birefnet_path)))}"
    module = types.ModuleType(module_name)
    sys.modules[module_name] = module
    exec(src, module.__dict__)

    # 3. Find the PreTrainedModel subclass and instantiate.
    from transformers import PreTrainedModel
    target_cls = None
    for attr_name in dir(module):
        attr = getattr(module, attr_name)
        if isinstance(attr, type) and issubclass(attr, PreTrainedModel) and attr is not PreTrainedModel:
            target_cls = attr
            break
    if target_cls is None:
        raise RuntimeError("birefnet.py did not expose a PreTrainedModel subclass")

    model = target_cls(BiRefNetConfig())

    # 4. Load weights.
    try:
        import safetensors.torch
        state_dict = safetensors.torch.load_file(str(weights_path))
    except ImportError:
        from transformers.modeling_utils import load_state_dict
        state_dict = load_state_dict(str(weights_path))
    model.load_state_dict(state_dict)

    model.eval()
    for p in model.parameters():
        p.requires_grad = False
    torch.set_float32_matmul_precision("high")
    model.to(DEVICE)
    return model


# ---------------------------------------------------------------------------
# Inference (single image) — matches RMBGModel.process_image semantics.
# ---------------------------------------------------------------------------

def infer_mask(model, pil_img: Image.Image, process_res: int, sensitivity: float) -> Image.Image:
    """Returns a grayscale 'L' mask sized to pil_img."""
    transform = transforms.Compose([
        transforms.Resize((process_res, process_res)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    orig_w, orig_h = pil_img.size
    rgb = pil_img.convert("RGB")
    inp = transform(rgb).unsqueeze(0).to(DEVICE)

    with torch.no_grad():
        out = model(inp)
        if isinstance(out, list) and out:
            logits = out[-1]
        elif isinstance(out, dict) and "logits" in out:
            logits = out["logits"]
        elif isinstance(out, torch.Tensor):
            logits = out
        else:
            # huggingface ModelOutput-style: take first tensor field.
            logits = None
            for v in (getattr(out, "values", lambda: [])() or []):
                if isinstance(v, torch.Tensor):
                    logits = v
                    break
            if logits is None:
                raise RuntimeError("Unrecognized RMBG model output format")

        prob = logits.sigmoid().cpu().squeeze()
        prob = prob * (1.0 + (1.0 - sensitivity))
        prob = torch.clamp(prob, 0.0, 1.0)
        prob = F.interpolate(
            prob.unsqueeze(0).unsqueeze(0),
            size=(orig_h, orig_w),
            mode="bilinear",
            align_corners=False,
        ).squeeze()

    arr = (prob.numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="L")


def composite_on_background(
    pil_img: Image.Image,
    mask: Image.Image,
    bg_color_hex: str,
) -> Image.Image:
    """Compose the source RGB onto a solid background using the L mask."""
    rgba = pil_img.convert("RGBA")
    r, g, b, _ = rgba.split()
    foreground = Image.merge("RGBA", (r, g, b, mask))

    rgba_color = _parse_hex_color(bg_color_hex)
    bg = Image.new("RGBA", pil_img.size, rgba_color)
    return Image.alpha_composite(bg, foreground).convert("RGB")


def _parse_hex_color(hex_color: str) -> tuple[int, int, int, int]:
    s = hex_color.lstrip("#")
    if len(s) == 6:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), 255)
    if len(s) == 8:
        return (
            int(s[0:2], 16), int(s[2:4], 16),
            int(s[4:6], 16), int(s[6:8], 16),
        )
    raise ValueError(f"Invalid hex color: {hex_color!r}")


# ---------------------------------------------------------------------------
# Optional mask post-processing (blur / offset) — matches RMBG.process_image.
# ---------------------------------------------------------------------------

def post_process_mask(mask: Image.Image, blur: int, offset: int) -> Image.Image:
    out = mask
    if blur > 0:
        out = out.filter(ImageFilter.GaussianBlur(radius=blur))
    if offset > 0:
        for _ in range(offset):
            out = out.filter(ImageFilter.MaxFilter(3))
    elif offset < 0:
        for _ in range(-offset):
            out = out.filter(ImageFilter.MinFilter(3))
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _default_model_dir() -> Path:
    # Honour env override; fall back to the known ComfyUI Easy Install location.
    env = os.environ.get("RMBG_MODEL_DIR")
    if env:
        return Path(env)
    return Path(r"D:\AI\ComfyUI-Easy-Install\ComfyUI\models\RMBG\RMBG-2.0")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="RMBG-2.0 background removal worker")
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--model-dir", type=Path, default=None)
    p.add_argument("--process-res", type=int, default=1024)
    p.add_argument("--sensitivity", type=float, default=1.0)
    p.add_argument("--mask-blur", type=int, default=0)
    p.add_argument("--mask-offset", type=int, default=0)
    p.add_argument("--background-color", default="#ffffff")
    args = p.parse_args(argv)

    model_dir = args.model_dir or _default_model_dir()

    if not args.input.is_file():
        print(f"[rmbg-worker] input not found: {args.input}", file=sys.stderr)
        return 2

    try:
        pil_img = Image.open(args.input)
        pil_img.load()
    except Exception as exc:
        print(f"[rmbg-worker] failed to read input: {exc}", file=sys.stderr)
        return 2

    try:
        model = load_rmbg_model(model_dir)
    except Exception as exc:
        print(f"[rmbg-worker] model load failed: {exc}", file=sys.stderr)
        return 2

    try:
        mask = infer_mask(model, pil_img, args.process_res, args.sensitivity)
        mask = post_process_mask(mask, args.mask_blur, args.mask_offset)
        composite = composite_on_background(pil_img, mask, args.background_color)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        composite.save(args.output, format="PNG")
    except Exception as exc:
        print(f"[rmbg-worker] inference failed: {exc}", file=sys.stderr)
        return 3

    # Tiny machine-readable status line (last line of stdout).
    print(json.dumps({"ok": True, "size": list(composite.size)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
