"""Public holidays and team-defined special days ("unpopular" days)."""

from __future__ import annotations

import re
from datetime import date
from functools import lru_cache

import holidays as holidays_lib
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import SpecialDay, Team

_SUFFIX = re.compile(r"\s*\((observed|estimated)[^)]*\)|\s*\*$", re.IGNORECASE)


def normalise_name(name: str) -> str:
    """'Boxing Day (observed)' -> 'Boxing Day', so the same holiday matches across years."""
    return _SUFFIX.sub("", name).strip()


@lru_cache(maxsize=512)
def _country_year(country: str, subdivision: str, year: int) -> dict[date, str]:
    try:
        cal = holidays_lib.country_holidays(country, subdiv=subdivision or None, years=year)
    except (NotImplementedError, KeyError, ValueError):
        return {}
    out: dict[date, str] = {}
    for d, name in cal.items():
        # Several holidays can share a date; the library joins them with "; ".
        out[d] = "; ".join(dict.fromkeys(normalise_name(n) for n in name.split("; ")))
    return out


def public_holidays(country: str, subdivision: str, start: date, end: date) -> dict[date, str]:
    """Public holidays within [start, end)."""
    if not country:
        return {}
    out: dict[date, str] = {}
    for year in range(start.year, end.year + 1):
        for d, name in _country_year(country, subdivision, year).items():
            if start <= d < end:
                out[d] = name
    return out


def team_special_days(db: Session, team: Team, start: date, end: date) -> dict[date, str]:
    """Public holidays plus the team's own special days within [start, end)."""
    out = public_holidays(team.holiday_country, team.holiday_subdivision, start, end)
    custom = db.scalars(
        select(SpecialDay).where(
            SpecialDay.team_id == team.id, SpecialDay.day >= start, SpecialDay.day < end
        )
    )
    for sd in custom:
        out[sd.day] = f"{out[sd.day]} · {sd.label}" if sd.day in out else sd.label
    return out


def _words(class_name: str) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", class_name)


@lru_cache(maxsize=1)
def supported_countries() -> list[dict]:
    from holidays.registry import COUNTRIES

    out = []
    for _module, (class_name, code, *_rest) in COUNTRIES.items():
        try:
            cls = holidays_lib.country_holidays(code).__class__
        except (NotImplementedError, KeyError, ValueError):
            continue
        aliases = getattr(cls, "subdivisions_aliases", {}) or {}
        names = {v: k for k, v in aliases.items()}
        subdivisions = [
            {"code": sub, "name": names.get(sub, sub)} for sub in getattr(cls, "subdivisions", ())
        ]
        out.append({"code": code, "name": _words(class_name), "subdivisions": subdivisions})
    out.sort(key=lambda c: c["name"])
    return out


def is_supported(country: str, subdivision: str) -> bool:
    if not country:
        return not subdivision
    for c in supported_countries():
        if c["code"] == country:
            return not subdivision or any(s["code"] == subdivision for s in c["subdivisions"])
    return False
