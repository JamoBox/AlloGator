"""Who was on call when: per-person day history from a team's rotas.

A person "covers" a calendar date when they hold the majority of that date's day slot. Days
in a period owned by someone else count as *cover* (stepping in for a teammate).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ROTA_PUBLISHED, Rota
from . import segments as seg
from .scheduling import rota_segments
from .slots import RotaGrid


@dataclass
class PersonHistory:
    days: set[date] = field(default_factory=set)
    cover_days: set[date] = field(default_factory=set)


def rota_days(rota: Rota) -> dict[int, PersonHistory]:
    """Per-person days (and cover days) in one rota's current schedule."""
    out: dict[int, PersonHistory] = defaultdict(PersonHistory)
    if not rota.shifts:
        return out
    grid = RotaGrid.for_rota(rota)
    segs = rota_segments(rota)
    owners = [seg.period_owner(segs, p) for p in grid.periods]
    for slot, pieces in zip(grid.days, seg.day_assignments(segs, grid), strict=True):
        uid = seg.day_majority(pieces)
        if uid is None:
            continue
        out[uid].days.add(slot.day)
        if uid != owners[slot.period_index]:
            out[uid].cover_days.add(slot.day)
    return out


def team_history(
    db: Session,
    team_id: int,
    since: date,
    until: date,
    *,
    exclude_rota_id: int | None = None,
) -> dict[int, PersonHistory]:
    """Days each person was (or is scheduled to be) on call in the team's published rotas
    within [since, until)."""
    rotas = db.scalars(select(Rota).where(Rota.team_id == team_id, Rota.status == ROTA_PUBLISHED))
    out: dict[int, PersonHistory] = defaultdict(PersonHistory)
    for rota in rotas:
        if rota.id == exclude_rota_id or rota.end_date <= since or rota.start_date >= until:
            continue
        for uid, h in rota_days(rota).items():
            out[uid].days.update(d for d in h.days if since <= d < until)
            out[uid].cover_days.update(d for d in h.cover_days if since <= d < until)
    return out


def merge(*histories: dict[int, PersonHistory]) -> dict[int, PersonHistory]:
    out: dict[int, PersonHistory] = defaultdict(PersonHistory)
    for h in histories:
        for uid, ph in h.items():
            out[uid].days |= ph.days
            out[uid].cover_days |= ph.cover_days
    return out
