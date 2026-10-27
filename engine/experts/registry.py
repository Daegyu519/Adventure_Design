"""models.yaml의 experts → 경로·역할별 전문가 목록. 전문가 추가·제거는 설정만 바꾼다."""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from pathlib import Path

from harness import mock_rules
from harness.prompts import DIR as PROMPTS_DIR
from harness.providers import available
from harness.router import NoResult, Router

from .base import Expert, ExpertRequest, ExpertResult
from .llm import SCHEMAS, LLMExpert


def _check(e: dict, chain: list[str], providers: dict) -> None:
    if e.get("role") not in SCHEMAS:
        raise ValueError(f"{e['id']}: role은 {sorted(SCHEMAS)} 중 하나")
    if not (PROMPTS_DIR / f"{e.get('prompt')}.md").is_file():
        raise ValueError(f"{e['id']}: prompt 파일 없음 ({e.get('prompt')})")
    for m in chain:
        provider, _, name = m.partition(":")
        if provider not in providers:
            raise ValueError(f"{e['id']}: providers에 없는 공급자 ({provider})")
        if provider == "mock" and (name.startswith("_") or not callable(getattr(mock_rules, name, None))):
            raise ValueError(f"{e['id']}: mock_rules에 {name} 없음")


@dataclass
class Registry:
    router: Router
    experts: list[Expert]

    @property
    def cfg(self) -> dict:
        return self.router.config

    @classmethod
    def load(cls, path: Path, force_mock: bool) -> "Registry":
        router = Router.from_file(path, force_mock)
        providers = router.config["providers"]
        experts: list[Expert] = []
        for e in router.config["experts"]:
            chain = router.chains[e["id"]]
            _check(e, chain, providers)
            if force_mock and not any(m.startswith("mock:") for m in chain):
                continue
            first = chain[0].split(":", 1)[0]
            if e.get("optional") and not available(first, providers.get(first) or {}, os.environ):
                continue
            experts.append(LLMExpert(e["id"], e["role"], set(e["paths"]), float(e.get("weight", 1.0)),
                                     e["prompt"], router))
        return cls(router, experts)

    def for_path(self, path: str, role: str) -> list[Expert]:
        return [e for e in self.experts if path in e.paths and e.role == role]

    def weight(self, expert_id: str) -> float:
        return next((e.weight for e in self.experts if e.id == expert_id), 1.0)


async def run_all(experts: list[Expert], req: ExpertRequest, deadline: float) -> list[ExpertResult]:
    """동시에 돌린다. 시간 안에 못 오거나(TimeoutError) 모두 실패한(NoResult) 전문가는 빼고, 다른 예외는 올린다."""
    left = max(0.0, deadline - time.monotonic())
    results = await asyncio.gather(*(asyncio.wait_for(e.run(req, deadline), left) for e in experts),
                                   return_exceptions=True)
    out: list[ExpertResult] = []
    for r in results:
        if isinstance(r, NoResult | TimeoutError):
            continue
        if isinstance(r, BaseException):
            raise r
        out.append(r)
    return out
