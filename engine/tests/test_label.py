import importlib.util
import json

from tests.test_eval import REPO, run

spec = importlib.util.spec_from_file_location("label", REPO / "eval/label/label.py")
label = importlib.util.module_from_spec(spec)
spec.loader.exec_module(label)
CANDS = REPO / "eval/label/candidates_t16.jsonl"


def test_candidates_shape():
    rows = label._read(CANDS)
    assert len(rows) == 60 and all("alert" not in r for r in rows)
    for p in range(1, 31):
        a, b = [r for r in rows if r["pair"] == p]
        assert (a["side"], b["side"]) == ("A", "B") and a["draft"] == b["draft"] and a["them"] != b["them"]


def test_export_blinded_and_not_adjacent(tmp_path):
    label.export(CANDS, tmp_path, seed=1)
    key = json.loads((tmp_path / "key.json").read_text(encoding="utf-8"))
    form = (tmp_path / "form.html").read_text(encoding="utf-8")
    assert len(key) == 60 and "pair" not in form and "side" not in form and '"B"' not in form
    pairs = [key[f"i{n:03d}"]["pair"] for n in range(1, 61)]
    assert all(a != b for a, b in zip(pairs, pairs[1:]))
    assert [key[f"i{n:03d}"]["side"] for n in range(1, 61)] != ["A", "B"] * 30


def test_kappa_known():
    assert round(label.kappa([True, True, False, False], [True, True, False, False]), 3) == 1.0
    assert round(label.kappa([True] * 4 + [False] * 6, [True] * 3 + [False] + [True] + [False] * 5), 3) == 0.583
    assert label.kappa([True, True], [True, True]) == 1.0   # pe=1


def test_merge_writes_contrast_schema_and_eval_set(tmp_path):
    label.export(CANDS, tmp_path, seed=2)
    key = json.loads((tmp_path / "key.json").read_text(encoding="utf-8"))
    mk = lambda who, flip: {"labeler": who, "labels": {
        i: {"cold": (k["side"] == "B") != (flip and i == "i001"), "memo": ""} for i, k in key.items()}}
    for n, d in (("a", False), ("b", True)):
        (tmp_path / f"{n}.json").write_text(json.dumps(mk(n, d)), encoding="utf-8")
    out = tmp_path / "set.jsonl"
    res = label.merge(tmp_path / "key.json", tmp_path / "a.json", tmp_path / "b.json", out)
    assert res["n"] == 60 and res["agree"] == 59 and res["disagreements"] == ["i001"]
    rows = label._read(out)
    assert len(rows) == 59
    assert all(set(r) == {"pair", "side", "relation", "them", "draft", "alert"} for r in rows)
    assert all(r["alert"] == (r["side"] == "B") for r in rows)
    p = run("--mock", "--json", "--set", str(out))
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout)["n"] == 59


def test_fleiss_kappa_known():
    assert label.fleiss_kappa([(3, 0), (0, 3)]) == 1.0
    assert round(label.fleiss_kappa([(2, 1), (1, 2)]), 3) == -0.333
    assert label.fleiss_kappa([(3, 0), (2, 0)]) is None   # 라벨러 수가 다름
    assert label.fleiss_kappa([]) is None


def test_merge_many_majority_weak_ties_and_eval(tmp_path):
    label.export(CANDS, tmp_path, seed=3)
    key = json.loads((tmp_path / "key.json").read_text(encoding="utf-8"))
    truth = {i: k["side"] == "B" for i, k in key.items()}
    # i001: 5명 중 c·d가 뒤집어 3:2(거의 갈림). i002: d·e가 빼먹어 3명 만장일치.
    # i003: e가 빼먹고 c·d가 뒤집어 4명 2:2(동표, 합의본에서 빠짐)
    def mk(who, flip=(), skip=()):
        return {"labeler": who, "labels": {i: {"cold": truth[i] != (i in flip), "memo": ""}
                                           for i in key if i not in skip}}
    people = [mk("a"), mk("b"), mk("c", flip={"i001", "i003"}), mk("d", flip={"i001", "i003"}, skip={"i002"}),
              mk("e", skip={"i002", "i003"})]
    files = []
    for p in people:
        f = tmp_path / f"{p['labeler']}.json"
        f.write_text(json.dumps(p), encoding="utf-8")
        files.append(f)
    out = tmp_path / "set.jsonl"
    res = label.merge_many(tmp_path / "key.json", files, out)
    assert res["labelers"] == 5 and res["n"] == 60 and res["consensus"] == 59
    assert res["weak"] == ["i001"] and res["ties"] == ["i003"]
    rows = label._read(out)
    assert all(set(r) == {"pair", "side", "relation", "them", "draft", "alert"} for r in rows)
    assert all(r["alert"] == (r["side"] == "B") for r in rows)
    assert res["per_labeler"]["c"]["agree_with_majority"] < 1.0 and res["per_labeler"]["a"]["agree_with_majority"] == 1.0
    assert 0 < res["fleiss_kappa"] < 1
    rep = json.loads(out.with_suffix(".report.json").read_text(encoding="utf-8"))
    assert len(rep["weak_items"]) == 1 and "labeler" not in json.dumps(rep["weak_items"])
    p = run("--mock", "--json", "--set", str(out))
    assert p.returncode == 0, p.stderr


def test_merge_many_rejects_duplicate_names(tmp_path):
    label.export(CANDS, tmp_path, seed=4)
    f = tmp_path / "x.json"
    f.write_text(json.dumps({"labeler": "same", "labels": {}}), encoding="utf-8")
    import pytest
    with pytest.raises(SystemExit):
        label.merge_many(tmp_path / "key.json", [f, f, f], tmp_path / "o.jsonl")
