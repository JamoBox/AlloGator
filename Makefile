# Common developer tasks. Requires Python 3.11+ and Node 20+.
PY ?= python3
VENV := backend/.venv
BIN := $(VENV)/bin

.PHONY: install dev backend frontend demo test lint format build docker clean

install:  ## Install backend (venv) and frontend dependencies
	$(PY) -m venv $(VENV)
	$(BIN)/pip install -e "backend[dev,postgres]"
	cd frontend && npm ci

backend:  ## Run the API with dev auth + auto-reload on :8000
	cd backend && ALLOGATOR_AUTH_MODE=dev ALLOGATOR_BASE_URL=http://localhost:5173 \
		.venv/bin/uvicorn allogator.main:app --reload --port 8000

frontend:  ## Run the Vite dev server on :5173 (proxies /api to :8000)
	cd frontend && npm run dev

dev:  ## Run backend and frontend together
	$(MAKE) -j2 backend frontend

demo:  ## Load demo data (a team with people, availability, a published rota and a swap)
	cd backend && ALLOGATOR_AUTH_MODE=dev .venv/bin/allogator seed-demo

test:  ## Run all tests
	cd backend && .venv/bin/pytest
	cd frontend && npm test

lint:  ## Lint + typecheck
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check .
	cd frontend && npm run typecheck

format:
	cd backend && .venv/bin/ruff check --fix . && .venv/bin/ruff format .

build:  ## Build the frontend (served by the backend from frontend/dist)
	cd frontend && npm run build

docker:  ## Build the container image
	docker build -t allogator:latest .

clean:
	rm -rf frontend/dist backend/*.db
