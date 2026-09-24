"""Pure interval operations on a rota's shifts.

A rota's shifts are handled as a list of :class:`Segment` that *tiles* the rota's time range:
sorted, non-overlapping, gap-free, never crossing a period boundary. Uncovered time is a
segment with ``user_id=None``. Every mutation (generation, manual edits, swaps, imports) goes
through :func:`paint`, which keeps that invariant.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import datetime

from .slots import Period, RotaGrid


@dataclass
class Segment:
    start: datetime
    end: datetime
    user_id: int | None
    period_index: int = 0
    locked: bool = False
    source: str = "generated"
    note: str = ""

    @property
    def seconds(self) -> float:
        return (self.end - self.start).total_seconds()

    def overlaps(self, start: datetime, end: datetime) -> bool:
        return self.start < end and start < self.end


def from_shifts(shifts) -> list[Segment]:
    return [
        Segment(
            start=s.start_at,
            end=s.end_at,
            user_id=s.user_id,
            period_index=s.period_index,
            locked=s.locked,
            source=s.source,
            note=s.note or "",
        )
        for s in sorted(shifts, key=lambda s: s.start_at)
    ]


def empty(grid: RotaGrid) -> list[Segment]:
    return [
        Segment(p.start, p.end, None, period_index=p.index, source="generated")
        for p in grid.periods
    ]


def _paint_one(base: list[Segment], seg: Segment) -> list[Segment]:
    out: list[Segment] = []
    for b in base:
        if not b.overlaps(seg.start, seg.end):
            out.append(b)
            continue
        if b.start < seg.start:
            out.append(replace(b, end=seg.start))
        if seg.end < b.end:
            out.append(replace(b, start=seg.end))
    out.append(seg)
    out.sort(key=lambda s: s.start)
    return out


def _split_at_periods(segments: list[Segment], grid: RotaGrid) -> list[Segment]:
    out: list[Segment] = []
    for seg in segments:
        for p in grid.periods:
            s = max(seg.start, p.start)
            e = min(seg.end, p.end)
            if s < e:
                out.append(replace(seg, start=s, end=e, period_index=p.index))
    return out


def _merge_notes(a: str, b: str) -> str:
    if not a:
        return b
    if not b or b == a:
        return a
    return f"{a}; {b}"


def merge(segments: list[Segment]) -> list[Segment]:
    out: list[Segment] = []
    for seg in segments:
        if (
            out
            and out[-1].end == seg.start
            and out[-1].user_id == seg.user_id
            and out[-1].period_index == seg.period_index
            and out[-1].locked == seg.locked
        ):
            prev = out[-1]
            source = prev.source if prev.source != "generated" else seg.source
            out[-1] = replace(
                prev, end=seg.end, source=source, note=_merge_notes(prev.note, seg.note)
            )
        else:
            out.append(replace(seg))
    return out


def paint(base: list[Segment], grid: RotaGrid, updates: list[Segment]) -> list[Segment]:
    """Paint ``base`` then ``updates`` (in order, later wins) onto an empty rota and normalise.

    ``base`` need not be a valid tiling (e.g. imported rows); gaps become uncovered time.
    """
    result = empty(grid)
    for u in [*base, *updates]:
        s = max(u.start, grid.start)
        e = min(u.end, grid.end)
        if s < e:
            result = _paint_one(result, replace(u, start=s, end=e))
    return merge(_split_at_periods(result, grid))


def reassign(
    segments: list[Segment],
    grid: RotaGrid,
    start: datetime,
    end: datetime,
    user_id: int | None,
    *,
    locked: bool = False,
    source: str = "manual",
    note: str = "",
) -> list[Segment]:
    return paint(
        segments,
        grid,
        [Segment(start, end, user_id, locked=locked, source=source, note=note)],
    )


def within(segments: list[Segment], start: datetime, end: datetime) -> list[Segment]:
    """Segments overlapping [start, end), clipped to it."""
    out = []
    for s in segments:
        if s.overlaps(start, end):
            out.append(replace(s, start=max(s.start, start), end=min(s.end, end)))
    return out


def holders(segments: list[Segment], start: datetime, end: datetime) -> set[int | None]:
    return {s.user_id for s in within(segments, start, end)}


def period_owner(segments: list[Segment], period: Period) -> int | None:
    """The person holding most of the period (ties -> earliest)."""
    totals: dict[int, float] = defaultdict(float)
    first_seen: dict[int, datetime] = {}
    for s in within(segments, period.start, period.end):
        if s.user_id is None:
            continue
        totals[s.user_id] += s.seconds
        first_seen.setdefault(s.user_id, s.start)
    if not totals:
        return None
    return max(totals, key=lambda u: (totals[u], -first_seen[u].timestamp()))


def day_assignments(segments: list[Segment], grid: RotaGrid) -> list[list[Segment]]:
    """For each day slot, the clipped segments covering it."""
    out: list[list[Segment]] = []
    j = 0
    n = len(segments)
    for slot in grid.days:
        while j < n and segments[j].end <= slot.start:
            j += 1
        k = j
        pieces = []
        while k < n and segments[k].start < slot.end:
            s = segments[k]
            pieces.append(replace(s, start=max(s.start, slot.start), end=min(s.end, slot.end)))
            k += 1
        out.append(pieces)
    return out


def day_majority(pieces: list[Segment]) -> int | None:
    totals: dict[int | None, float] = defaultdict(float)
    for p in pieces:
        totals[p.user_id] += p.seconds
    if not totals:
        return None
    return max(totals, key=lambda u: totals[u])


def user_seconds(segments: list[Segment]) -> dict[int, float]:
    totals: dict[int, float] = defaultdict(float)
    for s in segments:
        if s.user_id is not None:
            totals[s.user_id] += s.seconds
    return dict(totals)
