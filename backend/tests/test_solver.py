from collections import Counter

from allogator.services.solver import SolverInput, solve


def weeks(n, length=7):
    return [(i * length, (i + 1) * length) for i in range(n)]


def run(**kw):
    kw.setdefault("time_limit", 5)
    kw.setdefault("stall_seconds", 1)
    kw.setdefault("workers", 4)
    kw.setdefault("seed", 1)
    return solve(SolverInput(**kw))


def owners_by_period(res, periods):
    return [res.assignment[a:b] for a, b in periods]


def test_everyone_available_gets_whole_weeks_evenly_without_back_to_back():
    periods = weeks(8)
    res = run(num_days=56, periods=periods, members=[1, 2, 3, 4])
    for week in owners_by_period(res, periods):
        assert len(set(week)) == 1, "no partial cover when everyone is free"
    counts = Counter(res.owners)
    assert sorted(counts.values()) == [2, 2, 2, 2]
    for a, b in zip(res.owners, res.owners[1:], strict=False):
        assert a != b
    assert res.uncovered_days == []


def test_unavailability_is_a_hard_constraint():
    periods = weeks(4)
    unavailable = {1: set(range(0, 14)), 2: set(range(14, 28))}
    res = run(num_days=28, periods=periods, members=[1, 2, 3], unavailable=unavailable)
    for d, u in enumerate(res.assignment):
        assert u is not None
        assert d not in unavailable.get(u, set())


def test_days_nobody_can_cover_are_left_uncovered():
    periods = weeks(1)
    unavailable = {1: {3}, 2: {3}}
    res = run(num_days=7, periods=periods, members=[1, 2], unavailable=unavailable)
    assert res.uncovered_days == [3]
    # The rest of the week stays with one person rather than being split.
    others = {res.assignment[d] for d in range(7) if d != 3}
    assert len(others) == 1


def test_partial_cover_only_when_nobody_can_do_the_whole_week():
    periods = weeks(2)
    # Week 0: A is away Wed-Thu, B is away Mon; C is away all week. Nobody covers it fully.
    # Week 1: everyone is free.
    unavailable = {1: {2, 3}, 2: {0}, 3: set(range(7))}
    res = run(num_days=14, periods=periods, members=[1, 2, 3], unavailable=unavailable)
    week0, week1 = owners_by_period(res, periods)
    assert len(set(week1)) == 1
    assert len(set(week0)) == 2, "exactly one split"
    # Minimal cover: the split should cover as few days as possible (1 day: B covers... no,
    # A misses 2 days, B misses 1 day -> B owns the week and A covers Monday).
    assert Counter(week0) == Counter({2: 6, 1: 1})
    assert res.assignment[0] == 1


def test_partially_available_days_are_avoided_when_possible():
    periods = weeks(1)
    res = run(num_days=7, periods=periods, members=[1, 2], limited={1: {4}}, history={1: -3})
    # Person 1 is "behind" on load so fairness prefers them, but they flagged limited
    # availability; person 2 is fully free.
    assert set(res.assignment) == {2}


def test_limited_day_preferred_over_splitting_a_week():
    periods = weeks(1)
    res = run(
        num_days=7,
        periods=periods,
        members=[1, 2],
        unavailable={2: {1}},
        limited={1: {4}},
    )
    assert set(res.assignment) == {1}


def test_pinned_days_are_respected():
    periods = weeks(2)
    pinned = {d: 3 for d in range(7, 14)}
    res = run(num_days=14, periods=periods, members=[1, 2], pinned=pinned)
    assert res.assignment[7:14] == [3] * 7
    assert 3 not in res.assignment[:7]


def test_pinned_gap_stays_empty():
    res = run(num_days=7, periods=weeks(1), members=[1], pinned={2: None})
    assert res.assignment[2] is None


def test_history_offsets_shift_the_load():
    periods = weeks(3)
    res = run(num_days=21, periods=periods, members=[1, 2, 3, 4], history={1: 14, 2: 14})
    counts = Counter(res.owners)
    assert counts[1] == 0 and counts[2] == 0
    assert counts[3] + counts[4] == 3


def test_previous_owner_does_not_get_first_period():
    periods = weeks(2)
    for seed in range(3):
        res = run(num_days=14, periods=periods, members=[1, 2], previous_owner=1, seed=seed)
        assert res.owners[0] == 2


def test_regenerate_with_different_seed_can_differ_but_stays_valid():
    periods = weeks(6)
    results = {
        tuple(run(num_days=42, periods=periods, members=[1, 2, 3], seed=s).owners) for s in range(6)
    }
    for owners in results:
        assert sorted(Counter(owners).values()) == [2, 2, 2]
    assert len(results) > 1
