import json
from datetime import timedelta

from icalendar import Calendar

from .test_api_flow import _published_rota, make_team, next_monday


def _upload(api, team_id, name, content, expect=200, **form):
    data = {"dry_run": "false", **{k: str(v).lower() for k, v in form.items()}}
    return api.post(
        f"/api/teams/{team_id}/import",
        files={"file": (name, content, "application/octet-stream")},
        data=data,
        expect=expect,
    )


def test_json_round_trip_into_another_team(api):
    team = make_team(api, "Source")
    rota = _published_rota(api, team, weeks=3)
    exported = api.get(f"/api/teams/{team['id']}/export?format=json")
    assert "attachment" in exported.headers["content-disposition"]
    data = exported.json()
    assert data["format"] == "allogator-schedule"
    assert len(data["rotas"]) == 1 and data["rotas"][0]["status"] == "published"

    target = api.post("/api/teams", json={"name": "Target"}, expect=201).json()
    # Dry run changes nothing.
    report = api.post(
        f"/api/teams/{target['id']}/import",
        files={"file": ("x.json", exported.content, "application/json")},
        data={"dry_run": "true"},
    ).json()
    assert report["dry_run"] and report["summary"] == {"create": 1}
    assert api.get(f"/api/teams/{target['id']}/rotas").json() == []

    report = _upload(api, target["id"], "x.json", exported.content).json()
    assert report["summary"] == {"create": 1}
    assert len(report["new_members"]) == 3  # leader already a member of Target
    imported = api.get(f"/api/teams/{target['id']}/rotas").json()[0]
    detail = api.get(f"/api/rotas/{imported['id']}").json()
    assert detail["status"] == "published" and detail["imported"]
    assert detail["start_date"] == rota["start_date"]
    assert detail["num_periods"] == 3 and detail["period_days"] == 7
    email_of = {p["id"]: p["email"] for p in detail["people"]}
    src_email = {p["id"]: p["email"] for p in rota["people"]}
    assert [email_of[p["owner_id"]] for p in detail["periods"]] == [
        src_email[p["owner_id"]] for p in rota["periods"]
    ]

    # Importing again: overlaps are skipped by default, or replaced on request.
    report = _upload(api, target["id"], "x.json", exported.content).json()
    assert report["summary"] == {"skip": 1}
    report = _upload(api, target["id"], "x.json", exported.content, on_conflict="replace").json()
    assert report["summary"] == {"replace": 1}
    assert len(api.get(f"/api/teams/{target['id']}/rotas").json()) == 1


def test_csv_export_and_minimal_csv_import(api):
    team = make_team(api, "Csv")
    _published_rota(api, team, weeks=2)
    csv_text = api.get(f"/api/teams/{team['id']}/export?format=csv").text
    header = csv_text.splitlines()[0]
    assert header.startswith("rota,rota_start_date,period_days")
    assert len(csv_text.strip().splitlines()) == 3  # header + 2 weekly shifts

    target = api.post("/api/teams", json={"name": "Sheet", "timezone": "UTC"}, expect=201).json()
    monday = next_monday(3)
    rows = ["start,end,user_email,user_name"]
    people = ["x@example.com", "y@example.com", "x@example.com"]
    for i, who in enumerate(people):
        a = monday + timedelta(days=7 * i)
        b = a + timedelta(days=7)
        rows.append(f"{a}T09:00,{b}T09:00,{who},{who[0].upper()}")
    report = _upload(api, target["id"], "legacy.csv", "\n".join(rows).encode()).json()
    assert report["summary"] == {"create": 1}
    assert set(report["new_users"]) == {"x@example.com", "y@example.com"}
    rota = api.get(f"/api/teams/{target['id']}/rotas").json()[0]
    assert rota["period_days"] == 7 and rota["num_periods"] == 3
    assert rota["handover_time"] == "09:00" and rota["start_date"] == monday.isoformat()

    # The imported schedule is visible to its people and exportable as .ics.
    ics = api.as_("y@example.com").get("/api/me/calendar.ics").content
    assert len(Calendar.from_ical(ics).walk("VEVENT")) == 1
    team_ics = api.get(f"/api/teams/{target['id']}/export?format=ics").content
    assert len(Calendar.from_ical(team_ics).walk("VEVENT")) == 3


def test_import_errors_are_reported(api):
    team = api.post("/api/teams", json={"name": "Errs"}, expect=201).json()
    r = _upload(api, team["id"], "bad.csv", b"who,when\nx,y\n", expect=400)
    assert "missing required column" in r.json()["detail"]
    r = _upload(api, team["id"], "bad.json", b"{not json", expect=400)
    assert "Invalid JSON" in r.json()["detail"]
    r = _upload(api, team["id"], "x.json", json.dumps({"format": "other"}).encode(), expect=400)
    assert "Not an AlloGator export" in r.json()["detail"]
    r = _upload(
        api,
        team["id"],
        "x.csv",
        b"start,end,user_email\n2026-01-01T09:00,nope,a@b.c\n",
        expect=400,
    )
    assert "invalid datetime" in r.json()["detail"]
    # Members can't import.
    api.post(f"/api/teams/{team['id']}/members", json={"email": "m@example.com"}, expect=201)
    _upload(api.as_("m@example.com"), team["id"], "x.csv", b"start,end,user_email\n", expect=403)


def test_member_exports_only_published(api):
    team = make_team(api, "Vis")
    _published_rota(api, team, weeks=1)
    draft = api.post(
        f"/api/teams/{team['id']}/rotas",
        json={"start_date": next_monday(6).isoformat(), "num_periods": 1},
        expect=201,
    ).json()
    api.post(f"/api/rotas/{draft['id']}/generate", json={})
    member = api.as_("amy@example.com")
    data = member.get(f"/api/teams/{team['id']}/export?format=json").json()
    assert [r["status"] for r in data["rotas"]] == ["published"]
    member.get(f"/api/teams/{team['id']}/export?format=json&rota_id={draft['id']}", expect=403)
    leader_data = api.get(f"/api/teams/{team['id']}/export?format=json").json()
    assert len(leader_data["rotas"]) == 2


def test_csv_export_neutralises_formulas(api):
    team = make_team(api, "Formula")
    rota = _published_rota(api, team, weeks=1)
    owner = rota["periods"][0]["owner_id"]
    api.post(
        f"/api/rotas/{rota['id']}/assign",
        json={"user_id": owner, "period_index": 0, "note": '=HYPERLINK("http://evil")'},
    )
    text = api.get(f"/api/teams/{team['id']}/export?format=csv").text
    assert "'=HYPERLINK" in text
    assert ",=HYPERLINK" not in text
