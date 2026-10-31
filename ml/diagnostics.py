"""Shortcut checks on WEAK labels, never a human tone accuracy estimate."""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from pathlib import Path

from .data import write_json
from .model import Predictor, metrics


def shortcut_baselines(train: list[dict], validation: list[dict]) -> dict:
    labels = [r["label"] for r in validation]
    # Fit a decision stump using ONLY training reply character lengths.
    thresholds = sorted({len(r["draft"]) for r in train})
    best = (-1, 0, 1)
    for threshold in thresholds:
        for polarity in (0, 1):
            correct = sum(int(len(r["draft"]) > threshold) ^ polarity == r["label"] for r in train)
            if correct > best[0]:
                best = (correct, threshold, polarity)
    probabilities = [float(int(len(r["draft"]) > best[1]) ^ best[2]) for r in validation]
    length = metrics(labels, probabilities)
    length["fit_threshold_chars"], length["fit_polarity"] = best[1:]
    # Bag-of-token multinomial NB. Laplace smoothing, trained without validation.
    counts = [Counter(), Counter()]
    class_counts = Counter(r["label"] for r in train)
    for row in train:
        counts[row["label"]].update(re.findall(r"\w+", row["draft"].lower()))
    vocab = set(counts[0]) | set(counts[1])
    totals = [sum(c.values()) + max(1, len(vocab)) for c in counts]
    nb = []
    for row in validation:
        words = re.findall(r"\w+", row["draft"].lower())
        scores = [math.log(class_counts[k] / len(train)) + sum(math.log((counts[k][w] + 1) / totals[k])
                   for w in words if w in vocab) for k in (0, 1)]
        nb.append(1 / (1 + math.exp(max(-700, min(700, scores[0] - scores[1])))))
    return {"length_only": length, "reply_tokens_only": metrics(labels, nb),
            "fit_on": "train only", "interpretation": "0.5 accuracy expected under exact paired marginal balance"}


def diagnostics(train: list[dict], validation: list[dict], predictor: Predictor, output: Path) -> dict:
    labels = [r["label"] for r in validation]
    scores = [predictor.predict(row)[0] for row in validation]
    reply_only = [predictor.predict({**r, "relation": "", "context": [], "last_them": ""}, allow_empty=True)[0] for r in validation]
    context_only = [predictor.predict({**r, "draft": ""}, allow_empty=True)[0] for r in validation]
    by_reply = defaultdict(lambda: defaultdict(list))
    for row, score in zip(validation, scores):
        by_reply[row["draft"]][row["label"]].append(score)
    complete = [p for p in by_reply.values() if 0 in p and 1 in p]
    result = {"claim": "weak proxy diagnostics ONLY; NOT human tone judgment accuracy",
              "baselines": shortcut_baselines(train, validation), "full_input": metrics(labels, scores),
              "reply_only_ablation": metrics(labels, reply_only), "context_only_ablation": metrics(labels, context_only),
              "same_reply_groups": len(complete),
              "all_contexts_correct_fraction": sum(all(s < .5 for s in p[0]) and all(s >= .5 for s in p[1]) for p in complete) / len(complete),
              "mean_counterfactual_score_gap": sum(sum(p[1]) / len(p[1]) - sum(p[0]) / len(p[0]) for p in complete) / len(complete)}
    write_json(output, result)
    return result
