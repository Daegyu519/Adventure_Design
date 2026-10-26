"""패턴과 기준선 저장소. 원문은 저장하지 않는다."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .schemas import FeedbackPattern

WEEKLY_CAP_PER_PAIR = 5   # 한 관계에서 일주일에 반영할 수 있는 피드백 수 (악용 방지)


# ponytail: 메모리 저장소, T-24/T-26에서 tone 스키마로 교체
@dataclass
class ProfileStore:
    path: Path | None = None
    pair_patterns: dict = field(default_factory=dict)    # pair_id → trigger → {count, strength}
    global_patterns: dict = field(default_factory=dict)  # trigger → count
    baselines: dict = field(default_factory=dict)        # user_id → {avg_len, polite_rate, softener_rate, n}
    weekly: dict = field(default_factory=dict)           # pair_id → {week, n}

    @classmethod
    def load(cls, path: str | Path) -> "ProfileStore":
        p = Path(path)
        if p.exists():
            d = json.loads(p.read_text(encoding="utf-8"))
            return cls(path=p, **d)
        return cls(path=p)

    def save(self) -> None:
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            data = {k: getattr(self, k) for k in ("pair_patterns", "global_patterns", "baselines", "weekly")}
            self.path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    # ----- 피드백 패턴 -----
    def add_patterns(self, pair_id: str, patterns: list[FeedbackPattern]) -> bool:
        week = date.today().isocalendar()[1]
        w = self.weekly.setdefault(pair_id, {"week": week, "n": 0})
        if w["week"] != week:
            w.update(week=week, n=0)
        if w["n"] >= WEEKLY_CAP_PER_PAIR:
            return False
        w["n"] += 1
        bucket = self.pair_patterns.setdefault(pair_id, {})
        for p in patterns:
            e = bucket.setdefault(p.trigger, {"count": 0, "strength": 0.0, "feeling": p.feeling})
            e["strength"] = (e["strength"] * e["count"] + p.strength) / (e["count"] + 1)
            e["count"] += 1
            self.global_patterns[p.trigger] = self.global_patterns.get(p.trigger, 0) + 1
        return True

    def seed_global(self, counts: dict[str, int]) -> None:
        """데이터셋·다른 대화에서 모인 일반 패턴을 미리 넣는다."""
        for k, v in counts.items():
            self.global_patterns[k] = self.global_patterns.get(k, 0) + v

    def patterns_for(self, pair_id: str) -> dict:
        return self.pair_patterns.get(pair_id, {})

    # ----- 내 기준선 -----
    def update_baseline(self, user_id: str, length: int, polite: bool, softener: bool) -> None:
        b = self.baselines.setdefault(user_id, {"avg_len": 0.0, "polite_rate": 0.0, "softener_rate": 0.0, "n": 0})
        n = b["n"]
        b["avg_len"] = (b["avg_len"] * n + length) / (n + 1)
        b["polite_rate"] = (b["polite_rate"] * n + polite) / (n + 1)
        b["softener_rate"] = (b["softener_rate"] * n + softener) / (n + 1)
        b["n"] = n + 1

    def baseline(self, user_id: str) -> dict | None:
        b = self.baselines.get(user_id)
        return b if b and b["n"] >= 10 else None
