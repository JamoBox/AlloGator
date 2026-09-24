# syntax=docker/dockerfile:1

# ---- Frontend build -----------------------------------------------------------------------
FROM node:22-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- Runtime ------------------------------------------------------------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ALLOGATOR_STATIC_DIR=/app/static \
    ALLOGATOR_DATABASE_URL=sqlite:////data/allogator.db

WORKDIR /app
COPY backend/pyproject.toml backend/README.md ./backend/
COPY backend/allogator ./backend/allogator
RUN pip install "./backend[postgres]" && rm -rf ./backend

COPY --from=frontend /src/frontend/dist /app/static

RUN useradd --system --uid 10001 --home /app allogator \
    && mkdir -p /data && chown allogator /data
USER allogator
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')" || exit 1

# Migrations run automatically at startup (ALLOGATOR_AUTO_MIGRATE=true).
CMD ["allogator", "serve", "--host", "0.0.0.0", "--port", "8000"]
