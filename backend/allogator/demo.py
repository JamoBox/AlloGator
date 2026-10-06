"""Demo data so the whole workflow can be explored at once (dev mode / `allogator seed-demo`)."""

from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    AVAIL_PARTIAL,
    AVAIL_UNAVAILABLE,
    ROLE_LEADER,
    ROLE_MEMBER,
    ROTA_COLLECTING,
    ROTA_PUBLISHED,
    AvailabilitySubmission,
    Membership,
    Rota,
    SpecialDay,
    SwapOffer,
    SwapRequest,
    Team,
    Unavailability,
    User,
    utcnow,
)
from .services import segments as seg
from .services.scheduling import generate, rota_segments, write_segments
from .services.slots import RotaGrid
from .services.special_days import public_holidays

DEMO_TEAM = "Platform SRE"
PEOPLE = [
    ("leader@example.com", "Alex Morgan", ROLE_LEADER),
    ("sam@example.com", "Sam Patel", ROLE_MEMBER),
    ("jordan@example.com", "Jordan Lee", ROLE_MEMBER),
    ("priya@example.com", "Priya Shah", ROLE_MEMBER),
    ("chris@example.com", "Chris Walker", ROLE_MEMBER),
    ("taylor@example.com", "Taylor Kim", ROLE_MEMBER),
]


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _unpopular_day(db: Session, team: Team, start: date, end: date) -> tuple[date, str]:
    """The first public holiday in [start, end), or a made-up company day if there isn't one."""
    hols = public_holidays(team.holiday_country, team.holiday_subdivision, start, end)
    if hols:
        d = min(hols)
        return d, hols[d]
    return start + timedelta(weeks=6, days=4), "Company all-hands"


def _same_day_last_year(team: Team, day: date, name: str) -> date:
    prev = public_holidays(
        team.holiday_country,
        team.holiday_subdivision,
        date(day.year - 1, 1, 1),
        date(day.year, 1, 1),
    )
    for d, n in prev.items():
        if n == name:
            return d
    try:
        return day.replace(year=day.year - 1)
    except ValueError:
        return day - timedelta(days=365)


def seed_demo(db: Session, today: date | None = None, *, admin: bool = False) -> dict[str, Any]:
    """Create the demo team. ``admin`` also makes the demo leader a global admin: dev mode only."""
    if db.scalar(select(Team).where(Team.name == DEMO_TEAM)):
        return {"status": "exists"}
    today = today or date.today()
    rng = random.Random(42)

    users: dict[str, User] = {}
    for email, name, _ in PEOPLE:
        u = db.scalar(select(User).where(User.email == email))
        if u is None:
            u = User(email=email, display_name=name)
            db.add(u)
        users[email] = u
    users["leader@example.com"].is_admin = admin
    db.flush()

    team = Team(
        name=DEMO_TEAM,
        description="Primary on-call for the platform and infrastructure.",
        timezone="Europe/London",
        default_period_days=7,
        default_num_periods=8,
        default_handover_weekday=0,
        default_handover_time="09:00",
        holiday_country="GB",
        holiday_subdivision="ENG",
    )
    db.add(team)
    db.flush()
    long_ago = utcnow() - timedelta(days=400)
    for email, _, role in PEOPLE:
        db.add(Membership(team_id=team.id, user_id=users[email].id, role=role, joined_at=long_ago))
    db.flush()

    # History: last year's rota around the same holiday as the upcoming rota's, so the
    # decision hints have something to say ("Sam covered Christmas Day last year").
    upcoming_start = _monday(today) + timedelta(weeks=4)
    upcoming_end = upcoming_start + timedelta(weeks=12)
    target_day, target_name = _unpopular_day(db, team, upcoming_start, upcoming_end)
    past_day = _same_day_last_year(team, target_day, target_name)
    if not public_holidays(
        team.holiday_country, team.holiday_subdivision, target_day, target_day + timedelta(days=1)
    ):
        db.add(SpecialDay(team_id=team.id, day=target_day, label=target_name))
        db.add(SpecialDay(team_id=team.id, day=past_day, label=target_name))
    past = Rota(
        team_id=team.id,
        name="Last year",
        start_date=_monday(past_day) - timedelta(weeks=2),
        num_periods=6,
        period_days=7,
        handover_time="09:00",
        timezone=team.timezone,
        status=ROTA_COLLECTING,
        created_by_id=users["leader@example.com"].id,
    )
    db.add(past)
    db.flush()
    db.refresh(team)
    generate(db, past, seed=3, time_limit=5)
    past_grid = RotaGrid.for_rota(past)
    holiday_period = past_grid.periods[past_grid.days[past_grid.day_index(past_day)].period_index]
    past_segs = seg.reassign(
        rota_segments(past),
        past_grid,
        holiday_period.start,
        holiday_period.end,
        users["sam@example.com"].id,
        source="generated",
    )
    # Taylor stepped in for two days of someone else's week, so has done "extra" cover.
    other = past_grid.periods[(holiday_period.index + 2) % len(past_grid.periods)]
    cover_start = past_grid.days[other.first_day + 1]
    past_segs = seg.reassign(
        past_segs,
        past_grid,
        cover_start.start,
        past_grid.days[other.first_day + 2].end,
        users["taylor@example.com"].id,
        source="swap",
        note="Covered for a teammate",
    )
    write_segments(db, past, past_segs)
    past.status = ROTA_PUBLISHED
    past.published_at = utcnow() - timedelta(days=330)

    # Current rota: started four weeks ago, runs four more weeks. Published.
    current_start = _monday(today) - timedelta(weeks=4)
    current = Rota(
        team_id=team.id,
        name="",
        start_date=current_start,
        num_periods=8,
        period_days=7,
        handover_time="09:00",
        timezone=team.timezone,
        status=ROTA_COLLECTING,
        requested_at=utcnow() - timedelta(days=45),
        created_by_id=users["leader@example.com"].id,
    )
    db.add(current)
    db.flush()
    db.refresh(team)
    generate(db, current, seed=7, time_limit=5)
    current.status = ROTA_PUBLISHED
    current.published_at = utcnow() - timedelta(days=35)
    for m in team.memberships:
        db.add(
            AvailabilitySubmission(
                rota_id=current.id, user_id=m.user_id, submitted_at=utcnow() - timedelta(days=40)
            )
        )
    db.flush()

    # Upcoming rota: collecting availability.
    upcoming = Rota(
        team_id=team.id,
        name="",
        start_date=upcoming_start,
        num_periods=12,
        period_days=7,
        handover_time="09:00",
        timezone=team.timezone,
        status=ROTA_COLLECTING,
        availability_deadline=today + timedelta(days=7),
        request_message="Please get your dates in by the deadline - holidays especially!",
        requested_at=utcnow() - timedelta(days=2),
        created_by_id=users["leader@example.com"].id,
    )
    db.add(upcoming)
    db.flush()

    marked: set[tuple[int, date]] = set()

    def mark(email: str, start: date, days: int, kind: str = AVAIL_UNAVAILABLE, note: str = ""):
        for i in range(days):
            key = (users[email].id, start + timedelta(days=i))
            if key not in marked:
                marked.add(key)
                db.add(Unavailability(user_id=key[0], day=key[1], kind=kind, note=note))

    u0 = upcoming_start
    mark("sam@example.com", u0 + timedelta(days=9), 10, note="Family holiday")
    mark("jordan@example.com", u0 + timedelta(days=21), 7, note="Conference")
    mark("jordan@example.com", u0 + timedelta(days=30), 1, AVAIL_PARTIAL, "Dentist 13:00-15:00")
    mark("priya@example.com", u0 + timedelta(days=14), 14, note="Parental leave")
    mark("chris@example.com", u0 + timedelta(days=16), 3, note="Moving house")
    mark("chris@example.com", u0 + timedelta(days=35), 2, AVAIL_PARTIAL, "Busy 13:00-17:00")
    mark("taylor@example.com", u0 + timedelta(days=14), 5, note="Offsite")
    mark("leader@example.com", u0 + timedelta(days=17), 2, note="Training course")
    mark("sam@example.com", u0 + timedelta(days=40), 1, AVAIL_PARTIAL, "Out until 12:00")
    # A day nobody can fully cover, to show how gaps are flagged.
    gap_day = u0 + timedelta(days=18)
    for email, _, _ in PEOPLE:
        if email != "chris@example.com":
            mark(email, gap_day, 1, note="Company offsite")
    mark("chris@example.com", gap_day, 1, AVAIL_UNAVAILABLE, "Moving house")
    # The unpopular day: nobody wants it (a leader will need to decide).
    for email, _, _ in PEOPLE:
        if email == "jordan@example.com":
            mark(email, target_day, 1, note="Could maybe do the evening if desperate")
        else:
            mark(email, target_day, 1, note=f"Away for {target_name}")
    for email in ("sam@example.com", "jordan@example.com", "priya@example.com"):
        db.add(
            AvailabilitySubmission(
                rota_id=upcoming.id,
                user_id=users[email].id,
                comment=rng.choice(["", "All in", "Done, thanks"]),
            )
        )
    db.flush()

    # An open swap request on the current rota, with one offer.
    grid = RotaGrid.for_rota(current)
    segs = rota_segments(current)
    now = utcnow()
    future_periods = [p for p in grid.periods if p.start > now + timedelta(days=2)]
    swap_info = None
    if len(future_periods) >= 2:
        p1, p2 = future_periods[0], future_periods[1]
        owner1 = seg.period_owner(segs, p1)
        owner2 = seg.period_owner(segs, p2)
        if owner1 and owner2 and owner1 != owner2:
            slot_a = grid.days[p1.first_day + 2]
            slot_b = grid.days[p1.first_day + 3]
            if seg.holders(segs, slot_a.start, slot_b.end) == {owner1}:
                swap = SwapRequest(
                    team_id=team.id,
                    rota_id=current.id,
                    requester_id=owner1,
                    start_at=slot_a.start,
                    end_at=slot_b.end,
                    note="Wedding anniversary - can anyone take these two days?",
                )
                db.add(swap)
                db.flush()
                offer_slot = grid.days[p2.first_day + 4]
                if seg.holders(segs, offer_slot.start, offer_slot.end) == {owner2}:
                    db.add(
                        SwapOffer(
                            request_id=swap.id,
                            offerer_id=owner2,
                            rota_id=current.id,
                            start_at=offer_slot.start,
                            end_at=offer_slot.end,
                            note="Happy to swap for my Friday",
                        )
                    )
                swap_info = swap.id
    db.commit()
    return {
        "status": "created",
        "team_id": team.id,
        "current_rota_id": current.id,
        "upcoming_rota_id": upcoming.id,
        "unpopular_day": f"{target_day} ({target_name})",
        "swap_request_id": swap_info,
        "users": [email for email, _, _ in PEOPLE],
    }
