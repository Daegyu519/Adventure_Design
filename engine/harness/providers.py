"""모델 공급자. NVIDIA, Gemini, GitHub Models, 로컬 vLLM/Ollama는 모두 OpenAI 호환 API라 하나로 처리한다.
키가 없거나 데모만 할 때는 MockProvider가 같은 형식의 JSON을 돌려준다."""
from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Mapping

import httpx

from . import mock_rules


class ProviderError(Exception):
    """재시도 대신 다음 모델로 넘어가야 하는 오류. status는 HTTP 오류일 때만(로그엔 4xx·5xx 같은 분류만 남긴다)."""

    def __init__(self, msg: str = "", status: int | None = None) -> None:
        super().__init__(msg)
        self.status = status


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


def available(name: str, pcfg: dict, env: Mapping[str, str]) -> bool:
    """공급자를 쓸 수 있는지. 라우터·레지스트리·/health가 이 함수 하나를 같이 쓴다."""
    if name == "mock":
        return True
    if name == "local":
        return env.get("USE_LOCAL_MODEL") == "1"
    return bool(env.get(pcfg.get("api_key_env", ""))) or bool(pcfg.get("allow_no_key", False))  # 빈 값(.env의 `KEY=`)은 없는 것으로


class OpenAICompatProvider:
    def __init__(self, name: str, pcfg: dict):
        self.name = name
        self.pcfg = pcfg
        self.base_url = pcfg["base_url"].rstrip("/")
        self.api_key = os.getenv(pcfg.get("api_key_env", ""), "")
        self._client = httpx.AsyncClient()

    @property
    def available(self) -> bool:
        return available(self.name, self.pcfg, os.environ)

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
        except httpx.TimeoutException:
            raise ProviderError(f"{self.name}:{model} 시간 초과") from None
        except httpx.HTTPError as e:
            raise ProviderError(f"{self.name}:{model} 연결 실패 ({type(e).__name__})") from None
        # 오류 메시지에 요청·응답 본문을 넣지 않는다(가린 문장이라도 로그에 남기지 않음)
        if r.status_code == 429:
            raise RateLimited(f"{self.name}:{model} 한도 초과")
        if r.status_code >= 400:
            raise ProviderError(f"{self.name}:{model} HTTP {r.status_code}", r.status_code)
        try:
            content = r.json()["choices"][0]["message"].get("content") or ""
            if not isinstance(content, str):
                raise TypeError("content가 문자열이 아님")
            return content
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as e:
            raise ProviderError(f"{self.name}:{model} 응답 형식 오류 ({type(e).__name__})") from None


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
