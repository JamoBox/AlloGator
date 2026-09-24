"""Optimal rota assignment using OR-Tools CP-SAT.

The rota is a sequence of day slots grouped into periods (e.g. weeks). Every day slot gets at
most one person. Priorities, from most to least important (encoded as objective weights):

1. Cover every day that anyone can cover.
2. Give each period to a single person. Partial cover (someone else covering part of a
   period) is exceptional: minimise the number of split periods, then the number of covered
   days, then the number of mid-period handovers.
3. Avoid days people marked as "partially available".
4. Share the load fairly (sum of squared on-call days, offset by recent history).
5. Share unpopular days (public holidays, team special days) fairly over time: sum of
   squared holiday counts, including holidays covered in recent rotas.
6. Avoid giving someone back-to-back periods (and, more weakly, a gap of just one period).
7. Seeded random tie-breaking, so "regenerate" can offer a different, equally good rota.

Hard constraints: nobody is scheduled on a day they marked unavailable, and pinned days
(locked by a leader) keep their assignment. Partial cover only happens on days a period's owner
is unavailable, which is what keeps the model small and the solver snappy.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

log = logging.getLogger(__name__)

W_UNCOVERED = 1_000_000
W_SPLIT_PERIOD = 50_000
W_LIMITED_DAY = 5_000
W_COVER_DAY = 2_000
W_HANDOVER = 1_000
W_BACK_TO_BACK = 1_500
W_GAP_ONE = 300
W_FAIRNESS = 20
W_HOLIDAY_FAIRNESS = 250
W_RANDOM_MAX = 20


@dataclass
class SolverInput:
    num_days: int
    periods: list[tuple[int, int]]  # [first_day, end_day) per period
    members: list[int]  # people eligible for on-call
    unavailable: dict[int, set[int]] = field(default_factory=dict)  # user -> day indices
    limited: dict[int, set[int]] = field(default_factory=dict)  # user -> day indices
    history: dict[int, int] = field(default_factory=dict)  # user -> fairness offset (days)
    pinned: dict[int, int | None] = field(default_factory=dict)  # day -> user (None = gap)
    previous_owner: int | None = None  # on call immediately before the rota starts
    holidays: set[int] = field(default_factory=set)  # day indices of unpopular days
    holiday_history: dict[int, int] = field(default_factory=dict)  # user -> recent holiday days
    avoid_back_to_back: bool = True
    seed: int = 0
    time_limit: float = 10.0  # hard cap
    stall_seconds: float = 2.0  # stop once the best solution hasn't improved for this long
    workers: int = 8


@dataclass
class SolverResult:
    assignment: list[int | None]  # per day
    owners: list[int | None]  # per period
    status: str
    objective: float | None
    wall_time: float
    uncovered_days: list[int]


def solve(inp: SolverInput) -> SolverResult:
    """Period-first model: each period gets an owner who covers every day they're available
    (and not pinned to someone else). Cover variables exist only for days an owner might be
    unavailable, which keeps the model small so CP-SAT converges quickly."""
    started = time.monotonic()
    rng = random.Random(inp.seed)
    members = list(dict.fromkeys(inp.members))
    unav = {u: inp.unavailable.get(u, set()) for u in members}
    limited = {u: inp.limited.get(u, set()) for u in members}
    n_periods = len(inp.periods)
    period_of = [0] * inp.num_days
    for p, (a, b) in enumerate(inp.periods):
        for d in range(a, b):
            period_of[d] = p
    open_days = [d for d in range(inp.num_days) if d not in inp.pinned]

    m = cp_model.CpModel()
    objective: list = []

    # y[u, p]: u owns period p (covers its open days that they're available for).
    y: dict[tuple[int, int], cp_model.IntVar] = {}
    for p, (a, b) in enumerate(inp.periods):
        if not any(d not in inp.pinned for d in range(a, b)):
            continue  # fully pinned: no owner needed
        owners_p = []
        for u in members:
            y[u, p] = m.new_bool_var(f"y_{u}_{p}")
            owners_p.append(y[u, p])
        if owners_p:
            m.add_exactly_one(owners_p)

    # c[v, d]: v covers open day d because the owner can't.
    c: dict[tuple[int, int], cp_model.IntVar] = {}
    need: dict[int, list] = {}
    uncovered: dict[int, cp_model.IntVar] = {}
    for d in open_days:
        p = period_of[d]
        blocked_owners = [y[u, p] for u in members if (u, p) in y and d in unav[u]]
        if not blocked_owners:
            continue
        need[d] = blocked_owners
        covers = []
        for v in members:
            if d in unav[v]:
                continue
            c[v, d] = m.new_bool_var(f"c_{v}_{d}")
            m.add_implication(y[v, p], c[v, d].Not())  # the owner doesn't "cover" their own day
            covers.append(c[v, d])
        unc = m.new_bool_var(f"unc_{d}")
        uncovered[d] = unc
        m.add(sum(covers) + unc == sum(blocked_owners))
    if not members:
        for d in open_days:
            uncovered[d] = m.new_constant(1)
    objective.append(W_UNCOVERED * sum(uncovered.values()))

    # Partial cover: split periods, cover days and mid-period handovers.
    period_starts = {a for a, _ in inp.periods}
    for p, (a, b) in enumerate(inp.periods):
        terms = [c[v, d] for d in range(a, b) for v in members if (v, d) in c]
        if not terms:
            continue
        split = m.new_bool_var(f"split_{p}")
        m.add(sum(terms) <= (b - a) * split)
        objective.append(W_SPLIT_PERIOD * split)
        objective.append(W_COVER_DAY * sum(terms))
        for v in members:
            for d in range(a, b):
                if (v, d) not in c:
                    continue
                # A cover stint starting mid-period (a handover to v and later back).
                prev = c.get((v, d - 1)) if d - 1 >= a else None
                start = m.new_bool_var(f"s_{v}_{d}")
                m.add(start >= c[v, d] - prev if prev is not None else start >= c[v, d])
                objective.append(W_HANDOVER * (2 if d not in period_starts else 1) * start)

    # Per-person day counts as linear expressions.
    pinned_count = {u: sum(1 for w in inp.pinned.values() if w == u) for u in members}

    def owned_days(u: int, p: int, pred=lambda d: True) -> int:
        a, b = inp.periods[p]
        return sum(1 for d in range(a, b) if d not in inp.pinned and d not in unav[u] and pred(d))

    load = {}
    for u in members:
        terms = [owned_days(u, p) * y[u, p] for p in range(n_periods) if (u, p) in y]
        terms += [c[u, d] for d in open_days if (u, d) in c]
        load[u] = sum(terms) + pinned_count[u]

    # Partially-available days worked (by owners or covers).
    for u in members:
        if not limited[u]:
            continue
        for p in range(n_periods):
            if (u, p) in y:
                n = owned_days(u, p, lambda d, u=u: d in limited[u])
                if n:
                    objective.append(W_LIMITED_DAY * n * y[u, p])
        for d in limited[u]:
            if (u, d) in c:
                objective.append(W_LIMITED_DAY * c[u, d])

    # Fairness: minimise sum of squares of (days this rota + history offset).
    for u in members:
        offset = int(inp.history.get(u, 0))
        lo, hi = min(0, offset), inp.num_days + max(0, offset)
        total = m.new_int_var(lo, hi, f"total_{u}")
        m.add(total == load[u] + offset)
        sq = m.new_int_var(0, max(lo * lo, hi * hi), f"sq_{u}")
        m.add_multiplication_equality(sq, [total, total])
        objective.append(W_FAIRNESS * sq)

    # Unpopular days: spread them out, taking recent history into account. The squared total
    # (history + k)^2 is written exactly as increasing step costs over ordered booleans
    # (k >= 1, k >= 2, ...), which CP-SAT handles far better than a multiplication.
    if inp.holidays:
        n_hol = len(inp.holidays)
        for u in members:
            hist = max(0, int(inp.holiday_history.get(u, 0)))
            terms = [
                owned_days(u, p, lambda d: d in inp.holidays) * y[u, p]
                for p in range(n_periods)
                if (u, p) in y
            ]
            terms += [c[u, d] for d in inp.holidays if (u, d) in c]
            pinned_hol = sum(1 for d, w in inp.pinned.items() if w == u and d in inp.holidays)
            steps = [m.new_bool_var(f"hol_{u}_{j}") for j in range(1, n_hol + 1)]
            for a, b in zip(steps, steps[1:], strict=False):
                m.add_implication(b, a)
            m.add(sum(steps) == sum(terms) + pinned_hol)
            for j, step in enumerate(steps, start=1):
                objective.append(W_HOLIDAY_FAIRNESS * (2 * hist + 2 * j - 1) * step)

    # Spacing between one person's periods.
    if inp.avoid_back_to_back:
        for u in members:
            if inp.previous_owner == u and (u, 0) in y:
                objective.append(W_BACK_TO_BACK * y[u, 0])
            for p in range(n_periods):
                if (u, p) not in y:
                    continue
                if (u, p + 1) in y:
                    bb = m.new_bool_var(f"bb_{u}_{p}")
                    m.add(bb >= y[u, p] + y[u, p + 1] - 1)
                    objective.append(W_BACK_TO_BACK * bb)
                if (u, p + 2) in y:
                    g1 = m.new_bool_var(f"g1_{u}_{p}")
                    m.add(g1 >= y[u, p] + y[u, p + 2] - 1)
                    objective.append(W_GAP_ONE * g1)

    # Seeded tie-breaking.
    for var in y.values():
        objective.append(rng.randint(0, W_RANDOM_MAX) * var)

    m.minimize(sum(objective))
    _add_greedy_hint(m, inp, y, members, unav)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.5, inp.time_limit)
    solver.parameters.num_workers = max(1, inp.workers)
    solver.parameters.random_seed = inp.seed % (2**31)
    status = _solve_with_stall_limit(solver, m, inp.stall_seconds)
    status_name = solver.status_name(status)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log.warning("CP-SAT returned %s; falling back to greedy assignment", status_name)
        return _greedy(inp, started, status_name)

    owners: list[int | None] = [None] * n_periods
    for (u, p), var in y.items():
        if solver.value(var):
            owners[p] = u
    assignment: list[int | None] = [None] * inp.num_days
    for d in range(inp.num_days):
        if d in inp.pinned:
            assignment[d] = inp.pinned[d]
            continue
        owner = owners[period_of[d]]
        if owner is not None and d not in unav[owner]:
            assignment[d] = owner
            continue
        for v in members:
            if (v, d) in c and solver.value(c[v, d]):
                assignment[d] = v
                break
    return SolverResult(
        assignment=assignment,
        owners=owners,
        status=status_name.lower(),
        objective=solver.objective_value,
        wall_time=time.monotonic() - started,
        uncovered_days=[d for d, a in enumerate(assignment) if a is None],
    )


def _add_greedy_hint(m, inp: SolverInput, y, members, unav) -> None:
    """Hint a sensible starting point (least-loaded, most-available owner per period, avoiding
    back-to-back) so the first solution CP-SAT finds is already decent."""
    load = {u: int(inp.history.get(u, 0)) for u in members}
    prev = inp.previous_owner
    for p, (a, b) in enumerate(inp.periods):
        cands = [u for u in members if (u, p) in y]
        if not cands:
            continue
        best = min(
            cands,
            key=lambda u: (sum(1 for d in range(a, b) if d in unav[u]), u == prev, load[u]),
        )
        for u in cands:
            m.add_hint(y[u, p], 1 if u == best else 0)
        load[best] += b - a
        prev = best


# Improvements smaller than this are tie-break noise (random costs are at most W_RANDOM_MAX per
# choice; the smallest real gain, one step of day fairness, is 2 * W_FAIRNESS).
SIGNIFICANT_IMPROVEMENT = 30


class _Progress(cp_model.CpSolverSolutionCallback):
    def __init__(self) -> None:
        super().__init__()
        self.best: float | None = None
        self.last_improvement = time.monotonic()

    def on_solution_callback(self) -> None:
        obj = self.objective_value
        if self.best is None or obj < self.best - SIGNIFICANT_IMPROVEMENT:
            self.last_improvement = time.monotonic()
        if self.best is None or obj < self.best:
            self.best = obj


def _solve_with_stall_limit(solver: cp_model.CpSolver, model: cp_model.CpModel, stall: float):
    """Solve, but stop early once the incumbent hasn't improved for ``stall`` seconds.

    CP-SAT typically finds the optimum quickly and then spends most of its time proving it;
    for an interactive "generate" button a good solution now beats a proof later."""
    progress = _Progress()
    done = threading.Event()

    def watchdog() -> None:
        while not done.wait(0.1):
            if progress.best is not None and time.monotonic() - progress.last_improvement > stall:
                solver.stop_search()
                return

    thread = threading.Thread(target=watchdog, daemon=True)
    if stall > 0:
        thread.start()
    try:
        return solver.solve(model, progress)
    finally:
        done.set()


def _greedy(inp: SolverInput, started: float, status_name: str) -> SolverResult:
    """Simple fallback: whole periods to the least-loaded fully-available person,
    otherwise day-by-day."""
    load = {u: inp.history.get(u, 0) for u in inp.members}
    assignment: list[int | None] = [None] * inp.num_days
    owners: list[int | None] = [None] * len(inp.periods)
    prev_owner = inp.previous_owner

    def free(u: int, d: int) -> bool:
        return d not in inp.unavailable.get(u, set())

    for p, (a, b) in enumerate(inp.periods):
        open_days = [d for d in range(a, b) if d not in inp.pinned]
        for d in range(a, b):
            if d in inp.pinned:
                assignment[d] = inp.pinned[d]
        full = [u for u in inp.members if all(free(u, d) for d in open_days)]
        full.sort(key=lambda u: (u == prev_owner, load[u]))
        if full:
            owner = full[0]
            for d in open_days:
                assignment[d] = owner
            load[owner] += len(open_days)
        else:
            for d in open_days:
                cands = sorted((u for u in inp.members if free(u, d)), key=lambda u: load[u])
                if cands:
                    assignment[d] = cands[0]
                    load[cands[0]] += 1
        counts: dict[int, int] = {}
        for d in range(a, b):
            if assignment[d] is not None:
                counts[assignment[d]] = counts.get(assignment[d], 0) + 1
        owners[p] = max(counts, key=counts.get) if counts else None
        prev_owner = owners[p]
    return SolverResult(
        assignment=assignment,
        owners=owners,
        status=f"greedy ({status_name.lower()})",
        objective=None,
        wall_time=time.monotonic() - started,
        uncovered_days=[d for d, a in enumerate(assignment) if a is None],
    )
