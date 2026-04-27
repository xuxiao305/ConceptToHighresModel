"""FastAPI server exposing TRELLIS.2-4B image-to-3D over HTTP.

Designed for a single 24GB GPU (NVIDIA A30) on the DanLu instance.
The full TRELLIS.2 pipeline (sparse-structure flow + shape SLat flow +
texture SLat flow + O-Voxel post-process) fits in 24GB at 512^3 in bf16
when running with `expandable_segments`.

Endpoints
---------
GET  /health         -> {"status", "model_loaded", "device", ...}
POST /warmup         -> Force pipeline load (returns when ready)
POST /generate       -> multipart/form-data: `image` file + `payload` JSON,
                        returns model/gltf-binary (.glb)
POST /generate_b64   -> JSON: {image_b64, ...}, returns
                        {glb_b64, seed, elapsed_sec, ...}

Outputs
-------
A textured GLB (PBR) representing the generated 3D asset.
The decimation target / texture size / resolution are tunable per-request.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from typing import Any

# Must come BEFORE importing OpenCV / trellis2
os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# trellis2 is a sys.path package living inside the cloned repo
# (no setup.py / pyproject.toml). Make sure Python can find it.
_TRELLIS2_REPO = os.environ.get(
    "TRELLIS2_REPO_PATH", "/project/trellis2/TRELLIS.2"
)
if _TRELLIS2_REPO and _TRELLIS2_REPO not in sys.path:
    sys.path.insert(0, _TRELLIS2_REPO)

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image
from pydantic import BaseModel, Field

LOG = logging.getLogger("trellis2_server")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# ----------------------------------------------------------------------------
# Configuration (env-overridable)
# ----------------------------------------------------------------------------
MODEL_PATH = os.environ.get(
    "TRELLIS2_MODEL_PATH",
    "/project/trellis2/models/TRELLIS.2-4B",
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Lazy singletons
_pipe = None
_o_voxel_mod = None  # imported lazily so the FastAPI process can boot fast


def load_pipeline():
    """Load Trellis2ImageTo3DPipeline. Cached after first call."""
    global _pipe, _o_voxel_mod
    if _pipe is not None:
        return _pipe

    LOG.info("loading TRELLIS.2 pipeline from %s ...", MODEL_PATH)
    t0 = time.time()
    from trellis2.pipelines import Trellis2ImageTo3DPipeline  # type: ignore
    import o_voxel  # type: ignore  # noqa: F401

    _o_voxel_mod = o_voxel
    pipe = Trellis2ImageTo3DPipeline.from_pretrained(MODEL_PATH)
    pipe.cuda()
    _pipe = pipe
    LOG.info("pipeline ready in %.1fs", time.time() - t0)
    return _pipe


@asynccontextmanager
async def lifespan(app: FastAPI):
    LOG.info("server start; MODEL_PATH=%s DEVICE=%s", MODEL_PATH, DEVICE)
    if os.environ.get("TRELLIS2_EAGER_LOAD", "0") == "1":
        try:
            load_pipeline()
        except Exception as exc:
            LOG.error("eager load failed: %s", exc)
    yield


app = FastAPI(title="TRELLIS.2 Image-to-3D Server", lifespan=lifespan)


# ----------------------------------------------------------------------------
# Request schema
# ----------------------------------------------------------------------------
class GenerateRequest(BaseModel):
    image_b64: str = Field(..., description="Base64 PNG/JPEG of input image")
    seed: int | None = Field(default=None)
    # Pipeline knobs
    sparse_structure_steps: int = Field(default=12, ge=1, le=50)
    slat_steps: int = Field(default=12, ge=1, le=50)
    cfg_strength: float = Field(default=3.0, ge=0.0, le=20.0)
    # Post-process / GLB bake knobs
    decimation_target: int = Field(default=200_000, ge=1_000, le=10_000_000)
    texture_size: int = Field(default=2048, ge=512, le=4096)
    remesh: bool = Field(default=True)
    # nvdiffrast hard cap is 16M faces; keep mesh under it before simplify
    simplify_cap: int = Field(default=8_000_000, ge=100_000, le=16_777_216)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def _decode_b64_image(b64: str) -> Image.Image:
    if "," in b64 and b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGBA")


def _run_generate(image: Image.Image, req: GenerateRequest) -> tuple[bytes, dict[str, Any]]:
    pipe = load_pipeline()
    if req.seed is None:
        seed = int(torch.randint(0, 2**31 - 1, (1,)).item())
    else:
        seed = req.seed

    LOG.info("generate: seed=%d ss_steps=%d slat_steps=%d cfg=%.2f",
             seed, req.sparse_structure_steps, req.slat_steps, req.cfg_strength)

    t0 = time.time()
    # Pipeline.run accepts num_steps / cfg_strength keyword in TRELLIS.2 example.
    # We pass conservative kwargs that work across both default and CFG branches
    # of the public pipeline; unsupported kwargs are silently ignored by the
    # underlying call only if they're known — guard with try/except instead.
    run_kwargs: dict[str, Any] = dict(seed=seed)
    try:
        result = pipe.run(
            image,
            sparse_structure_sampler_params={
                "steps": req.sparse_structure_steps,
                "cfg_strength": req.cfg_strength,
            },
            slat_sampler_params={
                "steps": req.slat_steps,
                "cfg_strength": req.cfg_strength,
            },
            **run_kwargs,
        )
    except TypeError:
        # Older / simpler signature: pipeline.run(image)
        result = pipe.run(image, **run_kwargs)

    mesh = result[0] if isinstance(result, (list, tuple)) else result
    elapsed_gen = time.time() - t0

    # Simplify before GLB bake (nvdiffrast cap)
    try:
        mesh.simplify(req.simplify_cap)
    except Exception as exc:
        LOG.warning("simplify(%d) failed: %s", req.simplify_cap, exc)

    # Bake to GLB via o_voxel.postprocess
    t1 = time.time()
    glb = _o_voxel_mod.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=req.decimation_target,
        texture_size=req.texture_size,
        remesh=req.remesh,
        remesh_band=1,
        remesh_project=0,
        verbose=False,
    )
    elapsed_bake = time.time() - t1

    # Export to a temp file then read bytes (trimesh-style export needs a path)
    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as f:
        tmp_path = f.name
    try:
        glb.export(tmp_path, extension_webp=True)
        with open(tmp_path, "rb") as fh:
            data = fh.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    meta = {
        "seed": seed,
        "sparse_structure_steps": req.sparse_structure_steps,
        "slat_steps": req.slat_steps,
        "cfg_strength": req.cfg_strength,
        "decimation_target": req.decimation_target,
        "texture_size": req.texture_size,
        "elapsed_gen_sec": round(elapsed_gen, 2),
        "elapsed_bake_sec": round(elapsed_bake, 2),
        "elapsed_total_sec": round(elapsed_gen + elapsed_bake, 2),
        "glb_bytes": len(data),
    }
    return data, meta


# ----------------------------------------------------------------------------
# Endpoints
# ----------------------------------------------------------------------------
@app.get("/health")
def health():
    info = {
        "status": "ok",
        "model_loaded": _pipe is not None,
        "model_path": MODEL_PATH,
        "device": DEVICE,
    }
    if torch.cuda.is_available():
        info["gpu_name"] = torch.cuda.get_device_name(0)
        info["gpu_count"] = torch.cuda.device_count()
        try:
            free, total = torch.cuda.mem_get_info()
            info["gpu_mem_free_gb"] = round(free / 1e9, 2)
            info["gpu_mem_total_gb"] = round(total / 1e9, 2)
        except Exception:
            pass
    return info


@app.post("/warmup")
def warmup():
    try:
        load_pipeline()
    except Exception as exc:
        LOG.exception("warmup failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"status": "ready"}


@app.post("/generate_b64")
def generate_b64(req: GenerateRequest):
    try:
        img = _decode_b64_image(req.image_b64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad image_b64: {exc}") from exc

    try:
        glb_bytes, meta = _run_generate(img, req)
    except torch.cuda.OutOfMemoryError as exc:
        torch.cuda.empty_cache()
        raise HTTPException(status_code=507, detail=f"OOM: {exc}") from exc
    except Exception as exc:
        LOG.exception("inference failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return JSONResponse({
        "glb_b64": base64.b64encode(glb_bytes).decode("ascii"),
        **meta,
    })


@app.post("/generate")
async def generate_multipart(
    image: UploadFile = File(...),
    payload: str = Form(default="{}"),
):
    try:
        params = json.loads(payload) if payload else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"bad payload JSON: {exc}") from exc

    try:
        img = Image.open(io.BytesIO(await image.read())).convert("RGBA")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad image upload: {exc}") from exc

    try:
        # Inject the (already-decoded) image as a sentinel; the validator only
        # checks length so a single-char placeholder is fine.
        params.setdefault("image_b64", "x")
        req = GenerateRequest(**params)
        glb_bytes, meta = _run_generate(img, req)
    except torch.cuda.OutOfMemoryError as exc:
        torch.cuda.empty_cache()
        raise HTTPException(status_code=507, detail=f"OOM: {exc}") from exc
    except Exception as exc:
        LOG.exception("inference failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    headers = {f"x-meta-{k}": str(v) for k, v in meta.items()}
    return Response(
        content=glb_bytes,
        media_type="model/gltf-binary",
        headers=headers,
    )


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("TRELLIS2_HOST", "127.0.0.1")
    port = int(os.environ.get("TRELLIS2_PORT", "8766"))
    uvicorn.run(app, host=host, port=port, log_level="info")
