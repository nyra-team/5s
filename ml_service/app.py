import os
import json
import hashlib
import logging
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import open_clip
from PIL import Image
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import pickle

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="5S ML Service")

MODELS_DIR = Path("ml_service/models")
MODELS_DIR.mkdir(parents=True, exist_ok=True)

DEVICE = "cpu"
MODEL_NAME = "ViT-B-32"
PRETRAINED = "laion2b_s34b_b79k"

model = None
preprocess = None
tokenizer = None


def get_model():
    global model, preprocess, tokenizer
    if model is None:
        logger.info(f"Loading CLIP model {MODEL_NAME}...")
        model, _, preprocess = open_clip.create_model_and_transforms(
            MODEL_NAME, pretrained=PRETRAINED, device=DEVICE
        )
        tokenizer = open_clip.get_tokenizer(MODEL_NAME)
        model.eval()
        logger.info("CLIP model loaded successfully")
    return model, preprocess, tokenizer


class EmbedRequest(BaseModel):
    image_path: str


class EmbedResponse(BaseModel):
    embedding: list[float]
    embedding_hash: str


class PredictRequest(BaseModel):
    area_id: int
    embedding: list[float]
    ideal_embeddings: list[list[float]]


class PredictResponse(BaseModel):
    similarity: float
    total_score: int
    pillars: dict[str, int]
    scoring_mode: str
    model_version: str


class TrainRequest(BaseModel):
    area_id: int
    embeddings: list[list[float]]
    labels: list[dict]


class TrainResponse(BaseModel):
    model_version: str
    samples_used: int
    mae: float


def compute_embedding_hash(embedding: list[float]) -> str:
    raw = json.dumps([round(x, 8) for x in embedding]).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a_norm = a / (np.linalg.norm(a) + 1e-10)
    b_norm = b / (np.linalg.norm(b) + 1e-10)
    return float(np.dot(a_norm, b_norm))


def similarity_to_score(similarity: float) -> int:
    SIM_LOW = 0.75
    SIM_HIGH = 0.98
    clamped = max(0.0, min(1.0, similarity))
    if clamped <= SIM_LOW:
        score = 0
    elif clamped >= SIM_HIGH:
        score = 25
    else:
        score = int(round((clamped - SIM_LOW) / (SIM_HIGH - SIM_LOW) * 25))
    return max(0, min(25, score))


def similarity_to_pillars(similarity: float, seed_val: int) -> dict[str, int]:
    total = similarity_to_score(similarity)
    rng = np.random.RandomState(seed_val)
    pillars_list = ["sort", "set", "shine", "standardize", "sustain"]
    base = total // 5
    remainder = total % 5
    scores = [base] * 5
    indices = rng.permutation(5)
    for i in range(remainder):
        scores[indices[i]] += 1
    scores = [max(0, min(5, s)) for s in scores]
    return {p: s for p, s in zip(pillars_list, scores)}


def get_model_path(area_id: int) -> Path:
    return MODELS_DIR / f"area_{area_id}_regressor.pkl"


def get_model_version(area_id: int) -> str:
    model_path = get_model_path(area_id)
    if model_path.exists():
        stat = model_path.stat()
        return f"v{int(stat.st_mtime)}"
    return "similarity_only"


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/embed", response_model=EmbedResponse)
def embed_image(req: EmbedRequest):
    image_path = req.image_path
    if not os.path.exists(image_path):
        raise HTTPException(status_code=404, detail=f"Image not found: {image_path}")

    clip_model, clip_preprocess, _ = get_model()

    try:
        image = Image.open(image_path).convert("RGB")
        image_tensor = clip_preprocess(image).unsqueeze(0).to(DEVICE)

        with torch.no_grad():
            features = clip_model.encode_image(image_tensor)
            features = features / features.norm(dim=-1, keepdim=True)
            embedding = features.squeeze().cpu().numpy().tolist()

        emb_hash = compute_embedding_hash(embedding)
        return EmbedResponse(embedding=embedding, embedding_hash=emb_hash)

    except Exception as e:
        logger.error(f"Embedding failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/predict", response_model=PredictResponse)
def predict_score(req: PredictRequest):
    submission_emb = np.array(req.embedding, dtype=np.float32)

    if not req.ideal_embeddings:
        pillars = {p: 0 for p in ["sort", "set", "shine", "standardize", "sustain"]}
        return PredictResponse(
            similarity=0.0,
            total_score=0,
            pillars=pillars,
            scoring_mode="FALLBACK",
            model_version="none",
        )

    ideal_embs = [np.array(e, dtype=np.float32) for e in req.ideal_embeddings]
    centroid = np.mean(ideal_embs, axis=0)
    similarity = cosine_similarity(submission_emb, centroid)

    model_path = get_model_path(req.area_id)
    if model_path.exists():
        try:
            with open(model_path, "rb") as f:
                regressor_data = pickle.load(f)

            regressors = regressor_data["regressors"]
            pillars_list = ["sort", "set", "shine", "standardize", "sustain"]
            pillars = {}
            for pillar in pillars_list:
                if pillar in regressors:
                    pred = regressors[pillar].predict(submission_emb.reshape(1, -1))[0]
                    pillars[pillar] = max(0, min(5, int(round(pred))))
                else:
                    pillars[pillar] = 3

            total = sum(pillars.values())
            return PredictResponse(
                similarity=round(similarity, 4),
                total_score=total,
                pillars=pillars,
                scoring_mode="CALIBRATED",
                model_version=get_model_version(req.area_id),
            )
        except Exception as e:
            logger.error(f"Calibrated prediction failed, falling back: {e}")

    seed_val = int(compute_embedding_hash(req.embedding)[:8], 16)
    pillars = similarity_to_pillars(similarity, seed_val)
    total = sum(pillars.values())

    return PredictResponse(
        similarity=round(similarity, 4),
        total_score=total,
        pillars=pillars,
        scoring_mode="SIMILARITY_ONLY",
        model_version=get_model_version(req.area_id),
    )


@app.post("/train", response_model=TrainResponse)
def train_model(req: TrainRequest):
    if len(req.embeddings) != len(req.labels):
        raise HTTPException(status_code=400, detail="Embeddings and labels must have same length")

    if len(req.embeddings) < 5:
        raise HTTPException(status_code=400, detail="Need at least 5 labeled samples to train")

    from sklearn.linear_model import Ridge

    X = np.array(req.embeddings, dtype=np.float32)
    pillars_list = ["sort", "set", "shine", "standardize", "sustain"]

    regressors = {}
    total_mae = 0.0
    count = 0

    for pillar in pillars_list:
        y = np.array([lb.get(pillar, 3) for lb in req.labels], dtype=np.float32)
        reg = Ridge(alpha=1.0, random_state=42)
        reg.fit(X, y)
        regressors[pillar] = reg

        preds = reg.predict(X)
        mae = float(np.mean(np.abs(preds - y)))
        total_mae += mae
        count += 1

    avg_mae = total_mae / max(count, 1)

    model_path = get_model_path(req.area_id)
    with open(model_path, "wb") as f:
        pickle.dump({"regressors": regressors, "area_id": req.area_id}, f)

    version = get_model_version(req.area_id)

    return TrainResponse(
        model_version=version,
        samples_used=len(req.embeddings),
        mae=round(avg_mae, 4),
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("ML_SERVICE_PORT", "8100"))
    uvicorn.run(app, host="0.0.0.0", port=port)
