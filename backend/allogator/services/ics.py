"""iCalendar (.ics) generation for personal and team on-call calendars."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from urllib.parse import urlparse

from icalendar import Calendar, Event

from ..config import get_settings
from ..models import Shift


def _aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC)


def build_calendar(
    shifts: Iterable[Shift],
    *,
    name: str,
    personal: bool,
) -> bytes:
    """Build a calendar. ``personal`` titles events "On call: <team>"; otherwise
    "On call: <person> (<team>)"."""
    settings = get_settings()
    host = urlparse(settings.base_url).hostname or "allogator"
    cal = Calendar()
    cal.add("prodid", "-//AlloGator//On-call rota//EN")
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    cal.add("method", "PUBLISH")
    cal.add("x-wr-calname", name)
    cal.add("x-published-ttl", "PT1H")
    now = datetime.now(UTC)
    for shift in shifts:
        if shift.user is None:
            continue
        rota = shift.rota
        team = rota.team
        ev = Event()
        ev.add(
            "uid",
            f"allogator-{rota.id}-{shift.user_id}-{shift.start_at:%Y%m%dT%H%M%S}@{host}",
        )
        ev.add("dtstamp", now)
        ev.add("dtstart", _aware(shift.start_at))
        ev.add("dtend", _aware(shift.end_at))
        if personal:
            ev.add("summary", f"On call: {team.name}")
        else:
            ev.add("summary", f"On call: {shift.user.name} ({team.name})")
        lines = [
            f"Team: {team.name}",
            f"Rota: {rota.display_name}",
            f"Period {shift.period_index + 1}",
            f"On call: {shift.user.name} <{shift.user.email}>",
        ]
        if shift.note:
            lines.append(f"Note: {shift.note}")
        lines.append(f"{settings.base_url}/teams/{team.id}/rotas/{rota.id}")
        ev.add("description", "\n".join(lines))
        ev.add("transp", "OPAQUE")
        ev.add("categories", ["On-call"])
        cal.add_component(ev)
    return cal.to_ical()
