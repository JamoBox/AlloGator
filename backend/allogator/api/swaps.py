from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user, get_rota, is_leader, membership_of, require_member
from ..db import get_db
from ..models import (
    OFFER_ACCEPTED,
    OFFER_DECLINED,
    OFFER_PENDING,
    OFFER_WITHDRAWN,
    ROTA_PUBLISHED,
    SWAP_ACCEPTED,
    SWAP_CANCELLED,
    SWAP_OPEN,
    Rota,
    SwapOffer,
    SwapRequest,
    User,
    utcnow,
)
from ..schemas import OfferCreate, SlotIn, SwapCreate, SwapRequestOut
from ..services import segments as seg
from ..services.notify import Notifier, audit
from ..services.scheduling import rota_segments, team_memberships, write_segments
from ..services.slots import RotaGrid, get_zone, to_naive_utc
from .serialize import new_slots, slots_of, swap_out

router = APIRouter(prefix="/api", tags=["swaps"])

Slot = tuple[Rota, datetime, datetime]
MAX_SLOTS = 120


def _now() -> datetime:
    """Now (naive UTC) rounded up to the minute: nothing before it can be swapped."""
    now = utcnow()
    floor = now.replace(second=0, microsecond=0)
    return floor if floor == now else floor + timedelta(minutes=1)


def _from_now(slots: list[Slot]) -> list[Slot]:
    """Drop the part of each slot that has already happened, so a swap never rewrites on-call
    history. A slot wholly in the past is left alone for ``_check_slot`` to refuse."""
    now = _now()
    return [(r, max(start, now) if end > now else start, end) for r, start, end in slots]


def _fmt(rota: Rota, start: datetime, end: datetime) -> str:
    grid = RotaGrid.for_rota(rota)
    a, b = grid.local(start), grid.local(end)
    return f"{a:%a %d %b %H:%M} → {b:%a %d %b %H:%M}"


def _fmt_slots(slots: list[Slot]) -> str:
    return "; ".join(_fmt(r, a, b) for r, a, b in slots)


def _parse_slots(db: Session, body: SwapCreate | OfferCreate) -> list[Slot]:
    """The slots in a request body, in order, with touching blocks joined up."""
    raw = list(body.slots)
    if body.rota_id is not None or body.start_at is not None or body.end_at is not None:
        if body.rota_id is None or body.start_at is None or body.end_at is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "A slot needs rota_id, start_at and end_at"
            )
        raw.append(SlotIn(rota_id=body.rota_id, start_at=body.start_at, end_at=body.end_at))
    rotas: dict[int, Rota] = {}
    slots: list[Slot] = []
    for s in raw:
        if s.rota_id not in rotas:
            rotas[s.rota_id] = get_rota(db, s.rota_id)
        rota = rotas[s.rota_id]
        tz = get_zone(rota.timezone)
        start, end = to_naive_utc(s.start_at, tz), to_naive_utc(s.end_at, tz)
        if end <= start:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "End must be after start")
        slots.append((rota, start, end))
    if len({r.team_id for r in rotas.values()}) > 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick slots from one team")
    merged: list[Slot] = []
    for rota, start, end in sorted(slots, key=lambda x: (x[1], x[2])):
        if merged and merged[-1][0].id == rota.id and start <= merged[-1][2]:
            merged[-1] = (rota, merged[-1][1], max(merged[-1][2], end))
        else:
            merged.append((rota, start, end))
    if len(merged) > MAX_SLOTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That's too many separate slots")
    return _from_now(merged)


def _check_slot(rota: Rota, user_id: int, start: datetime, end: datetime, whose: str) -> None:
    if rota.status != ROTA_PUBLISHED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Swaps are only possible on published rotas")
    if end <= start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "End must be after start")
    grid = RotaGrid.for_rota(rota)
    if start < grid.start or end > grid.end:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That time is outside the rota")
    if end <= _now():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That slot is already in the past")
    holders = seg.holders(rota_segments(rota), start, end)
    if holders != {user_id}:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{whose} on call for the whole of that slot")


def _get_swap(db: Session, swap_id: int) -> SwapRequest:
    swap = db.get(SwapRequest, swap_id)
    if swap is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Swap request not found")
    return swap


def _get_offer(swap: SwapRequest, offer_id: int) -> SwapOffer:
    offer = next((o for o in swap.offers if o.id == offer_id), None)
    if offer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Offer not found")
    return offer


def _link(swap: SwapRequest) -> str:
    return f"/teams/{swap.team_id}/swaps?request={swap.id}"


@router.get("/teams/{team_id}/swaps", response_model=list[SwapRequestOut])
def list_swaps(
    team_id: int,
    include_closed: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_member(db, team_id, user)
    q = select(SwapRequest).where(SwapRequest.team_id == team_id)
    if not include_closed:
        q = q.where(SwapRequest.status == SWAP_OPEN, SwapRequest.end_at > utcnow())
    q = q.order_by(SwapRequest.created_at.desc()).limit(200)
    return [swap_out(db, s, user) for s in db.scalars(q)]


@router.get("/swaps/{swap_id}", response_model=SwapRequestOut)
def get_swap(swap_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    swap = _get_swap(db, swap_id)
    require_member(db, swap.team_id, user)
    return swap_out(db, swap, user)


@router.post("/swaps", response_model=SwapRequestOut, status_code=201)
def create_swap(
    body: SwapCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    slots = _parse_slots(db, body)
    if not slots:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick the time you need covered")
    rota = slots[0][0]
    require_member(db, rota.team_id, user)
    for r, start, end in slots:
        _check_slot(r, user.id, start, end, "You aren't")
    swap = SwapRequest(
        team_id=rota.team_id,
        rota_id=rota.id,
        requester_id=user.id,
        start_at=slots[0][1],
        end_at=max(end for _, _, end in slots),
        note=body.note.strip(),
        slots=new_slots(slots),
    )
    db.add(swap)
    db.flush()
    when = _fmt_slots(slots)
    notifier = Notifier(db, background)
    notifier.notify(
        [m.user for m in team_memberships(db, rota.team_id) if m.on_call],
        "swap_requested",
        f"Swap request: {user.name} needs cover {when}",
        f"{user.name} is looking for someone to take their on-call slot {when} "
        f"({rota.team.name})."
        + (f"\n\nNote: {swap.note}" if swap.note else "")
        + "\n\nIf you can help, offer one of your slots in exchange (or just offer to cover it).",
        link=_link(swap),
        exclude=[user.id],
    )
    audit(
        db,
        "swap.requested",
        f"{user.name} requested a swap for {when}",
        actor=user,
        team_id=rota.team_id,
        rota_id=rota.id,
        data={"swap_id": swap.id},
    )
    db.commit()
    notifier.flush()
    return swap_out(db, swap, user)


@router.post("/swaps/{swap_id}/offers", response_model=SwapRequestOut, status_code=201)
def make_offer(
    swap_id: int,
    body: OfferCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    swap = _get_swap(db, swap_id)
    m = membership_of(db, swap.team_id, user)
    if m is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not a member of this team")
    if swap.status != SWAP_OPEN:
        raise HTTPException(status.HTTP_409_CONFLICT, "This swap request is no longer open")
    if swap.requester_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't offer on your own request")
    if any(o.offerer_id == user.id and o.status == OFFER_PENDING for o in swap.offers):
        raise HTTPException(status.HTTP_409_CONFLICT, "You already have a pending offer here")

    offer = SwapOffer(request_id=swap.id, offerer_id=user.id, note=body.note.strip())
    slots = _parse_slots(db, body)
    if slots:
        if slots[0][0].team_id != swap.team_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Offer a slot from the same team")
        for r, start, end in slots:
            _check_slot(r, user.id, start, end, "You aren't")
        offer.rota_id = slots[0][0].id
        offer.start_at, offer.end_at = slots[0][1], max(end for _, _, end in slots)
        offer.slots = new_slots(slots)
        what = f"offered to swap their slot {_fmt_slots(slots)}"
    else:
        what = "offered to cover it"
    db.add(offer)
    db.flush()
    notifier = Notifier(db, background)
    notifier.notify(
        [swap.requester],
        "swap_offer",
        f"{user.name} responded to your swap request",
        f"For your slot {_fmt_slots(slots_of(swap))}, {user.name} {what}."
        + (f"\n\nNote: {offer.note}" if offer.note else "")
        + "\n\nAccept or decline it in AlloGator.",
        link=_link(swap),
    )
    audit(
        db,
        "swap.offered",
        f"{user.name} {what}",
        actor=user,
        team_id=swap.team_id,
        rota_id=swap.rota_id,
        data={"swap_id": swap.id, "offer_id": offer.id},
    )
    db.commit()
    notifier.flush()
    db.refresh(swap)
    return swap_out(db, swap, user)


@router.post("/swaps/{swap_id}/offers/{offer_id}/accept", response_model=SwapRequestOut)
def accept_offer(
    swap_id: int,
    offer_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    swap = _get_swap(db, swap_id)
    if user.id != swap.requester_id and not is_leader(db, swap.team_id, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can accept offers")
    if swap.status != SWAP_OPEN:
        raise HTTPException(status.HTTP_409_CONFLICT, "This swap request is no longer open")
    offer = _get_offer(swap, offer_id)
    if offer.status != OFFER_PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "That offer is no longer pending")

    # Re-validate against the current schedule: things may have changed since, and any part of
    # a slot that has gone by since it was requested is left as it was.
    requested, offered = _from_now(slots_of(swap)), _from_now(slots_of(offer))
    for r, start, end in requested:
        _check_slot(r, swap.requester_id, start, end, f"{swap.requester.name} is no longer")
    for r, start, end in offered:
        _check_slot(r, offer.offerer_id, start, end, f"{offer.offerer.name} is no longer")

    requester, offerer = swap.requester, offer.offerer
    note = f"Swap #{swap.id}: {requester.name} ↔ {offerer.name}"
    rota = swap.rota
    # Both sides' slots may span several rotas: reassign each rota's segments, then write once.
    work: dict[int, tuple[Rota, RotaGrid, list[seg.Segment]]] = {}
    for slots, uid in ((requested, offerer.id), (offered, requester.id)):
        for r, start, end in slots:
            _, grid, segs = work.get(r.id) or (r, RotaGrid.for_rota(r), rota_segments(r))
            segs = seg.reassign(segs, grid, start, end, uid, locked=True, source="swap", note=note)
            work[r.id] = (r, grid, segs)
    for r, _, segs in work.values():
        write_segments(db, r, segs)

    now = utcnow()
    swap.status = SWAP_ACCEPTED
    swap.resolved_at = now
    offer.status = OFFER_ACCEPTED
    notifier = Notifier(db, background)
    req_when = _fmt_slots(requested)
    summary = f"{offerer.name} now covers {req_when}"
    if offered:
        summary += f"; {requester.name} now covers {_fmt_slots(offered)}"
    for other_offer in swap.offers:
        if other_offer.id != offer.id and other_offer.status == OFFER_PENDING:
            other_offer.status = OFFER_DECLINED
            notifier.notify(
                [other_offer.offerer],
                "swap_filled",
                f"{requester.name}'s swap request was filled",
                f"Thanks for offering: {requester.name} accepted another offer for {req_when}.",
                link=_link(swap),
            )
    notifier.notify(
        [offerer],
        "swap_accepted",
        f"{requester.name} accepted your swap offer",
        f"Swap agreed: {summary}. The published rota has been updated; download your "
        "updated calendar from AlloGator.",
        link=_link(swap),
    )
    if user.id != requester.id:
        notifier.notify(
            [requester],
            "swap_accepted",
            "Your swap was completed",
            f"Swap agreed: {summary}.",
            link=_link(swap),
        )
    leaders = [m.user for m in team_memberships(db, swap.team_id) if m.is_leader]
    notifier.notify(
        leaders,
        "swap_completed",
        f"Swap completed in {rota.team.name}",
        f"{summary}.",
        link=f"/teams/{swap.team_id}/rotas/{rota.id}",
        exclude=[requester.id, offerer.id],
        email=False,
    )
    audit(
        db,
        "swap.accepted",
        f"Swap agreed: {summary}",
        actor=user,
        team_id=swap.team_id,
        rota_id=rota.id,
        data={"swap_id": swap.id, "offer_id": offer.id},
    )
    db.commit()
    notifier.flush()
    db.refresh(swap)
    return swap_out(db, swap, user)


@router.post("/swaps/{swap_id}/offers/{offer_id}/decline", response_model=SwapRequestOut)
def decline_offer(
    swap_id: int,
    offer_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    swap = _get_swap(db, swap_id)
    if user.id != swap.requester_id and not is_leader(db, swap.team_id, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can decline offers")
    offer = _get_offer(swap, offer_id)
    if offer.status != OFFER_PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "That offer is no longer pending")
    offer.status = OFFER_DECLINED
    notifier = Notifier(db, background)
    notifier.notify(
        [offer.offerer],
        "swap_declined",
        f"{swap.requester.name} declined your swap offer",
        f"Your offer for {_fmt_slots(slots_of(swap))} was declined.",
        link=_link(swap),
    )
    db.commit()
    notifier.flush()
    return swap_out(db, swap, user)


@router.post("/swaps/{swap_id}/offers/{offer_id}/withdraw", response_model=SwapRequestOut)
def withdraw_offer(
    swap_id: int,
    offer_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    swap = _get_swap(db, swap_id)
    offer = _get_offer(swap, offer_id)
    if offer.offerer_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "That isn't your offer")
    if offer.status != OFFER_PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "That offer is no longer pending")
    offer.status = OFFER_WITHDRAWN
    notifier = Notifier(db, background)
    notifier.notify(
        [swap.requester],
        "swap_withdrawn",
        f"{user.name} withdrew their swap offer",
        f"{user.name} is no longer offering to help with {_fmt_slots(slots_of(swap))}.",
        link=_link(swap),
        email=False,
    )
    audit(
        db,
        "swap.withdrawn",
        f"{user.name} withdrew their offer",
        actor=user,
        team_id=swap.team_id,
        rota_id=swap.rota_id,
        data={"swap_id": swap.id, "offer_id": offer.id},
    )
    db.commit()
    notifier.flush()
    db.refresh(swap)
    return swap_out(db, swap, user)


@router.post("/swaps/{swap_id}/cancel", response_model=SwapRequestOut)
def cancel_swap(
    swap_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    swap = _get_swap(db, swap_id)
    if user.id != swap.requester_id and not is_leader(db, swap.team_id, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can cancel this")
    if swap.status != SWAP_OPEN:
        raise HTTPException(status.HTTP_409_CONFLICT, "This swap request is no longer open")
    swap.status = SWAP_CANCELLED
    swap.resolved_at = utcnow()
    notifier = Notifier(db, background)
    pending = [o for o in swap.offers if o.status == OFFER_PENDING]
    for o in pending:
        o.status = OFFER_DECLINED
    notifier.notify(
        [o.offerer for o in pending],
        "swap_cancelled",
        f"{swap.requester.name} cancelled their swap request",
        f"The swap request for {_fmt_slots(slots_of(swap))} was cancelled.",
        link=_link(swap),
    )
    audit(
        db,
        "swap.cancelled",
        "Swap request cancelled",
        actor=user,
        team_id=swap.team_id,
        rota_id=swap.rota_id,
        data={"swap_id": swap.id},
    )
    db.commit()
    notifier.flush()
    return swap_out(db, swap, user)
