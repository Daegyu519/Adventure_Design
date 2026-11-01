"""T-16 블라인드 라벨 도구.
  export: 후보(candidates_t16.jsonl) -> 섞인 라벨 양식(form.html)과 정답 대응표(key.json)
  merge : 두 사람 라벨(json) + key -> 일치율·Cohen's kappa·불일치 목록, 합의본 jsonl
후보는 AI가 초안만 썼다. 어느 면이 의도였는지는 양식에 나오지 않고, 최종 라벨은 사람이 정한다."""
from __future__ import annotations

import argparse
import html
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _read(p) -> list[dict]:
    return [json.loads(l) for l in Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]


def shuffle_rows(rows: list[dict], rng: random.Random) -> list[dict]:
    """쌍·면 전체를 섞되 같은 쌍의 두 면이 붙지 않게 한다(다시 섞기, 쌍이 1개면 불가능하니 그대로)."""
    rows = rows[:]
    for _ in range(1000):
        rng.shuffle(rows)
        if len({r["pair"] for r in rows}) < 2 or all(a["pair"] != b["pair"] for a, b in zip(rows, rows[1:])):
            break
    return rows


def export(cands: Path, out: Path, seed: int | None = None) -> None:
    rows = shuffle_rows(_read(cands), random.Random(seed))
    out.mkdir(parents=True, exist_ok=True)
    # id는 섞은 순서의 번호. 쌍·면 정보는 key.json에만 있다.
    items = [{"id": f"i{n:03d}", "relation": r["relation"], "them": r["them"], "draft": r["draft"]}
             for n, r in enumerate(rows, 1)]
    key = {it["id"]: {k: r[k] for k in ("pair", "side", "relation", "them", "draft")} for it, r in zip(items, rows)}
    (out / "key.json").write_text(json.dumps(key, ensure_ascii=False, indent=1), encoding="utf-8")
    cards = "".join(
        f'<fieldset><legend>{n}. [{html.escape(it["relation"])}]</legend>'
        f'<p>상대: {html.escape(it["them"])}</p><p>내가 보낼 말: <b>{html.escape(it["draft"])}</b></p>'
        f'<label><input type=radio name={it["id"]} value=1> 차갑게 읽힘</label> '
        f'<label><input type=radio name={it["id"]} value=0> 괜찮음</label> '
        f'<input name=m_{it["id"]} placeholder=메모></fieldset>' for n, it in enumerate(items, 1))
    (out / "form.html").write_text(f"""<!doctype html><meta charset=utf-8><title>T-16 라벨</title>
<body style="font:16px sans-serif;max-width:640px;margin:auto">
<h3>같은 문장도 맥락에 따라 다르게 읽힙니다</h3>
<p>상대의 말 뒤에 이 문장을 받으면 <b>차갑게 읽힐지</b> 혼자서(상의 없이) 고르세요.</p>
<p>이름: <input id=who> <button onclick=save()>저장(JSON 다운로드)</button></p>{cards}
<script>function save(){{var w=document.getElementById('who').value.trim();if(!w)return alert('이름을 쓰세요');
var L={{}},n=0;document.querySelectorAll('fieldset').forEach(function(f){{var r=f.querySelector('input[type=radio]:checked'),
id=f.querySelector('input[type=radio]').name;if(r){{n++;L[id]={{cold:r.value==='1',memo:f.querySelector('input:not([type=radio])').value}}}}}});
if(n<{len(items)}&&!confirm('안 고른 것이 '+({len(items)}-n)+'개 있습니다. 그래도 저장?'))return;
var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({{labeler:w,labels:L}})],{{type:'application/json'}}));
a.download='labels_'+w+'.json';a.click()}}</script>""", encoding="utf-8")
    print(f"{len(items)}개 -> {out}/form.html (key.json은 합치기 전까지 두 사람에게 보여주지 않는다)")


def kappa(a: list[bool], b: list[bool]) -> float:
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    pa, pb = sum(a) / n, sum(b) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    return (po - pe) / (1 - pe) if pe < 1 else (1.0 if po == 1 else 0.0)


def merge(key: Path, f1: Path, f2: Path, out: Path) -> dict:
    key_d = json.loads(Path(key).read_text(encoding="utf-8"))
    l1, l2 = (json.loads(Path(f).read_text(encoding="utf-8")) for f in (f1, f2))
    ids = [i for i in key_d if i in l1["labels"] and i in l2["labels"]]
    a = [l1["labels"][i]["cold"] for i in ids]
    b = [l2["labels"][i]["cold"] for i in ids]
    agreed = [(i, x) for i, x, y in zip(ids, a, b) if x == y]
    diff = [i for i, x, y in zip(ids, a, b) if x != y]
    rows = sorted(({"pair": key_d[i]["pair"], "side": key_d[i]["side"], "relation": key_d[i]["relation"],
                    "them": key_d[i]["them"], "draft": key_d[i]["draft"], "alert": x} for i, x in agreed),
                  key=lambda r: (r["pair"], r["side"]))
    Path(out).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    res = {"n": len(ids), "agree": len(agreed), "agreement": round(len(agreed) / len(ids), 3) if ids else None,
           "kappa": round(kappa(a, b), 3) if ids else None, "disagreements": diff}
    print(f"둘 다 라벨한 {res['n']}개, 일치 {res['agree']} ({res['agreement']}), kappa {res['kappa']}")
    for i in diff:
        k = key_d[i]
        print(f"  불일치 쌍{k['pair']}{k['side']} [{k['relation']}] {k['them']} / {k['draft']}  "
              f"{l1['labeler']}={l1['labels'][i]['cold']} {l2['labeler']}={l2['labels'][i]['cold']}")
    print(f"합의본 {len(rows)}행 -> {out} (불일치는 둘이 상의해 직접 정한 뒤 추가)")
    return res


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("--candidates", type=Path, default=HERE / "candidates_t16.jsonl")
    e.add_argument("--out", type=Path, default=HERE / "out")
    e.add_argument("--seed", type=int)
    m = sub.add_parser("merge")
    m.add_argument("--key", type=Path, default=HERE / "out" / "key.json")
    m.add_argument("labels", type=Path, nargs=2)
    m.add_argument("--out", type=Path, default=HERE.parent / "contrast_set_t16.jsonl")
    a = ap.parse_args(argv)
    if a.cmd == "export":
        export(a.candidates, a.out, a.seed)
    else:
        merge(a.key, *a.labels, a.out)


if __name__ == "__main__":
    main(sys.argv[1:])
