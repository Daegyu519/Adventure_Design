"""CLI inference and synchronized batch=1 end-to-end latency benchmark."""
from __future__ import annotations

import argparse
import json
import math
import statistics
import time
from pathlib import Path

from .data import write_json
from .model import Predictor


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--relation")
    parser.add_argument("--last-them")
    parser.add_argument("--draft")
    parser.add_argument("--input-json", type=Path, help="object with relation/context/last_them/draft, no source text in process arguments")
    parser.add_argument("--context", type=Path, help='JSON array: [{"role":"them" or "me","text":"..."}]')
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cpu")
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.input_json:
        if any((args.relation, args.last_them, args.draft, args.context)):
            parser.error("input-json cannot be mixed with explicit message fields")
        message = json.loads(args.input_json.read_text(encoding="utf-8-sig"))
        if not isinstance(message, dict) or not all(k in message for k in ("last_them", "draft")):
            parser.error("input-json requires last_them/draft fields")
        message.setdefault("relation", "")
        args.relation, args.last_them, args.draft = (message[k] for k in ("relation", "last_them", "draft"))
        context = message.get("context", [])
    else:
        context = json.loads(args.context.read_text(encoding="utf-8-sig")) if args.context else []
    if args.runs < 1 or args.warmup < 0:
        parser.error("runs >= 1, warmup >= 0 required")
    if not isinstance(context, list) or any(not isinstance(t, dict) or t.get("role") not in {"me", "them"} or not isinstance(t.get("text"), str) for t in context):
        parser.error("invalid context")
    if not all(isinstance(s, str) and s.strip() for s in (args.last_them, args.draft)):
        parser.error("empty input")
    args.relation = args.relation or ""
    start = time.perf_counter()
    predictor = Predictor(args.checkpoint, args.device)
    load_ms = (time.perf_counter() - start) * 1000
    row = {"relation": args.relation, "last_them": args.last_them, "draft": args.draft,
           "context": context[-predictor.metadata["context_turns"]:]}
    probability, cold_ms = predictor.predict(row)
    for _ in range(args.warmup):
        predictor.predict(row)
    latency = sorted(predictor.predict(row)[1] for _ in range(args.runs))
    result = {"label": int(probability >= predictor.metadata["threshold"]), "cold_score": probability,
              "label_mode": predictor.metadata.get("label_mode", "reviewed"),
              "threshold": predictor.metadata["threshold"], "device": args.device, "batch_size": 1,
              "latency_ms": {"model_load": load_ms, "first_inference": cold_ms, "p50": statistics.median(latency),
                             "p95": latency[math.ceil(len(latency) * .95) - 1], "runs": args.runs, "warmup": args.warmup},
              "measurement": "tokenization + transfer + forward + softmax; synchronized CUDA; load excluded from p50/p95",
              "interpretation": "차갑게 읽힐 가능성 점수(미보정); 기술 검증용이며 일반화 성능은 미확인"}
    if predictor.metadata.get("label_mode") == "weak-demo":
        result["human_approved"] = False
        result["interpretation"] = "미검수 약한 레이블의 주제 불일치 대리 과제 점수; 실제 사람의 말투 판단 정확도가 아님"
    elif predictor.metadata.get("label_mode") == "cold-weak":
        result["human_approved"] = False
        result["interpretation"] = "맥락·단답 추출 규칙의 약지도 점수(미보정); 실제 인간 판단 성능은 미검증"
    if args.output:
        write_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
