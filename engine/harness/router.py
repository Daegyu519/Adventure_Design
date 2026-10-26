"""역할 이름으로 모델을 골라 부르는 하네스의 중심.
- 설정의 시도 순서대로 부르고, 키 없음·한도·시간 초과·JSON 깨짐이면 다음 모델로 넘어간다.
- 같은 모델이 연속으로 실패하면 잠시 건너뛴다(차단기).
- 같은 입력은 캐시에서 돌려준다.
- 호출마다 기록을 남기되 원문은 남기지 않는다."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeVar

import yaml
from pydantic import BaseModel, ValidationError

from .providers import MockProvider, OpenAICompatProvider, ProviderError, TokenBucket, extract_json

T = TypeVar("T", bound=BaseModel)
ROOT = Path(__file__).resolve().parent.parent


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
    traces: list = field(default_factory=list)

    @classmethod
    def from_file(cls, path: str | Path = ROOT / "config" / "models.yaml", force_mock: bool = False) -> "Router":
        cfg = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        r = cls(config=cfg, force_mock=force_mock)
        for name, p in cfg["providers"].items():
            if name == "mock":
                r.providers[name] = MockProvider()
            else:
                r.providers[name] = OpenAICompatProvider(name, p["base_url"], p["api_key_env"], p.get("allow_no_key", False))
        return r

    def timeout(self, path: str) -> float:
        return self.config["timeouts_ms"][path] / 1000

    def _bucket(self, provider: str, model: str) -> TokenBucket:
        key = f"{provider}:{model}"
        if key not in self.buckets:
            self.buckets[key] = TokenBucket(self.config["providers"][provider].get("rpm", 30))
        return self.buckets[key]

    async def call(self, role: str, system: str, user: str, payload: dict,
                   schema: type[T], deadline: float) -> tuple[T, str]:
        """deadline은 time.monotonic() 기준 절대 시각. 남은 시간 안에서만 시도한다."""
        key = hashlib.sha256(json.dumps([role, user, payload], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if key in self.cache:
            return self.cache[key]

        errors = []
        for entry in self.config["roles"][role]:
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
            t0 = time.monotonic()
            try:
                raw = await asyncio.wait_for(provider.complete(model, system, user, payload, remaining), remaining)
                obj = schema.model_validate(extract_json(raw))
                obj = _tag_model(obj, entry)
                breaker.record(True)
                self._trace(role, entry, t0, True)
                self.cache[key] = (obj, entry)
                return obj, entry
            except (ProviderError, asyncio.TimeoutError, ValueError, ValidationError) as e:
                breaker.record(False)
                self._trace(role, entry, t0, False, type(e).__name__)
                errors.append(f"{entry}: {type(e).__name__}")
        raise NoResult(f"{role} 실패 → " + "; ".join(errors))

    def _trace(self, role: str, entry: str, t0: float, ok: bool, err: str = "") -> None:
        self.traces.append({"role": role, "model": entry, "ms": round((time.monotonic() - t0) * 1000),
                            "ok": ok, "error": err})


def _tag_model(obj: BaseModel, entry: str) -> BaseModel:
    if "model" in type(obj).model_fields:
        obj = obj.model_copy(update={"model": entry})
    return obj
