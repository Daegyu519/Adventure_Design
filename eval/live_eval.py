"""사람 라벨 세트로 실제 실시간 모델을 여러 번 돌려 문턱별 정밀도·재현율과 자기 일치도를 본다(P-40).

  uv run --project engine python eval/live_eval.py run --env-file .env --rt-model nvidia:<모델> [--runs 5] [--out 파일.json]
  uv run --project engine python eval/live_eval.py report --live 파일.json

run   : 세트(기본 eval/contrast_set_t16.jsonl)를 실시간 경로로 --runs회. 회차마다 라우터 캐시를 비운다.
        판단과 속도를 따로 보려고 전문가 마감을 --deadline-ms(기본 8000)로 늘리고 지연을 기록한다.
        --rt-model이 있으면 models.yaml 복사본에서 실시간 말투 전문가의 모델만 바꾼다(scripts/mac-engine과 같은 방식).
        없으면 models.yaml 그대로(학교 GPU: USE_LOCAL_MODEL=1). 모델 이름은 이 파일에 두지 않는다(규칙 2).
report: 문턱별 정밀도·재현율·알림 비율(합의 강도별: 확실 = 5명 중 4명 이상, 만장일치, 갈림), 괜찮은 문장에 알림이 뜬 비율,
        같은 문장 반복의 자기 일치도(Fleiss kappa, 결과가 갈린 문장 수), 모델 지연과 실시간 마감 초과 비율.

세트는 사람이 라벨한 예문이어야 한다(실제 대화 금지, 규칙 9). 키는 env 파일이나 환경 변수에서만 읽고 출력하지 않는다.
세트 행에 votes([알려 줄 만함, 괜찮음])가 없으면 합의 강도별 표는 건너뛴다.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_SET = HERE / "contrast_set_t16.jsonl"
THRESHOLDS = (0.3, 0.45, 0.5, 0.6, 0.7)
KEY_NAMES = ("NVIDIA_API_KEY", "LOCAL_API_KEY", "USE_LOCAL_MODEL")


def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]


def fleiss(counts: list[tuple[int, int]]) -> float | None:
    """counts: 문장마다 (알림 횟수, 알림 아님 횟수). 반복 수가 같아야 한다."""
    if not counts:
        return None
    n = sum(counts[0])
    if n < 2 or any(sum(c) != n for c in counts):
        return None
    p_bar = sum((y * y + f * f - n) / (n * (n - 1)) for y, f in counts) / len(counts)
    p_yes = sum(y for y, _ in counts) / (len(counts) * n)
    pe = p_yes ** 2 + (1 - p_yes) ** 2
    return (p_bar - pe) / (1 - pe) if pe < 1 else 1.0


def predicted(r: dict, threshold: float, min_conf: float) -> bool:
    """집계와 같은 규칙: 자신 없으면 기권, 아니면 위험도가 문턱 이상일 때 알림. 전문가가 1개라 의견 차 기권은 없다."""
    return r["conf"] >= min_conf and r["risk"] >= threshold


def summarize(gold: list[dict], rows: list[dict], thresholds=THRESHOLDS, min_conf: float = 0.4,
              deadline_ms: int = 1350) -> dict:
    """gold: 세트 행(pair, side, alert, votes?). rows: run이 쓴 행(run, pair, side, risk, conf, neg, expert_ms | failed)."""
    g = {(r["pair"], r["side"]): r for r in gold}
    ok = [r for r in rows if not r.get("failed") and (r["pair"], r["side"]) in g]
    runs = sorted({r["run"] for r in rows})
    strength = lambda x: max(x["votes"]) / sum(x["votes"]) if x.get("votes") else None  # noqa: E731
    subsets = {"전체": lambda x: True}
    if all(x.get("votes") for x in gold):
        subsets = {"확실(80% 이상 동의)": lambda x: strength(x) >= 0.8, "만장일치": lambda x: strength(x) == 1.0,
                   "갈림": lambda x: strength(x) < 0.8, **subsets}

    def table(sub) -> list[dict]:
        out = []
        for th in thresholds:
            tp = fp = fn = tn = 0
            per_run = defaultdict(lambda: [0, 0])
            for r in ok:
                x = g[(r["pair"], r["side"])]
                if not sub(x):
                    continue
                p = predicted(r, th, min_conf)
                tp += p and x["alert"]; fp += p and not x["alert"]; fn += (not p) and x["alert"]; tn += (not p) and not x["alert"]
                if p:
                    per_run[r["run"]][0 if x["alert"] else 1] += 1
            n = tp + fp + fn + tn
            ps = [a / (a + b) for a, b in per_run.values()]
            out.append({"threshold": th, "n": n, "precision": round(tp / (tp + fp), 2) if tp + fp else None,
                        "recall": round(tp / (tp + fn), 2) if tp + fn else None,
                        "alert_rate": round((tp + fp) / n, 2) if n else None,
                        "false_alert_rate": round(fp / (fp + tn), 2) if fp + tn else None,   # 괜찮은 문장에 알림
                        "fp": fp, "fn": fn, "precision_by_run": [round(min(ps), 2), round(max(ps), 2)] if ps else None})
        return out

    by = defaultdict(list)
    for r in ok:
        by[(r["pair"], r["side"])].append(r)
    full = [v for v in by.values() if len(v) == len(runs)]
    consistency = []
    for th in thresholds:
        counts = [(sum(predicted(r, th, min_conf) for r in v), sum(not predicted(r, th, min_conf) for r in v)) for v in full]
        k = fleiss(counts)
        consistency.append({"threshold": th, "kappa": round(k, 2) if k is not None else None,
                            "flipped": sum(1 for y, f in counts if y and f), "n": len(counts)})
    ms = sorted(r["expert_ms"] for r in ok if isinstance(r.get("expert_ms"), (int, float)))
    q = lambda p: ms[min(len(ms) - 1, int(p * len(ms)))] if ms else None  # noqa: E731
    return {
        "calls": len(rows), "ok": len(ok), "runs": len(runs),
        "by_subset": {name: table(sub) for name, sub in subsets.items()},
        "consistency": consistency,
        "same_strength_all_runs": sum(1 for v in full if len({round(r["neg"], 2) for r in v}) == 1),
        "strength_values": Counter(round(r["neg"], 2) for r in ok).most_common(8),
        "latency_ms": {"p50": q(.5), "p90": q(.9), "p95": q(.95), "max": ms[-1] if ms else None,
                       "over_deadline": round(sum(m > deadline_ms for m in ms) / len(ms), 2) if ms else None},
    }


def wrong_items(gold: list[dict], rows: list[dict], threshold: float, min_conf: float = 0.4) -> list[dict]:
    """합의가 확실한(80% 이상) 문장 중 반복의 과반이 사람과 다르게 나온 것."""
    by = defaultdict(list)
    for r in rows:
        if not r.get("failed"):
            by[(r["pair"], r["side"])].append(r)
    out = []
    for x in gold:
        v = by.get((x["pair"], x["side"]))
        if not v or (x.get("votes") and max(x["votes"]) / sum(x["votes"]) < 0.8):
            continue
        a = sum(predicted(r, threshold, min_conf) for r in v)
        if (a * 2 > len(v)) != x["alert"]:
            out.append({**{k: x[k] for k in ("pair", "side", "relation", "them", "draft")}, "votes": x.get("votes"),
                        "alerts": a, "of": len(v), "kind": "틀린 알림" if a * 2 > len(v) else "놓침"})
    return out


def to_markdown(s: dict, wrong: dict[float, list[dict]]) -> str:
    f = lambda v: "-" if v is None else str(v)  # noqa: E731
    out = [f"호출 {s['calls']}, 성공 {s['ok']}, 회차 {s['runs']}"]
    for name, rows in s["by_subset"].items():
        out += ["", f"## {name} ({rows[0]['n']}건)", "",
                "| 문턱 | 정밀도 | 재현율 | 알림 비율 | 괜찮은 문장에 알림 | 틀린 알림 | 놓침 | 회차별 정밀도 |", "|---|---|---|---|---|---|---|---|"]
        for r in rows:
            pr = "~".join(map(str, r["precision_by_run"])) if r["precision_by_run"] else "-"
            out.append(f"| {r['threshold']} | {f(r['precision'])} | {f(r['recall'])} | {f(r['alert_rate'])} | "
                       f"{f(r['false_alert_rate'])} | {r['fp']} | {r['fn']} | {pr} |")
    out += ["", "## 자기 일치도 (같은 문장 반복)", "", "| 문턱 | Fleiss kappa | 결과가 갈린 문장 |", "|---|---|---|"]
    out += [f"| {c['threshold']} | {f(c['kappa'])} | {c['flipped']}/{c['n']} |" for c in s["consistency"]]
    lat = s["latency_ms"]
    out += ["", f"부정 강도가 모든 회차에서 같은 문장: {s['same_strength_all_runs']}",
            f"부정 강도 값(횟수): {s['strength_values']}",
            f"모델 지연 ms: p50 {f(lat['p50'])} · p90 {f(lat['p90'])} · p95 {f(lat['p95'])} · 최대 {f(lat['max'])}, "
            f"실시간 마감 초과 {f(lat['over_deadline'])}"]
    for th, items in wrong.items():
        out += ["", f"## 확실한 문장 중 문턱 {th}에서 사람과 다른 것", ""]
        out += [f"- {w['kind']} {w['alerts']}/{w['of']} · 사람 {w['votes']} · [{w['relation']}] {w['them']} / {w['draft']}" for w in items] or ["- 없음"]
    return "\n".join(out)


def load_env(path: Path | None) -> None:
    """KEY_NAMES만 읽는다. 값은 출력하지 않는다."""
    if path is None:
        return
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        k, sep, v = line.strip().partition("=")
        if sep and k in KEY_NAMES and v.strip():
            os.environ[k] = v.strip().strip('"').strip("'")


def models_copy(src: Path, rt_model: str | None, dst: Path) -> Path:
    """실시간 말투 전문가(paths에 realtime이 있는 role: tone)의 모델만 바꾼 복사본. rt_model이 없으면 원본 경로."""
    if not rt_model:
        return src
    import yaml
    cfg = yaml.safe_load(src.read_text(encoding="utf-8"))
    hit = [e for e in cfg["experts"] if e["role"] == "tone" and "realtime" in e["paths"]]
    if not hit:
        raise SystemExit("models.yaml에 실시간 말투 전문가가 없다")
    for e in hit:
        e["model"] = rt_model
    dst.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return dst


async def run(set_path: Path, models: Path, runs: int, deadline_ms: int, out: Path, pause_s: float) -> list[dict]:
    sys.path.insert(0, str(REPO / "engine"))
    from experts.registry import Registry
    from harness.schemas import Conversation, Turn
    from harness.store import ProfileStore
    from pipeline import realtime

    items = read_jsonl(set_path)
    reg = Registry.load(models, False)
    reg.cfg["paths"]["realtime"]["expert_deadline_ms"] = deadline_ms
    print("실시간 말투:", [reg.router.chains[e.id][0] for e in reg.for_path("realtime", "tone")], "판별기:", len(reg.classifiers), flush=True)
    store, rows = ProfileStore(), []
    for k in range(runs):
        reg.router.cache.clear()
        for it in items:
            c = Conversation(pair_id=f"eval-{it['pair']}", relation=it["relation"], turns=[Turn(speaker="them", text=it["them"])])
            rec = None
            for attempt in range(4):   # 한도·차단기에 걸리면 기다렸다 다시
                t = time.monotonic()
                o = await realtime(reg, it["draft"], c, store, "eval", [], t)
                if o.results and o.verdict:
                    r, v = o.results[0], o.verdict
                    rec = {"run": k, "pair": it["pair"], "side": it["side"], "ms": round((time.monotonic() - t) * 1000),
                           "expert_ms": r.latency_ms, "model": r.model, "risk": v.risk, "prior": v.features.get("prior"),
                           "neg": v.features.get("neg"), "conf": v.features.get("confidence"), "clf": o.clf,
                           "readings": dict(r.output.readings), "signals": list(o.gate.signals)}
                    break
                await asyncio.sleep(20 if attempt else 5)
            rows.append(rec or {"run": k, "pair": it["pair"], "side": it["side"], "failed": True})
            await asyncio.sleep(pause_s)
        done = sum(1 for r in rows if r["run"] == k and not r.get("failed"))
        print(f"회차 {k + 1}/{runs}: {done}/{len(items)} 성공, 실패 누계 {reg.router.failures}", flush=True)
        out.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")   # 회차마다 저장
    return rows


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="사람 라벨 세트로 실제 실시간 모델 평가(P-40)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--set", type=Path, default=DEFAULT_SET)
    r.add_argument("--env-file", type=Path)
    r.add_argument("--models", type=Path, default=REPO / "engine/config/models.yaml")
    r.add_argument("--rt-model", help="실시간 말투 전문가에 쓸 공급자:모델 (없으면 models.yaml 그대로)")
    r.add_argument("--runs", type=int, default=5)
    r.add_argument("--deadline-ms", type=int, default=8000)
    r.add_argument("--pause", type=float, default=1.7, help="호출 사이 쉬는 초(공급자 분당 한도 아래로)")
    r.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("report")
    p.add_argument("--set", type=Path, default=DEFAULT_SET)
    p.add_argument("--live", type=Path, required=True)
    p.add_argument("--min-conf", type=float, default=0.4)
    p.add_argument("--wrong-at", type=float, nargs="*", default=[0.45])
    p.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if a.cmd == "run":
        load_env(a.env_file)
        models = models_copy(a.models, a.rt_model, a.out.with_suffix(".models.yaml"))
        asyncio.run(run(a.set, models, a.runs, a.deadline_ms, a.out, a.pause))
        return 0
    gold, rows = read_jsonl(a.set), json.loads(a.live.read_text(encoding="utf-8"))
    s = summarize(gold, rows, min_conf=a.min_conf)
    wrong = {th: wrong_items(gold, rows, th, a.min_conf) for th in a.wrong_at}
    print(json.dumps(s | {"wrong": {str(k): v for k, v in wrong.items()}}, ensure_ascii=False, indent=1) if a.json
          else to_markdown(s, wrong))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
