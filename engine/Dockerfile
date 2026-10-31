# 빌드 컨텍스트는 engine/ 이다:  docker build -t tone-engine engine
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
WORKDIR /srv/engine

# 의존성 먼저(캐시): uv.lock과 어긋나면 실패, dev 제외
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

# 소스만. .env·테스트는 .dockerignore가 막는다. 비밀값은 이미지에 없고 실행할 때 env로 받는다.
COPY . .
COPY deploy-entrypoint.sh /usr/local/bin/deploy-entrypoint.sh

RUN useradd --system --uid 10001 --no-create-home tone && chmod +x /usr/local/bin/deploy-entrypoint.sh
USER tone

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4).status==200 else 1)"

ENTRYPOINT ["deploy-entrypoint.sh"]
# 프로세스 1개 고정: 한도·큐·중복 제거·거울 키가 프로세스 메모리에 있다.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
