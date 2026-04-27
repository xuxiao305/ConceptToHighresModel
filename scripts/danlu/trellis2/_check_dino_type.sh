/root/miniconda3/envs/trellis2/bin/python <<'PY'
from transformers import DINOv3ViTModel, DINOv3ViTConfig
print("DINOv3ViTConfig.model_type =", DINOv3ViTConfig.model_type)
import inspect
print("config file:", inspect.getfile(DINOv3ViTConfig))
PY
echo "===tail==="
tail -80 /project/trellis2/logs/server.out
