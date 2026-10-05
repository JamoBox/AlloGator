"""Model -> response schema conversion."""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import is_leader, membership_of
from ..models import (
    OFFER_WITHDRAWN,
    ROTA_PUBLISHED,
    SWAP_OPEN,
    AvailabilitySubmission,
    Membership,
    Rota,
    Shift,
    SwapOffer,
    SwapRequest,
    SwapSlot,
    Team,
    Unavailability,
    User,
    utcnow,
)
from ..schemas import (
    AvailabilityEntry,
    DayOut,
    MemberOut,
    PeriodOut,
    RotaDetail,
    RotaOut,
    ScheduleShift,
    ShiftOut,
    SlotOut,
    SwapOfferOut,
    SwapRequestOut,
    TeamDetail,
    TeamOut,
    UnavailabilityOut,
    UserOut,
)
from ..services import segments as seg
from ..services.scheduling import load_unavailability, rota_segments
from ..services.slots import RotaGrid, get_zone, utc_to_local
from ..services.special_days import team_special_days

# How far ahead to show a swap requester's unavailability to people offering.
REQUESTER_UNAVAILABLE_AHEAD = timedelta(days=400)


def user_out(u: User | None) -> UserOut | None:
    if u is None:
        return None
    return UserOut(
        id=u.id, email=u.email, display_name=u.display_name, name=u.name, is_admin=u.is_admin
    )


def unavailability_out(u: Unavailability) -> UnavailabilityOut:
    return UnavailabilityOut(
        date=u.day, kind=u.kind, note=u.note, added_by=u.set_by.name if u.set_by else None
    )


def team_out(db: Session, team: Team, user: User, detail: bool = False) -> TeamOut | TeamDetail:
    m = membership_of(db, team.id, user)
    base = {
        "id": team.id,
        "name": team.name,
        "description": team.description,
        "timezone": team.timezone,
        "default_period_days": team.default_period_days,
        "default_num_periods": team.default_num_periods,
        "default_handover_weekday": team.default_handover_weekday,
        "default_handover_time": team.default_handover_time,
        "avoid_back_to_back": team.avoid_back_to_back,
        "fairness_lookback_days": team.fairness_lookback_days,
        "holiday_country": team.holiday_country,
        "holiday_subdivision": team.holiday_subdivision,
        "my_role": m.role if m else None,
        "is_leader": bool((m and m.is_leader) or user.is_admin),
        "member_count": len(team.memberships),
    }
    if not detail:
        return TeamOut(**base)
    members = sorted(team.memberships, key=lambda m: (m.role != "leader", m.user.name.lower()))
    return TeamDetail(
        **base,
        members=[
            MemberOut(user=user_out(m.user), role=m.role, on_call=m.on_call, joined_at=m.joined_at)
            for m in members
        ],
    )


def rota_out(db: Session, rota: Rota, user: User, cls=RotaOut, **extra) -> RotaOut:
    eligible_ids = set(
        db.scalars(
            select(Membership.user_id).where(
                Membership.team_id == rota.team_id, Membership.on_call.is_(True)
            )
        )
    )
    submitted_ids = set(
        db.scalars(
            select(AvailabilitySubmission.user_id).where(AvailabilitySubmission.rota_id == rota.id)
        )
    )
    open_swaps = db.scalar(
        select(func.count(SwapRequest.id)).where(
            SwapRequest.rota_id == rota.id, SwapRequest.status == SWAP_OPEN
        )
    )
    tz = get_zone(rota.timezone)

    def local(dt):
        return utc_to_local(dt, tz) if dt else None

    return cls(
        id=rota.id,
        team_id=rota.team_id,
        team_name=rota.team.name,
        name=rota.name,
        display_name=rota.display_name,
        start_date=rota.start_date,
        end_date=rota.last_date,
        num_periods=rota.num_periods,
        period_days=rota.period_days,
        handover_time=rota.handover_time,
        timezone=rota.timezone,
        status=rota.status,
        availability_deadline=rota.availability_deadline,
        request_message=rota.request_message,
        requested_at=local(rota.requested_at),
        generated_at=local(rota.generated_at),
        published_at=local(rota.published_at),
        imported=rota.imported,
        eligible_count=len(eligible_ids),
        submitted_count=len(eligible_ids & submitted_ids),
        my_submitted=user.id in submitted_ids,
        i_am_eligible=user.id in eligible_ids,
        open_swaps=open_swaps or 0,
        **extra,
    )


def shifts_visible(db: Session, rota: Rota, user: User) -> bool:
    return rota.status == ROTA_PUBLISHED or is_leader(db, rota.team_id, user)


def rota_detail(db: Session, rota: Rota, user: User) -> RotaDetail:
    grid = RotaGrid.for_rota(rota)
    visible = shifts_visible(db, rota, user)
    segs = rota_segments(rota) if visible else seg.empty(grid)
    per_day = seg.day_assignments(segs, grid)
    specials = team_special_days(db, rota.team, grid.start_date, grid.end_date)

    periods = [
        PeriodOut(
            index=p.index,
            start_date=p.start_date,
            end_date=grid.days[p.end_day - 1].day,
            start_at=grid.local(p.start),
            end_at=grid.local(p.end),
            owner_id=seg.period_owner(segs, p),
        )
        for p in grid.periods
    ]
    days = []
    for slot, pieces in zip(grid.days, per_day, strict=True):
        ids: list[int | None] = []
        for p in pieces:
            if p.user_id not in ids:
                ids.append(p.user_id)
        days.append(
            DayOut(
                index=slot.index,
                date=slot.day,
                period_index=slot.period_index,
                start_at=grid.local(slot.start),
                end_at=grid.local(slot.end),
                user_ids=ids,
                majority=seg.day_majority(pieces),
                locked=bool(pieces) and all(p.locked for p in pieces),
                holiday=specials.get(slot.day),
            )
        )
    shifts = (
        [
            ShiftOut(
                id=s.id,
                rota_id=rota.id,
                period_index=s.period_index,
                user_id=s.user_id,
                start_at=grid.local(s.start_at),
                end_at=grid.local(s.end_at),
                locked=s.locked,
                source=s.source,
                note=s.note,
            )
            for s in rota.shifts
        ]
        if visible
        else []
    )
    member_users = [m.user for m in rota.team.memberships]
    assigned = {s.user_id for s in rota.shifts if s.user_id is not None} if visible else set()
    extra_users = [
        u
        for u in db.scalars(select(User).where(User.id.in_(assigned)))
        if u.id not in {m.id for m in member_users}
    ]
    people = [user_out(u) for u in sorted(member_users + extra_users, key=lambda u: u.name.lower())]
    submitted = {s.user_id for s in rota.submissions}
    unsubmitted = sorted(
        (m.user for m in rota.team.memberships if m.on_call and m.user_id not in submitted),
        key=lambda u: u.name.lower(),
    )
    return rota_out(
        db,
        rota,
        user,
        cls=RotaDetail,
        periods=periods,
        days=days,
        shifts=shifts,
        people=people,
        unsubmitted=[user_out(u) for u in unsubmitted],
        shifts_visible=visible,
        solver_info=rota.solver_info if is_leader(db, rota.team_id, user) else None,
    )


def schedule_shift(shift: Shift) -> ScheduleShift:
    rota = shift.rota
    tz = get_zone(rota.timezone)
    return ScheduleShift(
        id=shift.id,
        rota_id=rota.id,
        rota_name=rota.display_name,
        team_id=rota.team_id,
        team_name=rota.team.name,
        period_index=shift.period_index,
        user=user_out(shift.user),
        start_at=utc_to_local(shift.start_at, tz),
        end_at=utc_to_local(shift.end_at, tz),
        note=shift.note,
    )


def _unavailable_overlap(db: Session, user_id: int, rota: Rota, start, end) -> list[str]:
    """Human-readable availability notes for ``user_id`` within [start, end) of ``rota``."""
    grid = RotaGrid.for_rota(rota)
    days = sorted({s.day for s in grid.days if s.start < end and start < s.end})
    if not days:
        return []
    entries = load_unavailability(db, [user_id], days[0], days[-1] + timedelta(days=1))
    out = []
    for d in days:
        e = entries.get(user_id, {}).get(d)
        if e:
            label = "unavailable" if e.kind == "unavailable" else "partially available"
            out.append(f"{d:%a %d %b}: {label}" + (f" ({e.note})" if e.note else ""))
    return out


def slots_of(item: SwapRequest | SwapOffer) -> list[tuple[Rota, datetime, datetime]]:
    """The blocks of time in a swap request or offer (none: an offer to just cover it)."""
    if item.slots:
        return [(s.rota, s.start_at, s.end_at) for s in item.slots]
    if item.rota is not None and item.start_at is not None and item.end_at is not None:
        return [(item.rota, item.start_at, item.end_at)]
    return []


def new_slots(slots: list[tuple[Rota, datetime, datetime]]) -> list[SwapSlot]:
    return [SwapSlot(rota_id=r.id, start_at=a, end_at=b) for r, a, b in slots]


def _slots_out(slots: list[tuple[Rota, datetime, datetime]]) -> list[SlotOut]:
    return [
        SlotOut(
            rota_id=r.id,
            start_at=utc_to_local(a, get_zone(r.timezone)),
            end_at=utc_to_local(b, get_zone(r.timezone)),
        )
        for r, a, b in slots
    ]


def offer_out(db: Session, swap: SwapRequest, offer: SwapOffer) -> SwapOfferOut:
    warnings = []
    for rota, start, end in slots_of(swap):
        for w in _unavailable_overlap(db, offer.offerer_id, rota, start, end):
            warnings.append(f"{offer.offerer.name} marked {w}")
    offered = slots_of(offer)
    for rota, start, end in offered:
        for w in _unavailable_overlap(db, swap.requester_id, rota, start, end):
            warnings.append(f"{swap.requester.name} marked {w}")
    tz = get_zone(swap.rota.timezone)
    return SwapOfferOut(
        id=offer.id,
        offerer=user_out(offer.offerer),
        rota_id=offer.rota_id,
        start_at=utc_to_local(offer.start_at, tz) if offer.start_at else None,
        end_at=utc_to_local(offer.end_at, tz) if offer.end_at else None,
        slots=_slots_out(offered),
        note=offer.note,
        status=offer.status,
        created_at=utc_to_local(offer.created_at, tz),
        warnings=warnings,
    )


def swap_out(db: Session, swap: SwapRequest, user: User) -> SwapRequestOut:
    tz = get_zone(swap.rota.timezone)
    m = membership_of(db, swap.team_id, user)
    can_offer = (
        swap.status == SWAP_OPEN
        and m is not None
        and m.on_call
        and user.id != swap.requester_id
        and not any(o.offerer_id == user.id and o.status == "pending" for o in swap.offers)
    )
    slots = slots_of(swap)
    warnings = []
    segs = {r.id: rota_segments(r) for r, _, _ in slots} if swap.status == SWAP_OPEN else {}
    if segs and any(seg.holders(segs[r.id], a, b) != {swap.requester_id} for r, a, b in slots):
        warnings.append(
            "The schedule has changed since this request was made; "
            f"{swap.requester.name} no longer holds all of this time."
        )
    unavailable = []
    if swap.status == SWAP_OPEN:
        today = utc_to_local(utcnow(), tz).date()
        entries = load_unavailability(
            db, [swap.requester_id], today, today + REQUESTER_UNAVAILABLE_AHEAD
        ).get(swap.requester_id, {})
        unavailable = [
            AvailabilityEntry(user_id=swap.requester_id, date=d, kind=e.kind, note=e.note)
            for d, e in sorted(entries.items())
        ]
    return SwapRequestOut(
        id=swap.id,
        team_id=swap.team_id,
        team_name=swap.rota.team.name,
        rota_id=swap.rota_id,
        rota_name=swap.rota.display_name,
        requester=user_out(swap.requester),
        start_at=utc_to_local(swap.start_at, tz),
        end_at=utc_to_local(swap.end_at, tz),
        slots=_slots_out(slots),
        note=swap.note,
        status=swap.status,
        created_at=utc_to_local(swap.created_at, tz),
        resolved_at=utc_to_local(swap.resolved_at, tz) if swap.resolved_at else None,
        # A withdrawn offer is taken back entirely, note and all.
        offers=[offer_out(db, swap, o) for o in swap.offers if o.status != OFFER_WITHDRAWN],
        can_offer=can_offer,
        warnings=warnings,
        requester_unavailable=unavailable,
    )
