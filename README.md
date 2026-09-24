# 🐊 AlloGator

**Fair on-call rotas without the spreadsheet.** AlloGator collects everyone's availability,
generates an optimal on-call schedule, lets leaders review and adjust it, publishes it to
everyone's calendar, and handles swaps afterwards — all from a web UI.

![Rota board](docs/screenshots/rota-board.png)

## How it works

1. **Plan** — a team leader creates a rota: when it starts, how many periods to plan (e.g. the
   next 8 weeks) and how long each on-call period is (e.g. 7 days, handover Monday 09:00).
2. **Request dates** — one click emails everyone on the rota (plus an in-app notification)
   asking them to mark the days they can't cover, with an optional deadline and message.
3. **Everyone marks their availability** on an easy calendar: click or drag across days and
   choose *Can't cover* or *Partly available*, with an optional note visible to the team
   (e.g. "busy 13:00–17:00") so partial cover can be negotiated. Then *Confirm my dates*.
4. **Generate** — the solver finds the best schedule for the whole period (see below). The
   leader sees everyone's availability and the schedule on one board, with any problems flagged:
   days nobody can cover, periods that need partial cover, people scheduled on days they marked,
   back-to-back periods, and who hasn't submitted yet. Each issue lists who could help, with
   one-click fixes.
5. **Adjust** — click any cell to reassign a day, a whole period or a custom time range, or
   leave a day deliberately uncovered. Manual changes are *pinned*, so regenerating keeps them.
6. **Publish** — everyone is notified with a summary of their shifts and can download them as
   `.ics` calendar events, or subscribe to a personal calendar feed that stays up to date.
7. **Swap** — anyone can ask for someone to take all or part of a shift (whole days or exact
   times). Teammates are notified and offer one of their own slots in exchange, or just offer
   to cover. When the requester accepts an offer, the published rota and everyone's calendars
   update automatically.

| Your availability | What needs a decision |
| --- | --- |
| ![Availability](docs/screenshots/availability.png) | ![Issues](docs/screenshots/issues.png) |
| **Swaps** | **Your dashboard** |
| ![Swaps](docs/screenshots/swaps.png) | ![Dashboard](docs/screenshots/dashboard.png) |

## The scheduler

Rotas are solved as an optimisation problem with [OR-Tools CP-SAT](https://developers.google.com/optimization).
Each day slot (handover to handover, in the team's timezone, DST-aware) gets at most one person.
In priority order, the solver:

1. **Covers every day that anyone can cover.** Days nobody can do are left open and flagged
   for the leader, along with anyone partly available on them and their notes.
2. **Keeps each period with one person.** Partial cover (someone covering part of another
   person's period) is treated as exceptional: it's only used when nobody can do a whole
   period, and then with as few covered days and handovers as possible. It's always flagged.
3. **Avoids days people marked as partly available**, and flags any it does use.
4. **Shares the load fairly**, counting on-call already done in the team's recent rotas (the
   look-back window is configurable; newcomers aren't penalised for having no history).
5. **Avoids back-to-back periods** for the same person, including across rotas.
6. **Breaks ties randomly**, so *Regenerate* can offer a different, equally good arrangement.

Days marked *can't cover* are never assigned by the solver (only a leader can override that
manually). The search stops once the best schedule has stopped improving for a couple of seconds,
so generating typically takes 2–5 seconds.

## Quick start (local, no sign-in)

Requires Python 3.11+ and Node 20+.

```bash
make install          # backend venv + frontend packages
make build            # build the web UI (served by the backend)
make demo             # optional: a demo team with people, availability, a rota and a swap
cd backend && ALLOGATOR_AUTH_MODE=dev .venv/bin/allogator serve
```

Open <http://localhost:8000>. In dev mode there is no sign-in: the orange badge in the header
lets you act as any user, load demo data and read the emails that would have been sent.

For frontend development with hot reload, run `make dev` and open <http://localhost:5173>.

Or with Docker, in dev mode:

```bash
docker build -t allogator .
docker run -p 8000:8000 -e ALLOGATOR_AUTH_MODE=dev -v allogator-data:/data allogator
```

## Deploying

AlloGator doesn't manage passwords. It sits behind an authenticating reverse proxy
([oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/), Pomerium, Cloudflare Access,
an ingress with SSO, …) and trusts the identity header that proxy sets (by default
`X-Forwarded-Email`, plus `X-Forwarded-Preferred-Username` for the display name). People are
created automatically the first time they sign in. Leaders can add teammates by email before
they have ever signed in.

`docker-compose.yml` is a complete example: Postgres + AlloGator + oauth2-proxy with any OIDC
provider (Google, Okta, Entra ID, Keycloak, …):

```bash
cp .env.example .env    # fill in the OAUTH2_PROXY_* settings and ALLOGATOR_ADMIN_EMAILS
docker compose up -d    # then open http://localhost:4180
```

> ⚠️ In header mode AlloGator must only be reachable through the proxy; anyone who can reach
> it directly could claim to be anyone. The compose file doesn't publish the app's port. You
> can also set `ALLOGATOR_TRUSTED_PROXIES` to the proxy's address(es).

The per-person calendar feed (`/ical/<secret-token>.ics`) is authenticated by its unguessable
token because calendar apps can't sign in, so let `/ical/` through the proxy unauthenticated
(the compose file does this with `OAUTH2_PROXY_SKIP_AUTH_ROUTES`). People can reset their link
from their profile.

### Configuration

All settings are environment variables (or a `.env` file in the working directory):

| Variable | Default | |
| --- | --- | --- |
| `ALLOGATOR_DATABASE_URL` | `sqlite:///./allogator.db` | SQLAlchemy URL. For Postgres: `postgresql+psycopg://user:pass@host/db` |
| `ALLOGATOR_BASE_URL` | `http://localhost:8000` | Public URL, used in emails and calendar feed links |
| `ALLOGATOR_AUTH_MODE` | `header` | `header` (behind an auth proxy) or `dev` (no auth, user switcher) |
| `ALLOGATOR_AUTH_EMAIL_HEADER` | `X-Forwarded-Email` | Header carrying the signed-in user's email |
| `ALLOGATOR_AUTH_NAME_HEADER` | `X-Forwarded-Preferred-Username` | Header carrying their display name (optional) |
| `ALLOGATOR_TRUSTED_PROXIES` | *(any)* | Comma-separated IPs/CIDRs allowed to send identity headers |
| `ALLOGATOR_LOGOUT_URL` | *(none)* | Target of the "Sign out" menu item, e.g. `/oauth2/sign_out` |
| `ALLOGATOR_ADMIN_EMAILS` | *(none)* | Comma-separated emails that are always admins |
| `ALLOGATOR_OPEN_TEAM_CREATION` | `true` | Let anyone create a team (they become its leader); otherwise admins only |
| `ALLOGATOR_SMTP_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD` / `_FROM` | *(none)* / `587` | Outgoing email. Without a host, emails are logged (and visible in dev mode) |
| `ALLOGATOR_SMTP_STARTTLS` / `ALLOGATOR_SMTP_SSL` | `true` / `false` | SMTP transport security |
| `ALLOGATOR_SOLVER_TIME_LIMIT_SECONDS` | `20` | Hard cap on schedule generation |
| `ALLOGATOR_SOLVER_STALL_SECONDS` | `2` | Stop once the best schedule hasn't improved for this long |
| `ALLOGATOR_AUTO_MIGRATE` | `true` | Apply database migrations at startup (or run `allogator migrate`) |

Other commands: `allogator migrate`, `allogator seed-demo`, `allogator make-admin EMAIL`.

## Import and export

From a team's **Import / export** tab:

- **Export** every rota (historic, current and upcoming) as JSON (a full-fidelity backup),
  CSV (for spreadsheets) or `.ics`. Members can export published rotas; leaders get drafts too.
  Single rotas can be exported from the rota page.
- **Import** an AlloGator JSON export, or a CSV from anywhere with at least `start`, `end` and
  `user_email` columns (optionally `rota`, `user_name`, `note`, `period_days`, `handover_time`,
  `timezone`). Rows are grouped into rotas by the `rota` column, period length and handover time
  are inferred, and unknown people are added to the team. Every import shows a **preview**
  first; rotas overlapping existing ones can be skipped, replaced or kept alongside.

```csv
rota,start,end,user_email,user_name
Q1 2027,2027-01-04T09:00,2027-01-11T09:00,sam@example.com,Sam Patel
Q1 2027,2027-01-11T09:00,2027-01-18T09:00,priya@example.com,Priya Shah
```

## Roles

- **Members** mark their availability, see published rotas and everyone's availability notes,
  download calendar events, and request or offer swaps.
- **Leaders** (one or more per team) manage members and settings, plan rotas, request dates,
  generate, edit and publish schedules, and import data. Leaders can also mark someone as not
  taking part in on-call.
- **Admins** can see and manage every team and person.

## Project layout

```
backend/                 FastAPI + SQLAlchemy (Python)
  allogator/
    api/                 REST endpoints (teams, rotas, availability, swaps, me, admin…)
    services/
      solver.py          CP-SAT rota optimiser
      scheduling.py      builds solver input from the DB (availability, history, pins)
      analysis.py        issues/flags and fairness stats for a rota
      segments.py        interval maths for shifts (splits, merges, reassignments)
      slots.py           day slots and periods, timezone/DST aware
      transfer.py        JSON/CSV import and export
      ics.py, email.py, notify.py
    migrations/          Alembic migrations
  tests/
frontend/                React + TypeScript + Mantine (Vite)
  src/pages/             Dashboard, availability, team, rota, profile, admin
  src/components/        availability calendar, rota board, swaps, issues…
```

Development: `make test` runs the backend (pytest) and frontend (vitest) tests, and `make lint`
runs ruff and the TypeScript checker. The API is documented at `/docs` (OpenAPI).
