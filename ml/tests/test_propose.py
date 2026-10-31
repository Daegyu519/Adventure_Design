import csv
import json

import pytest

from ml.data import write_jsonl
from ml.propose import propose


def test_variant_import_removes_labels_and_requires_review(tmp_path):
    write_jsonl(tmp_path / "candidates.jsonl", [{"candidate_id": "one:1", "original_reply": "original"}])
    write_jsonl(tmp_path / "variants.jsonl", [{"candidate_id": "one:1", "draft": "variant", "generator": "rule:test-v1", "label": 1}])
    assert propose(tmp_path / "candidates.jsonl", tmp_path / "variants.jsonl", tmp_path / "review.csv") == 1
    with (tmp_path / "review.csv").open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    assert all(r["label"] == "" and r["status"] == "pending" for r in rows)
    with pytest.raises(FileExistsError):
        propose(tmp_path / "candidates.jsonl", tmp_path / "variants.jsonl", tmp_path / "review.csv")


def test_unknown_source_rejected(tmp_path):
    write_jsonl(tmp_path / "candidates.jsonl", [])
    write_jsonl(tmp_path / "variants.jsonl", [{"candidate_id": "bad", "draft": "variant", "generator": "human"}])
    with pytest.raises(ValueError):
        propose(tmp_path / "candidates.jsonl", tmp_path / "variants.jsonl", tmp_path / "out.csv")
