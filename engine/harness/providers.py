"""모델 공급자. NVIDIA, Gemini, GitHub Models, 로컬 vLLM/Ollama는 모두 OpenAI 호환 API라 하나로 처리한다.
키가 없거나 데모만 할 때는 MockProvider가 같은 형식의 JSON을 돌려준다."""
from __future__ import annotations

import json
import os
import re
import time

import httpx

from . import mock_rules


class ProviderError(Exception):
    """재시도 대신 다음 모델로 넘어가야 하는 오류."""


class RateLimited(ProviderError):
    pass


class TokenBucket:
    """분당 한도를 넘기 전에 미리 막는다. 기다리지 않고 바로 실패를 돌려준다(실시간 경로용)."""

    def __init__(self, rpm: int):
        self.capacity = float(rpm)
        self.tokens = float(rpm)
        self.rate = rpm / 60.0
        self.last = time.monotonic()

    def try_acquire(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


class OpenAICompatProvider:
    def __init__(self, name: str, base_url: str, api_key_env: str, allow_no_key: bool = False):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.api_key = os.getenv(api_key_env, "")
        self.allow_no_key = allow_no_key
        self._client = httpx.AsyncClient()

    @property
    def available(self) -> bool:
        if self.name == "local":
            return os.getenv("USE_LOCAL_MODEL") == "1"
        return bool(self.api_key) or self.allow_no_key

    async def complete(self, model: str, system: str, user: str, payload: dict, timeout_s: float) -> str:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        body = {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0.2,
            "max_tokens": 600,
        }
        try:
            r = await self._client.post(f"{self.base_url}/chat/completions", json=body,
                                        headers=headers, timeout=timeout_s)
        except httpx.TimeoutException as e:
            raise ProviderError(f"{self.name}:{model} 시간 초과") from e
        except httpx.HTTPError as e:
            raise ProviderError(f"{self.name}:{model} 연결 실패: {e}") from e
        if r.status_code == 429:
            raise RateLimited(f"{self.name}:{model} 한도 초과")
        if r.status_code >= 400:
            raise ProviderError(f"{self.name}:{model} HTTP {r.status_code}: {r.text[:200]}")
        msg = r.json()["choices"][0]["message"]
        return msg.get("content") or ""


class MockProvider:
    """API 없이 흐름을 시연하기 위한 가짜 모델. 판단은 mock_rules의 단순 규칙이다."""

    name = "mock"
    available = True

    async def complete(self, model: str, system: str, user: str, payload: dict, timeout_s: float) -> str:
        fn = getattr(mock_rules, model)
        return json.dumps(fn(payload), ensure_ascii=False)


def extract_json(text: str) -> dict:
    """모델이 앞뒤에 설명을 붙이거나 ```json 블록으로 감싸도 JSON만 꺼낸다."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)   # 추론 모델의 생각 부분 제거
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        raise ValueError("JSON 없음")
    return json.loads(m.group(0))
