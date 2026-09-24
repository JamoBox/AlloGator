from datetime import date, datetime, timedelta

from allogator.services import segments as seg
from allogator.services.slots import RotaGrid


def test_grid_basic_utc():
    g = RotaGrid(date(2026, 1, 5), 2, 7, "09:00", "UTC")
    assert len(g.days) == 14
    assert len(g.periods) == 2
    assert g.start == datetime(2026, 1, 5, 9)
    assert g.end == datetime(2026, 1, 19, 9)
    assert g.periods[1].start == datetime(2026, 1, 12, 9)
    assert g.day_index(date(2026, 1, 12)) == 7
    assert g.day_index(date(2026, 1, 19)) is None
    assert g.slot_at(datetime(2026, 1, 12, 8, 59)).index == 6
    assert g.slot_at(datetime(2026, 1, 12, 9)).index == 7
    assert g.slot_at(datetime(2026, 1, 19, 9)) is None


def test_grid_handles_dst():
    # UK clocks go back on Sunday 25 Oct 2026: that day slot is 25 hours long.
    g = RotaGrid(date(2026, 10, 19), 1, 7, "09:00", "Europe/London")
    lengths = [(s.end - s.start) for s in g.days]
    assert lengths[5] == timedelta(hours=25)  # Sat 24 09:00 -> Sun 25 09:00
    assert sum(lengths, timedelta()) == timedelta(days=7, hours=1)
    # 09:00 BST = 08:00 UTC before; 09:00 GMT = 09:00 UTC after.
    assert g.days[0].start == datetime(2026, 10, 19, 8)
    assert g.days[6].start == datetime(2026, 10, 25, 9)
    for dt in (g.days[5].start, g.days[5].start + timedelta(hours=24, minutes=30)):
        assert g.slot_at(dt).index == 5


def _assert_tiles(segs, grid):
    assert segs[0].start == grid.start
    assert segs[-1].end == grid.end
    for a, b in zip(segs, segs[1:], strict=False):
        assert a.end == b.start
        assert a.start < a.end
    for s in segs:
        p = grid.periods[s.period_index]
        assert p.start <= s.start and s.end <= p.end


def test_paint_splits_and_merges():
    g = RotaGrid(date(2026, 1, 5), 2, 7, "09:00", "UTC")
    segs = seg.paint([], g, [seg.Segment(g.start, g.end, 1)])
    # Split at the period boundary.
    assert [(s.user_id, s.period_index) for s in segs] == [(1, 0), (1, 1)]
    _assert_tiles(segs, g)

    wed = g.days[2]
    segs = seg.reassign(segs, g, wed.start, wed.end, 2)
    assert [s.user_id for s in segs] == [1, 2, 1, 1]
    _assert_tiles(segs, g)

    # Reassigning back to 1 (with the same lock state) re-merges.
    segs = seg.reassign(segs, g, wed.start, wed.end, 1, locked=False)
    assert [s.user_id for s in segs] == [1, 1]

    # Sub-day reassignment.
    segs = seg.reassign(segs, g, wed.start + timedelta(hours=4), wed.start + timedelta(hours=8), 3)
    assert [s.user_id for s in segs] == [1, 3, 1, 1]
    _assert_tiles(segs, g)
    assert seg.holders(segs, wed.start, wed.end) == {1, 3}
    assert seg.period_owner(segs, g.periods[0]) == 1


def test_paint_fills_gaps_and_clips():
    g = RotaGrid(date(2026, 1, 5), 1, 7, "09:00", "UTC")
    segs = seg.paint(
        [],
        g,
        [
            seg.Segment(g.start - timedelta(days=3), g.days[1].end, 5),
            seg.Segment(g.days[4].start, g.end + timedelta(days=2), 6),
        ],
    )
    _assert_tiles(segs, g)
    assert [s.user_id for s in segs] == [5, None, 6]


def test_day_assignments_and_majority():
    g = RotaGrid(date(2026, 1, 5), 1, 3, "09:00", "UTC")
    segs = seg.paint([], g, [seg.Segment(g.start, g.end, 1)])
    d1 = g.days[1]
    segs = seg.reassign(segs, g, d1.start, d1.start + timedelta(hours=16), 2)
    per_day = seg.day_assignments(segs, g)
    assert [len(p) for p in per_day] == [1, 2, 1]
    assert seg.day_majority(per_day[1]) == 2
