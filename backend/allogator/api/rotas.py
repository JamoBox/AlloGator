from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user, get_rota, get_team, is_leader, require_leader, require_member
from ..db import get_db
from ..models import (
    AVAIL_CLEARED,
    ROTA_COLLECTING,
    ROTA_PLANNING,
    ROTA_PUBLISHED,
    ROTA_REVIEW,
    SWAP_OPEN,
    AuditEvent,
    AvailabilitySubmission,
    Rota,
    SwapRequest,
    User,
    utcnow,
)
from ..schemas import (
    AssignRequest,
    AuditOut,
    AvailabilityCleared,
    AvailabilityEntry,
    AvailabilityMatrix,
    AvailabilityMember,
    GenerateRequest,
    LockRequest,
    RequestDates,
    RotaCreate,
    RotaDetail,
    RotaOut,
    RotaUpdate,
    SubmitAvailability,
)
from ..services import segments as seg
from ..services.analysis import analyze
from ..services.hints import candidate_hints
from ..services.notify import Notifier, audit
from ..services.scheduling import (
    eligible_memberships,
    generate,
    load_unavailability,
    rota_segments,
    team_memberships,
    write_segments,
)
from ..services.slots import RotaGrid, get_zone, to_naive_utc, utc_to_local
from .serialize import rota_detail, rota_out, user_out

router = APIRouter(prefix="/api", tags=["rotas"])


def fmt_range(a: date, b: date) -> str:
    return f"{a:%a %d %b %Y} – {b:%a %d %b %Y}"


def _rota_link(rota: Rota) -> str:
    return f"/teams/{rota.team_id}/rotas/{rota.id}"


def _require_not_published(rota: Rota) -> None:
    if rota.status == ROTA_PUBLISHED:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This rota is published. Unpublish it first to change it."
        )


# --- CRUD ----------------------------------------------------------------------------------


@router.get("/teams/{team_id}/rotas", response_model=list[RotaOut])
def list_rotas(team_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    team = get_team(db, team_id)
    require_member(db, team.id, user)
    rotas = sorted(team.rotas, key=lambda r: r.start_date, reverse=True)
    return [rota_out(db, r, user) for r in rotas]


@router.post("/teams/{team_id}/rotas", response_model=RotaDetail, status_code=201)
def create_rota(
    team_id: int,
    body: RotaCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    team = get_team(db, team_id)
    require_leader(db, team.id, user)
    rota = Rota(
        team_id=team.id,
        name=body.name.strip(),
        start_date=body.start_date,
        num_periods=body.num_periods,
        period_days=body.period_days or team.default_period_days,
        handover_time=body.handover_time or team.default_handover_time,
        timezone=team.timezone,
        status=ROTA_PLANNING,
        created_by_id=user.id,
    )
    db.add(rota)
    db.flush()
    audit(
        db,
        "rota.created",
        f"Created rota {rota.display_name}",
        actor=user,
        team_id=team.id,
        rota_id=rota.id,
    )
    db.commit()
    return rota_detail(db, rota, user)


@router.get("/rotas/{rota_id}", response_model=RotaDetail)
def get_rota_detail(
    rota_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    rota = get_rota(db, rota_id)
    require_member(db, rota.team_id, user)
    return rota_detail(db, rota, user)


@router.patch("/rotas/{rota_id}", response_model=RotaDetail)
def update_rota(
    rota_id: int,
    body: RotaUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    data = body.model_dump(exclude_unset=True)
    grid_fields = {"start_date", "num_periods", "period_days", "handover_time"}
    grid_changed = any(k in data and data[k] != getattr(rota, k) for k in grid_fields)
    if grid_changed:
        _require_not_published(rota)
    for k, v in data.items():
        if k == "name":
            v = (v or "").strip()
        if v is not None or k == "availability_deadline":
            setattr(rota, k, v)
    if grid_changed and rota.shifts:
        rota.shifts = []
        rota.solver_info = None
        rota.generated_at = None
        rota.status = ROTA_COLLECTING if rota.requested_at else ROTA_PLANNING
    audit(
        db,
        "rota.updated",
        "Updated rota settings",
        actor=user,
        team_id=rota.team_id,
        rota_id=rota.id,
        data={k: str(v) for k, v in data.items()},
    )
    db.commit()
    return rota_detail(db, rota, user)


@router.delete("/rotas/{rota_id}", status_code=204)
def delete_rota(
    rota_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    audit(
        db,
        "rota.deleted",
        f"Deleted rota {rota.display_name}",
        actor=user,
        team_id=rota.team_id,
    )
    db.delete(rota)
    db.commit()
    return Response(status_code=204)


# --- Availability collection -----------------------------------------------------------------


@router.post("/rotas/{rota_id}/request-dates", response_model=RotaDetail)
def request_dates(
    rota_id: int,
    body: RequestDates,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    _require_not_published(rota)
    rota.availability_deadline = body.deadline
    rota.request_message = body.message.strip()
    rota.requested_at = utcnow()
    if rota.status == ROTA_PLANNING:
        rota.status = ROTA_COLLECTING

    team = rota.team
    lines = [
        f"{user.name} is planning the on-call rota for {team.name} covering "
        f"{fmt_range(rota.start_date, rota.last_date)}.",
        "Please mark the days you can't cover (add a note if you're only partly available), "
        'then press "Confirm my dates".',
    ]
    if body.deadline:
        lines.append(f"Please respond by {body.deadline:%A %d %B %Y}.")
    if rota.request_message:
        lines.append(f"Message from {user.name}:\n{rota.request_message}")
    notifier = Notifier(db, background)
    n = notifier.notify(
        [m.user for m in eligible_memberships(db, team.id)],
        "dates_requested",
        f"Dates needed: {team.name} on-call {rota.start_date:%d %b} – {rota.last_date:%d %b}",
        "\n\n".join(lines),
        link=f"/availability?rota={rota.id}",
    )
    audit(
        db,
        "rota.dates_requested",
        f"Requested dates from {n} people",
        actor=user,
        team_id=team.id,
        rota_id=rota.id,
    )
    db.commit()
    notifier.flush()
    return rota_detail(db, rota, user)


@router.post("/rotas/{rota_id}/remind")
def remind(
    rota_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    submitted = {s.user_id for s in rota.submissions}
    pending = [m.user for m in eligible_memberships(db, rota.team_id) if m.user_id not in submitted]
    notifier = Notifier(db, background)
    body = (
        f"Reminder: please submit the days you can't cover for {rota.team.name} "
        f"({fmt_range(rota.start_date, rota.last_date)})."
    )
    if rota.availability_deadline:
        body += f" The deadline is {rota.availability_deadline:%A %d %B}."
    n = notifier.notify(
        pending,
        "dates_reminder",
        f"Reminder: dates needed for {rota.team.name} on-call",
        body,
        link=f"/availability?rota={rota.id}",
    )
    audit(
        db,
        "rota.reminded",
        f"Sent reminders to {n} people",
        actor=user,
        team_id=rota.team_id,
        rota_id=rota.id,
    )
    db.commit()
    notifier.flush()
    return {"reminded": n}


@router.get("/rotas/{rota_id}/availability", response_model=AvailabilityMatrix)
def availability_matrix(
    rota_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    rota = get_rota(db, rota_id)
    require_member(db, rota.team_id, user)
    memberships = team_memberships(db, rota.team_id)
    subs = {s.user_id: s for s in rota.submissions}
    unav = load_unavailability(
        db, [m.user_id for m in memberships], rota.start_date, rota.end_date, include_cleared=True
    )
    rows = [(uid, d, e) for uid, days in unav.items() for d, e in sorted(days.items())]
    tz = get_zone(rota.timezone)
    return AvailabilityMatrix(
        rota_id=rota.id,
        start_date=rota.start_date,
        end_date=rota.last_date,
        members=[
            AvailabilityMember(
                user=user_out(m.user),
                on_call=m.on_call,
                role=m.role,
                submitted_at=utc_to_local(subs[m.user_id].submitted_at, tz)
                if m.user_id in subs
                else None,
                comment=subs[m.user_id].comment if m.user_id in subs else "",
            )
            for m in memberships
        ],
        entries=[
            AvailabilityEntry(
                user_id=uid,
                date=d,
                kind=e.kind,
                note=e.note,
                set_by=e.set_by.name if e.set_by else None,
            )
            for uid, d, e in rows
            if e.kind != AVAIL_CLEARED
        ],
        cleared=[
            AvailabilityCleared(user_id=uid, date=d, set_by=e.set_by.name if e.set_by else None)
            for uid, d, e in rows
            if e.kind == AVAIL_CLEARED
        ],
    )


@router.post("/rotas/{rota_id}/submit", response_model=RotaOut)
def submit_availability(
    rota_id: int,
    body: SubmitAvailability,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_member(db, rota.team_id, user)
    sub = db.scalar(
        select(AvailabilitySubmission).where(
            AvailabilitySubmission.rota_id == rota.id, AvailabilitySubmission.user_id == user.id
        )
    )
    if sub is None:
        sub = AvailabilitySubmission(rota_id=rota.id, user_id=user.id)
        db.add(sub)
    sub.submitted_at = utcnow()
    sub.comment = body.comment.strip()
    db.flush()
    notifier = Notifier(db, background)
    eligible = eligible_memberships(db, rota.team_id)
    submitted = set(
        db.scalars(
            select(AvailabilitySubmission.user_id).where(AvailabilitySubmission.rota_id == rota.id)
        )
    )
    if rota.status == ROTA_COLLECTING and all(m.user_id in submitted for m in eligible):
        leaders = [m.user for m in team_memberships(db, rota.team_id) if m.is_leader]
        notifier.notify(
            leaders,
            "dates_complete",
            f"All dates are in for {rota.team.name} ({rota.display_name})",
            "Everyone has confirmed their availability. You can now generate the rota.",
            link=_rota_link(rota),
        )
    db.commit()
    notifier.flush()
    return rota_out(db, rota, user)


@router.delete("/rotas/{rota_id}/submit", response_model=RotaOut)
def withdraw_submission(
    rota_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    rota = get_rota(db, rota_id)
    require_member(db, rota.team_id, user)
    sub = db.scalar(
        select(AvailabilitySubmission).where(
            AvailabilitySubmission.rota_id == rota.id, AvailabilitySubmission.user_id == user.id
        )
    )
    if sub:
        db.delete(sub)
        db.commit()
    return rota_out(db, rota, user)


# --- Scheduling ------------------------------------------------------------------------------


@router.post("/rotas/{rota_id}/generate")
def generate_rota(
    rota_id: int,
    body: GenerateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    _require_not_published(rota)
    if not eligible_memberships(db, rota.team_id) and not any(s.locked for s in rota.shifts):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Nobody in this team is marked as taking part in on-call"
        )
    regenerated = rota.generated_at is not None
    result = generate(
        db, rota, seed=body.seed, keep_locked=body.keep_locked, time_limit=body.time_limit
    )
    audit(
        db,
        "rota.regenerated" if regenerated else "rota.generated",
        f"{'Regenerated' if regenerated else 'Generated'} schedule "
        f"({result.status}, {len(result.uncovered_days)} uncovered day(s))",
        actor=user,
        team_id=rota.team_id,
        rota_id=rota.id,
        data=rota.solver_info,
    )
    db.commit()
    db.refresh(rota)
    return {"rota": rota_detail(db, rota, user), "analysis": analyze(db, rota)}


@router.get("/rotas/{rota_id}/analysis")
def rota_analysis(
    rota_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    rota = get_rota(db, rota_id)
    require_member(db, rota.team_id, user)
    if rota.status != ROTA_PUBLISHED and not is_leader(db, rota.team_id, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "The schedule isn't published yet")
    return analyze(db, rota)


@router.get("/rotas/{rota_id}/hints")
def rota_hints(
    rota_id: int,
    start: date = Query(alias="from"),
    end: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Who should take these dates? Per-person hints from the team's on-call history."""
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    end = end or start
    if end < start or start < rota.start_date or end > rota.last_date:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dates must be within the rota")
    if (end - start).days > 62:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick at most two months at a time")
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    return candidate_hints(db, rota, days)


def _assign_interval(rota: Rota, grid: RotaGrid, body: AssignRequest):
    tz = grid.tz
    if body.period_index is not None:
        if not 0 <= body.period_index < len(grid.periods):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "No such period")
        p = grid.periods[body.period_index]
        return p.start, p.end
    if body.from_date is not None:
        to_date = body.to_date or body.from_date
        a, b = grid.day_index(body.from_date), grid.day_index(to_date)
        if a is None or b is None or b < a:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dates are outside the rota")
        return grid.days[a].start, grid.days[b].end
    if body.start_at is not None and body.end_at is not None:
        start, end = to_naive_utc(body.start_at, tz), to_naive_utc(body.end_at, tz)
        if end <= start:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "End must be after start")
        if start < grid.start or end > grid.end:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Times are outside the rota")
        return start, end
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST, "Give period_index, from_date/to_date or start_at/end_at"
    )


@router.post("/rotas/{rota_id}/assign", response_model=RotaDetail)
def assign(
    rota_id: int,
    body: AssignRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    if rota.status in (ROTA_PLANNING, ROTA_COLLECTING) and not rota.shifts:
        rota.status = ROTA_REVIEW
    target = None
    if body.user_id is not None:
        target = db.get(User, body.user_id)
        if target is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown user")
    grid = RotaGrid.for_rota(rota)
    start, end = _assign_interval(rota, grid, body)
    before = rota_segments(rota)
    affected = {u for u in seg.holders(before, start, end) if u is not None}
    after = seg.reassign(
        before, grid, start, end, body.user_id, locked=body.lock, source="manual", note=body.note
    )
    write_segments(db, rota, after)
    if rota.generated_at is None:
        rota.generated_at = utcnow()
    who = target.name if target else "nobody"
    when = f"{grid.local(start):%a %d %b %H:%M} – {grid.local(end):%a %d %b %H:%M}"
    audit(
        db,
        "rota.assigned",
        f"Assigned {when} to {who}",
        actor=user,
        team_id=rota.team_id,
        rota_id=rota.id,
        data={"user_id": body.user_id, "start": str(start), "end": str(end)},
    )
    notifier = Notifier(db, background)
    if rota.status == ROTA_PUBLISHED:
        if target:
            affected.add(target.id)
        affected.discard(user.id)
        users = list(db.scalars(select(User).where(User.id.in_(affected))))
        notifier.notify(
            users,
            "schedule_changed",
            f"On-call change in {rota.team.name}",
            f"{user.name} changed the published rota: {when} is now covered by {who}.",
            link=_rota_link(rota),
        )
    db.commit()
    notifier.flush()
    db.refresh(rota)
    return rota_detail(db, rota, user)


@router.post("/rotas/{rota_id}/lock", response_model=RotaDetail)
def lock_shifts(
    rota_id: int,
    body: LockRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    ids = set(body.shift_ids) if body.shift_ids is not None else None
    for s in rota.shifts:
        if ids is None or s.id in ids:
            s.locked = body.locked
    grid = RotaGrid.for_rota(rota)
    write_segments(db, rota, seg.paint([], grid, seg.from_shifts(rota.shifts)))
    db.commit()
    db.refresh(rota)
    return rota_detail(db, rota, user)


# --- Publishing -----------------------------------------------------------------------------


def _personal_summary(rota: Rota, user_id: int) -> str:
    grid = RotaGrid.for_rota(rota)
    mine = [s for s in rota.shifts if s.user_id == user_id]
    if not mine:
        return "You have no on-call shifts in this rota."
    lines = ["Your on-call shifts:"]
    for s in mine:
        lines.append(
            f"  • {grid.local(s.start_at):%a %d %b %H:%M} → {grid.local(s.end_at):%a %d %b %H:%M}"
        )
    return "\n".join(lines)


@router.post("/rotas/{rota_id}/publish", response_model=RotaDetail)
def publish(
    rota_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    if rota.status == ROTA_PUBLISHED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Already published")
    if not any(s.user_id for s in rota.shifts):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Generate or build a schedule first")
    republish = rota.published_at is not None
    rota.status = ROTA_PUBLISHED
    rota.published_at = utcnow()
    notifier = Notifier(db, background)
    for m in team_memberships(db, rota.team_id):
        notifier.notify(
            [m.user],
            "published",
            f"{'Updated' if republish else 'New'} on-call rota for {rota.team.name}: "
            f"{rota.start_date:%d %b} – {rota.last_date:%d %b}",
            f"{user.name} has published the on-call rota for "
            f"{fmt_range(rota.start_date, rota.last_date)}.\n\n"
            + _personal_summary(rota, m.user_id)
            + "\n\nYou can download these as calendar events from AlloGator.",
            link=_rota_link(rota),
        )
    audit(
        db,
        "rota.published",
        "Published the schedule",
        actor=user,
        team_id=rota.team_id,
        rota_id=rota.id,
    )
    db.commit()
    notifier.flush()
    return rota_detail(db, rota, user)


@router.post("/rotas/{rota_id}/unpublish", response_model=RotaDetail)
def unpublish(
    rota_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rota = get_rota(db, rota_id)
    require_leader(db, rota.team_id, user)
    if rota.status != ROTA_PUBLISHED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Not published")
    rota.status = ROTA_REVIEW
    notifier = Notifier(db, background)
    open_swaps = list(
        db.scalars(
            select(SwapRequest).where(
                SwapRequest.rota_id == rota.id, SwapRequest.status == SWAP_OPEN
            )
        )
    )
    for swap in open_swaps:
        swap.status = "cancelled"
        swap.resolved_at = utcnow()
    notifier.notify(
        [m.user for m in team_memberships(db, rota.team_id)],
        "unpublished",
        f"{rota.team.name} rota {rota.start_date:%d %b} – {rota.last_date:%d %b} is being revised",
        f"{user.name} has taken the rota back into review. You'll be notified when it is "
        "published again."
        + (f" {len(open_swaps)} open swap request(s) were cancelled." if open_swaps else ""),
        link=_rota_link(rota),
        exclude=[user.id],
    )
    audit(
        db,
        "rota.unpublished",
        "Unpublished the schedule for revision",
        actor=user,
        team_id=rota.team_id,
        rota_id=rota.id,
    )
    db.commit()
    notifier.flush()
    return rota_detail(db, rota, user)


@router.get("/rotas/{rota_id}/history", response_model=list[AuditOut])
def rota_history(
    rota_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    rota = get_rota(db, rota_id)
    require_member(db, rota.team_id, user)
    tz = get_zone(rota.timezone)
    events = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.rota_id == rota.id)
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(200)
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


def default_next_start(team, today: date) -> date:
    """The next handover weekday after the team's last rota (or from today)."""
    last_end = max((r.end_date for r in team.rotas), default=None)
    start = max(today + timedelta(days=1), last_end) if last_end else today + timedelta(days=1)
    while start.weekday() != team.default_handover_weekday:
        start += timedelta(days=1)
    return start
