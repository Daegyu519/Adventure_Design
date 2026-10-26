"""테스트용 공급자. 무엇이 모델로 나갔는지 기록한다(네트워크 없음)."""
from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path

from app.settings import DEFAULT_MODELS_PATH
from experts.registry import Registry
from harness import mock_rules


class SpyProvider:
    available = True

    def __init__(self, name: str = "mock", canned: dict[str, Callable[[dict], dict | str]] | None = None,
                 delay: float = 0.0):
        self.name = name
        self.canned = canned or {}
        self.delay = delay          # canned 모델에만 걸린다(느린 전문가 하나만 흉내 내려고)
        self.calls: list[dict] = []

    async def complete(self, model: str, system: str, user: str, payload: dict, timeout_s: float) -> str:
        self.calls.append({"model": model, "user": user, "payload": payload})
        if model in self.canned:
            await asyncio.sleep(self.delay)
            out = self.canned[model](payload)
        else:
            out = getattr(mock_rules, model)(payload)
        return out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)

    def seen(self) -> str:
        return json.dumps(self.calls, ensure_ascii=False)


def make_registry(spy: SpyProvider | None = None, path: Path = DEFAULT_MODELS_PATH) -> Registry:
    reg = Registry.load(path, force_mock=True)
    if spy:
        reg.router.providers[spy.name] = spy
    return reg
