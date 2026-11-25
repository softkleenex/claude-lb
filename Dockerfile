FROM python:3.12-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.8.3 /uv /usr/local/bin/uv
WORKDIR /src

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv

# Dependency layer: resolved from uv.lock, so the image runs exactly the versions CI
# tested, and stays cached until the lockfile changes.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project --extra postgres

COPY claude_lb ./claude_lb
RUN uv sync --locked --no-dev --no-editable --extra postgres


FROM python:3.12-slim

LABEL org.opencontainers.image.source="https://github.com/softkleenex/claude-lb" \
      org.opencontainers.image.description="Anthropic API key load balancer & proxy" \
      org.opencontainers.image.licenses="MIT"

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
