from datetime import date, timedelta

from allogator.services.solver import SolverInput, solve

from .test_api_flow import MEMBERS, make_team, uid


def weeks(n):
    return [(i * 7, (i + 1) * 7) for i in range(n)]


def test_solver_shares_holidays_by_history():
    # Day 3 is a public holiday. Person 1 has done 3 holidays recently, person 2 none.
    for seed in range(3):
        res = solve(
            SolverInput(
                num_days=14,
                periods=weeks(2),
                members=[1, 2],
                holidays={3},
                holiday_history={1: 3},
                seed=seed,
                time_limit=5,
                stall_seconds=0.5,
                workers=2,
            )
        )
        assert res.owners[0] == 2


def test_holiday_settings_and_special_days(api):
    team = make_team(api, "Hols")
    countries = api.get("/api/holidays/countries").json()
    gb = next(c for c in countries if c["code"] == "GB")
    assert {"code": "ENG", "name": "England"} in gb["subdivisions"]

    api.patch(f"/api/teams/{team['id']}", json={"holiday_country": "XX"}, expect=400)
    api.patch(
        f"/api/teams/{team['id']}",
        json={"holiday_country": "GB", "holiday_subdivision": "NOPE"},
        expect=400,
    )
    t = api.patch(
        f"/api/teams/{team['id']}",
        json={"holiday_country": "GB", "holiday_subdivision": "ENG"},
    ).json()
    assert (t["holiday_country"], t["holiday_subdivision"]) == ("GB", "ENG")

    # Custom special day (leaders only) + public holidays listed together.
    amy = api.as_("amy@example.com")
    amy.post(
        f"/api/teams/{team['id']}/special-days",
        json={"date": "2026-11-27", "label": "Black Friday"},
        expect=403,
    )
    sd = api.post(
        f"/api/teams/{team['id']}/special-days",
        json={"date": "2026-11-27", "label": "Black Friday"},
        expect=201,
    ).json()
    listed = amy.get(f"/api/teams/{team['id']}/special-days?from=2026-11-01&to=2026-12-31").json()
    labels = {(d["date"], d["label"], d["source"]) for d in listed}
    assert ("2026-11-27", "Black Friday", "custom") in labels
    assert ("2026-12-25", "Christmas Day", "public") in labels
    mine = amy.get("/api/me/special-days?from=2026-12-20&to=2026-12-31").json()
    assert any(d["label"] == "Christmas Day" and d["team_name"] == "Hols" for d in mine)

    # Rota days carry the label.
    rota = api.post(
        f"/api/teams/{team['id']}/rotas",
        json={"start_date": "2026-11-23", "num_periods": 5},
        expect=201,
    ).json()
    by_date = {d["date"]: d["holiday"] for d in rota["days"]}
    assert by_date["2026-11-27"] == "Black Friday"
    assert by_date["2026-12-25"] == "Christmas Day"
    assert by_date["2026-12-24"] is None

    api.delete(f"/api/teams/{team['id']}/special-days/{sd['id']}")
    rota = api.get(f"/api/rotas/{rota['id']}").json()
    assert {d["date"]: d["holiday"] for d in rota["days"]}["2026-11-27"] is None


def _published(api, team_id, start, periods, assignments):
    """Create and publish a rota with explicit assignments [(user_id, from, to), ...]."""
    rota = api.post(
        f"/api/teams/{team_id}/rotas",
        json={"start_date": start, "num_periods": periods},
        expect=201,
    ).json()
    for user_id, a, b in assignments:
        api.post(
            f"/api/rotas/{rota['id']}/assign",
            json={"user_id": user_id, "from_date": a, "to_date": b},
        )
    api.post(f"/api/rotas/{rota['id']}/publish")
    return rota


def test_hints_for_a_christmas_nobody_can_do(api):
    team = make_team(api, "Xmas")
    api.patch(
        f"/api/teams/{team['id']}", json={"holiday_country": "GB", "holiday_subdivision": "ENG"}
    )
    ids = {e: uid(team, e) for e in ["leader@example.com", *MEMBERS]}
    # Only the three members are on call; the leader isn't.
    api.patch(
        f"/api/teams/{team['id']}/members/{ids['leader@example.com']}", json={"on_call": False}
    )
    amy, ben, cat = (ids[e] for e in MEMBERS)

    # Last year: Ben did Christmas week; Cat stepped in for two days of Amy's week.
    _published(
        api,
        team["id"],
        "2025-12-22",
        2,
        [
            (ben, "2025-12-22", "2025-12-28"),
            (amy, "2025-12-29", "2026-01-04"),
            (cat, "2025-12-30", "2025-12-31"),
        ],
    )

    # This year: everybody marks Christmas Day as unavailable.
    for email in MEMBERS:
        api.as_(email).post(
            "/api/me/unavailability",
            json={"dates": ["2026-12-25"], "kind": "unavailable", "note": "Family"},
        )
    rota = api.post(
        f"/api/teams/{team['id']}/rotas",
        json={"start_date": "2026-12-21", "num_periods": 2},
        expect=201,
    ).json()
    res = api.post(f"/api/rotas/{rota['id']}/generate", json={"seed": 1}).json()
    uncovered = [i for i in res["analysis"]["issues"] if i["type"] == "uncovered"]
    assert len(uncovered) == 1
    assert "Christmas Day" in uncovered[0]["title"]

    # Members can't see the hints; leaders can.
    api.as_("amy@example.com").get(f"/api/rotas/{rota['id']}/hints?from=2026-12-25", expect=403)
    api.get(f"/api/rotas/{rota['id']}/hints?from=2027-02-01", expect=400)
    hints = api.get(f"/api/rotas/{rota['id']}/hints?from=2026-12-25").json()
    assert hints["everyone_unavailable"] is True
    assert hints["labels"] == {"2026-12-25": "Christmas Day"}
    by_user = {c["user_id"]: c for c in hints["candidates"]}
    assert set(by_user) == {amy, ben, cat}
    texts = {u: [h["text"] for h in c["hints"]] for u, c in by_user.items()}

    assert any("Covered Christmas Day last year (2025)" in t for t in texts[ben])
    assert any("No record of covering Christmas Day" in t for t in texts[amy])
    assert any("covered 2 extra days for teammates" in t for t in texts[cat])
    assert all(any("Said they can't cover: Family" in t for t in ts) for ts in texts.values())
    # Ben did Christmas last year, so he shouldn't be the suggestion.
    suggested = [c for c in hints["candidates"] if c["suggested"]]
    assert len(suggested) == 1 and suggested[0]["user_id"] != ben
    assert hints["candidates"][0]["suggested"]

    # The owner of Christmas week gets an "own period" hint; nobody else does.
    owner = next(p["owner_id"] for p in res["rota"]["periods"] if p["index"] == 0)
    assert any("Christmas Day falls in their own on-call period" in t for t in texts[owner])
    for u in {amy, ben, cat} - {owner}:
        assert not any("own on-call period" in t for t in texts[u])

    # Fairness stats count holidays.
    stats = {s["user_id"]: s for s in res["analysis"]["stats"]}
    assert stats[ben]["holiday_history"] >= 1  # Christmas + Boxing Day 2025
    assert sum(s["holiday_days"] for s in stats.values()) >= 2  # Boxing Day, New Year's Day
    # ...and say which days they were.
    assert "Christmas Day" in {h["label"] for h in stats[ben]["holiday_history_dates"]}
    for s in stats.values():
        assert len(s["holiday_dates"]) == s["holiday_days"]
        assert len(s["holiday_history_dates"]) == s["holiday_history"]


def test_hints_date_range_limits(api):
    team = make_team(api, "Lim")
    start = date(2026, 10, 5)
    rota = api.post(
        f"/api/teams/{team['id']}/rotas",
        json={"start_date": start.isoformat(), "num_periods": 1},
        expect=201,
    ).json()
    end = start + timedelta(days=6)
    r = api.get(f"/api/rotas/{rota['id']}/hints?from={start}&to={end}").json()
    assert len(r["dates"]) == 7
    assert len(r["candidates"]) == 4
    api.get(f"/api/rotas/{rota['id']}/hints?from={end}&to={start}", expect=400)
