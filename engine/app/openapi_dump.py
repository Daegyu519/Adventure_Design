"""앱 타입 생성용 OpenAPI(`cd apps/mobile && npm run gen:engine:pull`). 엔진 OpenAPI가 원본이다.

앱은 엔진에 아직 없는 /v1 경로의 타입(ARCHITECTURE 4장 seed, T-04b)도 이미 쓴다. 그래서 기존 파일의 경로 중 엔진이 내지
않는 것과, 그 경로가 쓰는 스키마만 옮겨 둔다. 엔진이 같은 경로·스키마를 내면 엔진 것이 이긴다.
# ponytail: 4장 경로가 엔진에 다 생기면 옮기기를 지우고 app.openapi()만 덤프한다.

    uv run python -m app.openapi_dump <기존 engine.openapi.json>   # 표준 출력으로 정렬·들여쓰기한 JSON
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any

from app.main import app

PREFIX = "#/components/schemas/"


def _refs(x: Any) -> set[str]:
    if isinstance(x, dict):
        own = {x["$ref"].removeprefix(PREFIX)} if isinstance(x.get("$ref"), str) else set()
        return own.union(*(_refs(v) for v in x.values()))
    if isinstance(x, list):
        return set().union(*(_refs(v) for v in x))
    return set()


def merged(engine: dict, old: dict) -> dict:
    out = copy.deepcopy(engine)
    paths = out.setdefault("paths", {})
    schemas = out.setdefault("components", {}).setdefault("schemas", {})
    old_components = old.get("components", {})
    old_schemas = old_components.get("schemas", {})
    todo: set[str] = set()
    for path, ops in old.get("paths", {}).items():
        if path not in paths:
            paths[path] = copy.deepcopy(ops)
            todo |= _refs(ops)
            for name in {k for op in ops.values() if isinstance(op, dict) for req in op.get("security", []) for k in req}:
                if name in old_components.get("securitySchemes", {}):
                    out["components"].setdefault("securitySchemes", {}).setdefault(
                        name, copy.deepcopy(old_components["securitySchemes"][name]))
    while todo:   # 옮긴 경로가 (간접으로) 쓰는 스키마만. 엔진에 같은 이름이 있으면 엔진 것
        name = todo.pop()
        if name not in schemas and name in old_schemas:
            schemas[name] = copy.deepcopy(old_schemas[name])
            todo |= _refs(old_schemas[name])
    return out


def main() -> None:
    old_file = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    old = json.loads(old_file.read_text(encoding="utf-8")) if old_file and old_file.exists() else {}
    print(json.dumps(merged(app.openapi(), old), indent=2, sort_keys=True, ensure_ascii=False))


if __name__ == "__main__":
    main()
