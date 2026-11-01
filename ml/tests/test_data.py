"""Fabricated structural fixtures only; never exported as a training corpus."""
import csv
import json
from collections import Counter
from zipfile import ZipFile

import pytest

from ml.data import REVIEW_FIELDS, audit, candidates, documents, finalize, prepare, read_jsonl


def conversation(cid="one"):
    return {"info": {"id": cid, "relation": "friend", "speaker_emotion": "unknown"},
            "utterances": [{"role": "speaker", "text": "context-A", "extra": 1},
                           {"role": "listener", "text": "reply", "listener_empathy": 5, "avg_rating": 5},
                           {"role": "speaker", "text": "context-B"},
                           {"role": "listener", "text": "reply"}]}


def source_zip(root, split, cid, name="nested/arbitrary.ZIP"):
    path = root / split / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, "w") as zipped:
        zipped.writestr("deep/sample.JSON", json.dumps(conversation(cid)))
        zipped.writestr("ignore.txt", "ignored")


def reviewed(root):
    source_zip(root / "raw", "train", "one")
    source_zip(root / "raw", "validation", "two")
    prepare(root / "raw", root / "reviews")
    for split in ("train", "validation"):
        path = root / "reviews" / f"{split}.review.csv"
        with path.open(encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.DictReader(stream))
        # Different contexts across splits, identical reply within each split.
        for label, row in enumerate(rows):
            row.update(label=str(label), status="approved", reviewer="test-reviewer", rationale="test fixture")
        with path.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=REVIEW_FIELDS)
            writer.writeheader()
            writer.writerows(rows)
    # Avoid identical full input across splits; preserve original split identity.
    path = root / "reviews/validation.candidates.jsonl"
    rows = read_jsonl(path)
    for row in rows:
        row["relation"] = "colleague"
    path.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    return root / "reviews"


def test_recursive_zip_and_metadata(tmp_path):
    source_zip(tmp_path, "train", "one")
    stats = Counter()
    obj, source = next(documents(tmp_path / "train", stats))
    rows = list(candidates(obj, source, "train", 2))
    assert stats == {"zip_files": 1, "conversations": 1}
    assert len(rows) == 2 and all(r["label"] is None for r in rows)
    assert rows[1]["context"] == [{"role": "me", "text": "reply"}, {"role": "them", "text": "context-B"}]
    assert rows[0]["last_them"] == "context-A"
    assert rows[0]["source"]["member"] == "deep/sample.JSON"
    assert len(rows[0]["source"]["json_sha256"]) == 64


def test_split_leak_even_outside_export_limit(tmp_path):
    source_zip(tmp_path, "train", "one")
    source_zip(tmp_path, "validation", "two")
    source_zip(tmp_path, "validation", "one", "z.zip")
    with pytest.raises(ValueError, match="duplicate conversation"):
        prepare(tmp_path, tmp_path / "out", limit=1)


def test_corrupt_and_missing_data_fail(tmp_path):
    with pytest.raises(ValueError, match="no ZIP"):
        list(documents(tmp_path, Counter()))
    path = tmp_path / "bad.zip"
    with ZipFile(path, "w") as zipped:
        zipped.writestr("bad.json", "{}")
    with pytest.raises(ValueError, match="invalid source"):
        list(documents(tmp_path, Counter()))


def test_finalize_and_pair_audit(tmp_path):
    reviews = reviewed(tmp_path)
    report = finalize(reviews, tmp_path / "labeled")
    assert report["train"]["labels"] == {0: 1, 1: 1}
    assert report["validation"]["same_reply_opposite_labels"] == 1
    rows = read_jsonl(tmp_path / "labeled/train.jsonl")
    assert all(r["source"]["dataset"] == "AI-Hub-046" for r in rows)


def test_pending_is_never_training_data(tmp_path):
    source_zip(tmp_path, "train", "one")
    source_zip(tmp_path, "validation", "two")
    prepare(tmp_path, tmp_path / "reviews")
    with pytest.raises(ValueError, match="empty labeled"):
        finalize(tmp_path / "reviews", tmp_path / "labeled")


def test_labels_require_human_evidence_and_no_leak(tmp_path):
    finalize(reviewed(tmp_path), tmp_path / "labeled")
    train = read_jsonl(tmp_path / "labeled/train.jsonl")
    validation = read_jsonl(tmp_path / "labeled/validation.jsonl")
    validation[0]["conversation_id"] = "one"
    with pytest.raises(ValueError, match="conversation leakage"):
        audit(train, validation)
    train[0]["reviewer"] = ""
    with pytest.raises(ValueError, match="human review"):
        audit(train, validation)


def test_full_input_leak_is_rejected(tmp_path):
    finalize(reviewed(tmp_path), tmp_path / "labeled")
    train = read_jsonl(tmp_path / "labeled/train.jsonl")
    validation = read_jsonl(tmp_path / "labeled/validation.jsonl")
    for row in validation:
        row["relation"] = "friend"
    with pytest.raises(ValueError, match="identical input"):
        audit(train, validation)


def test_review_overwrite_is_rejected(tmp_path):
    reviews = reviewed(tmp_path)
    before = (reviews / "train.review.csv").read_bytes()
    with pytest.raises(ValueError, match="protected"):
        prepare(tmp_path / "raw", reviews)
    assert (reviews / "train.review.csv").read_bytes() == before


def test_conflicting_identical_context_is_rejected(tmp_path):
    finalize(reviewed(tmp_path), tmp_path / "labeled")
    train = read_jsonl(tmp_path / "labeled/train.jsonl")
    validation = read_jsonl(tmp_path / "labeled/validation.jsonl")
    for field in ("context", "last_them"):
        train[1][field] = train[0][field]
    with pytest.raises(ValueError, match="conflicting labels"):
        audit(train, validation)
