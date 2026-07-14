# ANPR + embedding-sidecar med GPU. DINOv3 ViT-L kör på Nvidia-GPU (CUDAExecutionProvider) -
# ~50-100x snabbare bild-embedding än CPU. Övriga modeller (e5-text, fast-alpr, rapidocr,
# DINOv2) stannar på CPU → GPU:n gör tunga bild-embeddingen, CPU:n är fri för sök. Kräver
# nvidia-container-toolkit + GPU-reservation i compose. FALLER TYST TILLBAKA TILL CPU om CUDA
# inte laddar (providers-lista med CPU-fallback + ORT_USE_GPU=0 stänger av helt).
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# fast-alpr[onnx]/rapidocr drar CPU-onnxruntime. VIKTIGT: installera INTE onnxruntime-gpu än -
# modell-prefetchen nedan instansierar ONNX-sessioner, och onnxruntime-gpu SEGFAULTAR (exit 139)
# när den försöker init:a CUDA utan GPU (GPU saknas i bygg-steget). Vi kör prefetchen på
# CPU-onnxruntime och BYTER till onnxruntime-gpu allra sist.
RUN pip3 install --no-cache-dir \
    "fast-alpr[onnx]" \
    rapidocr-onnxruntime \
    huggingface_hub \
    tokenizers \
    fastapi \
    "uvicorn[standard]" \
    opencv-python-headless \
    numpy

WORKDIR /app

# För-hämta ALPR-, RapidOCR-, DINOv3- OCH e5-modellerna (annars stallar första requesten på en
# nedladdning). Körs på CPU-onnxruntime (inget CUDA-init → ingen segfault i bygget). Ligger FÖRE
# COPY server.py så en server.py-ändring inte tvingar om-nedladdning (cache-vänligt).
RUN python3 -c "from fast_alpr import ALPR; ALPR(detector_model='yolo-v9-t-384-license-plate-end2end', ocr_model='cct-xs-v2-global-model')" \
    && python3 -c "from rapidocr_onnxruntime import RapidOCR; RapidOCR()" \
    && python3 -c "from huggingface_hub import hf_hub_download as d; r='onnx-community/dinov3-vitl16-pretrain-lvd1689m-ONNX'; d(r,'onnx/model.onnx',local_dir='/models/dl'); d(r,'onnx/model.onnx_data',local_dir='/models/dl')" \
    && mkdir -p /models/dinov3-large \
    && cp /models/dl/onnx/model.onnx /models/dinov3-large/model.onnx \
    && cp /models/dl/onnx/model.onnx_data /models/dinov3-large/model.onnx_data \
    && rm -rf /models/dl \
    && python3 -c "from huggingface_hub import hf_hub_download as d; d('Xenova/multilingual-e5-base','onnx/model.onnx',local_dir='/models/e5dl'); d('Xenova/multilingual-e5-base','tokenizer.json',local_dir='/models/e5dl')" \
    && mkdir -p /models/e5-base \
    && cp /models/e5dl/onnx/model.onnx /models/e5-base/model.onnx \
    && cp /models/e5dl/tokenizer.json /models/e5-base/tokenizer.json \
    && rm -rf /models/e5dl

# SIST: byt CPU-onnxruntime → onnxruntime-gpu (samma import, GPU-superset). Vid körning finns
# GPU:n → ViT-L kör på CUDA; CPU-EP kvar för sessioner som inte begär CUDA. 1.20.x = CUDA 12 + cuDNN 9.
RUN pip3 uninstall -y onnxruntime \
    && pip3 install --no-cache-dir onnxruntime-gpu==1.20.1

# SIST (cache-vänligt): server-koden. Ändras oftast → hålls efter de tunga stegen.
COPY server.py /app/server.py

EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
