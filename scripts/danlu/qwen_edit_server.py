"""FastAPI server exposing Qwen-Image-Edit-2511 over HTTP.

Designed for a single 24GB GPU (NVIDIA A30) using diffusers'
`enable_model_cpu_offload()` so the ~50GB model can run by streaming
weights between CPU RAM and GPU VRAM.

Endpoints
---------
GET  /health        -> {"status": "...", "model_loaded": bool, "device": str}
POST /warmup        -> Force model load (returns when ready)
POST /edit          -> multipart/form-data: `image` file + `payload` JSON,
                       returns image/png
POST /edit_b64      -> JSON: {image_b64, prompt, ...}, returns
                       {image_b64, seed, steps, elapsed_sec}

The API returns deterministic outputs when `seed` is provided.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image
from pydantic import BaseModel, Field

LOG = logging.getLogger("qwen_edit_server")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

MODEL_PATH = os.environ.get(
    "QWEN_EDIT_MODEL_PATH",
    "/project/qwen_edit/models/Qwen-Image-Edit-2511",
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Lazy-loaded singletons
_pipe = None
_pipe_class_name: str | None = None


def _select_pipeline_class():
    """Pick the diffusers pipeline class for Qwen-Image-Edit.

    Newer (2509/2511) checkpoints use `QwenImageEditPlusPipeline`; the
    original release uses `QwenImageEditPipeline`. Read model_index.json
    to decide.
    """
    import diffusers

    idx_path = os.path.join(MODEL_PATH, "model_index.json")
    cls_name = "QwenImageEditPipeline"
    if os.path.exists(idx_path):
        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                idx = json.load(f)
            cls_name = idx.get("_class_name", cls_name)
        except Exception as exc:
            LOG.warning("failed to read model_index.json: %s", exc)

    cls = getattr(diffusers, cls_name, None)
    if cls is None:
        # Fallback search
        for fallback in (
            "QwenImageEditPlusPipeline",
            "QwenImageEditPipeline",
            "DiffusionPipeline",
        ):
            cls = getattr(diffusers, fallback, None)
            if cls is not None:
                cls_name = fallback
                break
    if cls is None:
        raise RuntimeError("No suitable diffusers pipeline class found")
    return cls, cls_name


def load_pipeline():
    global _pipe, _pipe_class_name
    if _pipe is not None:
        return _pipe

    LOG.info("loading Qwen-Image-Edit from %s ...", MODEL_PATH)
    t0 = time.time()
    cls, cls_name = _select_pipeline_class()
    _pipe_class_name = cls_name
    LOG.info("using pipeline class: %s", cls_name)

    pipe = cls.from_pretrained(MODEL_PATH, torch_dtype=torch.bfloat16)

    # 24GB A30 cannot hold the bf16 Qwen-Image-Edit transformer + activations
    # via module-level offload, so we use sequential (submodule) offload.
    # Slower but reliably fits in <16GB peak VRAM.
    offload_mode = os.environ.get("QWEN_EDIT_OFFLOAD", "sequential").lower()
    if offload_mode == "model":
        pipe.enable_model_cpu_offload()
    else:
        pipe.enable_sequential_cpu_offload()
    try:
        pipe.enable_vae_tiling()
    except Exception:
        pass
    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass

    _pipe = pipe
    LOG.info("pipeline ready in %.1fs", time.time() - t0)
    return _pipe


@asynccontextmanager
async def lifespan(app: FastAPI):
    LOG.info("server start; MODEL_PATH=%s DEVICE=%s", MODEL_PATH, DEVICE)
    if os.environ.get("QWEN_EDIT_EAGER_LOAD", "0") == "1":
        try:
            load_pipeline()
        except Exception as exc:
            LOG.error("eager load failed: %s", exc)
    yield


app = FastAPI(title="Qwen-Image-Edit Server", lifespan=lifespan)


class EditRequest(BaseModel):
    image_b64: str = Field(..., description="Base64 PNG/JPEG of input image")
    prompt: str = Field(..., description="Edit instruction in natural language")
    negative_prompt: str = Field(default=" ", description="Negative prompt")
    num_inference_steps: int = Field(default=40, ge=1, le=100)
    true_cfg_scale: float = Field(default=4.0, ge=0.0, le=20.0)
    seed: int | None = Field(default=None)
    width: int | None = Field(default=None)
    height: int | None = Field(default=None)


def _decode_b64_image(b64: str) -> Image.Image:
    if "," in b64 and b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def _encode_image_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _run_edit(
    image: Image.Image,
    prompt: str,
    negative_prompt: str,
    num_inference_steps: int,
    true_cfg_scale: float,
    seed: int | None,
    width: int | None,
    height: int | None,
) -> tuple[Image.Image, dict[str, Any]]:
    pipe = load_pipeline()
    if seed is None:
        seed = int(torch.randint(0, 2**31 - 1, (1,)).item())
    gen = torch.Generator(device="cuda").manual_seed(seed)

    kwargs: dict[str, Any] = dict(
        image=image,
        prompt=prompt,
        negative_prompt=negative_prompt,
        num_inference_steps=num_inference_steps,
        true_cfg_scale=true_cfg_scale,
        generator=gen,
    )
    if width is not None and height is not None:
        kwargs["width"] = width
        kwargs["height"] = height

    t0 = time.time()
    result = pipe(**kwargs)
    elapsed = time.time() - t0
    out_img = result.images[0]
    meta = {
        "seed": seed,
        "steps": num_inference_steps,
        "true_cfg_scale": true_cfg_scale,
        "elapsed_sec": round(elapsed, 2),
        "pipeline_class": _pipe_class_name,
    }
    return out_img, meta


@app.get("/health")
def health():
    info = {
        "status": "ok",
        "model_loaded": _pipe is not None,
        "pipeline_class": _pipe_class_name,
        "model_path": MODEL_PATH,
        "device": DEVICE,
    }
    if torch.cuda.is_available():
        info["gpu_name"] = torch.cuda.get_device_name(0)
        info["gpu_count"] = torch.cuda.device_count()
    return info


@app.post("/warmup")
def warmup():
    try:
        load_pipeline()
    except Exception as exc:
        LOG.exception("warmup failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"status": "ready", "pipeline_class": _pipe_class_name}


@app.post("/edit_b64")
def edit_b64(req: EditRequest):
    try:
        img = _decode_b64_image(req.image_b64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad image_b64: {exc}") from exc

    try:
        out, meta = _run_edit(
            image=img,
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            num_inference_steps=req.num_inference_steps,
            true_cfg_scale=req.true_cfg_scale,
            seed=req.seed,
            width=req.width,
            height=req.height,
        )
    except torch.cuda.OutOfMemoryError as exc:
        torch.cuda.empty_cache()
        raise HTTPException(status_code=507, detail=f"OOM: {exc}") from exc
    except Exception as exc:
        LOG.exception("inference failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return JSONResponse({"image_b64": _encode_image_b64(out), **meta})


@app.post("/edit")
async def edit_multipart(
    image: UploadFile = File(...),
    payload: str = Form(default="{}"),
):
    try:
        params = json.loads(payload) if payload else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"bad payload JSON: {exc}") from exc

    try:
        img = Image.open(io.BytesIO(await image.read())).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad image upload: {exc}") from exc

    prompt = params.get("prompt") or ""
    if not prompt:
        raise HTTPException(status_code=400, detail="payload.prompt is required")

    try:
        out, meta = _run_edit(
            image=img,
            prompt=prompt,
            negative_prompt=params.get("negative_prompt", " "),
            num_inference_steps=int(params.get("num_inference_steps", 40)),
            true_cfg_scale=float(params.get("true_cfg_scale", 4.0)),
            seed=params.get("seed"),
            width=params.get("width"),
            height=params.get("height"),
        )
    except torch.cuda.OutOfMemoryError as exc:
        torch.cuda.empty_cache()
        raise HTTPException(status_code=507, detail=f"OOM: {exc}") from exc
    except Exception as exc:
        LOG.exception("inference failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    headers = {f"x-meta-{k}": str(v) for k, v in meta.items()}
    return Response(content=buf.getvalue(), media_type="image/png", headers=headers)


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("QWEN_EDIT_HOST", "127.0.0.1")
    port = int(os.environ.get("QWEN_EDIT_PORT", "8765"))
    uvicorn.run(app, host=host, port=port, log_level="info")
