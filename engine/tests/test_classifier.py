import asyncio
import math
import time
from pathlib import Path

import pytest
from pydantic import ValidationError

from experts.base import ExpertRequest
from experts.classifier import ClassifierExpert, ColdSignal, load_classifiers
from experts.registry import Registry
from harness.schemas import Turn


def request():
    return ExpertRequest(path="realtime", relation="", draft="draft", turns=[Turn(speaker="them", text="last")])


class Fake:
    def predict(self, row):
        assert row["last_them"] == "last"
        return .8, 1.0


def test_binary_contract_and_masked_request():
    expert = ClassifierExpert("cold", "fixture", Fake())
    result = asyncio.run(expert.run(request(), time.monotonic() + 1))
    assert result.model_dump() == {"cold_score": .8, "model_id": "fixture", "latency_ms": 1.0}
    assert not hasattr(result, "readings") and not hasattr(result, "confidence")
    for score in [math.nan, math.inf, -1, 1.1]:
        with pytest.raises(ValidationError):
            ColdSignal(cold_score=score, model_id="fixture", latency_ms=1)


def test_optional_missing_corrupt_and_mock(tmp_path):
    item = {"id": "cold", "model_id": "fixture", "enabled": True, "checkpoint": "missing"}
    assert load_classifiers([item], tmp_path) == []
    item["checkpoint"] = str(tmp_path)
    assert load_classifiers([item], tmp_path, factory=lambda *_: Fake())
    assert load_classifiers([item], tmp_path, force_mock=True) == []
    def broken(*_):
        raise RuntimeError("private message must not be logged")
    assert load_classifiers([item], tmp_path, factory=broken) == []
    assert load_classifiers([{**item, "checkpoint": None}], tmp_path) == []
    assert load_classifiers([{k: v for k, v in item.items() if k != "checkpoint"}], tmp_path) == []


def test_failures_empty_deadline_and_overlapping_timeout():
    class Slow:
        calls = 0
        def predict(self, row):
            self.calls += 1
            time.sleep(.1)
            raise ValueError("private")
    async def check():
        backend = Slow()
        expert = ClassifierExpert("cold", "fixture", backend)
        assert await expert.run(request(), time.monotonic() - 1) is None
        assert await expert.run(request().model_copy(update={"draft": " "}), time.monotonic()+1) is None
        assert await expert.run(request(), time.monotonic()+.02) is None
        assert await expert.run(request(), time.monotonic()+1) is None
        await asyncio.sleep(.15)
        assert backend.calls == 1
    asyncio.run(check())


def test_default_gemma_registry_unchanged():
    reg = Registry.load(Path(__file__).parents[1] / "config/models.yaml", force_mock=True)
    assert reg.classifiers == []
    assert [e.id for e in reg.for_path("realtime", "tone")] == ["tone_label"]


def test_simultaneous_requests_do_not_queue_native_work():
    class Slow(Fake):
        calls = 0
        def predict(self, row):
            self.calls += 1
            time.sleep(.05)
            return .4, 50
    async def check():
        backend = Slow()
        expert = ClassifierExpert("cold", "fixture", backend)
        deadline = time.monotonic() + .01
        assert await asyncio.gather(*(expert.run(request(), deadline) for _ in range(8))) == [None] * 8
        await asyncio.sleep(.08)
        assert backend.calls == 1
    asyncio.run(check())
