"""Optimal rota assignment using OR-Tools CP-SAT.

The rota is a sequence of day slots grouped into periods (e.g. weeks). Every day slot gets at
most one person. Priorities, from most to least important (encoded as objective weights):

1. Cover every day that anyone can cover.
2. Give each period to a single person. Partial cover (someone else covering part of a
   period) is exceptional: minimise the number of split periods, then the number of covered
   days, then the number of mid-period handovers.
3. Avoid days people marked as "partially available".
4. Share the load fairly (sum of squared on-call days, offset by recent history).
5. Avoid giving someone back-to-back periods (and, more weakly, a gap of just one period).
6. Seeded random tie-breaking, so "regenerate" can offer a different, equally good rota.

Hard constraints: nobody is scheduled on a day they marked unavailable, and pinned days
(locked by a leader) keep their assignment.
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
    started = time.monotonic()
    rng = random.Random(inp.seed)
    members = list(dict.fromkeys(inp.members))
    pinned_users = {u for u in inp.pinned.values() if u is not None}
    people = members + [u for u in sorted(pinned_users) if u not in members]
    member_set = set(members)

    m = cp_model.CpModel()

    # x[u, d]: person u is on call for day d.
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    for u in people:
        unavailable = inp.unavailable.get(u, set())
        for d in range(inp.num_days):
            if d in inp.pinned:
                if inp.pinned[d] == u:
                    x[u, d] = m.new_bool_var(f"x_{u}_{d}")
                    m.add(x[u, d] == 1)
                continue
            if u in member_set and d not in unavailable:
                x[u, d] = m.new_bool_var(f"x_{u}_{d}")

    by_day: dict[int, list[cp_model.IntVar]] = {d: [] for d in range(inp.num_days)}
    for (_u, d), var in x.items():
        by_day[d].append(var)

    uncovered: dict[int, cp_model.IntVar] = {}
    for d in range(inp.num_days):
        if d in inp.pinned and inp.pinned[d] is None:
            continue  # deliberately left empty by a leader
        unc = m.new_bool_var(f"unc_{d}")
        uncovered[d] = unc
        m.add(sum(by_day[d]) + unc == 1)
    for d, u in inp.pinned.items():
        if u is None:
            m.add(sum(by_day[d]) == 0)

    objective: list = []
    objective.append(W_UNCOVERED * sum(uncovered.values()))

    # y[u, p]: person u "owns" period p. Owner days are free; other people's days are cover.
    y: dict[tuple[int, int], cp_model.IntVar] = {}
    for p, (a, b) in enumerate(inp.periods):
        owners_p = []
        split = m.new_bool_var(f"split_{p}")
        cover_terms = []
        for u in people:
            days_u = [x[u, d] for d in range(a, b) if (u, d) in x]
            if not days_u:
                continue
            yv = m.new_bool_var(f"y_{u}_{p}")
            y[u, p] = yv
            owners_p.append(yv)
            m.add(yv <= sum(days_u))
            for d in range(a, b):
                if (u, d) not in x:
                    continue
                # own = x AND y ; cover = x AND NOT y
                own = m.new_bool_var(f"own_{u}_{d}")
                m.add(own <= x[u, d])
                m.add(own <= yv)
                cover_terms.append(x[u, d] - own)
        if owners_p:
            m.add(sum(owners_p) <= 1)
        if cover_terms:
            m.add(sum(cover_terms) <= (b - a) * split)
            objective.append(W_COVER_DAY * sum(cover_terms))
        objective.append(W_SPLIT_PERIOD * split)

    # Mid-period handovers: a person starting a stint on a day that is not a period start.
    period_starts = {a for a, _ in inp.periods}
    for u in people:
        for d in range(inp.num_days):
            if d in period_starts or (u, d) not in x:
                continue
            prev = x.get((u, d - 1))
            start = m.new_bool_var(f"start_{u}_{d}")
            if prev is None:
                m.add(start >= x[u, d])
            else:
                m.add(start >= x[u, d] - prev)
            objective.append(W_HANDOVER * start)

    # Partially-available days.
    for u in people:
        for d in inp.limited.get(u, set()):
            if (u, d) in x and inp.pinned.get(d) != u:
                objective.append(W_LIMITED_DAY * x[u, d])

    # Fairness: minimise sum of squares of (days this rota + history offset).
    for u in members:
        load_terms = [x[u, d] for d in range(inp.num_days) if (u, d) in x]
        offset = int(inp.history.get(u, 0))
        lo = min(0, offset)
        hi = inp.num_days + max(0, offset)
        total = m.new_int_var(lo, hi, f"total_{u}")
        m.add(total == sum(load_terms) + offset)
        sq = m.new_int_var(0, max(lo * lo, hi * hi), f"sq_{u}")
        m.add_multiplication_equality(sq, [total, total])
        objective.append(W_FAIRNESS * sq)

    # Spacing between one person's periods.
    if inp.avoid_back_to_back:
        n_periods = len(inp.periods)
        for u in people:
            for p in range(n_periods):
                if (u, p) not in y:
                    continue
                if p == 0 and inp.previous_owner == u:
                    objective.append(W_BACK_TO_BACK * y[u, 0])
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

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.5, inp.time_limit)
    solver.parameters.num_workers = max(1, inp.workers)
    solver.parameters.random_seed = inp.seed % (2**31)
    status = _solve_with_stall_limit(solver, m, inp.stall_seconds)
    status_name = solver.status_name(status)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log.warning("CP-SAT returned %s; falling back to greedy assignment", status_name)
        return _greedy(inp, started, status_name)

    assignment: list[int | None] = [None] * inp.num_days
    for (u, d), var in x.items():
        if solver.value(var):
            assignment[d] = u
    owners: list[int | None] = [None] * len(inp.periods)
    for (u, p), var in y.items():
        if solver.value(var):
            owners[p] = u
    return SolverResult(
        assignment=assignment,
        owners=owners,
        status=status_name.lower(),
        objective=solver.objective_value,
        wall_time=time.monotonic() - started,
        uncovered_days=[d for d, a in enumerate(assignment) if a is None],
    )


class _Progress(cp_model.CpSolverSolutionCallback):
    def __init__(self) -> None:
        super().__init__()
        self.best: float | None = None
        self.last_improvement = time.monotonic()

    def on_solution_callback(self) -> None:
        obj = self.objective_value
        if self.best is None or obj < self.best - 1e-9:
            self.best = obj
            self.last_improvement = time.monotonic()


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
