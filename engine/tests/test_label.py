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
