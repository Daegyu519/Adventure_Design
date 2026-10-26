import os
from collections.abc import Mapping

import yaml
from fastapi import FastAPI

from app.settings import Settings

app = FastAPI(title="tone-chat engine")


def model_status(cfg: dict, env: Mapping[str, str]) -> dict[str, str]:
    """roles의 모든 `provider:model`에 대해 쓸 수 있으면 "up", 아니면 "down"."""
    providers = cfg.get("providers", {})
    status: dict[str, str] = {}
    for models in cfg.get("roles", {}).values():
        for ref in models:
            name = ref.split(":", 1)[0]
            p = providers.get(name) or {}
            usable = name == "mock" or p.get("allow_no_key", False) or bool(env.get(p.get("api_key_env", "")))  # 빈 값(.env의 `KEY=`)은 없는 것으로
            status[ref] = "up" if usable else "down"
    return status


@app.get("/health")
def health() -> dict:
    cfg = yaml.safe_load(Settings.from_env().models_path.read_text(encoding="utf-8")) or {}
    return {"ok": True, "models": model_status(cfg, os.environ)}
