import diffusers, transformers, torch
print('torch', torch.__version__, 'cuda_avail=', torch.cuda.is_available(), 'cuda_ver=', torch.version.cuda)
print('diffusers', diffusers.__version__)
print('transformers', transformers.__version__)
print('QwenImageEditPlusPipeline:', hasattr(diffusers, 'QwenImageEditPlusPipeline'))
print('QwenImageEditPipeline:', hasattr(diffusers, 'QwenImageEditPipeline'))
# Try to actually import the pipeline class — earlier it errored at attr access
try:
    cls = getattr(diffusers, 'QwenImageEditPlusPipeline')
    print('QwenImageEditPlusPipeline cls:', cls)
except Exception as e:
    print('IMPORT_ERROR QwenImageEditPlusPipeline:', type(e).__name__, str(e)[:200])
