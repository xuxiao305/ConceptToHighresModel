"""
SegFormer garment parsing worker.

Runs HuggingFace `mattmdjaga/segformer_b2_clothes` on one image and writes:
  - a single-channel label PNG, where each pixel value is the class id
  - an optional SAM3-compatible segmentation JSON with selected garment classes

This is intentionally shaped like the existing RMBG worker: the Vite dev server
spawns this script per request, so GPU/CPU memory is released when the process
exits.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from transformers import AutoImageProcessor, SegformerForSemanticSegmentation


DEFAULT_MODEL_ID = "mattmdjaga/segformer_b2_clothes"
DEFAULT_CACHE_DIR = Path(r"C:\Users\xuxiao02\.cache\huggingface\hub")
DEFAULT_GARMENT_CLASSES = ("Upper-clothes", "Dress", "Skirt", "Pants", "Scarf")


PALETTE = np.array([
    [0, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [128, 128, 0],
    [0, 0, 128],
    [128, 0, 128],
    [0, 128, 128],
    [128, 128, 128],
    [64, 0, 0],
    [192, 0, 0],
    [64, 128, 0],
    [192, 128, 0],
    [64, 0, 128],
    [192, 0, 128],
    [64, 128, 128],
    [192, 128, 128],
    [0, 64, 0],
    [128, 64, 0],
], dtype=np.uint8)


def _device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


def _load_model(model_id_or_dir: str, cache_dir: Path | None, local_files_only: bool):
    kwargs = {
        "cache_dir": str(cache_dir) if cache_dir else None,
        "local_files_only": local_files_only,
    }
    kwargs = {k: v for k, v in kwargs.items() if v is not None}
    processor = AutoImageProcessor.from_pretrained(model_id_or_dir, **kwargs)
    model = SegformerForSemanticSegmentation.from_pretrained(model_id_or_dir, **kwargs)
    model.eval()
    model.to(_device())
    return processor, model


def _predict_label(image: Image.Image, processor, model) -> np.ndarray:
    rgb = image.convert("RGB")
    inputs = processor(images=rgb, return_tensors="pt")
    inputs = {k: v.to(_device()) for k, v in inputs.items()}
    with torch.no_grad():
        logits = model(**inputs).logits
        logits = F.interpolate(
            logits,
            size=(rgb.height, rgb.width),
            mode="bilinear",
            align_corners=False,
        )
        pred = logits.argmax(dim=1)[0].detach().cpu().numpy().astype(np.uint8)
    return pred


def _label_to_color(label: np.ndarray) -> Image.Image:
    h, w = label.shape
    color = np.zeros((h, w, 3), dtype=np.uint8)
    for cls_id in range(min(len(PALETTE), int(label.max()) + 1)):
        color[label == cls_id] = PALETTE[cls_id]
    return Image.fromarray(color, mode="RGB")


def _bbox_from_mask(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask)
    if xs.size == 0 or ys.size == 0:
        return None
    x1 = int(xs.min())
    y1 = int(ys.min())
    x2 = int(xs.max())
    y2 = int(ys.max())
    return x1, y1, x2, y2


def _build_segmentation_json(
    label: np.ndarray,
    id2label: dict[int, str],
    image_name: str,
    mask_name: str,
    include_names: set[str],
) -> dict:
    objects = []
    used_values = set()
    for cls_id in sorted(int(x) for x in np.unique(label)):
        if cls_id == 0:
            continue
        name = id2label.get(cls_id, f"Class_{cls_id}")
        if include_names and name not in include_names:
            continue
        mask = label == cls_id
        bbox = _bbox_from_mask(mask)
        if bbox is None:
            continue
        x1, y1, x2, y2 = bbox
        mask_value = cls_id
        if mask_value in used_values or mask_value <= 0:
            mask_value = min(255, len(objects) + 1)
        used_values.add(mask_value)
        objects.append({
            "label": name,
            "class_id": cls_id,
            "mask_value": mask_value,
            "bbox": {
                "xyxy": [x1, y1, x2, y2],
                "xywh": [x1, y1, x2 - x1 + 1, y2 - y1 + 1],
            },
            "pixel_count": int(mask.sum()),
        })
    return {
        "image": image_name,
        "mask_png": mask_name,
        "model": DEFAULT_MODEL_ID,
        "objects": objects,
    }


def _parse_class_names(raw: str | None) -> set[str]:
    if raw is None or raw.strip() == "":
        return set(DEFAULT_GARMENT_CLASSES)
    if raw.strip().lower() in {"all", "*"}:
        return set()
    return {x.strip() for x in raw.split(",") if x.strip()}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="SegFormer garment parsing worker")
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--label-output", required=True, type=Path)
    p.add_argument("--json-output", type=Path)
    p.add_argument("--color-output", type=Path)
    p.add_argument("--model", default=os.environ.get("SEGFORMER_MODEL", DEFAULT_MODEL_ID))
    p.add_argument("--cache-dir", type=Path, default=Path(os.environ.get("HF_HOME", DEFAULT_CACHE_DIR)))
    p.add_argument("--classes", default=",".join(DEFAULT_GARMENT_CLASSES),
                   help="Comma-separated class names to export as JSON objects; use 'all' for every non-background class.")
    p.add_argument("--allow-download", action="store_true")
    args = p.parse_args(argv)

    if not args.input.is_file():
        print(f"[segformer-worker] input not found: {args.input}", file=sys.stderr)
        return 2

    try:
        image = Image.open(args.input)
        image.load()
    except Exception as exc:
        print(f"[segformer-worker] failed to read input: {exc}", file=sys.stderr)
        return 2

    try:
        processor, model = _load_model(
            args.model,
            args.cache_dir,
            local_files_only=not args.allow_download,
        )
        label = _predict_label(image, processor, model)
        args.label_output.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(label, mode="L").save(args.label_output, format="PNG")

        if args.color_output:
            args.color_output.parent.mkdir(parents=True, exist_ok=True)
            _label_to_color(label).save(args.color_output, format="PNG")

        id2label = {int(k): v for k, v in model.config.id2label.items()}
        include_names = _parse_class_names(args.classes)
        exported_json = None
        if args.json_output:
            exported_json = _build_segmentation_json(
                label=label,
                id2label=id2label,
                image_name=args.input.name,
                mask_name=args.label_output.name,
                include_names=include_names,
            )
            args.json_output.parent.mkdir(parents=True, exist_ok=True)
            args.json_output.write_text(json.dumps(exported_json, ensure_ascii=False, indent=2), encoding="utf-8")

        classes_present = [
            {"id": int(cls_id), "label": id2label.get(int(cls_id), f"Class_{int(cls_id)}"), "pixels": int((label == cls_id).sum())}
            for cls_id in sorted(np.unique(label))
        ]
        print(json.dumps({
            "ok": True,
            "size": [int(image.width), int(image.height)],
            "device": _device(),
            "classesPresent": classes_present,
            "objects": exported_json["objects"] if exported_json else [],
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"[segformer-worker] inference failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
