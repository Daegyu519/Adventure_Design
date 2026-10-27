"""전문가 ID로 모델을 골라 부르는 하네스의 중심.
- 전문가의 사슬(모델 + fallback) 순서대로 부르고, 키 없음·한도·시간 초과·JSON 깨짐이면 다음 모델로 넘어간다.
- 같은 모델이 연속으로 실패하면 잠시 건너뛴다(차단기).
- 같은 입력은 캐시에서 돌려준다(상한을 넘으면 통째로 비운다). 넣을 때와 꺼낼 때 깊은 복사를 해서
  한 요청이 결과를 고쳐도(이름 복원 등) 다른 요청에 새지 않는다.
- mock이 아닌 공급자로 보내기 직전에 system·user·payload에 패턴 가리기를 한 번 더 한다(입구 Masker의 안전망).
  local도 원격 주소를 가리킬 수 있으니 예외로 두지 않는다.
- 호출마다 기록을 남기되 원문은 남기지 않는다."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

import yaml
from pydantic import BaseModel, ValidationError

from . import pii
from .providers import MockProvider, OpenAICompatProvider, ProviderError, TokenBucket, extract_json

T = TypeVar("T", bound=BaseModel)


def chains(cfg: dict) -> dict[str, list[str]]:
    """전문가 id → [model, *fallback[model]]. mock:auto는 mock:<expert.mock 또는 prompt>로 바꾼다."""
    fallback = cfg.get("fallback") or {}
    out: dict[str, list[str]] = {}
    for e in cfg.get("experts") or []:
        auto = f"mock:{e.get('mock') or e.get('prompt')}"
        out[e["id"]] = [auto if m == "mock:auto" else m for m in [e["model"], *fallback.get(e["model"], [])]]
    return out


def _scrub(x: Any) -> Any:
    """중첩된 문자열까지 패턴 가리기(이름 없이)."""
    if isinstance(x, str):
        return pii.mask(x)
    if isinstance(x, dict):
        return {k: _scrub(v) for k, v in x.items()}
    if isinstance(x, list | tuple):
        return [_scrub(v) for v in x]
    return x


class NoResult(Exception):
    """모든 모델이 실패. 실시간 경로에서는 조용히 기권한다."""


@dataclass
class Breaker:
    fails: int = 0
    open_until: float = 0.0

    def ok(self) -> bool:
        return time.monotonic() >= self.open_until

    def record(self, success: bool, limit: int = 3, cool_s: float = 60.0) -> None:
        if success:
            self.fails = 0
            return
        self.fails += 1
        if self.fails >= limit:
            self.open_until = time.monotonic() + cool_s
            self.fails = 0


@dataclass
class Router:
    config: dict
    force_mock: bool = False
    providers: dict = field(default_factory=dict)
    buckets: dict = field(default_factory=dict)
    breakers: dict = field(default_factory=dict)
    cache: dict = field(default_factory=dict)
    traces: deque = field(default_factory=lambda: deque(maxlen=1000))
    chains: dict[str, list[str]] = field(init=False)

    CACHE_MAX = 2048   # ponytail: 전체 비우기, LRU 필요하면 교체

    def __post_init__(self) -> None:
        self.chains = chains(self.config)

    @classmethod
    def from_file(cls, path: Path, force_mock: bool = False) -> "Router":
        cfg = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        r = cls(config=cfg, force_mock=force_mock)
        for name, p in cfg["providers"].items():
            r.providers[name] = MockProvider() if name == "mock" else OpenAICompatProvider(name, p)
        return r

    def timeout(self, path: str) -> float:
        return self.config["paths"][path]["deadline_ms"] / 1000

    def _bucket(self, provider: str, model: str) -> TokenBucket:
        key = f"{provider}:{model}"
        if key not in self.buckets:
            self.buckets[key] = TokenBucket(self.config["providers"][provider].get("rpm", 30))
        return self.buckets[key]

    async def call(self, expert_id: str, system: str, user: str, payload: dict,
                   schema: type[T], deadline: float) -> tuple[T, str]:
        """deadline은 time.monotonic() 기준 절대 시각. 남은 시간 안에서만 시도한다."""
        key = hashlib.sha256(json.dumps([expert_id, user, payload], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if key in self.cache:
            cached, entry = self.cache[key]
            return cached.model_copy(deep=True), entry

        errors = []
        for entry in self.chains[expert_id]:
            provider_name, model = entry.split(":", 1)
            if self.force_mock and provider_name != "mock":
                continue
            provider = self.providers[provider_name]
            breaker = self.breakers.setdefault(entry, Breaker())
            if not provider.available or not breaker.ok():
                continue
            if not self._bucket(provider_name, model).try_acquire():
                errors.append(f"{entry}: 한도 대기")
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0.05:
                break
            if provider_name == "mock":
                s, u, p = system, user, payload
            else:
                s, u, p = pii.mask(system), pii.mask(user), _scrub(payload)
            t0 = time.monotonic()
            try:
                raw = await asyncio.wait_for(provider.complete(model, s, u, p, remaining), remaining)
                obj = schema.model_validate(extract_json(raw))
                obj = _tag_model(obj, entry)
                breaker.record(True)
                self._trace(expert_id, entry, t0, True)
                if len(self.cache) >= self.CACHE_MAX:
                    self.cache.clear()
                self.cache[key] = (obj.model_copy(deep=True), entry)
                return obj, entry
            except (ProviderError, asyncio.TimeoutError, ValueError, ValidationError) as e:
                breaker.record(False)
                self._trace(expert_id, entry, t0, False, type(e).__name__)
                errors.append(f"{entry}: {type(e).__name__}")
        raise NoResult(f"{expert_id} 실패 → " + "; ".join(errors))

    def _trace(self, expert_id: str, entry: str, t0: float, ok: bool, err: str = "") -> None:
        self.traces.append({"expert": expert_id, "model": entry, "ms": round((time.monotonic() - t0) * 1000),
                            "ok": ok, "error": err})


def _tag_model(obj: BaseModel, entry: str) -> BaseModel:
    if "model" in type(obj).model_fields:
        obj = obj.model_copy(update={"model": entry})
    return obj
