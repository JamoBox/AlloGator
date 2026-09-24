"""Rota analysis: issues a leader should look at, plus per-person load statistics.

Works on the *current* shifts (generated or manually edited) against current availability,
so it stays accurate after edits, swaps or late availability changes.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AVAIL_PARTIAL,
    AVAIL_UNAVAILABLE,
    ROTA_COLLECTING,
    ROTA_PLANNING,
    ROTA_REVIEW,
    Membership,
    Rota,
    Unavailability,
    User,
)
from . import segments as seg
from .history import team_history
from .scheduling import (
    HOLIDAY_LOOKBACK,
    fairness_offsets,
    load_unavailability,
    rota_segments,
    team_memberships,
)
from .slots import DaySlot, RotaGrid
from .special_days import team_special_days

_EPSILON = timedelta(microseconds=1)


def _candidates(
    eligible: list[Membership],
    unav: dict[int, dict[date, Unavailability]],
    days: list[date],
    exclude: set[int | None] = frozenset(),
) -> list[dict[str, Any]]:
    out = []
    for m in eligible:
        if m.user_id in exclude:
            continue
        entries = unav.get(m.user_id, {})
        blocked = [d for d in days if d in entries and entries[d].kind == AVAIL_UNAVAILABLE]
        limited = [d for d in days if d in entries and entries[d].kind == AVAIL_PARTIAL]
        free = len(days) - len(blocked)
        if free == 0:
            continue
        if not blocked and not limited:
            status = "available"
        elif not blocked:
            status = "limited"
        else:
            status = "some_days"
        out.append(
            {
                "user_id": m.user_id,
                "status": status,
                "free_days": free,
                "total_days": len(days),
                "notes": [
                    {"date": d, "kind": entries[d].kind, "note": entries[d].note}
                    for d in days
                    if d in entries
                ],
            }
        )
    order = {"available": 0, "limited": 1, "some_days": 2}
    out.sort(key=lambda c: (order[c["status"]], -c["free_days"]))
    return out


def _group_runs(slots: list[DaySlot]) -> list[list[DaySlot]]:
    runs: list[list[DaySlot]] = []
    for s in slots:
        if runs and runs[-1][-1].index == s.index - 1:
            runs[-1].append(s)
        else:
            runs.append([s])
    return runs


def _fmt_range(a: date, b: date) -> str:
    if a == b:
        return f"{a:%a %d %b}"
    return f"{a:%a %d %b} – {b:%a %d %b}"


def _labels(days: list[date], specials: dict[date, str]) -> str:
    names = list(dict.fromkeys(specials[d] for d in days if d in specials))
    return f" ({', '.join(names)})" if names else ""


def analyze(db: Session, rota: Rota) -> dict[str, Any]:
    grid = RotaGrid.for_rota(rota)
    segs = rota_segments(rota)
    memberships = team_memberships(db, rota.team_id)
    eligible = [m for m in memberships if m.on_call and m.user.active]
    member_by_user = {m.user_id: m for m in memberships}
    assigned_ids = {s.user_id for s in segs if s.user_id is not None}
    all_ids = sorted(set(member_by_user) | assigned_ids)
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(all_ids)))}
    unav = load_unavailability(db, all_ids, grid.start_date, grid.end_date)
    specials = team_special_days(db, rota.team, grid.start_date, grid.end_date)
    per_day = seg.day_assignments(segs, grid)
    submitted = {s.user_id for s in rota.submissions}
    has_schedule = bool(rota.shifts)

    def name(uid: int | None) -> str:
        return users[uid].name if uid in users else "Nobody"

    issues: list[dict[str, Any]] = []

    def add(kind: str, severity: str, title: str, detail: str = "", **extra: Any) -> None:
        issues.append(
            {
                "id": f"{kind}-{len(issues)}",
                "type": kind,
                "severity": severity,
                "title": title,
                "detail": detail,
                **extra,
            }
        )

    # --- Uncovered time -----------------------------------------------------------------
    if has_schedule:
        uncovered_slots = [
            slot
            for slot, pieces in zip(grid.days, per_day, strict=True)
            if any(p.user_id is None for p in pieces)
        ]
        for run in _group_runs(uncovered_slots):
            days = [s.day for s in run]
            gaps = [p for s in run for p in per_day[s.index] if p.user_id is None]
            cands = _candidates(eligible, unav, days)
            if cands:
                detail = (
                    "Nobody is fully available. "
                    + ", ".join(
                        f"{name(c['user_id'])} ({c['free_days']}/{c['total_days']} days"
                        + (", limited" if c["status"] != "available" else "")
                        + ")"
                        for c in cands[:5]
                    )
                    + " could help."
                )
                if any(c["status"] == "available" for c in cands):
                    detail = "Unassigned, but some people are available."
            else:
                detail = "Nobody is available on these days. A leader needs to decide."
            add(
                "uncovered",
                "error",
                f"No cover: {_fmt_range(days[0], days[-1])}{_labels(days, specials)}",
                detail,
                period_index=run[0].period_index,
                start_date=days[0],
                end_date=days[-1],
                start_at=grid.local(gaps[0].start),
                end_at=grid.local(gaps[-1].end),
                candidates=cands,
            )

    # --- Partial cover ------------------------------------------------------------------
    owners: list[int | None] = []
    cover_days: dict[int, float] = defaultdict(float)
    for period in grid.periods:
        owner = seg.period_owner(segs, period) if has_schedule else None
        owners.append(owner)
        if owner is None:
            continue
        pieces = seg.merge(
            [
                p
                for p in seg.within(segs, period.start, period.end)
                if p.user_id is not None and p.user_id != owner
            ]
        )
        if not pieces:
            continue
        period_days = [grid.days[i].day for i in period.day_indices]
        full = _candidates(eligible, unav, period_days, exclude={owner})
        full = [c for c in full if c["status"] == "available"]
        covers = [
            {
                "user_id": p.user_id,
                "start_at": grid.local(p.start),
                "end_at": grid.local(p.end),
                "start_date": grid.slot_at(p.start).day,
                "end_date": grid.slot_at(p.end - _EPSILON).day,
            }
            for p in pieces
        ]
        cover_text = "; ".join(
            f"{name(c['user_id'])} covers {c['start_at']:%a %d %b %H:%M}"
            f" – {c['end_at']:%a %d %b %H:%M}"
            for c in covers
        )
        detail = f"{name(owner)}'s period has partial cover: {cover_text}."
        if full:
            detail += (
                " Could be covered in full by: " + ", ".join(name(c["user_id"]) for c in full) + "."
            )
        add(
            "partial_cover",
            "warning",
            f"Partial cover in period {period.index + 1} "
            f"({_fmt_range(period.start_date, grid.days[period.end_day - 1].day)})",
            detail,
            period_index=period.index,
            start_date=period.start_date,
            end_date=grid.days[period.end_day - 1].day,
            owner_id=owner,
            covers=covers,
            candidates=full,
        )

    # --- Conflicts with availability ----------------------------------------------------
    conflict_days: dict[int, list[DaySlot]] = defaultdict(list)
    limited_days: dict[int, list[DaySlot]] = defaultdict(list)
    for slot, pieces in zip(grid.days, per_day, strict=True):
        for uid in {p.user_id for p in pieces if p.user_id is not None}:
            entry = unav.get(uid, {}).get(slot.day)
            if entry is None:
                continue
            if entry.kind == AVAIL_UNAVAILABLE:
                conflict_days[uid].append(slot)
            elif entry.kind == AVAIL_PARTIAL:
                limited_days[uid].append(slot)
    for uid, slots in conflict_days.items():
        for run in _group_runs(slots):
            notes = [unav[uid][s.day].note for s in run if unav[uid][s.day].note]
            add(
                "conflict",
                "error",
                f"{name(uid)} is scheduled but unavailable: {_fmt_range(run[0].day, run[-1].day)}",
                "; ".join(notes),
                user_ids=[uid],
                period_index=run[0].period_index,
                start_date=run[0].day,
                end_date=run[-1].day,
                candidates=_candidates(eligible, unav, [s.day for s in run], exclude={uid}),
            )
    for uid, slots in limited_days.items():
        for run in _group_runs(slots):
            notes = [
                f"{s.day:%a %d %b}: {unav[uid][s.day].note}" for s in run if unav[uid][s.day].note
            ]
            add(
                "limited",
                "warning",
                f"{name(uid)} has limited availability: {_fmt_range(run[0].day, run[-1].day)}",
                "; ".join(notes) or "Marked as partially available.",
                user_ids=[uid],
                period_index=run[0].period_index,
                start_date=run[0].day,
                end_date=run[-1].day,
            )

    # --- Back-to-back periods -----------------------------------------------------------
    for p in range(1, len(owners)):
        if owners[p] is not None and owners[p] == owners[p - 1]:
            add(
                "back_to_back",
                "info",
                f"{name(owners[p])} has back-to-back periods {p} and {p + 1}",
                user_ids=[owners[p]],
                period_index=p,
                start_date=grid.periods[p - 1].start_date,
                end_date=grid.days[grid.periods[p].end_day - 1].day,
            )

    # --- Missing submissions ------------------------------------------------------------
    if rota.status in (ROTA_PLANNING, ROTA_COLLECTING, ROTA_REVIEW) and not rota.imported:
        missing = [m.user_id for m in eligible if m.user_id not in submitted]
        if missing and rota.requested_at is not None:
            add(
                "unsubmitted",
                "info",
                f"{len(missing)} of {len(eligible)} people haven't confirmed their dates",
                ", ".join(name(u) for u in missing),
                user_ids=missing,
            )

    # --- Stats --------------------------------------------------------------------------
    _, hist = fairness_offsets(db, rota, eligible, rota.team.fairness_lookback_days)
    since = grid.start_date - HOLIDAY_LOOKBACK
    past_specials = team_special_days(db, rota.team, since, grid.start_date)
    past = team_history(db, rota.team_id, since, grid.start_date, exclude_rota_id=rota.id)
    holiday_now: dict[int, int] = defaultdict(int)
    for slot, pieces in zip(grid.days, per_day, strict=True):
        if slot.day in specials and (uid := seg.day_majority(pieces)) is not None:
            holiday_now[uid] += 1
    day_share: dict[int, float] = defaultdict(float)
    for slot, pieces in zip(grid.days, per_day, strict=True):
        total = (slot.end - slot.start).total_seconds()
        for p in pieces:
            if p.user_id is not None:
                day_share[p.user_id] += p.seconds / total
    owned: dict[int, int] = defaultdict(int)
    for period, owner in zip(grid.periods, owners, strict=True):
        if owner is not None:
            owned[owner] += 1
        for p in seg.within(segs, period.start, period.end):
            if p.user_id is not None and p.user_id != owner:
                slot = grid.slot_at(p.start)
                total = (slot.end - slot.start).total_seconds() if slot else 86400
                cover_days[p.user_id] += p.seconds / total

    stats = []
    for uid in all_ids:
        m = member_by_user.get(uid)
        entries = unav.get(uid, {})
        stats.append(
            {
                "user_id": uid,
                "name": name(uid),
                "on_call": bool(m and m.on_call),
                "member": m is not None,
                "days": round(day_share.get(uid, 0.0), 2),
                "periods_owned": owned.get(uid, 0),
                "cover_days": round(cover_days.get(uid, 0.0), 2),
                "conflict_days": len(conflict_days.get(uid, [])),
                "limited_days": len(limited_days.get(uid, [])),
                "unavailable_days": sum(1 for e in entries.values() if e.kind == AVAIL_UNAVAILABLE),
                "partial_days": sum(1 for e in entries.values() if e.kind == AVAIL_PARTIAL),
                "history_days": round(hist.get(uid, 0.0), 1),
                "holiday_days": holiday_now.get(uid, 0),
                "holiday_history": sum(1 for d in past[uid].days if d in past_specials)
                if uid in past
                else 0,
                "submitted": uid in submitted,
            }
        )

    summary = {
        "errors": sum(1 for i in issues if i["severity"] == "error"),
        "warnings": sum(1 for i in issues if i["severity"] == "warning"),
        "infos": sum(1 for i in issues if i["severity"] == "info"),
        "uncovered_days": sum(
            1 for pieces in per_day if has_schedule and any(p.user_id is None for p in pieces)
        ),
        "split_periods": sum(1 for i in issues if i["type"] == "partial_cover"),
        "holidays": len(specials),
        "owners": owners,
    }
    return {"issues": issues, "stats": stats, "summary": summary, "solver": rota.solver_info}
