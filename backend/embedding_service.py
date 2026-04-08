"""
Local sentence embeddings via FastEmbed (ONNX, no GPU required).
Uses the smallest widely supported model in FastEmbed for speed.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np

# Official FastEmbed catalog: smallest common English model = fast CPU inference.
# https://qdrant.github.io/fastembed/examples/Supported_Models/
_FASTEMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

_model_lock = threading.Lock()
_text_model: Any = None
_loaded_model_id: str | None = None


def get_loaded_model_id() -> str:
    return _loaded_model_id or _FASTEMBED_MODEL


def _get_text_model():
    global _text_model, _loaded_model_id
    with _model_lock:
        if _text_model is None:
            from fastembed import TextEmbedding

            _text_model = TextEmbedding(model_name=_FASTEMBED_MODEL)
            _loaded_model_id = _FASTEMBED_MODEL
        return _text_model


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0.0 and nb == 0.0:
        return 1.0
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def compute_pair_cosine_similarities(pairs: list[list[str]]) -> list[float]:
    """
    For each [a, b], return cosine similarity of embeddings (L2-normalized space).
    Empty+empty -> 1.0; empty+nonempty -> 0.0 without calling the model.
    """
    if not pairs:
        return []

    model = _get_text_model()
    # Collect unique non-empty strings to embed once
    need_embed: list[str] = []
    index_of: dict[str, int] = {}
    for ab in pairs:
        for t in ab:
            s = t if isinstance(t, str) else ("" if t is None else str(t))
            if len(s.strip()) == 0:
                continue
            if s not in index_of:
                index_of[s] = len(need_embed)
                need_embed.append(s)

    vectors: dict[str, np.ndarray] = {}
    if need_embed:
        # fastembed.embed yields one vector per document (order preserved)
        for text, vec in zip(need_embed, model.embed(need_embed)):
            arr = np.asarray(vec, dtype=np.float64)
            vectors[text] = arr

    out: list[float] = []
    for ab in pairs:
        a = ab[0] if isinstance(ab[0], str) else ("" if ab[0] is None else str(ab[0]))
        b = ab[1] if isinstance(ab[1], str) else ("" if ab[1] is None else str(ab[1]))
        ea = len(a.strip()) == 0
        eb = len(b.strip()) == 0
        if ea and eb:
            out.append(1.0)
            continue
        if ea or eb:
            out.append(0.0)
            continue
        va = vectors.get(a)
        vb = vectors.get(b)
        if va is None or vb is None:
            out.append(0.0)
            continue
        out.append(_cosine(va, vb))
    return out
