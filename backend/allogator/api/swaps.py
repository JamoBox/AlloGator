from __future__ import annotations

from datetime import datetime

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
from ..schemas import OfferCreate, SwapCreate, SwapRequestOut
from ..services import segments as seg
from ..services.notify import Notifier, audit
from ..services.scheduling import rota_segments, team_memberships, write_segments
from ..services.slots import RotaGrid, get_zone, to_naive_utc
from .serialize import swap_out

router = APIRouter(prefix="/api", tags=["swaps"])


def _fmt(rota: Rota, start: datetime, end: datetime) -> str:
    grid = RotaGrid.for_rota(rota)
    a, b = grid.local(start), grid.local(end)
    return f"{a:%a %d %b %H:%M} → {b:%a %d %b %H:%M}"


def _check_slot(rota: Rota, user_id: int, start: datetime, end: datetime, whose: str) -> None:
    if rota.status != ROTA_PUBLISHED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Swaps are only possible on published rotas")
    if end <= start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "End must be after start")
    grid = RotaGrid.for_rota(rota)
    if start < grid.start or end > grid.end:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That time is outside the rota")
    if end <= utcnow():
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
    rota = get_rota(db, body.rota_id)
    require_member(db, rota.team_id, user)
    tz = get_zone(rota.timezone)
    start, end = to_naive_utc(body.start_at, tz), to_naive_utc(body.end_at, tz)
    _check_slot(rota, user.id, start, end, "You aren't")
    swap = SwapRequest(
        team_id=rota.team_id,
        rota_id=rota.id,
        requester_id=user.id,
        start_at=start,
        end_at=end,
        note=body.note.strip(),
    )
    db.add(swap)
    db.flush()
    when = _fmt(rota, start, end)
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
    if body.start_at is not None or body.end_at is not None or body.rota_id is not None:
        if body.start_at is None or body.end_at is None or body.rota_id is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "An offered slot needs rota_id, start_at and end_at"
            )
        offer_rota = get_rota(db, body.rota_id)
        if offer_rota.team_id != swap.team_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Offer a slot from the same team")
        tz = get_zone(offer_rota.timezone)
        start, end = to_naive_utc(body.start_at, tz), to_naive_utc(body.end_at, tz)
        _check_slot(offer_rota, user.id, start, end, "You aren't")
        offer.rota_id, offer.start_at, offer.end_at = offer_rota.id, start, end
        what = f"offered to swap their slot {_fmt(offer_rota, start, end)}"
    else:
        what = "offered to cover it"
    db.add(offer)
    db.flush()
    notifier = Notifier(db, background)
    notifier.notify(
        [swap.requester],
        "swap_offer",
        f"{user.name} responded to your swap request",
        f"For your slot {_fmt(swap.rota, swap.start_at, swap.end_at)}, {user.name} {what}."
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

    # Re-validate against the current schedule: things may have changed since.
    _check_slot(
        swap.rota,
        swap.requester_id,
        swap.start_at,
        swap.end_at,
        f"{swap.requester.name} is no longer",
    )
    if offer.rota is not None:
        _check_slot(
            offer.rota,
            offer.offerer_id,
            offer.start_at,
            offer.end_at,
            f"{offer.offerer.name} is no longer",
        )

    requester, offerer = swap.requester, offer.offerer
    note = f"Swap #{swap.id}: {requester.name} ↔ {offerer.name}"
    rota = swap.rota
    grid = RotaGrid.for_rota(rota)
    segs = seg.reassign(
        rota_segments(rota),
        grid,
        swap.start_at,
        swap.end_at,
        offerer.id,
        locked=True,
        source="swap",
        note=note,
    )
    if offer.rota is not None and offer.rota_id == rota.id:
        segs = seg.reassign(
            segs,
            grid,
            offer.start_at,
            offer.end_at,
            requester.id,
            locked=True,
            source="swap",
            note=note,
        )
    write_segments(db, rota, segs)
    if offer.rota is not None and offer.rota_id != rota.id:
        other = offer.rota
        other_grid = RotaGrid.for_rota(other)
        write_segments(
            db,
            other,
            seg.reassign(
                rota_segments(other),
                other_grid,
                offer.start_at,
                offer.end_at,
                requester.id,
                locked=True,
                source="swap",
                note=note,
            ),
        )

    now = utcnow()
    swap.status = SWAP_ACCEPTED
    swap.resolved_at = now
    offer.status = OFFER_ACCEPTED
    notifier = Notifier(db, background)
    req_when = _fmt(rota, swap.start_at, swap.end_at)
    summary = f"{offerer.name} now covers {req_when}"
    if offer.rota is not None:
        summary += f"; {requester.name} now covers {_fmt(offer.rota, offer.start_at, offer.end_at)}"
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
        f"Your offer for {_fmt(swap.rota, swap.start_at, swap.end_at)} was declined.",
        link=_link(swap),
    )
    db.commit()
    notifier.flush()
    return swap_out(db, swap, user)


@router.post("/swaps/{swap_id}/offers/{offer_id}/withdraw", response_model=SwapRequestOut)
def withdraw_offer(
    swap_id: int,
    offer_id: int,
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
    db.commit()
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
        f"The swap request for {_fmt(swap.rota, swap.start_at, swap.end_at)} was cancelled.",
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
