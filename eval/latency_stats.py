"""R-05 속도 기준 측정: `tone.analysis_traces`에 이미 쌓인 기록으로 구간별 지연을 본다.

  uv run --project engine python eval/latency_stats.py --env-file .env [--days 14] [--json]
  uv run --project engine python eval/latency_stats.py --jsonl rows.jsonl      # 가짜·내보낸 행으로

보는 것
  - 경로(hint·detail·mirror)별 전체 지연 p50·p95·p99·최대, 결과 상태 비율(timeout·error 포함)
  - 전문가·모델별 지연 p50·p95·최대 (시간 초과·오류 행은 전문가 기록이 없어 빠진다)
  - 모델 밖 시간 = 전체 지연 − 가장 느린 전문가 (맥락 조회·집계·검사 등)
  - KST 시간대별·날짜별 hint 지연과 1.5초 초과 비율 ("간헐적" 병목이 몰리는 때)

재는 범위: 엔진이 요청 본문을 받은 뒤(t0)부터 응답 직전까지. 토큰 인증(의존성), 네트워크, 앱 화면 표시는 들어 있지 않다.
개인정보: user_id·room_id·문장은 읽지도 출력하지도 않는다(DB에도 문장은 없다). DB 주소는 환경 변수나 env 파일에서만 읽고 출력하지 않는다.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
HINT_BUDGET_MS = 1500


def pct(xs: list[float], q: float) -> float | None:
    """선형 보간 백분위(q는 0~100). 비어 있으면 None."""
    if not xs:
        return None
    s = sorted(xs)
    k = (len(s) - 1) * q / 100
    lo, hi = math.floor(k), math.ceil(k)
    return float(s[lo] + (s[hi] - s[lo]) * (k - lo))


def dist(xs: list[float]) -> dict:
    r = lambda v: None if v is None else round(v)
    return {"n": len(xs), "p50": r(pct(xs, 50)), "p95": r(pct(xs, 95)), "p99": r(pct(xs, 99)),
            "max": r(max(xs)) if xs else None}


def _experts(raw) -> tuple[str | None, list[dict]]:
    """experts 칸 → (status, results). 객체(현재 형식)와 배열(초기 기본값 '[]')을 모두 받는다."""
    if isinstance(raw, str):
        raw = json.loads(raw)
    if isinstance(raw, dict):
        return raw.get("status"), [r for r in raw.get("results") or [] if isinstance(r, dict)]
    if isinstance(raw, list):
        return None, [r for r in raw if isinstance(r, dict)]
    return None, []


def _when(v) -> datetime:
    if isinstance(v, str):
        v = datetime.fromisoformat(v.replace("Z", "+00:00"))
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.astimezone(KST)


def summarize(rows: list[dict]) -> dict:
    """rows: {path, latency_ms, experts, created_at}. 다른 칸이 있어도 쓰지 않는다."""
    by_path: dict[str, list[float]] = defaultdict(list)
    status: dict[str, Counter] = defaultdict(Counter)
    by_expert: dict[tuple, list[float]] = defaultdict(list)
    overhead: dict[str, list[float]] = defaultdict(list)
    hour: dict[int, list[float]] = defaultdict(list)
    day: dict[str, list[float]] = defaultdict(list)

    for row in rows:
        path, ms = row["path"], float(row["latency_ms"])
        st, results = _experts(row.get("experts"))
        by_path[path].append(ms)
        status[path][st or "unknown"] += 1
        exp_ms = [float(r["latency_ms"]) for r in results if isinstance(r.get("latency_ms"), (int, float))]
        for r in results:
            if isinstance(r.get("latency_ms"), (int, float)):
                by_expert[(path, str(r.get("expert_id")), str(r.get("model")))].append(float(r["latency_ms"]))
        if exp_ms:
            overhead[path].append(max(0.0, ms - max(exp_ms)))
        if path == "hint":
            t = _when(row["created_at"])
            hour[t.hour].append(ms)
            day[t.date().isoformat()].append(ms)

    over = lambda xs: round(sum(x > HINT_BUDGET_MS for x in xs) / len(xs), 3) if xs else None
    return {
        "paths": {p: dist(xs) | {"status": dict(status[p].most_common())} for p, xs in sorted(by_path.items())},
        "hint_over_budget": over(by_path.get("hint", [])),
        "experts": [{"path": p, "expert": e, "model": m} | dist(xs)
                    for (p, e, m), xs in sorted(by_expert.items(), key=lambda kv: -(pct(kv[1], 95) or 0))],
        "non_model": {p: dist(xs) for p, xs in sorted(overhead.items())},
        "hint_by_hour_kst": {h: dist(xs) | {"over_budget": over(xs)} for h, xs in sorted(hour.items())},
        "hint_by_day_kst": {d: dist(xs) | {"over_budget": over(xs)} for d, xs in sorted(day.items())},
    }


def _fmt(v) -> str:
    return "-" if v is None else str(v)


def to_markdown(s: dict) -> str:
    out = ["## 경로별 전체 지연 (ms, 엔진 안)", "",
           "| 경로 | n | p50 | p95 | p99 | 최대 | 상태 |", "|---|---|---|---|---|---|---|"]
    for p, d in s["paths"].items():
        st = ", ".join(f"{k} {v}" for k, v in d["status"].items())
        out.append(f"| {p} | {d['n']} | {_fmt(d['p50'])} | {_fmt(d['p95'])} | {_fmt(d['p99'])} | {_fmt(d['max'])} | {st} |")
    out += ["", f"hint 중 {HINT_BUDGET_MS}ms 초과 비율: {_fmt(s['hint_over_budget'])}", "",
            "## 전문가·모델별 지연 (p95 큰 순)", "",
            "| 경로 | 전문가 | 모델 | n | p50 | p95 | 최대 |", "|---|---|---|---|---|---|---|"]
    for e in s["experts"]:
        out.append(f"| {e['path']} | {e['expert']} | {e['model']} | {e['n']} | {_fmt(e['p50'])} | {_fmt(e['p95'])} | {_fmt(e['max'])} |")
    out += ["", "## 모델 밖 시간 (전체 − 가장 느린 전문가)", "",
            "| 경로 | n | p50 | p95 | 최대 |", "|---|---|---|---|---|"]
    for p, d in s["non_model"].items():
        out.append(f"| {p} | {d['n']} | {_fmt(d['p50'])} | {_fmt(d['p95'])} | {_fmt(d['max'])} |")
    for title, key, label in (("KST 시간대별 hint", "hint_by_hour_kst", "시"), ("날짜별 hint", "hint_by_day_kst", "날짜")):
        out += ["", f"## {title}", "", f"| {label} | n | p50 | p95 | 최대 | 1.5초 초과 |", "|---|---|---|---|---|---|"]
        for k, d in s[key].items():
            out.append(f"| {k} | {d['n']} | {_fmt(d['p50'])} | {_fmt(d['p95'])} | {_fmt(d['max'])} | {_fmt(d['over_budget'])} |")
    out += ["", "주의: 시간 초과·오류 행은 전문가 기록이 비어 전문가 표와 모델 밖 시간에서 빠진다. "
            "토큰 인증·네트워크·앱 표시 시간은 들어 있지 않다."]
    return "\n".join(out)


def read_env_file(path: Path, name: str) -> str | None:
    """KEY=VALUE 한 줄만 찾는다. 값은 돌려주기만 하고 출력하지 않는다."""
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


async def fetch(db_url: str, days: int) -> list[dict]:
    import asyncpg   # 엔진 의존성. --jsonl만 쓸 때는 필요 없다

    conn = await asyncpg.connect(db_url, statement_cache_size=0, timeout=15)
    try:
        recs = await conn.fetch(
            "select path, latency_ms, experts::text as experts, created_at from tone.analysis_traces "
            "where created_at >= now() - make_interval(days => $1) order by created_at", days)
    finally:
        await conn.close()
    return [dict(r) for r in recs]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="R-05 trace 지연 집계")
    ap.add_argument("--env-file", type=Path, help="SUPABASE_DB_URL을 읽을 env 파일 (없으면 환경 변수)")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--jsonl", type=Path, help="DB 대신 이 파일의 행을 쓴다")
    ap.add_argument("--json", action="store_true", help="마크다운 대신 JSON")
    a = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")   # Windows 콘솔 기본 cp949에서 한국어 표가 깨지지 않게

    if a.jsonl:
        rows = [json.loads(l) for l in a.jsonl.read_text(encoding="utf-8").splitlines() if l.strip()]
    else:
        url = (read_env_file(a.env_file, "SUPABASE_DB_URL") if a.env_file else None) or os.environ.get("SUPABASE_DB_URL")
        if not url:
            print("SUPABASE_DB_URL이 없다 (--env-file 또는 환경 변수)", file=sys.stderr)
            return 2
        try:
            rows = asyncio.run(fetch(url, a.days))
        except Exception as e:  # noqa: BLE001 - 접속 문자열(비밀번호)이 메시지에 섞일 수 있어 종류만
            print(f"DB 읽기 실패: {type(e).__name__}", file=sys.stderr)
            return 1
    if not rows:
        print("행이 없다", file=sys.stderr)
        return 1
    s = summarize(rows)
    print(json.dumps(s, ensure_ascii=False, indent=1) if a.json else to_markdown(s))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
