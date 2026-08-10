FROM python:3.12-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /src

# Dependency layer: cached until pyproject.toml changes.
COPY pyproject.toml README.md ./
RUN uv venv /opt/venv && \
    VIRTUAL_ENV=/opt/venv uv pip install --no-cache "fastapi>=0.115" "uvicorn[standard]>=0.32" \
      "httpx>=0.27" "sqlalchemy[asyncio]>=2.0.36" "aiosqlite>=0.20" "pydantic>=2.9" \
      "pydantic-settings>=2.6" "cryptography>=43" "typer>=0.15" "rich>=13"

COPY app ./app
RUN VIRTUAL_ENV=/opt/venv uv pip install --no-cache --no-deps .


FROM python:3.12-slim

RUN useradd --system --create-home --uid 10001 claudelb && \
    mkdir -p /var/lib/claude-lb && chown claudelb:claudelb /var/lib/claude-lb

COPY --from=builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CLAUDE_LB_IN_DOCKER=1 \
    CLAUDE_LB_HOST=0.0.0.0 \
    CLAUDE_LB_PORT=2456

USER claudelb
WORKDIR /var/lib/claude-lb
VOLUME ["/var/lib/claude-lb"]
EXPOSE 2456

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:2456/health', timeout=4).status==200 else 1)"

ENTRYPOINT ["claude-lb"]
CMD ["serve"]
