"""Schema/rule fixtures only; these utterances are never production training data."""
import copy
import hashlib

import pytest

from ml.cold_data import audit, neutral
from ml.weak import signature


def group(split):
    ordinary = {"relation": "친구", "context": [], "last_them": "회의 시간 맞지?",
                "original_reply": "네, 확인했어.", "conversation_id": split + "-f"}
    emotional = {"relation": "친구", "context": [{"role": "them", "text": "시험 공부 때문에 너무 힘들어"}],
                 "last_them": "시험 공부 때문에 요즘 계속 힘들고 걱정돼서 마음이 복잡해",
                 "original_reply": "네, 시험 공부 때문에 많이 힘들겠네.", "conversation_id": split + "-e"}
    ordinary["last_them"] += split
    emotional["last_them"] += split
    rows = []
    for base, text, label, rule in [(ordinary, "네", 0, "factual-confirmation-ack"),
                                   (emotional, "네", 1, "distress-bare-ack"),
                                   (emotional, emotional["original_reply"], 0, "distress-support-topic")]:
        r = {**base, "draft": text, "label": label, "split": split, "source": {"dataset": "AI-Hub-046"},
             "source_conversation_id": base["conversation_id"],
             "source_conversation_ids": [split + "-e", split + "-f"], "contrast_group_id": split,
             "rule_version": "extractive-ack-context-v1", "review_status": "weak_unreviewed",
             "human_approved": False, "label_source": "heuristic", "labeling_rule": rule}
        r["sample_id"] = hashlib.sha256(signature(r).encode()).hexdigest()
        rows.append(r)
    return rows


def test_rule_audit_and_leakage():
    train, val = group("train"), group("validation")
    result = audit(train, val)
    assert result["train"]["n"] == 3
    assert result["validation"]["same_reply_opposite_labels"] == 1
    bad = copy.deepcopy(val)
    bad[0]["source_conversation_ids"] = train[0]["source_conversation_ids"]
    with pytest.raises(ValueError):
        audit(train, bad)
    bad = copy.deepcopy(val)
    bad[0]["label"] = 1
    with pytest.raises(ValueError, match="rule evidence"):
        audit(train, bad)


def test_confirmation_excludes_refusal_distress_and_high_stakes():
    assert neutral({"last_them": "회의 시간 맞지?"})
    assert not neutral({"last_them": "수술 시간 맞지?"})
    assert not neutral({"last_them": "걱정돼. 시간 맞지?"})
    assert not neutral({"last_them": "그랬구나."})
