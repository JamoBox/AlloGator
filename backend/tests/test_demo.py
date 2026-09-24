from datetime import date

import pytest
from sqlalchemy import select

from allogator.demo import seed_demo
from allogator.models import ROTA_PUBLISHED, Rota
from allogator.services.analysis import analyze
from allogator.services.hints import candidate_hints
from allogator.services.scheduling import generate


@pytest.mark.parametrize(
    "today",
    [
        date(2026, 9, 24),  # upcoming rota includes Christmas
        date(2026, 9, 1),  # no public holiday in range: a custom special day is used
        date(2027, 3, 10),  # Easter
    ],
)
def test_demo_seed_showcases_hints(db, today):
    info = seed_demo(db, today=today)
    assert info["status"] == "created"
    rotas = {r.id: r for r in db.scalars(select(Rota))}
    assert rotas[info["current_rota_id"]].status == ROTA_PUBLISHED
    upcoming = rotas[info["upcoming_rota_id"]]
    generate(db, upcoming, seed=1, time_limit=5)
    db.commit()

    target = date.fromisoformat(info["unpopular_day"].split(" ")[0])
    uncovered = [i for i in analyze(db, upcoming)["issues"] if i["type"] == "uncovered"]
    assert any(i["start_date"] <= target <= i["end_date"] for i in uncovered)

    hints = candidate_hints(db, upcoming, [target])
    texts = {c["name"]: " / ".join(h["text"] for h in c["hints"]) for c in hints["candidates"]}
    assert "last year" in texts["Sam Patel"]  # Sam covered it last year
    assert hints["candidates"][0]["name"] != "Sam Patel"
    assert seed_demo(db, today=today)["status"] == "exists"
