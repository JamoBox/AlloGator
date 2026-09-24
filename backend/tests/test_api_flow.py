from datetime import date, datetime, timedelta

from icalendar import Calendar

from allogator.services.email import OUTBOX

LEADER = "leader@example.com"
MEMBERS = ["amy@example.com", "ben@example.com", "cat@example.com"]


def next_monday(weeks_ahead=1) -> date:
    today = date.today()
    return today + timedelta(days=(7 - today.weekday()) + 7 * (weeks_ahead - 1))


def make_team(api, name="SRE"):
    team = api.post(
        "/api/teams", json={"name": name, "timezone": "Europe/London"}, expect=201
    ).json()
    for email in MEMBERS:
        api.post(
            f"/api/teams/{team['id']}/members",
            json={"email": email, "display_name": email.split("@")[0].title()},
            expect=201,
        )
    return api.get(f"/api/teams/{team['id']}").json()


def uid(team, email):
    return next(m["user"]["id"] for m in team["members"] if m["user"]["email"] == email)


def test_full_leader_and_member_workflow(api):
    team = make_team(api)
    assert team["is_leader"] and len(team["members"]) == 4
    # New rotas default to one period per on-call person.
    assert api.get(f"/api/teams/{team['id']}/rota-defaults").json()["num_periods"] == 4
    start = next_monday(2)

    rota = api.post(
        f"/api/teams/{team['id']}/rotas",
        json={"start_date": start.isoformat(), "num_periods": 4},
        expect=201,
    ).json()
    assert rota["status"] == "planning"
    assert rota["period_days"] == 7 and len(rota["days"]) == 28
    assert rota["end_date"] == (start + timedelta(days=27)).isoformat()

    # Request dates: everyone on call is notified and emailed.
    OUTBOX.clear()
    rota = api.post(
        f"/api/rotas/{rota['id']}/request-dates",
        json={"deadline": (date.today() + timedelta(days=5)).isoformat(), "message": "Holidays!"},
    ).json()
    assert rota["status"] == "collecting"
    assert {m.to for m in OUTBOX} == {LEADER, *MEMBERS}
    amy = api.as_("amy@example.com")
    notes = amy.get("/api/notifications").json()
    assert notes[0]["kind"] == "dates_requested"
    assert amy.get("/api/me/todo").json()["dates_needed"][0]["id"] == rota["id"]

    # Members mark unavailability. Week 2 Wednesday nobody can do; Amy has a partial day.
    wk2_wed = start + timedelta(days=9)
    for email in [LEADER, *MEMBERS]:
        api.as_(email).post(
            "/api/me/unavailability",
            json={"dates": [wk2_wed.isoformat()], "kind": "unavailable", "note": "Offsite"},
        )
    amy.post(
        "/api/me/unavailability",
        json={
            "dates": [(start + timedelta(days=1)).isoformat()],
            "kind": "partial",
            "note": "busy 13:00-17:00",
        },
    )
    mine = amy.get("/api/me/unavailability").json()
    assert {e["kind"] for e in mine} == {"unavailable", "partial"}

    # Other members can see notes in the availability matrix.
    matrix = api.as_("ben@example.com").get(f"/api/rotas/{rota['id']}/availability").json()
    assert any(e["note"] == "busy 13:00-17:00" for e in matrix["entries"])

    # Leaders can see who still has to confirm.
    rota = api.get(f"/api/rotas/{rota['id']}").json()
    assert len(rota["unsubmitted"]) == 4
    amy.post(f"/api/rotas/{rota['id']}/submit", json={"comment": ""})
    rota = api.get(f"/api/rotas/{rota['id']}").json()
    assert "amy@example.com" not in {u["email"] for u in rota["unsubmitted"]}

    # Submissions; the last one notifies leaders.
    for email in [LEADER, *MEMBERS]:
        api.as_(email).post(f"/api/rotas/{rota['id']}/submit", json={"comment": ""})
    leader_notes = api.get("/api/notifications").json()
    assert any(n["kind"] == "dates_complete" for n in leader_notes)

    # Members can't generate.
    amy.post(f"/api/rotas/{rota['id']}/generate", json={}, expect=403)

    res = api.post(f"/api/rotas/{rota['id']}/generate", json={"seed": 1}).json()
    rota, analysis = res["rota"], res["analysis"]
    assert rota["status"] == "review"
    uncovered = [i for i in analysis["issues"] if i["type"] == "uncovered"]
    assert len(uncovered) == 1 and uncovered[0]["start_date"] == wk2_wed.isoformat()
    assert analysis["summary"]["split_periods"] == 0
    owners = [p["owner_id"] for p in rota["periods"]]
    assert None not in owners and len(set(owners)) == 4

    # Draft shifts are hidden from members.
    member_view = amy.get(f"/api/rotas/{rota['id']}").json()
    assert member_view["shifts_visible"] is False and member_view["shifts"] == []

    # Leader resolves the gap manually by giving Wednesday to Ben.
    ben_id = uid(team, "ben@example.com")
    rota = api.post(
        f"/api/rotas/{rota['id']}/assign",
        json={"user_id": ben_id, "from_date": wk2_wed.isoformat(), "lock": True},
    ).json()
    day = next(d for d in rota["days"] if d["date"] == wk2_wed.isoformat())
    assert day["user_ids"] == [ben_id] and day["locked"]
    analysis = api.get(f"/api/rotas/{rota['id']}/analysis").json()
    types = {i["type"] for i in analysis["issues"]}
    assert "uncovered" not in types
    # Ben said he couldn't do it, but the leader decided: noted, no longer a problem.
    conflict = next(i for i in analysis["issues"] if i["type"] == "conflict")
    assert conflict["severity"] == "info" and conflict["decided"]
    if owners[1] != ben_id:
        cover = next(i for i in analysis["issues"] if i["type"] == "partial_cover")
        assert cover["severity"] == "info" and cover["decided"]
    assert analysis["summary"]["errors"] == 0 and analysis["summary"]["warnings"] == 0

    # Availability that changes after the decision is flagged again.
    thu = wk2_wed + timedelta(days=1)
    api.post(
        f"/api/rotas/{rota['id']}/assign",
        json={"user_id": ben_id, "from_date": thu.isoformat(), "lock": True},
    )
    api.as_("ben@example.com").post(
        "/api/me/unavailability",
        json={"dates": [thu.isoformat()], "kind": "unavailable", "note": "Dentist"},
    )
    analysis = api.get(f"/api/rotas/{rota['id']}/analysis").json()
    conflicts = [i for i in analysis["issues"] if i["type"] == "conflict"]
    assert {(i["start_date"], i["severity"]) for i in conflicts} == {
        (wk2_wed.isoformat(), "info"),
        (thu.isoformat(), "error"),
    }
    # Re-confirming the assignment settles it.
    api.post(
        f"/api/rotas/{rota['id']}/assign",
        json={"user_id": ben_id, "from_date": thu.isoformat(), "lock": True},
    )
    analysis = api.get(f"/api/rotas/{rota['id']}/analysis").json()
    assert analysis["summary"]["errors"] == 0

    # Regenerate keeping locked days: the manual edit survives.
    rota = api.post(
        f"/api/rotas/{rota['id']}/generate", json={"seed": 2, "keep_locked": True}
    ).json()["rota"]
    day = next(d for d in rota["days"] if d["date"] == wk2_wed.isoformat())
    assert day["user_ids"] == [ben_id]

    # Publish: everyone notified, members see shifts and can download calendars.
    OUTBOX.clear()
    rota = api.post(f"/api/rotas/{rota['id']}/publish").json()
    assert rota["status"] == "published"
    assert {m.to for m in OUTBOX} == {LEADER, *MEMBERS}
    amy_mail = next(m for m in OUTBOX if m.to == "amy@example.com")
    assert "Your on-call shifts" in amy_mail.text
    assert amy_mail.link.startswith("https://allogator.test/teams/")
    member_view = amy.get(f"/api/rotas/{rota['id']}").json()
    assert member_view["shifts_visible"] and member_view["shifts"]

    my_shifts = amy.get("/api/me/shifts").json()
    amy_id = uid(team, "amy@example.com")
    assert my_shifts and all(s["user"]["id"] == amy_id for s in my_shifts)
    r = amy.get("/api/me/calendar.ics")
    assert r.headers["content-type"].startswith("text/calendar")
    cal = Calendar.from_ical(r.content)
    events = [c for c in cal.walk("VEVENT")]
    assert len(events) == len(my_shifts)
    assert all(str(e["summary"]) == "On call: SRE" for e in events)

    # Subscription feed works without auth headers, via the secret token.
    feed_url = amy.get("/api/me").json()["calendar_feed_url"]
    path = feed_url.replace("https://allogator.test", "")
    r = api.client.get(path)
    assert r.status_code == 200 and b"BEGIN:VCALENDAR" in r.content
    assert api.client.get("/ical/not-a-token.ics").status_code == 404

    # Team schedule view.
    sched = amy.get(f"/api/teams/{team['id']}/schedule").json()
    assert len(sched["shifts"]) >= 4

    # Editing a published rota notifies the people affected.
    cat_id = uid(team, "cat@example.com")
    target_period = next(p for p in rota["periods"] if p["owner_id"] != cat_id)
    prev_owner = target_period["owner_id"]
    api.post(
        f"/api/rotas/{rota['id']}/assign",
        json={"user_id": cat_id, "period_index": target_period["index"]},
    )
    cat_notes = api.as_("cat@example.com").get("/api/notifications").json()
    assert cat_notes[0]["kind"] == "schedule_changed"
    prev_email = next(m["user"]["email"] for m in team["members"] if m["user"]["id"] == prev_owner)
    if prev_email != LEADER:
        assert api.as_(prev_email).get("/api/notifications").json()[0]["kind"] == "schedule_changed"

    history = api.get(f"/api/rotas/{rota['id']}/history").json()
    actions = [h["action"] for h in history]
    assert "rota.published" in actions and "rota.generated" in actions


def _published_rota(api, team, weeks=4, start=None):
    start = start or next_monday(1)
    rota = api.post(
        f"/api/teams/{team['id']}/rotas",
        json={"start_date": start.isoformat(), "num_periods": weeks},
        expect=201,
    ).json()
    api.post(f"/api/rotas/{rota['id']}/generate", json={"seed": 5})
    return api.post(f"/api/rotas/{rota['id']}/publish").json()


def test_swap_request_offer_accept(api):
    team = make_team(api)
    rota = _published_rota(api, team, weeks=4)
    periods = rota["periods"]
    p0, p1 = periods[0], periods[1]
    requester_id, offerer_id = p0["owner_id"], p1["owner_id"]
    assert requester_id != offerer_id
    email = {m["user"]["id"]: m["user"]["email"] for m in team["members"]}
    requester, offerer = api.as_(email[requester_id]), api.as_(email[offerer_id])
    days = [d for d in rota["days"] if d["period_index"] == 0]
    req_start, req_end = days[2]["start_at"], days[3]["end_at"]

    # Someone else can't request a swap for a slot that isn't theirs.
    offerer.post(
        "/api/swaps",
        json={"rota_id": rota["id"], "start_at": req_start, "end_at": req_end},
        expect=409,
    )

    OUTBOX.clear()
    swap = requester.post(
        "/api/swaps",
        json={"rota_id": rota["id"], "start_at": req_start, "end_at": req_end, "note": "Wedding"},
        expect=201,
    ).json()
    assert swap["status"] == "open"
    assert email[requester_id] not in {m.to for m in OUTBOX}
    assert len(OUTBOX) == 3  # everyone else on call

    listing = offerer.get(f"/api/teams/{team['id']}/swaps").json()
    assert listing[0]["id"] == swap["id"] and listing[0]["can_offer"]

    days1 = [d for d in rota["days"] if d["period_index"] == 1]
    offer_start, offer_end = days1[4]["start_at"], days1[4]["end_at"]
    # The requester can't offer on their own request, and nobody can offer a slot they
    # don't hold.
    requester.post(f"/api/swaps/{swap['id']}/offers", json={}, expect=400)
    offerer.post(
        f"/api/swaps/{swap['id']}/offers",
        json={"rota_id": rota["id"], "start_at": days[5]["start_at"], "end_at": days[5]["end_at"]},
        expect=409,
    )
    swap = offerer.post(
        f"/api/swaps/{swap['id']}/offers",
        json={"rota_id": rota["id"], "start_at": offer_start, "end_at": offer_end, "note": "Sure"},
        expect=201,
    ).json()
    offer = swap["offers"][0]
    assert offer["status"] == "pending"
    assert requester.get("/api/notifications").json()[0]["kind"] == "swap_offer"

    # Only the requester (or a leader) can accept.
    third = next(
        e
        for i, e in email.items()
        if i not in (requester_id, offerer_id) and e != "leader@example.com"
    )
    api.as_(third).post(f"/api/swaps/{swap['id']}/offers/{offer['id']}/accept", expect=403)

    swap = requester.post(f"/api/swaps/{swap['id']}/offers/{offer['id']}/accept").json()
    assert swap["status"] == "accepted" and swap["offers"][0]["status"] == "accepted"

    rota = api.get(f"/api/rotas/{rota['id']}").json()
    by_date = {d["date"]: d for d in rota["days"]}
    assert by_date[days[2]["date"]]["user_ids"] == [offerer_id]
    assert by_date[days[3]["date"]]["user_ids"] == [offerer_id]
    assert by_date[days[4]["date"]]["user_ids"] == [requester_id]
    assert by_date[days1[4]["date"]]["user_ids"] == [requester_id]
    assert offerer.get("/api/notifications").json()[0]["kind"] == "swap_accepted"

    # The partial cover now shows up in the analysis, and calendars reflect the swap.
    analysis = api.get(f"/api/rotas/{rota['id']}/analysis").json()
    assert any(i["type"] == "partial_cover" for i in analysis["issues"])
    cal = Calendar.from_ical(offerer.get("/api/me/calendar.ics").content)
    starts = {e.decoded("dtstart") for e in cal.walk("VEVENT")}
    assert datetime.fromisoformat(req_start) in starts

    # Accepting again is rejected.
    requester.post(f"/api/swaps/{swap['id']}/offers/{offer['id']}/accept", expect=409)


def test_swap_cover_only_and_cancel(api):
    team = make_team(api)
    rota = _published_rota(api, team, weeks=3)
    owner = rota["periods"][1]["owner_id"]
    email = {m["user"]["id"]: m["user"]["email"] for m in team["members"]}
    days = [d for d in rota["days"] if d["period_index"] == 1]
    req = api.as_(email[owner])
    swap = req.post(
        "/api/swaps",
        json={"rota_id": rota["id"], "start_at": days[0]["start_at"], "end_at": days[0]["end_at"]},
        expect=201,
    ).json()
    helper = next(e for i, e in email.items() if i != owner)
    swap = api.as_(helper).post(f"/api/swaps/{swap['id']}/offers", json={}, expect=201).json()
    # Duplicate pending offer rejected.
    api.as_(helper).post(f"/api/swaps/{swap['id']}/offers", json={}, expect=409)
    swap = req.post(f"/api/swaps/{swap['id']}/cancel").json()
    assert swap["status"] == "cancelled" and swap["offers"][0]["status"] == "declined"


def test_swap_separate_days_and_withdraw(api):
    team = make_team(api)
    rota = _published_rota(api, team, weeks=4)
    p0, p1 = rota["periods"][0], rota["periods"][1]
    requester_id, offerer_id = p0["owner_id"], p1["owner_id"]
    assert requester_id != offerer_id
    email = {m["user"]["id"]: m["user"]["email"] for m in team["members"]}
    requester, offerer = api.as_(email[requester_id]), api.as_(email[offerer_id])
    days0 = [d for d in rota["days"] if d["period_index"] == 0]
    days1 = [d for d in rota["days"] if d["period_index"] == 1]

    def slot(d):
        return {"rota_id": rota["id"], "start_at": d["start_at"], "end_at": d["end_at"]}

    # Two separate days, plus two touching days that are joined into one slot.
    swap = requester.post(
        "/api/swaps",
        json={"slots": [slot(days0[5]), slot(days0[2]), slot(days0[3])]},
        expect=201,
    ).json()
    assert [s["start_at"] for s in swap["slots"]] == [days0[2]["start_at"], days0[5]["start_at"]]
    assert swap["slots"][0]["end_at"] == days0[3]["end_at"]
    # Every slot must be yours.
    offerer.post("/api/swaps", json={"slots": [slot(days1[0]), slot(days0[0])]}, expect=409)

    # People offering can see the days the requester said they can't do.
    requester.post(
        "/api/me/unavailability",
        json={"dates": [days1[3]["date"]], "kind": "unavailable", "note": "Dentist"},
    )
    shown = offerer.get(f"/api/swaps/{swap['id']}").json()["requester_unavailable"]
    assert [(e["date"], e["note"]) for e in shown] == [(days1[3]["date"], "Dentist")]

    # An offer made and then withdrawn disappears, and the requester is told.
    swap = offerer.post(
        f"/api/swaps/{swap['id']}/offers",
        json={"slots": [slot(days1[1])], "note": "Maybe?"},
        expect=201,
    ).json()
    offer = swap["offers"][0]
    swap = offerer.post(f"/api/swaps/{swap['id']}/offers/{offer['id']}/withdraw").json()
    assert swap["offers"] == [] and swap["can_offer"]
    assert requester.get("/api/notifications").json()[0]["kind"] == "swap_withdrawn"

    # Offer two separate days back and accept.
    swap = offerer.post(
        f"/api/swaps/{swap['id']}/offers",
        json={"slots": [slot(days1[1]), slot(days1[4])]},
        expect=201,
    ).json()
    offer = swap["offers"][0]
    assert len(offer["slots"]) == 2
    requester.post(f"/api/swaps/{swap['id']}/offers/{offer['id']}/accept")

    by_date = {d["date"]: d for d in api.get(f"/api/rotas/{rota['id']}").json()["days"]}
    for d in (days0[2], days0[3], days0[5]):
        assert by_date[d["date"]]["user_ids"] == [offerer_id]
    assert by_date[days0[4]["date"]]["user_ids"] == [requester_id]
    for d in (days1[1], days1[4]):
        assert by_date[d["date"]]["user_ids"] == [requester_id]
    assert by_date[days1[2]["date"]]["user_ids"] == [offerer_id]


def test_permissions(api):
    team = make_team(api)
    outsider = api.as_("outsider@example.com")
    outsider.get(f"/api/teams/{team['id']}", expect=403)
    outsider.get(f"/api/teams/{team['id']}/rotas", expect=403)
    amy = api.as_("amy@example.com")
    amy.post(
        f"/api/teams/{team['id']}/rotas",
        json={"start_date": next_monday().isoformat(), "num_periods": 2},
        expect=403,
    )
    amy.patch(f"/api/teams/{team['id']}", json={"name": "Hacked"}, expect=403)
    amy.post(f"/api/teams/{team['id']}/members", json={"email": "x@example.com"}, expect=403)
    # Last leader can't be demoted/removed.
    leader_id = uid(team, LEADER)
    api.patch(f"/api/teams/{team['id']}/members/{leader_id}", json={"role": "member"}, expect=400)
    # A member can leave on their own.
    amy.delete(f"/api/teams/{team['id']}/members/{uid(team, 'amy@example.com')}", expect=200)


def test_published_rota_is_frozen_until_unpublished(api):
    team = make_team(api)
    rota = _published_rota(api, team, weeks=2)
    api.post(f"/api/rotas/{rota['id']}/generate", json={}, expect=409)
    api.patch(f"/api/rotas/{rota['id']}", json={"num_periods": 3}, expect=409)
    rota = api.post(f"/api/rotas/{rota['id']}/unpublish").json()
    assert rota["status"] == "review"
    api.post(f"/api/rotas/{rota['id']}/generate", json={})
    rota = api.patch(f"/api/rotas/{rota['id']}", json={"num_periods": 3}).json()
    assert rota["num_periods"] == 3 and rota["shifts"] == []


def test_fairness_uses_history(api):
    team = make_team(api)
    first = _published_rota(api, team, weeks=4)
    second_start = date.fromisoformat(first["end_date"]) + timedelta(days=1)
    rota = api.post(
        f"/api/teams/{team['id']}/rotas",
        json={"start_date": second_start.isoformat(), "num_periods": 4},
        expect=201,
    ).json()
    # Pretend the members joined long ago so history counts for everyone.
    from allogator.db import session_factory
    from allogator.models import Membership

    db = session_factory()()
    for m in db.query(Membership).all():
        m.joined_at = datetime(2020, 1, 1)
    db.commit()
    db.close()
    rota = api.post(f"/api/rotas/{rota['id']}/generate", json={"seed": 3}).json()["rota"]
    first_owners = [p["owner_id"] for p in first["periods"]]
    second_owners = [p["owner_id"] for p in rota["periods"]]
    # Each person gets exactly one week per rota, and nobody gets the handover week twice.
    assert sorted(first_owners) == sorted(second_owners)
    assert second_owners[0] != first_owners[-1]


def test_header_auth_mode(settings_env, monkeypatch):
    from fastapi.testclient import TestClient

    from allogator.config import get_settings
    from allogator.main import create_app

    monkeypatch.setenv("ALLOGATOR_AUTH_MODE", "header")
    monkeypatch.setenv("ALLOGATOR_ADMIN_EMAILS", "boss@example.com")
    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        assert client.get("/api/me").status_code == 401
        r = client.get(
            "/api/me",
            headers={
                "X-Forwarded-Email": "Boss@Example.com",
                "X-Forwarded-Preferred-Username": "The Boss",
            },
        )
        assert r.status_code == 200
        me = r.json()
        assert me["email"] == "boss@example.com" and me["is_admin"] and me["name"] == "The Boss"
        # Dev header is ignored in header mode.
        assert client.get("/api/me", headers={"X-AlloGator-Dev-User": "x@y.z"}).status_code == 401
        assert client.get("/api/dev/users").status_code == 404

    monkeypatch.setenv("ALLOGATOR_TRUSTED_PROXIES", "10.0.0.0/8")
    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        r = client.get("/api/me", headers={"X-Forwarded-Email": "boss@example.com"})
        assert r.status_code == 403  # testclient isn't in 10/8
