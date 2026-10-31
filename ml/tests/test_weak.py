"""Artificial keyword/ID fixtures ONLY; not a corpus or tone examples."""
import copy
import json
from zipfile import ZipFile

import pytest

from ml.data import candidates, validate_rows
from ml.weak import build_pairs, eligible, prepare_weak, validate_weak, weak_audit
from ml.diagnostics import shortcut_baselines


def pool(split="train", n=4, sentences=False):
    result = []
    for index in range(n):
        domain = "시험" if index % 2 == 0 else "병원"
        cid = f"{split}-{index}"
        # Structural tokens; never used to train actual KcELECTRA.
        reply = f"{domain} 응원 {cid}."
        if sentences:
            reply += f" {cid}."
        obj = {"info": {"id": cid, "relation": "친구", "speaker_emotion": "fixture"},
               "utterances": [{"role": "speaker", "text": f"{domain} 걱정 {cid}"},
                              {"role": "listener", "text": reply}]}
        result.extend(candidates(obj, {"dataset": "AI-Hub-046", "zip": "fixture.zip", "member": cid,
                                       "json_sha256": "fixture-only"}, split))
    return result


def write_raw(root, split, n=8):
    path = root / split / "nested/arbitrary.zip"
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, "w") as zipped:
        for row in pool(split, n):
            obj = {"info": {"id": row["conversation_id"], "relation": row["relation"], "speaker_emotion": "fixture"},
                   "utterances": [{"role": "speaker", "text": row["last_them"]},
                                  {"role": "listener", "text": row["original_reply"]}]}
            zipped.writestr(f"nested/{row['conversation_id']}.json", json.dumps(obj))


def test_weak_pairs_are_balanced_extractive_and_unreviewed():
    rows = build_pairs(pool(n=8, sentences=True), 16)
    val = build_pairs(pool("validation", n=8, sentences=True), 16)
    report = weak_audit(rows, val)
    assert len(rows) == 16
    assert report["train"]["labels"] == {0: 8, 1: 8}
    assert report["train"]["draft_histograms_identical"]
    assert report["train"]["context_histograms_identical"]
    assert all(r["draft"] in r["reply_source"]["original_reply"] for r in rows)
    assert all(r["weak_label"] == r["label"] and r["human_approved"] is False for r in rows)
    assert any(r["transform"] == "sentence-extraction" for r in rows)
    assert rows == build_pairs(pool(n=8, sentences=True), 16)
    baselines = shortcut_baselines(rows, val)
    assert baselines["length_only"]["accuracy"] == .5
    assert baselines["reply_tokens_only"]["accuracy"] == .5


def test_no_blanket_original_zero_or_random_negative():
    rows = pool()
    rows[0]["original_reply"] = "fixture-no-support"
    assert not eligible(rows[0])
    assert all(r["candidate_id"] != rows[0]["candidate_id"] for r in build_pairs(rows, 16))
    assert build_pairs([r for r in pool() if "시험" in r["original_reply"]], 16) == []


def test_official_human_path_rejects_weak_even_with_forged_approval():
    rows = build_pairs(pool(), 8)
    rows[0].update(review_status="approved", reviewer="forged", rationale="forged")
    with pytest.raises(ValueError, match="not human-approved"):
        validate_rows(rows, "train")
    with pytest.raises(ValueError, match="impersonate"):
        validate_weak(rows, "train")


def test_donor_lineage_leak_and_unbalanced_pairs_rejected():
    train, val = build_pairs(pool(), 8), build_pairs(pool("validation"), 8)
    assert weak_audit(train, val)
    contaminated = copy.deepcopy(val)
    # Source split is validated for the reply donor as well as the context.
    contaminated[1]["reply_source"]["split"] = "train"
    with pytest.raises(ValueError, match="split/dataset"):
        weak_audit(train, contaminated)
    with pytest.raises(ValueError, match="balance"):
        weak_audit(train[:-1], val)


def test_full_scan_manifest_and_no_csv_required(tmp_path):
    write_raw(tmp_path / "raw", "train", 8)
    write_raw(tmp_path / "raw", "validation", 4)
    output = tmp_path / "weak"
    report = prepare_weak(tmp_path / "raw", output, 16, 8)
    assert report["train"]["n"] == 16
    assert not list(output.glob("*.csv"))
    manifest = json.loads((output / "source_manifest.json").read_text(encoding="utf-8"))
    assert manifest["splits"]["train"]["conversations"] == 8
    assert manifest["splits"]["validation"]["read_errors"] == 0
    with pytest.raises(ValueError, match="must be empty"):
        prepare_weak(tmp_path / "raw", output, 16, 8)


def test_insufficient_weak_sources_fail_without_fallback(tmp_path):
    write_raw(tmp_path / "raw", "train", 2)
    write_raw(tmp_path / "raw", "validation", 2)
    with pytest.raises(ValueError, match="too few eligible"):
        prepare_weak(tmp_path / "raw", tmp_path / "out", 16, 8)
    assert not (tmp_path / "out/train.jsonl").exists()


def test_same_relation_is_required_and_duplicate_source_ids_fail(tmp_path):
    rows = pool(n=2)
    rows[1]["relation"] = "other"
    assert build_pairs(rows, 8) == []
    write_raw(tmp_path / "raw", "train", 8)
    write_raw(tmp_path / "raw", "validation", 4)
    # Add the same source conversation to a differently named validation ZIP.
    source = tmp_path / "raw/train/nested/arbitrary.zip"
    target = tmp_path / "raw/validation/duplicate.zip"
    target.write_bytes(source.read_bytes())
    with pytest.raises(ValueError, match="duplicate conversation"):
        prepare_weak(tmp_path / "raw", tmp_path / "out", 16, 8)


def test_invalid_sizes_and_extractive_integrity():
    with pytest.raises(ValueError):
        build_pairs(pool(), 5)
    rows = build_pairs(pool(), 8)
    rows[0]["draft"] = "not-from-source"
    with pytest.raises(ValueError, match="extract"):
        validate_weak(rows, "train")
