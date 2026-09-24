"""Time-grid maths for rotas.

A rota is ``num_periods`` periods of ``period_days`` days. Each *day slot* runs from the
handover time on its date to the handover time on the next date, in the rota's timezone, so
DST transitions give 23 or 25 hour slots. Unavailability marked on a date applies to the slot
starting on that date.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from functools import cached_property
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def parse_hhmm(value: str) -> time:
    try:
        hh, mm = value.strip().split(":")
        return time(int(hh), int(mm))
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"Invalid time {value!r}; expected HH:MM") from exc


def get_zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"Unknown timezone {name!r}") from exc


def local_to_utc(d: date, t: time, tz: ZoneInfo) -> datetime:
    """Local wall-clock date+time -> naive UTC."""
    return datetime.combine(d, t, tzinfo=tz).astimezone(UTC).replace(tzinfo=None)


def utc_to_local(dt: datetime, tz: ZoneInfo) -> datetime:
    """Naive UTC -> aware local datetime."""
    return dt.replace(tzinfo=UTC).astimezone(tz)


def to_naive_utc(dt: datetime, tz: ZoneInfo) -> datetime:
    """Aware datetime -> naive UTC. Naive input is interpreted as wall-clock time in ``tz``."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(UTC).replace(tzinfo=None)


@dataclass(frozen=True)
class DaySlot:
    index: int
    day: date
    start: datetime  # naive UTC
    end: datetime  # naive UTC
    period_index: int


@dataclass(frozen=True)
class Period:
    index: int
    first_day: int  # index into grid.days
    end_day: int  # exclusive
    start: datetime
    end: datetime
    start_date: date
    end_date: date  # exclusive

    @property
    def day_indices(self) -> range:
        return range(self.first_day, self.end_day)


class RotaGrid:
    def __init__(
        self,
        start_date: date,
        num_periods: int,
        period_days: int,
        handover_time: str | time,
        timezone: str | ZoneInfo,
    ) -> None:
        if num_periods < 1 or period_days < 1:
            raise ValueError("A rota needs at least one period of at least one day")
        self.start_date = start_date
        self.num_periods = num_periods
        self.period_days = period_days
        self.handover = (
            parse_hhmm(handover_time) if isinstance(handover_time, str) else handover_time
        )
        self.tz = get_zone(timezone) if isinstance(timezone, str) else timezone

        self.days: list[DaySlot] = []
        self.periods: list[Period] = []
        for p in range(num_periods):
            first = p * period_days
            for k in range(period_days):
                i = first + k
                d = start_date + timedelta(days=i)
                self.days.append(
                    DaySlot(
                        index=i,
                        day=d,
                        start=local_to_utc(d, self.handover, self.tz),
                        end=local_to_utc(d + timedelta(days=1), self.handover, self.tz),
                        period_index=p,
                    )
                )
            self.periods.append(
                Period(
                    index=p,
                    first_day=first,
                    end_day=first + period_days,
                    start=self.days[first].start,
                    end=self.days[first + period_days - 1].end,
                    start_date=start_date + timedelta(days=first),
                    end_date=start_date + timedelta(days=first + period_days),
                )
            )

    @classmethod
    def for_rota(cls, rota) -> RotaGrid:
        return cls(
            rota.start_date, rota.num_periods, rota.period_days, rota.handover_time, rota.timezone
        )

    @property
    def start(self) -> datetime:
        return self.days[0].start

    @property
    def end(self) -> datetime:
        return self.days[-1].end

    @property
    def end_date(self) -> date:
        return self.days[-1].day + timedelta(days=1)

    @cached_property
    def _day_index(self) -> dict[date, int]:
        return {s.day: s.index for s in self.days}

    def day_index(self, d: date) -> int | None:
        return self._day_index.get(d)

    def slot_at(self, dt: datetime) -> DaySlot | None:
        """The day slot containing naive-UTC instant ``dt``."""
        if dt < self.start or dt >= self.end:
            return None
        # Slots are ~24h; estimate then correct for DST drift.
        i = min(len(self.days) - 1, max(0, int((dt - self.start).total_seconds() // 86400)))
        while i > 0 and dt < self.days[i].start:
            i -= 1
        while i < len(self.days) - 1 and dt >= self.days[i].end:
            i += 1
        return self.days[i]

    def period_boundaries(self) -> list[datetime]:
        return [p.start for p in self.periods] + [self.end]

    def local(self, dt: datetime) -> datetime:
        return utc_to_local(dt, self.tz)
