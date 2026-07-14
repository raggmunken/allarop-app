"""
ANPR-sidecar: dedikerad plåtläsning via fast-alpr (YOLOv9-detektering + CCT-OCR, ONNX,
CPU). Ersätter den generella vision-LLM:en för fordonsskyltar - tränad specifikt på
skyltar → läser även skeva/små/delvis skymda skyltar som LLM:en missar, lokalt och
gratis utan rate-limits. Node POSTar rå bild-bytes → {plate, confidence}.

Bara en läsare; ALL validering (svenskt format, korsvalidering mot märket) sker i Node.
"""
import asyncio
import base64
import os

import cv2
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Request
from fast_alpr import ALPR
from rapidocr_onnxruntime import RapidOCR
from tokenizers import Tokenizer

DETECTOR = os.environ.get("ALPR_DETECTOR", "yolo-v9-t-384-license-plate-end2end")
OCR = os.environ.get("ALPR_OCR", "cct-xs-v2-global-model")
# DINOv3 ViT-L/16 (1024-dim) - Metas nyaste (2025), skarpast objektseparation av de
# CPU-körbara modellerna. ~3x långsammare än DINOv2-base men bakgrundspasset tål det, och
# steady-state (nya objekt) är låg volym. CLS-token (index 0) = bild-embedding.
EMBED_MODEL_PATH = os.environ.get("EMBED_MODEL_PATH", "/models/dinov3-large/model.onnx")
# TEXT-embedding: multilingual-e5-base (768-dim, XLM-RoBERTa, 100+ språk inkl. svenska).
# Vald efter kalibrering: -small över-viktade delade tokens i sammansättningar ("minne" i
# minnestallrik ~ "ram minne") → för dålig separation på svenska; -base skiljer mening klart
# bättre. Mean-pooling över tokens + L2-norm; e5 kräver prefix "query: "/"passage: ". ONNX/CPU.
TEXT_MODEL_PATH = os.environ.get("TEXT_MODEL_PATH", "/models/e5-base/model.onnx")
TEXT_TOKENIZER_PATH = os.environ.get("TEXT_TOKENIZER_PATH", "/models/e5-base/tokenizer.json")
TEXT_MAX_TOKENS = int(os.environ.get("TEXT_MAX_TOKENS", "256"))

alpr = ALPR(detector_model=DETECTOR, ocr_model=OCR)
# Generell text-OCR (PP-OCR-modeller på ONNX) för modellkoder/skyltar på verktyg m.m.
ocr_engine = RapidOCR()

# DINOv3 ViT-L (1024-dim) - visuell jämförbarhetsgate + retention. TUNG → kör på GPU
# (CUDAExecutionProvider) när ORT_USE_GPU=1 (default), annars CPU. CPU-EP alltid sist som
# fallback så en GPU som ej laddar (drivrutin/VRAM/version) faller tyst tillbaka till CPU.
_USE_GPU = os.environ.get("ORT_USE_GPU", "1") == "1"
_EMBED_PROVIDERS = (["CUDAExecutionProvider", "CPUExecutionProvider"] if _USE_GPU else ["CPUExecutionProvider"])
_embed_sess = ort.InferenceSession(EMBED_MODEL_PATH, providers=_EMBED_PROVIDERS)
print(f"[embed] DINOv3 ViT-L providers: {_embed_sess.get_providers()}", flush=True)
_embed_input = _embed_sess.get_inputs()[0].name
_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# TEXT-embedding: e5-base ONNX + snabb tokenizer. Padding/trunkering av tokenizern → hel batch
# i ett ONNX-anrop. OCKSÅ på GPU (samma ORT_USE_GPU) → query-embeddingen (sök) konkurrerar INTE
# med bild-avkodningen på sidecar-CPU:n i max-speed-läge → söket förblir snabbt.
_text_sess = ort.InferenceSession(TEXT_MODEL_PATH, providers=_EMBED_PROVIDERS)
print(f"[embed] e5-text providers: {_text_sess.get_providers()}", flush=True)
_text_input_names = {i.name for i in _text_sess.get_inputs()}
_text_tok = Tokenizer.from_file(TEXT_TOKENIZER_PATH)
_text_tok.enable_truncation(max_length=TEXT_MAX_TOKENS)
_text_tok.enable_padding()

app = FastAPI()


_EMBED_DIM = int(_embed_sess.get_outputs()[0].shape[-1]) if isinstance(_embed_sess.get_outputs()[0].shape[-1], int) else 768
_TEXT_DIM = int(_text_sess.get_outputs()[0].shape[-1]) if isinstance(_text_sess.get_outputs()[0].shape[-1], int) else 384


@app.get("/health")
def health():
    provs = _embed_sess.get_providers()
    return {"ok": True, "detector": DETECTOR, "ocr": OCR, "embed_dim": _EMBED_DIM, "text_dim": _TEXT_DIM,
            "embed_providers": provs, "gpu": "CUDAExecutionProvider" in provs}


def _preprocess_dinov2(img_bgr):
    """cv2 BGR → DINOv2-input: RGB, kortaste sidan 256 (bikubisk, behåll aspekt),
    centrumbeskär 224, /255, ImageNet-normalisera, HWC→CHW, batch, float32."""
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    scale = 256.0 / min(h, w)
    rgb = cv2.resize(rgb, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_CUBIC)
    h2, w2 = rgb.shape[:2]
    top, left = (h2 - 224) // 2, (w2 - 224) // 2
    crop = rgb[top:top + 224, left:left + 224]
    arr = crop.astype(np.float32) / 255.0
    arr = (arr - _IMAGENET_MEAN) / _IMAGENET_STD
    arr = np.transpose(arr, (2, 0, 1))[np.newaxis, :, :, :]
    return np.ascontiguousarray(arr, dtype=np.float32)


_embed_out_names = [o.name for o in _embed_sess.get_outputs()]


def _cls_batch(inp):
    """Preprocessad batch (N,3,224,224) → L2-normaliserade CLS-embeddings (N, dim)."""
    outputs = _embed_sess.run(None, {_embed_input: inp})
    # Välj last_hidden_state via NAMN (ALDRIG pooler_output - dess huvud är otränat i
    # HF DINOv2). Fallback: den 3D-utgången (batch, tokens, dim).
    hidden = None
    for i, n in enumerate(_embed_out_names):
        if n == "last_hidden_state":
            hidden = outputs[i]
            break
    if hidden is None:
        hidden = next((o for o in outputs if getattr(o, "ndim", 0) == 3), outputs[0])
    cls = np.asarray(hidden)[:, 0, :].astype(np.float32)  # CLS-token per bild
    norms = np.linalg.norm(cls, axis=1, keepdims=True)
    return cls / np.clip(norms, 1e-12, None)  # L2-norm → cosinus == prickprodukt i Node


def _embed_one(body):
    arr = np.frombuffer(body, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return {"dim": 0, "embedding": None}
    cls = _cls_batch(_preprocess_dinov2(img))[0]
    return {"dim": int(cls.shape[0]), "embedding": cls.tolist()}


@app.post("/embed")
async def embed(request: Request):
    """Rå bild-bytes → L2-normaliserad CLS-embedding (DINOv3 ViT-L). Node lagrar den
    (media.embedding) och gatar prisjämförelsen på cosinus-likhet. Avkodning + inferens körs i
    en TRÅD (asyncio.to_thread) så event-loopen är fri → samtidiga anrop överlappar och matar
    GPU:n (annars serialiseras allt av den blockerande ONNX-Run:en → GPU svälts)."""
    body = await request.body()
    if not body:
        return {"dim": 0, "embedding": None}
    return await asyncio.to_thread(_embed_one, body)


def _embed_batch_sync(imgs_b64):
    results = [None] * len(imgs_b64)
    tensors = []
    slots = []
    for i, b in enumerate(imgs_b64):
        try:
            raw = base64.b64decode(b)
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                continue
            tensors.append(_preprocess_dinov2(img)[0])
            slots.append(i)
        except Exception:
            continue
    if tensors:
        batch = np.ascontiguousarray(np.stack(tensors), dtype=np.float32)
        cls = _cls_batch(batch)  # EN GPU-Run för hela batchen → mångfaldigt snabbare/bild
        for k, slot in enumerate(slots):
            results[slot] = cls[k].tolist()
    return {"dim": _EMBED_DIM, "embeddings": results}


@app.post("/embed-batch")
async def embed_batch(request: Request):
    """JSON {images:[base64,...]} → {dim, embeddings:[[...]|null,...]}. BATCHAD ViT-L-Run över
    alla bilder i ETT anrop → EN GPU-forward-pass för hela batchen (dramatiskt snabbare/bild än
    en i taget). Körs i tråd (to_thread) så event-loopen är fri. Oavkodbar bild → null."""
    try:
        payload = await request.json()
    except Exception:
        return {"dim": _EMBED_DIM, "embeddings": []}
    imgs_b64 = payload.get("images") or []
    if not imgs_b64:
        return {"dim": _EMBED_DIM, "embeddings": []}
    return await asyncio.to_thread(_embed_batch_sync, imgs_b64)


def _embed_text_sync(texts, prefix):
    prepared = [prefix + (t if isinstance(t, str) else "").strip() for t in texts]
    encs = _text_tok.encode_batch(prepared)
    ids = np.array([e.ids for e in encs], dtype=np.int64)
    mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
    feed = {}
    if "input_ids" in _text_input_names:
        feed["input_ids"] = ids
    if "attention_mask" in _text_input_names:
        feed["attention_mask"] = mask
    if "token_type_ids" in _text_input_names:
        feed["token_type_ids"] = np.zeros_like(ids)
    hidden = _text_sess.run(None, feed)[0]  # (batch, tokens, dim) = last_hidden_state
    m = mask.astype(np.float32)[:, :, None]
    summed = (hidden * m).sum(axis=1)
    counts = np.clip(m.sum(axis=1), 1e-9, None)
    pooled = summed / counts
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    pooled = pooled / np.clip(norms, 1e-12, None)
    return {"dim": int(pooled.shape[1]), "embeddings": pooled.astype(np.float32).tolist()}


@app.post("/embed-text")
async def embed_text(request: Request):
    """JSON {texts:[...], prefix:"query"|"passage"} → {dim, embeddings:[[...]]}.
    e5: prefix, tokenisera, ONNX, MEAN-poola (masked), L2-normalisera → cosinus i Node. Tom
    text → nollvektor. Körs i tråd (to_thread) så söket inte köar bakom bild-embeddingen."""
    try:
        payload = await request.json()
    except Exception:
        return {"dim": _TEXT_DIM, "embeddings": []}
    texts = payload.get("texts") or []
    if isinstance(texts, str):
        texts = [texts]
    prefix = "query: " if payload.get("prefix") == "query" else "passage: "
    if not texts:
        return {"dim": _TEXT_DIM, "embeddings": []}
    return await asyncio.to_thread(_embed_text_sync, texts, prefix)


def _ocr_of(result):
    """Plocka (text, confidence) ur ett ALPR-resultat oavsett attribut-/dict-form."""
    ocr = getattr(result, "ocr", None)
    if ocr is None and isinstance(result, dict):
        ocr = result.get("ocr")
    if ocr is None:
        return None, 0.0
    text = getattr(ocr, "text", None) if not isinstance(ocr, dict) else ocr.get("text")
    conf = getattr(ocr, "confidence", None) if not isinstance(ocr, dict) else ocr.get("confidence")
    # Confidence kan vara per-tecken (lista/array) → svagaste tecknet styr helheten.
    try:
        if hasattr(conf, "__len__") and not isinstance(conf, (str, bytes)):
            vals = [float(c) for c in conf]
            conf = min(vals) if vals else 0.0
        else:
            conf = float(conf)
    except (TypeError, ValueError):
        conf = 0.0
    return text, conf


@app.post("/read")
async def read(request: Request):
    body = await request.body()
    if not body:
        return {"plate": None, "confidence": 0.0}
    arr = np.frombuffer(body, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return {"plate": None, "confidence": 0.0}
    best_text, best_conf = None, 0.0
    for r in alpr.predict(img):
        text, conf = _ocr_of(r)
        if text and conf >= best_conf:
            best_text, best_conf = text, conf
    return {"plate": best_text, "confidence": best_conf}


# Lägsta text-confidence som tas med (svag OCR på slitna/skeva skyltar → brus).
OCR_MIN_CONF = float(os.environ.get("OCR_MIN_CONF", "0.5"))


@app.post("/ocr")
async def ocr(request: Request):
    """All läsbar text i en bild → rader (text + confidence) + sammanfogad sträng.
    Ingen validering här; Node äger nyttan (sökindex + modell-ledtråd, aldrig visad fakta)."""
    body = await request.body()
    if not body:
        return {"text": "", "lines": []}
    arr = np.frombuffer(body, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return {"text": "", "lines": []}
    result, _ = ocr_engine(img)
    lines = []
    for row in result or []:
        # RapidOCR-rad: [box, text, confidence].
        txt = str(row[1]).strip()
        try:
            conf = float(row[2])
        except (TypeError, ValueError, IndexError):
            conf = 0.0
        if txt and conf >= OCR_MIN_CONF:
            lines.append({"text": txt, "confidence": conf})
    return {"text": " ".join(l["text"] for l in lines), "lines": lines}
