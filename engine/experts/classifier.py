"""Optional binary signal. Never a ToneReading and never used by L3 automatically."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

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


@dataclass
class ClassifierExpert:
    id: str
    model_id: str
    backend: Backend
    paths: set[str] = field(default_factory=lambda: {"realtime"})
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)

    async def run(self, req: ExpertRequest, deadline: float) -> ColdSignal | None:
        """Already masked inputs only. Errors abstain without logging message text.

        A timeout does not stop a running native forward pass. Keep the lock until
        that pass finishes, and reject overlapping work instead of queueing it.
        """
        if (req.path not in self.paths or not req.draft.strip() or not req.last_them().strip()
                or time.monotonic() >= deadline or self._lock.locked()):
            return None
        row = {"relation": req.relation, "last_them": req.last_them(), "draft": req.draft,
               "context": [{"role": t.speaker, "text": t.text} for t in req.turns[-8:]]}
        # Acquire before scheduling; acquire() has no suspension while unlocked.
        await self._lock.acquire()

        async def work():
            try:
                score, latency = await asyncio.to_thread(self.backend.predict, row)
                return ColdSignal(cold_score=score, model_id=self.model_id, latency_ms=latency)
            except Exception:
                return None
            finally:
                self._lock.release()

        task = asyncio.create_task(work())
        try:
            return await asyncio.wait_for(asyncio.shield(task), max(0, deadline - time.monotonic()))
        except TimeoutError:
            return None


def load_classifiers(entries: list[dict], root: Path, force_mock: bool = False,
                     factory: Callable = load_backend) -> list[ClassifierExpert]:
    result = []
    if force_mock:
        return result
    for entry in entries:
        if not entry.get("enabled", False):
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
