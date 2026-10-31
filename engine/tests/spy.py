"""테스트용 공급자. 무엇이 모델로 나갔는지 기록한다(네트워크 없음)."""
from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path

import yaml

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
        self.calls.append({"model": model, "system": system, "user": user, "payload": payload})
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


def legacy_rt_config(path: Path = DEFAULT_MODELS_PATH) -> dict:
    """테스트 전용: 실시간 경로에 context 전문가가 있고 게이트 0.3이던 옛 구조(P-12 이전).
    context 병합·그룹방 프롬프트·보낸 사람 패턴·trace 같은 동작을 계속 시험하려고 운영 설정에서 파생한다."""
    cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    for e in cfg["experts"]:
        if e["id"] in {"ctx_fast", "tone_ds"}:
            e["paths"] = ["realtime", *e["paths"]]
        if e["id"] == "tone_fast":
            e["paths"] = []
    cfg["paths"]["realtime"]["gate_threshold"] = 0.3
    return cfg


def make_legacy_rt_registry(tmp_path: Path, spy: SpyProvider | None = None) -> Registry:
    p = tmp_path / "models_legacy_rt.yaml"
    p.write_text(yaml.safe_dump(legacy_rt_config(), allow_unicode=True), encoding="utf-8")
    return make_registry(spy, p)
