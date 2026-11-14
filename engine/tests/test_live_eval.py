import importlib.util
import json

import yaml

from tests.test_eval import REPO

spec = importlib.util.spec_from_file_location("live_eval", REPO / "eval/live_eval.py")
live_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live_eval)

GOLD = [
    {"pair": 1, "side": "A", "relation": "친구", "them": "a", "draft": "x", "alert": False, "votes": [0, 5]},
    {"pair": 1, "side": "B", "relation": "친구", "them": "b", "draft": "x", "alert": True, "votes": [5, 0]},
    {"pair": 2, "side": "A", "relation": "가족", "them": "c", "draft": "y", "alert": True, "votes": [4, 1]},
    {"pair": 2, "side": "B", "relation": "가족", "them": "d", "draft": "y", "alert": True, "votes": [3, 2]},
]


def row(run, pair, side, risk, conf=0.9, ms=500):
    return {"run": run, "pair": pair, "side": side, "risk": risk, "conf": conf, "neg": risk, "expert_ms": ms}


def test_summarize_precision_recall_by_agreement_strength():
    # 두 회차. 1A(괜찮음)는 한 번만 0.5, 1B·2A는 높음, 2B(갈림)는 낮음
    rows = [row(0, 1, "A", 0.5), row(1, 1, "A", 0.2), row(0, 1, "B", 0.8), row(1, 1, "B", 0.8),
            row(0, 2, "A", 0.7), row(1, 2, "A", 0.7), row(0, 2, "B", 0.1), row(1, 2, "B", 0.1)]
    s = live_eval.summarize(GOLD, rows, thresholds=(0.45, 0.6))
    sure = {r["threshold"]: r for r in s["by_subset"]["확실(80% 이상 동의)"]}
    assert sure[0.45]["n"] == 6 and sure[0.45]["fp"] == 1 and sure[0.45]["fn"] == 0
    assert sure[0.45]["precision"] == 0.8 and sure[0.45]["recall"] == 1.0 and sure[0.45]["false_alert_rate"] == 0.5
    assert sure[0.6]["precision"] == 1.0 and sure[0.6]["fp"] == 0
    assert s["by_subset"]["만장일치"][0]["n"] == 4 and s["by_subset"]["갈림"][0]["n"] == 2
    assert s["by_subset"]["갈림"][0]["fn"] == 2 and s["by_subset"]["전체"][0]["n"] == 8


def test_summarize_consistency_latency_and_failures():
    rows = [row(0, 1, "A", 0.5, ms=2000), row(1, 1, "A", 0.2), row(0, 1, "B", 0.8), row(1, 1, "B", 0.8),
            {"run": 0, "pair": 2, "side": "A", "failed": True}, row(1, 2, "A", 0.7)]
    s = live_eval.summarize(GOLD, rows, thresholds=(0.45,))
    c = s["consistency"][0]
    assert s["calls"] == 6 and s["ok"] == 5 and c["n"] == 2 and c["flipped"] == 1   # 2A는 한 회차가 실패라 빠진다
    assert s["latency_ms"]["over_deadline"] == 0.2 and s["latency_ms"]["max"] == 2000


def test_low_confidence_is_not_an_alert():
    rows = [row(0, 1, "B", 0.9, conf=0.3)]
    assert live_eval.summarize(GOLD, rows, thresholds=(0.45,))["by_subset"]["전체"][0]["fn"] == 1


def test_wrong_items_only_sure_ones_and_no_votes_set():
    rows = [row(0, 1, "A", 0.9), row(0, 1, "B", 0.1), row(0, 2, "A", 0.9), row(0, 2, "B", 0.1)]
    w = live_eval.wrong_items(GOLD, rows, 0.45)
    assert [(x["pair"], x["side"], x["kind"]) for x in w] == [(1, "A", "틀린 알림"), (1, "B", "놓침")]   # 2B는 갈림이라 뺀다
    plain = [{k: v for k, v in g.items() if k != "votes"} for g in GOLD]
    assert list(live_eval.summarize(plain, rows)["by_subset"]) == ["전체"]
    assert "틀린 알림" in live_eval.to_markdown(live_eval.summarize(GOLD, rows), {0.45: w})


def test_models_copy_changes_only_realtime_tone(tmp_path):
    src = REPO / "engine/config/models.yaml"
    assert live_eval.models_copy(src, None, tmp_path / "m.yaml") == src
    dst = live_eval.models_copy(src, "mock:tone", tmp_path / "m.yaml")
    before, after = (yaml.safe_load(p.read_text(encoding="utf-8")) for p in (src, dst))
    changed = [(b["id"], a["model"]) for b, a in zip(before["experts"], after["experts"]) if b != a]
    assert changed and all(m == "mock:tone" for _, m in changed)
    assert all("realtime" in b["paths"] and b["role"] == "tone" for b in before["experts"] if b["id"] in dict(changed))
    assert before["aggregate"] == after["aggregate"]


def test_load_env_reads_only_known_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    f = tmp_path / ".env"
    f.write_text('NVIDIA_API_KEY="k"\nSUPABASE_DB_URL=secret\n', encoding="utf-8")
    live_eval.load_env(f)
    import os
    assert os.environ["NVIDIA_API_KEY"] == "k" and "SUPABASE_DB_URL" not in os.environ
    monkeypatch.delenv("NVIDIA_API_KEY")


def test_report_matches_saved_run():
    # 저장해 둔 11/14 실측이 일지의 표와 같은 값을 낸다(문턱 0.45, 확실한 45문장)
    gold = live_eval.read_jsonl(REPO / "eval/contrast_set_t16.jsonl")
    rows = json.loads((REPO / "eval/results/t16_laguna_5runs_2026-11-14.json").read_text(encoding="utf-8"))
    s = live_eval.summarize(gold, rows)
    r = next(x for x in s["by_subset"]["확실(80% 이상 동의)"] if x["threshold"] == 0.45)
    assert (r["n"], r["precision"], r["recall"], r["fp"], r["fn"]) == (225, 0.88, 0.79, 15, 29)
    assert next(c for c in s["consistency"] if c["threshold"] == 0.45)["kappa"] == 0.89
