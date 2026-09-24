from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..config import get_settings
from ..db import get_db
from ..models import (
    OFFER_PENDING,
    ROTA_COLLECTING,
    ROTA_PUBLISHED,
    SWAP_OPEN,
    AvailabilitySubmission,
    Membership,
    Rota,
    Shift,
    SwapRequest,
    Team,
    Unavailability,
    User,
    new_calendar_token,
    utcnow,
)
from ..schemas import (
    MembershipBrief,
    MeOut,
    MeUpdate,
    ScheduleShift,
    SpecialDayOut,
    UnavailabilityBulk,
    UnavailabilityOut,
)
from ..services.ics import build_calendar
from ..services.special_days import team_special_days
from .serialize import rota_out, schedule_shift, swap_out

router = APIRouter(prefix="/api/me", tags=["me"])


def feed_url(user: User) -> str:
    return f"{get_settings().base_url}/ical/{user.calendar_token}.ics"


def me_out(db: Session, user: User) -> MeOut:
    rows = db.execute(
        select(Membership, Team).join(Team).where(Membership.user_id == user.id).order_by(Team.name)
    )
    s = get_settings()
    return MeOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        name=user.name,
        is_admin=user.is_admin,
        email_notifications=user.email_notifications,
        calendar_feed_url=feed_url(user),
        memberships=[
            MembershipBrief(team_id=t.id, team_name=t.name, role=m.role, on_call=m.on_call)
            for m, t in rows
        ],
        can_create_teams=s.open_team_creation or user.is_admin,
    )


@router.get("", response_model=MeOut)
def get_me(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return me_out(db, user)


@router.patch("", response_model=MeOut)
def update_me(
    body: MeUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    if body.display_name is not None:
        user.display_name = body.display_name.strip()
    if body.email_notifications is not None:
        user.email_notifications = body.email_notifications
    db.commit()
    return me_out(db, user)


@router.post("/calendar-token", response_model=MeOut)
def rotate_calendar_token(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user.calendar_token = new_calendar_token()
    db.commit()
    return me_out(db, user)


def my_published_shifts(
    db: Session, user: User, since: datetime | None, team_id: int | None, rota_id: int | None
) -> list[Shift]:
    q = (
        select(Shift)
        .join(Rota)
        .where(Shift.user_id == user.id, Rota.status == ROTA_PUBLISHED)
        .order_by(Shift.start_at)
    )
    if since is not None:
        q = q.where(Shift.end_at > since)
    if team_id is not None:
        q = q.where(Rota.team_id == team_id)
    if rota_id is not None:
        q = q.where(Rota.id == rota_id)
    return list(db.scalars(q))


@router.get("/shifts", response_model=list[ScheduleShift])
def my_shifts(
    include_past: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    since = None if include_past else utcnow()
    return [schedule_shift(s) for s in my_published_shifts(db, user, since, None, None)]


@router.get("/calendar.ics")
def my_calendar(
    team_id: int | None = None,
    rota_id: int | None = None,
    include_past: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    since = None if include_past else utcnow() - timedelta(days=1)
    shifts = my_published_shifts(db, user, since, team_id, rota_id)
    return Response(
        build_calendar(shifts, name=f"On-call: {user.name}", personal=True),
        media_type="text/calendar",
        headers={"Content-Disposition": 'attachment; filename="my-on-call.ics"'},
    )


# --- Availability ----------------------------------------------------------------------------


@router.get("/unavailability", response_model=list[UnavailabilityOut])
def my_unavailability(
    start: date | None = Query(default=None, alias="from"),
    end: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = select(Unavailability).where(Unavailability.user_id == user.id)
    if start:
        q = q.where(Unavailability.day >= start)
    if end:
        q = q.where(Unavailability.day <= end)
    return [
        UnavailabilityOut(date=u.day, kind=u.kind, note=u.note)
        for u in db.scalars(q.order_by(Unavailability.day))
    ]


@router.post("/unavailability", response_model=list[UnavailabilityOut])
def set_unavailability(
    body: UnavailabilityBulk,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark (or clear, with kind=null) a set of dates."""
    dates = sorted(set(body.dates))
    if body.kind is None:
        db.execute(
            delete(Unavailability).where(
                Unavailability.user_id == user.id, Unavailability.day.in_(dates)
            )
        )
    else:
        existing = {
            u.day: u
            for u in db.scalars(
                select(Unavailability).where(
                    Unavailability.user_id == user.id, Unavailability.day.in_(dates)
                )
            )
        }
        for d in dates:
            row = existing.get(d)
            if row is None:
                db.add(
                    Unavailability(user_id=user.id, day=d, kind=body.kind, note=body.note.strip())
                )
            else:
                row.kind = body.kind
                row.note = body.note.strip()
                row.updated_at = utcnow()
    db.commit()
    return [
        UnavailabilityOut(date=u.day, kind=u.kind, note=u.note)
        for u in db.scalars(
            select(Unavailability)
            .where(Unavailability.user_id == user.id, Unavailability.day.in_(dates))
            .order_by(Unavailability.day)
        )
    ]


@router.get("/special-days", response_model=list[SpecialDayOut])
def my_special_days(
    start: date | None = Query(default=None, alias="from"),
    end: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Holidays and special days for all of the user's teams (for the availability calendar)."""
    start = start or date.today() - timedelta(days=31)
    end = end or start + timedelta(days=400)
    out = []
    for team in db.scalars(select(Team).join(Membership).where(Membership.user_id == user.id)):
        for d, label in team_special_days(db, team, start, end + timedelta(days=1)).items():
            out.append(
                SpecialDayOut(
                    id=None,
                    date=d,
                    label=label,
                    source="public",
                    team_id=team.id,
                    team_name=team.name,
                )
            )
    return sorted(out, key=lambda x: (x.date, x.team_name or ""))


# --- To-do ---------------------------------------------------------------------------------


@router.get("/todo")
def my_todo(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Things waiting on the current user, for the dashboard."""
    team_ids = list(db.scalars(select(Membership.team_id).where(Membership.user_id == user.id)))
    eligible_team_ids = set(
        db.scalars(
            select(Membership.team_id).where(
                Membership.user_id == user.id, Membership.on_call.is_(True)
            )
        )
    )
    submitted = set(
        db.scalars(
            select(AvailabilitySubmission.rota_id).where(AvailabilitySubmission.user_id == user.id)
        )
    )
    collecting = list(
        db.scalars(
            select(Rota)
            .where(Rota.team_id.in_(eligible_team_ids), Rota.status == ROTA_COLLECTING)
            .order_by(Rota.start_date)
        )
    )
    open_swaps = list(
        db.scalars(
            select(SwapRequest)
            .where(SwapRequest.team_id.in_(team_ids), SwapRequest.status == SWAP_OPEN)
            .order_by(SwapRequest.start_at)
        )
    )
    now = utcnow()
    open_swaps = [s for s in open_swaps if s.end_at > now]
    mine = [s for s in open_swaps if s.requester_id == user.id]
    others = [
        s
        for s in open_swaps
        if s.requester_id != user.id
        and s.team_id in eligible_team_ids
        and not any(o.offerer_id == user.id and o.status == OFFER_PENDING for o in s.offers)
    ]
    leader_team_ids = set(
        db.scalars(
            select(Membership.team_id).where(
                Membership.user_id == user.id, Membership.role == "leader"
            )
        )
    )
    to_review = list(
        db.scalars(
            select(Rota)
            .where(
                Rota.team_id.in_(leader_team_ids),
                Rota.status.in_(["planning", "collecting", "review"]),
            )
            .order_by(Rota.start_date)
        )
    )
    return {
        "dates_needed": [rota_out(db, r, user) for r in collecting if r.id not in submitted],
        "collecting": [rota_out(db, r, user) for r in collecting],
        "my_swap_requests": [swap_out(db, s, user) for s in mine],
        "swap_requests_to_help": [swap_out(db, s, user) for s in others],
        "rotas_in_progress": [rota_out(db, r, user) for r in to_review],
    }
