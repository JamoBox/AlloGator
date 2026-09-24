"""History-based hints to help a leader choose who should take days nobody wants (or can) do.

For each person on the rota we look at their on-call history and produce short, human hints,
each with a tone ("good" = argues for picking them, "bad" = argues against, "neutral" = FYI)
and a weight. Summing the weights gives a score; the lowest score is suggested. The leader
always makes the call: this only surfaces what's easy to forget ("Sam did Christmas last year").
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AVAIL_PARTIAL,
    AVAIL_UNAVAILABLE,
    OFFER_ACCEPTED,
    Rota,
    SwapOffer,
    SwapRequest,
    utcnow,
)
from . import segments as seg
from .history import PersonHistory, merge, rota_days, team_history
from .scheduling import eligible_memberships, load_unavailability, rota_segments
from .slots import RotaGrid
from .special_days import team_special_days

YEAR = timedelta(days=365)
HISTORY_YEARS = 5


@dataclass
class Hint:
    tone: str  # good | bad | neutral
    text: str
    weight: float = 0.0
    kind: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"tone": self.tone, "text": self.text, "kind": self.kind}


@dataclass
class Candidate:
    user_id: int
    name: str
    availability: str = "free"  # free | partial | unavailable
    hints: list[Hint] = field(default_factory=list)

    @property
    def score(self) -> float:
        return sum(h.weight for h in self.hints)


def _names(label: str) -> list[str]:
    parts: list[str] = []
    for chunk in label.split(" · "):
        parts.extend(p.strip() for p in chunk.split("; ") if p.strip())
    return parts


def _mean(values: Iterable[float]) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _fmt(d: date) -> str:
    return f"{d:%a} {d.day} {d:%b %Y}"


def candidate_hints(db: Session, rota: Rota, dates: list[date]) -> dict[str, Any]:
    if not dates:
        raise ValueError("No dates given")
    dates = sorted(set(dates))
    team = rota.team
    first, last = dates[0], dates[-1]
    grid = RotaGrid.for_rota(rota)
    memberships = eligible_memberships(db, team.id)
    ids = [m.user_id for m in memberships]
    target = set(dates)

    since = first - YEAR * HISTORY_YEARS
    other = team_history(db, team.id, since, last + YEAR, exclude_rota_id=rota.id)
    current_raw = rota_days(rota)
    current = {
        uid: PersonHistory(days=h.days - target, cover_days=h.cover_days - target)
        for uid, h in current_raw.items()
    }
    combined = merge(other, current)
    specials = team_special_days(db, team, since, last + YEAR)
    unav = load_unavailability(db, ids, first, last + timedelta(days=1))

    target_labels = {d: specials[d] for d in dates if d in specials}
    target_names = list(dict.fromkeys(n for label in target_labels.values() for n in _names(label)))
    has_weekend = any(d.weekday() >= 5 for d in dates)
    window = (first - YEAR, first)
    two_years = (first - 2 * YEAR, first)
    earliest = min((d for h in combined.values() for d in h.days), default=first)

    def in_window(days: set[date], w: tuple[date, date]) -> set[date]:
        return {d for d in days if w[0] <= d < w[1]}

    load = {u: len(in_window(combined.get(u, PersonHistory()).days, window)) for u in ids}
    cover = {u: len(in_window(combined.get(u, PersonHistory()).cover_days, window)) for u in ids}
    special_2y = {
        u: sum(
            1 for d in in_window(combined.get(u, PersonHistory()).days, two_years) if d in specials
        )
        for u in ids
    }
    weekend = {
        u: sum(
            1 for d in in_window(combined.get(u, PersonHistory()).days, window) if d.weekday() >= 5
        )
        for u in ids
    }
    rota_load = {u: len(current.get(u, PersonHistory()).days) for u in ids}
    # Owners of the period(s) the dates fall in: giving them the dates avoids a handover.
    segs = rota_segments(rota)
    owners = {
        seg.period_owner(segs, p)
        for p in grid.periods
        if p.start_date <= last and first < p.end_date
    }
    avg_load, avg_cover = _mean(load.values()), _mean(cover.values())
    avg_special, avg_weekend = _mean(special_2y.values()), _mean(weekend.values())
    avg_rota = _mean(rota_load.values())

    year_ago = utcnow() - YEAR
    helped = dict.fromkeys(ids, 0)
    asked = dict.fromkeys(ids, 0)
    for offer, request in db.execute(
        select(SwapOffer, SwapRequest)
        .join(SwapRequest, SwapOffer.request_id == SwapRequest.id)
        .where(
            SwapRequest.team_id == team.id,
            SwapOffer.status == OFFER_ACCEPTED,
            SwapOffer.created_at >= year_ago,
        )
    ):
        if offer.offerer_id in helped:
            helped[offer.offerer_id] += 1
        if request.requester_id in asked:
            asked[request.requester_id] += 1

    candidates: list[Candidate] = []
    for m in memberships:
        u = m.user_id
        c = Candidate(user_id=u, name=m.user.name)
        days = combined.get(u, PersonHistory()).days

        # --- Availability for the dates in question ---------------------------------
        entries = unav.get(u, {})
        blocked = [d for d in dates if d in entries and entries[d].kind == AVAIL_UNAVAILABLE]
        partial = [d for d in dates if d in entries and entries[d].kind == AVAIL_PARTIAL]
        notes = "; ".join(
            dict.fromkeys(entries[d].note for d in blocked + partial if entries[d].note)
        )
        if blocked:
            c.availability = "unavailable"
            c.hints.append(
                Hint(
                    "bad",
                    "Said they can't cover" + (f": {notes}" if notes else ""),
                    25.0 * len(blocked),
                    "availability",
                )
            )
        elif partial:
            c.availability = "partial"
            c.hints.append(
                Hint(
                    "neutral",
                    "Partly available" + (f": {notes}" if notes else ""),
                    6.0 * len(partial),
                    "availability",
                )
            )
        else:
            c.hints.append(
                Hint("good", "Hasn't marked these dates as unavailable", -4.0, "availability")
            )

        # --- Unpopular days: holidays and special days --------------------------------
        for name in target_names:
            covered = sorted(
                d for d in days if d < first and d in specials and name in _names(specials[d])
            )
            if not covered:
                since_text = (
                    "in the last 5 years" if earliest <= first - YEAR * HISTORY_YEARS else "before"
                )
                c.hints.append(
                    Hint("good", f"No record of covering {name} {since_text}", -6.0, "holiday")
                )
                continue
            last_time = covered[-1]
            years_ago = first.year - last_time.year
            if years_ago == 0:
                c.hints.append(
                    Hint(
                        "bad",
                        f"Already covered {name} this year ({_fmt(last_time)})",
                        8.0,
                        "holiday",
                    )
                )
            elif years_ago == 1:
                c.hints.append(
                    Hint("bad", f"Covered {name} last year ({last_time.year})", 8.0, "holiday")
                )
            elif years_ago == 2:
                c.hints.append(
                    Hint("bad", f"Covered {name} two years ago ({last_time.year})", 4.0, "holiday")
                )
            else:
                c.hints.append(
                    Hint(
                        "good",
                        f"Last covered {name} in {last_time.year} ({years_ago} years ago)",
                        -2.0,
                        "holiday",
                    )
                )
        if target_labels:
            diff = special_2y[u] - avg_special
            if diff >= 1:
                c.hints.append(
                    Hint(
                        "bad",
                        f"Covered {_plural(special_2y[u], 'holiday/special day')} "
                        f"in the last 2 years (team average {avg_special:.1f})",
                        1.5 * diff,
                        "holidays",
                    )
                )
            elif diff <= -1:
                c.hints.append(
                    Hint(
                        "good",
                        (
                            f"Only {_plural(special_2y[u], 'holiday/special day')}"
                            if special_2y[u]
                            else "No holidays or special days on call"
                        )
                        + f" in the last 2 years (team average {avg_special:.1f})",
                        1.5 * diff,
                        "holidays",
                    )
                )

        # --- Overall load -----------------------------------------------------------------
        diff = load[u] - avg_load
        if diff >= 2:
            c.hints.append(
                Hint(
                    "bad",
                    f"{diff:.0f} more on-call days than the team average in the last 12 months",
                    min(12.0, 0.4 * diff),
                    "load",
                )
            )
        elif diff <= -2:
            c.hints.append(
                Hint(
                    "good",
                    f"{-diff:.0f} fewer on-call days than the team average in the last 12 months",
                    max(-12.0, 0.4 * diff),
                    "load",
                )
            )
        elif avg_load:
            c.hints.append(
                Hint("neutral", "About average on-call load over the last 12 months", 0, "load")
            )

        diff = cover[u] - avg_cover
        if cover[u] and diff >= 1:
            c.hints.append(
                Hint(
                    "bad",
                    f"Already covered {_plural(cover[u], 'extra day')} for "
                    "teammates in the last 12 months",
                    min(8.0, 0.6 * diff),
                    "extra",
                )
            )
        elif cover[u] == 0 and avg_cover >= 1:
            c.hints.append(
                Hint(
                    "good",
                    "Hasn't had to cover for anyone in the last 12 months",
                    -0.6 * avg_cover,
                    "extra",
                )
            )
        if helped[u]:
            c.hints.append(
                Hint(
                    "neutral",
                    f"Took {_plural(helped[u], 'swap')} for teammates this year",
                    0,
                    "swaps",
                )
            )
        if asked[u]:
            c.hints.append(
                Hint(
                    "neutral",
                    f"Had {_plural(asked[u], 'swap request')} covered by teammates this year",
                    0,
                    "swaps",
                )
            )

        if has_weekend:
            diff = weekend[u] - avg_weekend
            if diff >= 3:
                c.hints.append(
                    Hint(
                        "bad",
                        f"{weekend[u]} weekend days on call in the last 12 months "
                        f"(average {avg_weekend:.0f})",
                        0.3 * diff,
                        "weekend",
                    )
                )
            elif diff <= -3:
                c.hints.append(
                    Hint(
                        "good",
                        f"Only {weekend[u]} weekend days on call in the last 12 "
                        f"months (average {avg_weekend:.0f})",
                        0.3 * diff,
                        "weekend",
                    )
                )

        # --- This rota --------------------------------------------------------------------
        diff = rota_load[u] - avg_rota
        if diff >= 3:
            c.hints.append(
                Hint(
                    "bad",
                    f"Already has {rota_load[u]} days in this rota (average {avg_rota:.0f})",
                    0.3 * diff,
                    "rota",
                )
            )
        elif diff <= -3:
            c.hints.append(
                Hint(
                    "good",
                    f"Only {rota_load[u]} days in this rota so far (average {avg_rota:.0f})",
                    0.3 * diff,
                    "rota",
                )
            )

        # --- Proximity to their other shifts ---------------------------------------------
        before = 0
        d = first - timedelta(days=1)
        while d in days:
            before += 1
            d -= timedelta(days=1)
        after = 0
        d = last + timedelta(days=1)
        while d in days:
            after += 1
            d += timedelta(days=1)
        own_period = u in owners and before + len(dates) + after <= grid.period_days
        if own_period:
            what = " / ".join(target_names) if target_names else "It"
            c.hints.append(
                Hint(
                    "good",
                    f"{what} falls in their own on-call period — no extra handovers",
                    -3.0,
                    "own",
                )
            )
        elif before or after:
            stretch = before + len(dates) + after
            where = (
                "right before"
                if before and not after
                else "right after"
                if after and not before
                else "either side"
            )
            long_run = stretch > grid.period_days
            c.hints.append(
                Hint(
                    "bad" if long_run else "neutral",
                    f"On call {where} — would make a {stretch}-day run",
                    5.0 if long_run else 1.0,
                    "stretch",
                )
            )
        else:
            prev = max((x for x in days if x < first), default=None)
            nxt = min((x for x in days if x > last), default=None)
            if prev and (first - prev).days <= 7:
                c.hints.append(
                    Hint(
                        "bad",
                        f"Only just finished a shift ({_plural((first - prev).days, 'day')} "
                        "before)",
                        1.5,
                        "recent",
                    )
                )
            if nxt and (nxt - last).days <= 7:
                c.hints.append(
                    Hint(
                        "bad",
                        f"Starts another shift {_plural((nxt - last).days, 'day')} later",
                        1.5,
                        "recent",
                    )
                )

        joined_days = max(0, (utcnow() - m.joined_at).days)
        if joined_days < 90:
            ago = (
                "today"
                if joined_days == 0
                else f"{_plural(joined_days, 'day')} ago"
                if joined_days < 14
                else f"{_plural(joined_days // 7, 'week')} ago"
            )
            c.hints.append(Hint("neutral", f"Joined the team {ago}", 0, "tenure"))
        candidates.append(c)

    candidates.sort(key=lambda c: (c.score, load.get(c.user_id, 0), c.name.lower()))
    suggested = candidates[0].user_id if candidates else None
    everyone_blocked = bool(candidates) and all(c.availability == "unavailable" for c in candidates)
    out = []
    for c in candidates:
        hints = sorted(c.hints, key=lambda h: (h.kind != "availability", -abs(h.weight)))
        out.append(
            {
                "user_id": c.user_id,
                "name": c.name,
                "score": round(c.score, 2),
                "availability": c.availability,
                "suggested": c.user_id == suggested,
                "hints": [h.as_dict() for h in hints],
                "why": [h.text for h in hints if h.tone == "good"][:2],
            }
        )
    return {
        "dates": dates,
        "labels": {d.isoformat(): label for d, label in target_labels.items()},
        "everyone_unavailable": everyone_blocked,
        "candidates": out,
    }
