"""Optional binary signal. Never a ToneReading and never used by L3 automatically."""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .base import ExpertRequest


class ColdSignal(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    cold_score: float = Field(ge=0, le=1)
    model_id: str
    latency_ms: float = Field(ge=0)


class Backend(Protocol):
    def predict(self, row: dict) -> tuple[float, float]: ...


def load_backend(path: Path, device: str) -> Backend:
    # ML dependencies stay optional. For research runs include repository root in PYTHONPATH.
    from ml.model import Predictor
    return Predictor(path, device)


HEALTH_TTL_S = 5.0


class HttpBackend:
    """School-GPU classifier service (ml/classifier_shim.py, P-28). Sends the already masked row only (rule 16).
    Any failure (timeout, 4xx/5xx, bad JSON, bad score) raises; ClassifierExpert turns that into no signal."""

    def __init__(self, url: str, timeout_ms: float = 150, client: httpx.Client | None = None):
        self.url = url
        self.client = client or httpx.Client(timeout=timeout_ms / 1000)   # reused: keep-alive
        self._health: tuple[float, bool] = (-HEALTH_TTL_S, False)   # (monotonic time, result)

    def predict(self, row: dict) -> tuple[float, float]:
        body = {k: row[k] for k in ("context", "draft", "relation", "last_them")}
        r = self.client.post(self.url, json=body)
        r.raise_for_status()
        out = r.json()
        score, ms = float(out["score"]), float(out["latency_ms"])
        if not 0 <= score <= 1 or ms < 0:   # also rejects NaN
            raise ValueError("bad classifier response")
        return score, ms

    def healthy(self, timeout: float = 0.3) -> bool:
        """/health is public: cache the probe so a flood of requests cannot tie up the threadpool."""
        now = time.monotonic()
        if now - self._health[0] < HEALTH_TTL_S:
            return self._health[1]
        try:
            ok = self.client.get(self.url.rsplit("/", 1)[0] + "/health", timeout=timeout).status_code == 200
        except Exception:   # noqa: BLE001
            ok = False
        self._health = (now, ok)
        return ok

    def close(self) -> None:
        self.client.close()


@dataclass
class ClassifierExpert:
    id: str
    model_id: str
    backend: Backend
    paths: set[str] = field(default_factory=lambda: {"realtime"})
    exclusive: bool = True   # in-process native forward passes must not overlap; HTTP calls are independent
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)

    async def run(self, req: ExpertRequest, deadline: float) -> ColdSignal | None:
        """Already masked inputs only. Errors abstain without logging message text.

        A timeout does not stop a running native forward pass. Keep the lock until
        that pass finishes, and reject overlapping work instead of queueing it.
        """
        if (req.path not in self.paths or not req.draft.strip() or not req.last_them().strip()
                or time.monotonic() >= deadline or (self.exclusive and self._lock.locked())):
            return None
        row = {"relation": req.relation, "last_them": req.last_them(), "draft": req.draft,
               "context": [{"role": t.speaker, "text": t.text} for t in req.turns[-8:]]}
        # Acquire before scheduling; acquire() has no suspension while unlocked.
        if self.exclusive:
            await self._lock.acquire()

        async def work():
            try:
                score, latency = await asyncio.to_thread(self.backend.predict, row)
                return ColdSignal(cold_score=score, model_id=self.model_id, latency_ms=latency)
            except Exception:
                return None
            finally:
                if self.exclusive:
                    self._lock.release()

        task = asyncio.create_task(work())
        try:
            return await asyncio.wait_for(asyncio.shield(task), max(0, deadline - time.monotonic()))
        except TimeoutError:
            return None


def load_classifiers(entries: list[dict], root: Path, force_mock: bool = False,
                     factory: Callable = load_backend, env: Mapping[str, str] | None = None) -> list[ClassifierExpert]:
    result = []
    if force_mock:
        return result
    env = os.environ if env is None else env
    for entry in entries:
        if not entry.get("enabled", False):
            continue
        if entry.get("backend") == "http":   # local-model service: only when USE_LOCAL_MODEL=1 (like local providers)
            if env.get("USE_LOCAL_MODEL") == "1":
                result.append(ClassifierExpert(entry["id"], entry["model_id"],
                                               HttpBackend(entry["url"], float(entry.get("timeout_ms", 150))),
                                               set(entry.get("paths", ["realtime"])), exclusive=False))
            continue
        try:
            path = Path(entry["checkpoint"])
            path = path if path.is_absolute() else root / path
            if not path.is_dir():
                raise FileNotFoundError("classifier checkpoint missing")
            result.append(ClassifierExpert(entry["id"], entry["model_id"],
                                           factory(path, entry.get("device", "cpu")),
                                           set(entry.get("paths", ["realtime"]))))
        except Exception:
            if not entry.get("optional", True):
                raise RuntimeError("required classifier unavailable") from None
    return result


async def run_classifiers(classifiers: list[ClassifierExpert], req: ExpertRequest, deadline: float) -> float | None:
    """Max cold_score over classifiers that answered in time; None if none did (the aggregate then omits the term)."""
    signals = await asyncio.gather(*(c.run(req, deadline) for c in classifiers))
    scores = [s.cold_score for s in signals if s is not None]
    return max(scores) if scores else None
