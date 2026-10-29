"""요청마다 `app/context.py`가 `app/db.Repo`에서 채우는 읽기 전용 스냅숏(패턴·기준선). 쓰기는 `app/db.py`가 한다.
원문은 담지 않는다."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ProfileStore:
    pair_patterns: dict = field(default_factory=dict)    # pair_id → trigger → {count, strength, feeling}
    global_patterns: dict = field(default_factory=dict)  # trigger → count(서로 다른 신고자 수)
    baselines: dict = field(default_factory=dict)        # user_id → {avg_len, polite_rate, softener_rate, n}

    def patterns_for(self, pair_id: str) -> dict:
        return self.pair_patterns.get(pair_id, {})

    def baseline(self, user_id: str) -> dict | None:
        b = self.baselines.get(user_id)
        return b if b and b["n"] >= 10 else None
