import importlib.util
import json
import subprocess
import sys

from tests.test_eval import REPO

spec = importlib.util.spec_from_file_location("latency_stats", REPO / "eval/latency_stats.py")
ls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ls)


def hint(ms, status="none", experts=(), at="2026-11-05T03:00:00+00:00"):
    return {"path": "hint", "latency_ms": ms, "created_at": at,
            "experts": {"status": status, "gate": None, "features": {},
                        "results": [{"expert_id": e, "role": "tone", "model": m, "latency_ms": t} for e, m, t in experts]}}


ROWS = [
    hint(700, experts=[("tone_label", "local_detail:qwen", 600)]),
    hint(900, "alert", experts=[("tone_label", "local_detail:qwen", 820)]),
    hint(1520, "timeout", at="2026-11-05T12:30:00+00:00"),     # KST 21시, 전문가 기록 없음
    hint(1100, experts=[("tone_label", "local_detail:qwen", 1000)], at="2026-11-06T12:10:00+00:00"),
    {"path": "detail", "latency_ms": 4000, "created_at": "2026-11-05T03:00:00Z", "user_id": "secret-user",
     "experts": json.dumps({"status": "ok", "results": [
         {"expert_id": "judge", "role": "judge", "model": "nvidia:x", "latency_ms": 3500},
         {"expert_id": "tone_ds", "role": "tone", "model": "nvidia:y", "latency_ms": 2000}]})},
    {"path": "mirror", "latency_ms": 3000, "created_at": "2026-11-05T03:00:00Z", "experts": []},   # 옛 배열 형식
]


def test_pct_linear():
    assert ls.pct([], 50) is None
    assert ls.pct([10], 95) == 10
    assert ls.pct([0, 100], 50) == 50
    assert ls.pct([1, 2, 3, 4, 5], 95) == 4.8


def test_summarize_paths_experts_overhead():
    s = ls.summarize(ROWS)
    h = s["paths"]["hint"]
    assert h["n"] == 4 and h["max"] == 1520
    assert h["status"] == {"none": 2, "alert": 1, "timeout": 1}
    assert s["hint_over_budget"] == 0.25
    assert s["paths"]["mirror"]["status"] == {"unknown": 1}
    # 전문가 표: p95 큰 순, 시간 초과 행은 빠진다
    assert [e["expert"] for e in s["experts"]] == ["judge", "tone_ds", "tone_label"]
    assert next(e for e in s["experts"] if e["expert"] == "tone_label")["n"] == 3
    # 모델 밖 = 전체 - 가장 느린 전문가: hint 100,80,100 / detail 500
    assert s["non_model"]["hint"]["max"] == 100 and s["non_model"]["hint"]["n"] == 3
    assert s["non_model"]["detail"]["p50"] == 500


def test_hour_and_day_in_kst():
    s = ls.summarize(ROWS)
    assert set(s["hint_by_hour_kst"]) == {12, 21}
    assert s["hint_by_hour_kst"][21]["n"] == 2 and s["hint_by_hour_kst"][21]["over_budget"] == 0.5   # 1520·1100
    assert set(s["hint_by_day_kst"]) == {"2026-11-05", "2026-11-06"}


def test_markdown_has_no_ids_or_text():
    md = ls.to_markdown(ls.summarize(ROWS))
    assert "secret-user" not in md and "경로별 전체 지연" in md and "tone_label" in md


def test_cli_jsonl_and_missing_url(tmp_path, monkeypatch):
    f = tmp_path / "rows.jsonl"
    f.write_text("".join(json.dumps(r) + "\n" for r in ROWS), encoding="utf-8")
    p = subprocess.run([sys.executable, str(REPO / "eval/latency_stats.py"), "--jsonl", str(f), "--json"],
                       capture_output=True, text=True, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout)["paths"]["hint"]["n"] == 4

    env_file = tmp_path / "e.env"
    env_file.write_text("OTHER=1\nSUPABASE_DB_URL=\n", encoding="utf-8")
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    assert ls.read_env_file(env_file, "SUPABASE_DB_URL") is None
    assert ls.main(["--env-file", str(env_file)]) == 2
