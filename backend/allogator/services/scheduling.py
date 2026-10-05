"""Glue between the database and the solver: building inputs and writing results."""

from __future__ import annotations

import random
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (
    AVAIL_CLEARED,
    AVAIL_PARTIAL,
    AVAIL_UNAVAILABLE,
    ROTA_PUBLISHED,
    ROTA_REVIEW,
    Membership,
    Rota,
    Shift,
    Unavailability,
    User,
    utcnow,
)
from . import segments as seg
from .slots import RotaGrid
from .solver import SolverInput, SolverResult, solve


def eligible_memberships(db: Session, team_id: int) -> list[Membership]:
    return list(
        db.scalars(
            select(Membership)
            .join(User)
            .where(Membership.team_id == team_id, Membership.on_call.is_(True), User.active)
            .order_by(User.display_name, User.email)
        )
    )


def team_memberships(db: Session, team_id: int) -> list[Membership]:
    return list(
        db.scalars(
            select(Membership)
            .join(User)
            .where(Membership.team_id == team_id)
            .order_by(User.display_name, User.email)
        )
    )


def load_unavailability(
    db: Session, user_ids: list[int], start: date, end: date, include_cleared: bool = False
) -> dict[int, dict[date, Unavailability]]:
    """Unavailability entries for users within [start, end). ``include_cleared`` also returns
    the tombstones left when a leader cleared a member's day (only the board needs those)."""
    out: dict[int, dict[date, Unavailability]] = defaultdict(dict)
    if not user_ids:
        return out
    q = select(Unavailability).where(
        Unavailability.user_id.in_(user_ids),
        Unavailability.day >= start,
        Unavailability.day < end,
    )
    if not include_cleared:
        q = q.where(Unavailability.kind != AVAIL_CLEARED)
    for row in db.scalars(q):
        out[row.user_id][row.day] = row
    return out


RESET = "reset"  # kind for a leader putting back what the member entered


def save_unavailability(
    db: Session,
    user: User,
    dates: list[date],
    kind: str | None,
    note: str,
    set_by: User | None = None,
) -> list[Unavailability]:
    """Mark (or clear, with kind=None) dates for ``user``; the caller commits.

    A leader acting for them passes ``set_by``. Their change is layered over the member's own
    entry, kept in orig_kind/orig_note: clearing a day the member marked leaves an AVAIL_CLEARED
    tombstone, and kind=RESET puts the member's entry back. A member's own edit takes over."""
    dates = sorted(set(dates))
    rows = {
        u.day: u
        for u in db.scalars(
            select(Unavailability).where(
                Unavailability.user_id == user.id, Unavailability.day.in_(dates)
            )
        )
    }
    by = set_by.id if set_by and set_by.id != user.id else None
    note = note.strip()
    for d in dates:
        row = rows.get(d)
        # What the member themselves had entered for this day (kind None = nothing).
        if row is None:
            orig = (None, "")
        elif row.set_by_id is None:
            orig = (row.kind, row.note)
        else:
            orig = (row.orig_kind, row.orig_note)
        if kind == RESET:
            k, n, who = *orig, None
        elif kind is None:
            k, n, who = (AVAIL_CLEARED if by and orig[0] else None), "", by
        else:
            k, n, who = kind, note, by
        if k is None:
            if row:
                db.delete(row)
                del rows[d]
            continue
        if row is None:
            row = rows[d] = Unavailability(user_id=user.id, day=d)
            db.add(row)
        row.kind, row.note, row.set_by_id, row.updated_at = k, n, who, utcnow()
        row.orig_kind, row.orig_note = orig if who else (None, "")
    db.flush()
    return sorted((r for r in rows.values() if r.kind != AVAIL_CLEARED), key=lambda r: r.day)


def write_segments(db: Session, rota: Rota, segments: list[seg.Segment]) -> None:
    rota.shifts = [
        Shift(
            period_index=s.period_index,
            user_id=s.user_id,
            start_at=s.start,
            end_at=s.end,
            locked=s.locked,
            source=s.source,
            note=s.note,
        )
        for s in segments
    ]
    db.flush()


def rota_segments(rota: Rota) -> list[seg.Segment]:
    grid = RotaGrid.for_rota(rota)
    if not rota.shifts:
        return seg.empty(grid)
    return seg.from_shifts(rota.shifts)


def history_days(db: Session, rota: Rota, user_ids: list[int], since: date) -> dict[int, float]:
    """On-call days per user in this team's *other* published rotas between ``since`` and the
    start of ``rota``."""
    if not user_ids:
        return {}
    grid = RotaGrid.for_rota(rota)
    window_start = RotaGrid(since, 1, 1, rota.handover_time, rota.timezone).start
    rows = db.execute(
        select(Shift.user_id, Shift.start_at, Shift.end_at)
        .join(Rota)
        .where(
            Rota.team_id == rota.team_id,
            Rota.id != rota.id,
            Rota.status == ROTA_PUBLISHED,
            Shift.user_id.in_(user_ids),
            Shift.end_at > window_start,
            Shift.start_at < grid.start,
        )
    )
    totals: dict[int, float] = defaultdict(float)
    for user_id, start, end in rows:
        s = max(start, window_start)
        e = min(end, grid.start)
        if s < e:
            totals[user_id] += (e - s).total_seconds() / 86400
    return dict(totals)


def fairness_offsets(
    db: Session, rota: Rota, memberships: list[Membership], lookback_days: int
) -> tuple[dict[int, int], dict[int, float]]:
    """Per-user fairness offset: how far above/below the team average each person's recent
    on-call load is. People who joined during the lookback window are treated as average so
    that newcomers are not flooded with shifts."""
    if lookback_days <= 0 or not memberships:
        return {}, {}
    since = rota.start_date - timedelta(days=lookback_days)
    ids = [m.user_id for m in memberships]
    hist = history_days(db, rota, ids, since)
    grid_start = RotaGrid(since, 1, 1, rota.handover_time, rota.timezone).start
    veterans = [m.user_id for m in memberships if m.joined_at <= grid_start]
    if not veterans:
        return {}, hist
    mean = sum(hist.get(u, 0.0) for u in veterans) / len(veterans)
    cap = rota.period_days * 2
    offsets = {}
    for u in veterans:
        dev = hist.get(u, 0.0) - mean
        offsets[u] = int(round(max(-cap, min(cap, dev))))
    return offsets, hist


def previous_owner(db: Session, rota: Rota) -> int | None:
    grid = RotaGrid.for_rota(rota)
    instant = grid.start - timedelta(minutes=1)
    return db.scalar(
        select(Shift.user_id)
        .join(Rota)
        .where(
            Rota.team_id == rota.team_id,
            Rota.id != rota.id,
            Rota.status == ROTA_PUBLISHED,
            Shift.start_at <= instant,
            Shift.end_at > instant,
        )
        .limit(1)
    )


HOLIDAY_LOOKBACK = timedelta(days=730)


def _holiday_inputs(
    db: Session, rota: Rota, grid: RotaGrid, member_ids: list[int]
) -> tuple[set[int], dict[int, int]]:
    """Day indices of unpopular days in the rota, and how many each person did recently."""
    from .history import team_history
    from .special_days import team_special_days

    team = rota.team
    upcoming = team_special_days(db, team, grid.start_date, grid.end_date)
    idx = {i for d in upcoming if (i := grid.day_index(d)) is not None}
    if not idx:
        return set(), {}
    since = rota.start_date - HOLIDAY_LOOKBACK
    past_specials = team_special_days(db, team, since, rota.start_date)
    past = team_history(db, team.id, since, rota.start_date, exclude_rota_id=rota.id)
    counts = {
        u: sum(1 for d in past[u].days if d in past_specials) for u in member_ids if u in past
    }
    return idx, counts


def generate(
    db: Session,
    rota: Rota,
    *,
    seed: int | None = None,
    keep_locked: bool = True,
    time_limit: float | None = None,
) -> SolverResult:
    settings = get_settings()
    team = rota.team
    grid = RotaGrid.for_rota(rota)
    current = rota_segments(rota)
    locked = [s for s in current if s.locked] if keep_locked else []

    # Days fully covered by locked segments are pinned for the solver.
    pinned: dict[int, int | None] = {}
    for slot, pieces in zip(grid.days, seg.day_assignments(locked, grid), strict=True):
        covered = sum(p.seconds for p in pieces)
        users = {p.user_id for p in pieces}
        if pieces and covered >= (slot.end - slot.start).total_seconds() and len(users) == 1:
            pinned[slot.index] = next(iter(users))

    memberships = eligible_memberships(db, rota.team_id)
    member_ids = [m.user_id for m in memberships]
    unav = load_unavailability(db, member_ids, grid.start_date, grid.end_date)
    unavailable: dict[int, set[int]] = defaultdict(set)
    limited: dict[int, set[int]] = defaultdict(set)
    for user_id, days in unav.items():
        for day, entry in days.items():
            idx = grid.day_index(day)
            if idx is None:
                continue
            if entry.kind == AVAIL_UNAVAILABLE:
                unavailable[user_id].add(idx)
            elif entry.kind == AVAIL_PARTIAL:
                limited[user_id].add(idx)

    offsets, _ = fairness_offsets(db, rota, memberships, team.fairness_lookback_days)
    holiday_idx, holiday_history = _holiday_inputs(db, rota, grid, member_ids)
    if seed is None:
        seed = random.randrange(1, 2**31)

    result = solve(
        SolverInput(
            num_days=len(grid.days),
            periods=[(p.first_day, p.end_day) for p in grid.periods],
            members=member_ids,
            unavailable=dict(unavailable),
            limited=dict(limited),
            history=offsets,
            pinned=pinned,
            previous_owner=previous_owner(db, rota),
            holidays=holiday_idx,
            holiday_history=holiday_history,
            avoid_back_to_back=team.avoid_back_to_back,
            seed=seed,
            time_limit=time_limit if time_limit is not None else settings.solver_time_limit_seconds,
            stall_seconds=settings.solver_stall_seconds,
            workers=settings.solver_workers,
        )
    )

    generated = [
        seg.Segment(slot.start, slot.end, result.assignment[slot.index], source="generated")
        for slot in grid.days
    ]
    write_segments(db, rota, seg.paint(generated, grid, locked))
    rota.generated_at = utcnow()
    rota.solver_info = {
        "status": result.status,
        "objective": result.objective,
        "seconds": round(result.wall_time, 3),
        "seed": seed,
        "pinned_days": len(pinned),
        "kept_locked": keep_locked,
        "history_offsets": {str(k): v for k, v in offsets.items()},
        "holiday_days": len(holiday_idx),
    }
    if rota.status != ROTA_PUBLISHED:
        rota.status = ROTA_REVIEW
    db.flush()
    return result
