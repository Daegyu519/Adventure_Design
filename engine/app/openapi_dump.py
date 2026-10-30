"""앱 타입 생성용 OpenAPI(`cd apps/mobile && npm run gen:engine:pull`). 엔진 OpenAPI가 원본이다.

    uv run python -m app.openapi_dump   # 표준 출력으로 정렬·들여쓰기한 JSON
"""
from __future__ import annotations

import json

from app.main import app


def main() -> None:
    print(json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False))


if __name__ == "__main__":
    main()
