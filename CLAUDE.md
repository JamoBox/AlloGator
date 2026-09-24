# AlloGator

On-call rota planner: FastAPI backend (`backend/`) + React/Mantine frontend (`frontend/`).
See README.md for the product overview.

## Commands

- Backend setup: `cd backend && python3 -m venv .venv && .venv/bin/pip install -e ".[dev,postgres]"`
- Backend tests: `cd backend && .venv/bin/pytest`
- Backend lint: `cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check .`
- Frontend: `cd frontend && npm ci && npm run typecheck && npm test && npm run build`
- Run locally: `cd backend && ALLOGATOR_AUTH_MODE=dev .venv/bin/allogator serve` (serves `frontend/dist`)
- Demo data: `cd backend && ALLOGATOR_AUTH_MODE=dev .venv/bin/allogator seed-demo`
- New migration: `cd backend && .venv/bin/alembic revision --autogenerate -m "..."`

## Conventions

- DB datetimes are naive UTC; calendar `Date`s are local to the rota's timezone. API responses
  return aware datetimes in the rota/team timezone (`services/slots.py` does the conversions).
- A rota's shifts always tile its whole time range; uncovered time is a shift with
  `user_id = NULL`. Mutate shifts only via `services/segments.py` (`paint`/`reassign`) and
  `scheduling.write_segments`.
- Emails go through `services/notify.Notifier`; call `notifier.flush()` after `db.commit()`.
- Frontend data access goes through `src/api/hooks.ts` (React Query); mutations use `useAction`
  with explicit cache invalidation.
