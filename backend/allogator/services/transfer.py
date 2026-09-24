"""Schedule export and import (JSON for full fidelity, CSV for spreadsheets)."""

from __future__ import annotations

import csv
import io
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    ROLE_LEADER,
    ROLE_MEMBER,
    ROTA_PUBLISHED,
    ROTA_REVIEW,
    ROTA_STATUSES,
    Membership,
    Rota,
    Team,
    User,
    utcnow,
)
from . import segments as seg
from .scheduling import write_segments
from .slots import RotaGrid, get_zone, to_naive_utc, utc_to_local

FORMAT_NAME = "allogator-schedule"
FORMAT_VERSION = 1
CSV_COLUMNS = [
    "rota",
    "rota_start_date",
    "period_days",
    "handover_time",
    "timezone",
    "period",
    "start",
    "end",
    "user_email",
    "user_name",
    "note",
]


class ImportError_(ValueError):
    """Raised for malformed import files; message is shown to the user."""


# --------------------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------------------


def _csv_safe(value: str) -> str:
    """Stop free text being interpreted as a formula when the CSV is opened in a spreadsheet."""
    if value and value[0] in "=+-@\t\r":
        return "'" + value
    return value


def _rotas_for_export(team: Team, rotas: list[Rota] | None, published_only: bool) -> list[Rota]:
    rotas = rotas if rotas is not None else sorted(team.rotas, key=lambda r: r.start_date)
    if published_only:
        rotas = [r for r in rotas if r.status == ROTA_PUBLISHED]
    return rotas


def export_json(
    db: Session, team: Team, rotas: list[Rota] | None = None, *, published_only: bool = False
) -> dict[str, Any]:
    rotas = _rotas_for_export(team, rotas, published_only)
    people = []
    for m in sorted(team.memberships, key=lambda m: m.user.email):
        people.append(
            {
                "email": m.user.email,
                "name": m.user.display_name,
                "role": m.role,
                "on_call": m.on_call,
            }
        )
    out_rotas = []
    for r in rotas:
        tz = get_zone(r.timezone)
        out_rotas.append(
            {
                "name": r.name,
                "start_date": r.start_date.isoformat(),
                "num_periods": r.num_periods,
                "period_days": r.period_days,
                "handover_time": r.handover_time,
                "timezone": r.timezone,
                "status": r.status,
                "shifts": [
                    {
                        "start": utc_to_local(s.start_at, tz).isoformat(),
                        "end": utc_to_local(s.end_at, tz).isoformat(),
                        "user_email": s.user.email if s.user else None,
                        "user_name": s.user.display_name if s.user else None,
                        "note": s.note,
                        "locked": s.locked,
                    }
                    for s in r.shifts
                ],
            }
        )
    return {
        "format": FORMAT_NAME,
        "version": FORMAT_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "team": {"name": team.name, "timezone": team.timezone, "description": team.description},
        "people": people,
        "rotas": out_rotas,
    }


def export_csv(team: Team, rotas: list[Rota] | None = None, *, published_only: bool = False) -> str:
    rotas = _rotas_for_export(team, rotas, published_only)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_COLUMNS)
    w.writeheader()
    for r in rotas:
        tz = get_zone(r.timezone)
        for s in r.shifts:
            if s.user is None:
                continue
            w.writerow(
                {
                    "rota": _csv_safe(r.display_name),
                    "rota_start_date": r.start_date.isoformat(),
                    "period_days": r.period_days,
                    "handover_time": r.handover_time,
                    "timezone": r.timezone,
                    "period": s.period_index + 1,
                    "start": utc_to_local(s.start_at, tz).isoformat(),
                    "end": utc_to_local(s.end_at, tz).isoformat(),
                    "user_email": s.user.email,
                    "user_name": _csv_safe(s.user.display_name),
                    "note": _csv_safe(s.note),
                }
            )
    return buf.getvalue()


# --------------------------------------------------------------------------------------
# Import
# --------------------------------------------------------------------------------------


@dataclass
class _Row:
    start: datetime  # naive UTC
    end: datetime
    email: str | None
    name: str = ""
    note: str = ""
    locked: bool = False


@dataclass
class _ParsedRota:
    name: str
    timezone: str
    start_date: date | None = None
    num_periods: int | None = None
    period_days: int | None = None
    handover_time: str | None = None
    status: str | None = None
    rows: list[_Row] = field(default_factory=list)


@dataclass
class _ParsedFile:
    rotas: list[_ParsedRota]
    people: list[dict[str, Any]] = field(default_factory=list)


def _parse_dt(value: str, tz_name: str, where: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (ValueError, AttributeError) as exc:
        raise ImportError_(f"{where}: invalid datetime {value!r}") from exc
    return to_naive_utc(dt, get_zone(tz_name))


def _parse_json(data: dict[str, Any], team: Team) -> _ParsedFile:
    if data.get("format") != FORMAT_NAME:
        raise ImportError_(f"Not an AlloGator export (expected format {FORMAT_NAME!r})")
    if int(data.get("version", 0)) > FORMAT_VERSION:
        raise ImportError_("This export was made by a newer AlloGator version")
    rotas = []
    for i, r in enumerate(data.get("rotas") or []):
        where = f"rota #{i + 1}"
        tz = r.get("timezone") or team.timezone
        try:
            get_zone(tz)
        except ValueError as exc:
            raise ImportError_(f"{where}: {exc}") from exc
        pr = _ParsedRota(
            name=r.get("name") or "",
            timezone=tz,
            start_date=date.fromisoformat(r["start_date"]) if r.get("start_date") else None,
            num_periods=r.get("num_periods"),
            period_days=r.get("period_days"),
            handover_time=r.get("handover_time"),
            status=r.get("status"),
        )
        for j, s in enumerate(r.get("shifts") or []):
            w = f"{where} shift #{j + 1}"
            if "start" not in s or "end" not in s:
                raise ImportError_(f"{w}: start and end are required")
            pr.rows.append(
                _Row(
                    start=_parse_dt(s["start"], tz, w),
                    end=_parse_dt(s["end"], tz, w),
                    email=(s.get("user_email") or None),
                    name=s.get("user_name") or "",
                    note=s.get("note") or "",
                    locked=bool(s.get("locked", False)),
                )
            )
        rotas.append(pr)
    return _ParsedFile(rotas=rotas, people=list(data.get("people") or []))


def _parse_csv(text: str, team: Team) -> _ParsedFile:
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ImportError_("CSV file is empty")
    fields = {f.strip().lower() for f in reader.fieldnames}
    missing = {"start", "end", "user_email"} - fields
    if missing:
        raise ImportError_(f"CSV is missing required column(s): {', '.join(sorted(missing))}")
    groups: dict[str, _ParsedRota] = {}
    for n, raw in enumerate(reader, start=2):
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
        if not any(row.values()):
            continue
        where = f"CSV line {n}"
        name = row.get("rota") or "Imported schedule"
        tz = row.get("timezone") or team.timezone
        try:
            get_zone(tz)
        except ValueError as exc:
            raise ImportError_(f"{where}: {exc}") from exc
        pr = groups.get(name)
        if pr is None:
            pr = groups[name] = _ParsedRota(name=name, timezone=tz)
            if row.get("rota_start_date"):
                try:
                    pr.start_date = date.fromisoformat(row["rota_start_date"])
                except ValueError as exc:
                    raise ImportError_(f"{where}: invalid rota_start_date") from exc
            if row.get("period_days"):
                try:
                    pr.period_days = int(row["period_days"])
                except ValueError as exc:
                    raise ImportError_(f"{where}: invalid period_days") from exc
            if row.get("handover_time"):
                pr.handover_time = row["handover_time"]
        email = row.get("user_email") or None
        pr.rows.append(
            _Row(
                start=_parse_dt(row["start"], tz, where),
                end=_parse_dt(row["end"], tz, where),
                email=email,
                name=row.get("user_name", ""),
                note=row.get("note", ""),
            )
        )
    return _ParsedFile(rotas=list(groups.values()))


def parse_file(filename: str, content: bytes, team: Team) -> _ParsedFile:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ImportError_("File must be UTF-8 encoded") from exc
    stripped = text.lstrip()
    if filename.lower().endswith(".json") or stripped.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ImportError_(f"Invalid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise ImportError_("Invalid JSON: expected an object")
        return _parse_json(data, team)
    return _parse_csv(text, team)


def _infer_grid_params(pr: _ParsedRota, team: Team) -> tuple[date, int, int, str]:
    if not pr.rows:
        raise ImportError_(f"Rota {pr.name!r} has no shifts")
    for r in pr.rows:
        if r.end <= r.start:
            raise ImportError_(f"Rota {pr.name!r}: a shift ends before it starts ({r.start})")
    tz = get_zone(pr.timezone)
    first = min(r.start for r in pr.rows)
    last = max(r.end for r in pr.rows)
    first_local = utc_to_local(first, tz)
    handover = pr.handover_time or f"{first_local:%H:%M}"
    start_date = pr.start_date or first_local.date()
    period_days = pr.period_days
    if not period_days:
        lengths = Counter(
            max(1, round((r.end - r.start).total_seconds() / 86400)) for r in pr.rows if r.email
        )
        period_days = lengths.most_common(1)[0][0] if lengths else team.default_period_days
    period_days = max(1, min(int(period_days), 366))
    num_periods = pr.num_periods
    if not num_periods:
        base = RotaGrid(start_date, 1, 1, handover, tz).start
        span_days = (last - base).total_seconds() / 86400
        num_periods = max(1, math.ceil(span_days / period_days - 1e-9))
    return start_date, int(num_periods), period_days, handover


def import_schedule(
    db: Session,
    team: Team,
    parsed: _ParsedFile,
    *,
    actor: User,
    on_conflict: str = "skip",
    as_draft: bool = False,
    add_members: bool = True,
) -> dict[str, Any]:
    """Apply a parsed import. The caller commits (or rolls back for a dry run)."""
    if on_conflict not in ("skip", "replace", "keep_both"):
        raise ImportError_("on_conflict must be skip, replace or keep_both")

    report: dict[str, Any] = {"rotas": [], "new_users": [], "new_members": [], "warnings": []}
    users_by_email = {u.email: u for u in db.scalars(select(User))}
    members = {m.user_id: m for m in team.memberships}
    people_meta = {p.get("email", "").lower(): p for p in parsed.people if p.get("email")}

    def resolve(email: str | None, name: str) -> int | None:
        if not email:
            return None
        email = email.strip().lower()
        user = users_by_email.get(email)
        if user is None:
            user = User(email=email, display_name=name or "")
            db.add(user)
            db.flush()
            users_by_email[email] = user
            report["new_users"].append(email)
        if user.id not in members and add_members:
            meta = people_meta.get(email, {})
            m = Membership(
                team_id=team.id,
                user_id=user.id,
                role=ROLE_LEADER if meta.get("role") == ROLE_LEADER else ROLE_MEMBER,
                on_call=bool(meta.get("on_call", True)),
            )
            db.add(m)
            db.flush()
            members[user.id] = m
            report["new_members"].append(email)
        return user.id

    existing = list(team.rotas)
    for pr in parsed.rotas:
        start_date, num_periods, period_days, handover = _infer_grid_params(pr, team)
        try:
            grid = RotaGrid(start_date, num_periods, period_days, handover, pr.timezone)
        except ValueError as exc:
            raise ImportError_(f"Rota {pr.name!r}: {exc}") from exc
        end_date = grid.end_date
        overlapping = [r for r in existing if r.start_date < end_date and start_date < r.end_date]
        entry: dict[str, Any] = {
            "name": pr.name or f"{start_date:%d %b %Y}",
            "start_date": start_date,
            "end_date": end_date - timedelta(days=1),
            "num_periods": num_periods,
            "period_days": period_days,
            "handover_time": handover,
            "timezone": pr.timezone,
            "shifts": sum(1 for r in pr.rows if r.email),
            "overlaps": [{"id": r.id, "name": r.display_name} for r in overlapping],
            "action": "create",
        }
        report["rotas"].append(entry)
        outside = [r for r in pr.rows if r.start < grid.start or r.end > grid.end]
        if outside:
            report["warnings"].append(
                f"{entry['name']}: {len(outside)} shift(s) extend beyond the rota and were clipped"
            )
        if overlapping:
            if on_conflict == "skip":
                entry["action"] = "skip"
                continue
            if on_conflict == "replace":
                entry["action"] = "replace"
                for r in overlapping:
                    db.delete(r)
                    existing.remove(r)
                db.flush()

        status = pr.status if pr.status in ROTA_STATUSES else ROTA_PUBLISHED
        if as_draft:
            status = ROTA_REVIEW
        rota = Rota(
            team_id=team.id,
            name=pr.name,
            start_date=start_date,
            num_periods=num_periods,
            period_days=period_days,
            handover_time=handover,
            timezone=pr.timezone,
            status=status,
            imported=True,
            created_by_id=actor.id,
            published_at=utcnow() if status == ROTA_PUBLISHED else None,
            generated_at=utcnow(),
        )
        db.add(rota)
        db.flush()
        rows = sorted(pr.rows, key=lambda r: r.start)
        segments = [
            seg.Segment(
                r.start,
                r.end,
                resolve(r.email, r.name),
                locked=r.locked,
                source="imported",
                note=r.note,
            )
            for r in rows
        ]
        write_segments(db, rota, seg.paint([], grid, segments))
        entry["rota_id"] = rota.id
        existing.append(rota)

    counts = defaultdict(int)
    for e in report["rotas"]:
        counts[e["action"]] += 1
    report["summary"] = dict(counts)
    return report
