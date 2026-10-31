"""Shared input contract, inference and binary metrics."""
from __future__ import annotations

import math
import time
from pathlib import Path

from .data import write_json


def encode(tokenizer, row: dict, max_length: int, *, allow_empty: bool = False, input_format: str = "legacy-v1") -> dict:
    """Keep reply AND recent context. Emotion/ratings/situation are not features."""
    if max_length < 32:
        raise ValueError("max_length must be >= 32")
    row = normalize_input(row, allow_empty=allow_empty)
    if input_format == "context-pair-v2":
        return encode_pair_v2(tokenizer, row, max_length)
    if input_format not in {"legacy-v1", "relation+recent_history+last_them / draft; v1"}:
        raise ValueError("unknown input format")
    relation = tokenizer.encode("관계: " + row["relation"], add_special_tokens=False)[:24]
    context = "\n".join(f"{t['role']}: {t['text']}" for t in row["context"])
    context += "\n상대 최근 발화: " + row["last_them"]
    history = tokenizer.encode(context, add_special_tokens=False)
    reply = tokenizer.encode("내 답장: " + row["draft"], add_special_tokens=False)
    available = max_length - tokenizer.num_special_tokens_to_add(pair=True)
    # Reserve half for reply, preserve its prefix and the latest history tail.
    reply = reply[:available // 2]
    relation = relation[:min(24, available // 4)]
    history = history[-(available - len(reply) - len(relation)):]
    return tokenizer.prepare_for_model(relation + history, pair_ids=reply, truncation=False,
                                       return_attention_mask=True)


def encode_pair_v2(tokenizer, row: dict, max_length: int) -> dict:
    """Explicit CLS/SEP for generic Fast tokenizers; opt-in for NEW training only.

    Existing checkpoints must keep legacy-v1. Their learned position-0 semantics
    cannot be changed safely just by changing the inference tokenizer.
    """
    cls, sep = tokenizer.cls_token_id, tokenizer.sep_token_id
    if cls is None or sep is None:
        raise ValueError("context-pair-v2 requires CLS and SEP token IDs")
    available = max_length - 3
    relation = tokenizer.encode("관계: " + row["relation"], add_special_tokens=False)[:min(24, available//4)]
    reply = tokenizer.encode("내 답장: " + row["draft"], add_special_tokens=False)[:available//2]
    # Keep the legacy content/truncation policy to isolate special-token repair.
    # Duplicate latest history is measured separately, not changed in this v2.
    history = row["context"]
    content = "\n".join(f"{t['role']}: {t['text']}" for t in history)
    content += "\n상대 최근 발화: " + row["last_them"]
    history_ids = tokenizer.encode(content, add_special_tokens=False)
    budget = available-len(relation)-len(reply)
    first = relation+history_ids[-budget:]
    ids = [cls]+first+[sep]+reply+[sep]
    return {"input_ids":ids,"attention_mask":[1]*len(ids),
            "token_type_ids":[0]*(len(first)+2)+[1]*(len(reply)+1)}


def normalize_input(row: dict, *, allow_empty: bool = False) -> dict:
    if not isinstance(row, dict):
        raise ValueError("input must be an object")
    if not all(isinstance(row.get(k), str) and (allow_empty or row[k].strip()) for k in ("last_them", "draft")):
        raise ValueError("nonempty last_them and draft required")
    relation = row.get("relation", "")
    context = row.get("context", [])
    if not isinstance(relation, str) or not isinstance(context, list):
        raise ValueError("invalid relation/context")
    if any(not isinstance(t, dict) or t.get("role") not in {"me", "them"}
           or not isinstance(t.get("text"), str) for t in context):
        raise ValueError("invalid context turn")
    return {**row, "relation": relation, "context": context[-8:]}


def metrics(labels: list[int], probabilities: list[float], threshold: float = 0.5) -> dict:
    if not labels or len(labels) != len(probabilities) or not 0 < threshold < 1:
        raise ValueError("invalid metrics input")
    matrix = [[0, 0], [0, 0]]
    for label, probability in zip(labels, probabilities):
        if label not in (0, 1) or not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError("invalid label/probability")
        matrix[label][int(probability >= threshold)] += 1
    tn, fp = matrix[0]
    fn, tp = matrix[1]
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {"n": len(labels), "threshold": threshold, "precision": precision, "recall": recall,
            "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
            "accuracy": (tp + tn) / len(labels), "confusion_matrix": matrix,
            "predicted_labels": {"0": tn + fn, "1": fp + tp},
            "matrix_axes": "rows=true [0,1], columns=predicted [0,1]", "positive_class": 1}


def device_for(name: str):
    import os
    import torch
    if name == "cuda":
        if not os.environ.get("CUDA_VISIBLE_DEVICES", "").strip():
            raise ValueError("set CUDA_VISIBLE_DEVICES to an explicitly allowed GPU")
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable")
    return torch.device(name)


class Predictor:
    def __init__(self, checkpoint: Path, device: str = "cpu"):
        import json
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        self.device = device_for(device)
        self.metadata = json.loads((checkpoint / "pipeline.json").read_text(encoding="utf-8"))
        self.tokenizer = AutoTokenizer.from_pretrained(checkpoint, local_files_only=True)
        self.model = AutoModelForSequenceClassification.from_pretrained(checkpoint, local_files_only=True).to(self.device).eval()

    def predict_batch(self, rows: list[dict]) -> list[float]:
        import torch
        if not rows:
            return []
        inputs = self.tokenizer.pad([encode(self.tokenizer, row, self.metadata["max_length"], input_format=self.metadata.get("input_format","legacy-v1")) for row in rows],
                                    return_tensors="pt").to(self.device)
        with torch.inference_mode():
            scores = self.model(**inputs).logits.softmax(-1)[:, 1].cpu().tolist()
        if not all(math.isfinite(p) and 0 <= p <= 1 for p in scores):
            raise RuntimeError("invalid model scores")
        return scores

    def predict(self, row: dict, *, allow_empty: bool = False) -> tuple[float, float]:
        import torch
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        start = time.perf_counter()
        inputs = self.tokenizer.pad([encode(self.tokenizer, row, self.metadata["max_length"], allow_empty=allow_empty,
                                           input_format=self.metadata.get("input_format","legacy-v1"))], return_tensors="pt").to(self.device)
        with torch.inference_mode():
            probability = self.model(**inputs).logits.softmax(-1)[0, 1].item()
        if not math.isfinite(probability):
            raise RuntimeError("non-finite model score")
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        return probability, (time.perf_counter() - start) * 1000


def evaluate(predictor: Predictor, rows: list[dict], output: Path, threshold: float = 0.5) -> dict:
    probabilities = [predictor.predict(row)[0] for row in rows]
    result = metrics([r["label"] for r in rows], probabilities, threshold)
    result["interpretation"] = "technical_validation_only; no established generalization performance"
    write_json(output, result)
    return result
