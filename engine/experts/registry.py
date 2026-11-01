"""models.yaml의 experts → 경로·역할별 전문가 목록. 전문가 추가·제거는 설정만 바꾼다."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from harness import mock_rules
from harness.prompts import DIR as PROMPTS_DIR
from harness.providers import available
from harness.router import NoResult, Router

from .base import Expert, ExpertRequest, ExpertResult
from .llm import SCHEMAS, LLMExpert
from .classifier import ClassifierExpert, load_classifiers

log = logging.getLogger(__name__)


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
    classifiers: list[ClassifierExpert] = field(default_factory=list)

    @property
    def cfg(self) -> dict:
        return self.router.config

    @classmethod
    def load(cls, path: Path, force_mock: bool) -> "Registry":
        router = Router.from_file(path, force_mock)
        override_thresholds(router.config, os.environ)
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
        classifiers = load_classifiers(router.config.get("classifiers", []), Path(path).resolve().parent, force_mock)
        return cls(router, experts, classifiers)

    def for_path(self, path: str, role: str) -> list[Expert]:
        return [e for e in self.experts if path in e.paths and e.role == role]

    def classifiers_for(self, path: str) -> list[ClassifierExpert]:
        return [c for c in self.classifiers if path in c.paths]

    def weight(self, expert_id: str) -> float:
        return next((e.weight for e in self.experts if e.id == expert_id), 1.0)


# 테스트로 힌트 기준을 낮출 때 배포 env로 models.yaml 값을 덮는다(P-21). 비어 있으면 models.yaml 그대로.
THRESHOLD_ENV = {"HINT_GATE_THRESHOLD": ("paths", "realtime", "gate_threshold"),
                 "HINT_ALERT_THRESHOLD": ("aggregate", "alert_threshold"),
                 "HINT_MIN_CONFIDENCE": ("aggregate", "min_confidence")}


def override_thresholds(cfg: dict, env) -> None:
    for name, keys in THRESHOLD_ENV.items():
        raw = (env.get(name) or "").strip()
        if not raw:
            continue
        v = float(raw)
        if not 0.0 <= v <= 1.0:   # nan도 여기서 걸린다
            raise ValueError(f"{name}는 0~1 사이여야 한다")
        d = cfg
        for k in keys[:-1]:
            d = d[k]
        d[keys[-1]] = v
        log.warning("hint threshold overridden by env: %s=%s", name, v)
    # 하소연 반영 기준(신호별 서로 다른 신고자 수, 규칙 7). 테스트 중 바로 반영되게 낮출 때(P-32)
    raw = (env.get("PATTERN_MIN_OBS") or "").strip()
    if raw:
        n = int(raw)
        if n < 1:
            raise ValueError("PATTERN_MIN_OBS는 1 이상이어야 한다")
        cfg["aggregate"]["global_min_obs"] = n
        log.warning("pattern min obs overridden by env: PATTERN_MIN_OBS=%s", n)


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
