from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import (
    get_current_user,
    get_or_create_user,
    get_team,
    is_leader,
    membership_of,
    require_leader,
    require_member,
)
from ..config import get_settings
from ..db import get_db
from ..models import (
    ROLE_LEADER,
    ROTA_PUBLISHED,
    AuditEvent,
    Membership,
    Rota,
    Shift,
    SpecialDay,
    Team,
    User,
    utcnow,
)
from ..schemas import (
    AuditOut,
    MemberAdd,
    MemberUpdate,
    SpecialDayCreate,
    SpecialDayOut,
    TeamCreate,
    TeamDetail,
    TeamOut,
    TeamSchedule,
    TeamUpdate,
)
from ..services import transfer
from ..services.ics import build_calendar
from ..services.notify import Notifier, audit
from ..services.scheduling import eligible_memberships
from ..services.slots import RotaGrid, get_zone, utc_to_local
from ..services.special_days import is_supported, public_holidays
from .rotas import default_next_start
from .serialize import schedule_shift, team_out, user_out

router = APIRouter(prefix="/api/teams", tags=["teams"])

MAX_IMPORT_BYTES = 5 * 1024 * 1024


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "team"


def _check_holidays(country: str, subdivision: str) -> None:
    if not is_supported(country, subdivision):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Unknown holiday country/region for public holidays"
        )


@router.get("", response_model=list[TeamOut])
def list_teams(
    all: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    if all and user.is_admin:
        teams = list(db.scalars(select(Team).order_by(Team.name)))
    else:
        teams = list(
            db.scalars(
                select(Team)
                .join(Membership)
                .where(Membership.user_id == user.id)
                .order_by(Team.name)
            )
        )
    return [team_out(db, t, user) for t in teams]


@router.post("", response_model=TeamDetail, status_code=201)
def create_team(
    body: TeamCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    if not (get_settings().open_team_creation or user.is_admin):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can create teams")
    data = body.model_dump(exclude_none=True)
    _check_holidays(data.get("holiday_country", ""), data.get("holiday_subdivision", ""))
    team = Team(**{**data, "name": body.name.strip()})
    db.add(team)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A team with that name exists") from exc
    db.add(Membership(team_id=team.id, user_id=user.id, role=ROLE_LEADER, on_call=True))
    audit(db, "team.created", f"Created team {team.name}", actor=user, team_id=team.id)
    db.commit()
    db.refresh(team)
    return team_out(db, team, user, detail=True)


@router.get("/{team_id}", response_model=TeamDetail)
def get_team_detail(
    team_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    team = get_team(db, team_id)
    require_member(db, team.id, user)
    return team_out(db, team, user, detail=True)


@router.patch("/{team_id}", response_model=TeamDetail)
def update_team(
    team_id: int,
    body: TeamUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    data = body.model_dump(exclude_unset=True, exclude_none=True)
    if "holiday_country" in data or "holiday_subdivision" in data:
        country = data.get("holiday_country", team.holiday_country)
        sub = data.get("holiday_subdivision", team.holiday_subdivision)
        if "holiday_country" in data and data["holiday_country"] != team.holiday_country:
            sub = data.get("holiday_subdivision", "")
            data["holiday_subdivision"] = sub
        _check_holidays(country, sub)
    for k, v in data.items():
        setattr(team, k, v.strip() if k == "name" else v)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A team with that name exists") from exc
    audit(
        db,
        "team.updated",
        "Updated team settings",
        actor=user,
        team_id=team.id,
        data={k: str(v) for k, v in data.items()},
    )
    db.commit()
    return team_out(db, team, user, detail=True)


@router.delete("/{team_id}", status_code=204)
def delete_team(
    team_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    db.delete(team)
    db.commit()
    return Response(status_code=204)


@router.get("/{team_id}/rota-defaults")
def rota_defaults(
    team_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    team = get_team(db, team_id)
    require_member(db, team.id, user)
    return {
        "start_date": default_next_start(team, date.today()),
        # One period per on-call person, so the rota goes round the team once.
        "num_periods": len(eligible_memberships(db, team.id)) or team.default_num_periods,
        "period_days": team.default_period_days,
        "handover_time": team.default_handover_time,
    }


# --- Special days ----------------------------------------------------------------------------


@router.get("/{team_id}/special-days", response_model=list[SpecialDayOut])
def list_special_days(
    team_id: int,
    start: date | None = Query(default=None, alias="from"),
    end: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Public holidays (from the team's country) and custom special days in [from, to]."""
    team = get_team(db, team_id)
    require_member(db, team.id, user)
    start = start or date.today() - timedelta(days=31)
    end = end or start + timedelta(days=400)
    stop = end + timedelta(days=1)
    out = [
        SpecialDayOut(id=None, date=d, label=label, source="public", team_id=team.id)
        for d, label in public_holidays(
            team.holiday_country, team.holiday_subdivision, start, stop
        ).items()
    ]
    for sd in db.scalars(
        select(SpecialDay).where(
            SpecialDay.team_id == team.id, SpecialDay.day >= start, SpecialDay.day < stop
        )
    ):
        out.append(
            SpecialDayOut(id=sd.id, date=sd.day, label=sd.label, source="custom", team_id=team.id)
        )
    return sorted(out, key=lambda x: (x.date, x.source))


@router.post("/{team_id}/special-days", response_model=SpecialDayOut, status_code=201)
def add_special_day(
    team_id: int,
    body: SpecialDayCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    sd = db.scalar(
        select(SpecialDay).where(SpecialDay.team_id == team.id, SpecialDay.day == body.date)
    )
    if sd is None:
        sd = SpecialDay(team_id=team.id, day=body.date, label=body.label.strip())
        db.add(sd)
    else:
        sd.label = body.label.strip()
    audit(
        db,
        "team.special_day",
        f"Marked {body.date:%d %b %Y} as “{sd.label}”",
        actor=user,
        team_id=team.id,
    )
    db.commit()
    return SpecialDayOut(id=sd.id, date=sd.day, label=sd.label, source="custom", team_id=team.id)


@router.delete("/{team_id}/special-days/{special_day_id}", status_code=204)
def delete_special_day(
    team_id: int,
    special_day_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    sd = db.get(SpecialDay, special_day_id)
    if sd is None or sd.team_id != team.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    db.delete(sd)
    db.commit()
    return Response(status_code=204)


# --- Members ---------------------------------------------------------------------------------


@router.post("/{team_id}/members", response_model=TeamDetail, status_code=201)
def add_member(
    team_id: int,
    body: MemberAdd,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    member = get_or_create_user(db, body.email, body.display_name)
    if body.display_name and not member.display_name:
        member.display_name = body.display_name.strip()
    if membership_of(db, team.id, member):
        raise HTTPException(status.HTTP_409_CONFLICT, f"{member.email} is already a member")
    db.add(Membership(team_id=team.id, user_id=member.id, role=body.role, on_call=body.on_call))
    notifier = Notifier(db, background)
    notifier.notify(
        [member],
        "team_added",
        f"You've been added to {team.name}",
        f"{user.name} added you to the {team.name} on-call team"
        + (" as a leader." if body.role == ROLE_LEADER else "."),
        link=f"/teams/{team.id}",
        exclude=[user.id],
    )
    audit(
        db, "team.member_added", f"Added {member.email} as {body.role}", actor=user, team_id=team.id
    )
    db.commit()
    notifier.flush()
    db.refresh(team)
    return team_out(db, team, user, detail=True)


@router.patch("/{team_id}/members/{user_id}", response_model=TeamDetail)
def update_member(
    team_id: int,
    user_id: int,
    body: MemberUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    m = db.scalar(
        select(Membership).where(Membership.team_id == team.id, Membership.user_id == user_id)
    )
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a member")
    if body.role is not None and body.role != ROLE_LEADER and m.role == ROLE_LEADER:
        leaders = [x for x in team.memberships if x.role == ROLE_LEADER]
        if len(leaders) <= 1 and not user.is_admin:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A team needs at least one leader")
    if body.role is not None:
        m.role = body.role
    if body.on_call is not None:
        m.on_call = body.on_call
    audit(
        db,
        "team.member_updated",
        f"Updated {m.user.email}",
        actor=user,
        team_id=team.id,
        data=body.model_dump(exclude_none=True),
    )
    db.commit()
    db.refresh(team)
    return team_out(db, team, user, detail=True)


@router.delete("/{team_id}/members/{user_id}", response_model=TeamDetail)
def remove_member(
    team_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    if user_id != user.id:
        require_leader(db, team.id, user)
    m = db.scalar(
        select(Membership).where(Membership.team_id == team.id, Membership.user_id == user_id)
    )
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a member")
    if m.role == ROLE_LEADER and sum(1 for x in team.memberships if x.role == ROLE_LEADER) <= 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A team needs at least one leader")
    email = m.user.email
    db.delete(m)
    audit(db, "team.member_removed", f"Removed {email}", actor=user, team_id=team.id)
    db.commit()
    db.refresh(team)
    return team_out(db, team, user, detail=True)


# --- Schedule ------------------------------------------------------------------------------


def _published_shifts(db: Session, team_id: int, start: datetime, end: datetime) -> list[Shift]:
    return list(
        db.scalars(
            select(Shift)
            .join(Rota)
            .where(
                Rota.team_id == team_id,
                Rota.status == ROTA_PUBLISHED,
                Shift.user_id.is_not(None),
                Shift.end_at > start,
                Shift.start_at < end,
            )
            .order_by(Shift.start_at)
        )
    )


@router.get("/{team_id}/schedule", response_model=TeamSchedule)
def team_schedule(
    team_id: int,
    start: date | None = Query(default=None, alias="from"),
    end: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_member(db, team.id, user)
    tz = get_zone(team.timezone)
    today = datetime.now(tz).date()
    start = start or today - timedelta(days=7)
    end = end or today + timedelta(days=120)
    a = RotaGrid(start, 1, 1, "00:00", tz).start
    b = RotaGrid(end, 1, 1, "00:00", tz).start
    shifts = _published_shifts(db, team.id, a, b)
    now = utcnow()
    current = next(
        (s for s in _published_shifts(db, team.id, now, now + timedelta(seconds=1))),
        None,
    )
    return TeamSchedule(
        team_id=team.id,
        timezone=team.timezone,
        on_call_now=schedule_shift(current) if current else None,
        shifts=[schedule_shift(s) for s in shifts],
    )


@router.get("/{team_id}/audit", response_model=list[AuditOut])
def team_audit(team_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    tz = get_zone(team.timezone)
    events = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.team_id == team.id)
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(300)
    )
    return [
        AuditOut(
            id=e.id,
            action=e.action,
            summary=e.summary,
            actor=user_out(e.actor),
            created_at=utc_to_local(e.created_at, tz),
            data=e.data,
        )
        for e in events
    ]


# --- Export / import -------------------------------------------------------------------------


@router.get("/{team_id}/export")
def export_team(
    team_id: int,
    format: Literal["json", "csv", "ics"] = "json",
    rota_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_member(db, team.id, user)
    leader = is_leader(db, team.id, user)
    rotas = None
    if rota_id is not None:
        rota = db.get(Rota, rota_id)
        if rota is None or rota.team_id != team.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Rota not found")
        if rota.status != ROTA_PUBLISHED and not leader:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "That rota isn't published yet")
        rotas = [rota]
    published_only = not leader
    stamp = f"{date.today():%Y%m%d}"
    base = f"allogator-{_slug(team.name)}" + (f"-rota{rota_id}" if rota_id else "") + f"-{stamp}"
    if format == "json":
        data = transfer.export_json(db, team, rotas, published_only=published_only)
        return Response(
            json.dumps(data, indent=2, default=str),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{base}.json"'},
        )
    if format == "csv":
        return Response(
            transfer.export_csv(team, rotas, published_only=published_only),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{base}.csv"'},
        )
    selected = rotas if rotas is not None else [r for r in team.rotas if r.status == ROTA_PUBLISHED]
    shifts = [s for r in selected for s in r.shifts if s.user_id is not None]
    return Response(
        build_calendar(shifts, name=f"{team.name} on-call", personal=False),
        media_type="text/calendar",
        headers={"Content-Disposition": f'attachment; filename="{base}.ics"'},
    )


@router.post("/{team_id}/import")
async def import_team(
    team_id: int,
    file: UploadFile = File(...),
    dry_run: bool = Form(True),
    on_conflict: Literal["skip", "replace", "keep_both"] = Form("skip"),
    as_draft: bool = Form(False),
    add_members: bool = Form(True),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    content = await file.read(MAX_IMPORT_BYTES + 1)
    if len(content) > MAX_IMPORT_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File too large (max 5MB)")
    try:
        parsed = transfer.parse_file(file.filename or "", content, team)
        report = transfer.import_schedule(
            db,
            team,
            parsed,
            actor=user,
            on_conflict=on_conflict,
            as_draft=as_draft,
            add_members=add_members,
        )
    except transfer.ImportError_ as exc:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    report["dry_run"] = dry_run
    if dry_run:
        db.rollback()
    else:
        audit(
            db,
            "team.imported",
            f"Imported {file.filename}: "
            + ", ".join(f"{v} {k}" for k, v in report.get("summary", {}).items()),
            actor=user,
            team_id=team.id,
        )
        db.commit()
    return report
