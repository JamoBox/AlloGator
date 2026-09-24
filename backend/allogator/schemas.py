"""Request/response schemas. Response datetimes are timezone-aware (in the rota's timezone)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, field_validator

from .services.slots import get_zone, parse_hhmm


def _utc_iso(value: datetime) -> str:
    return (value.replace(tzinfo=UTC) if value.tzinfo is None else value).isoformat()


# Database timestamps are naive UTC; serialise them with an explicit offset.
UtcDatetime = Annotated[datetime, PlainSerializer(_utc_iso, return_type=str)]


class _Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def _check_hhmm(v: str | None) -> str | None:
    if v is None:
        return v
    t = parse_hhmm(v)
    return f"{t:%H:%M}"


def _check_tz(v: str | None) -> str | None:
    if v is None:
        return v
    get_zone(v)
    return v


# --- Users ---------------------------------------------------------------------------------


class UserOut(_Out):
    id: int
    email: str
    display_name: str
    name: str
    is_admin: bool = False


class MembershipBrief(BaseModel):
    team_id: int
    team_name: str
    role: str
    on_call: bool


class MeOut(UserOut):
    email_notifications: bool
    calendar_feed_url: str
    memberships: list[MembershipBrief]
    can_create_teams: bool


class MeUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    email_notifications: bool | None = None


class AdminUserOut(UserOut):
    active: bool
    created_at: UtcDatetime
    last_seen_at: UtcDatetime | None
    team_count: int = 0


class AdminUserUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    is_admin: bool | None = None
    active: bool | None = None


# --- Teams ---------------------------------------------------------------------------------


class TeamSettings(BaseModel):
    description: str | None = None
    timezone: str | None = None
    default_period_days: int | None = Field(default=None, ge=1, le=90)
    default_num_periods: int | None = Field(default=None, ge=1, le=104)
    default_handover_weekday: int | None = Field(default=None, ge=0, le=6)
    default_handover_time: str | None = None
    avoid_back_to_back: bool | None = None
    fairness_lookback_days: int | None = Field(default=None, ge=0, le=3650)
    holiday_country: str | None = Field(default=None, max_length=8)
    holiday_subdivision: str | None = Field(default=None, max_length=16)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        return _check_tz(v)

    @field_validator("default_handover_time")
    @classmethod
    def _hm(cls, v: str | None) -> str | None:
        return _check_hhmm(v)


class TeamCreate(TeamSettings):
    name: str = Field(min_length=1, max_length=200)


class TeamUpdate(TeamSettings):
    name: str | None = Field(default=None, min_length=1, max_length=200)


class MemberOut(BaseModel):
    user: UserOut
    role: str
    on_call: bool
    joined_at: UtcDatetime


class TeamOut(_Out):
    id: int
    name: str
    description: str
    timezone: str
    default_period_days: int
    default_num_periods: int
    default_handover_weekday: int
    default_handover_time: str
    avoid_back_to_back: bool
    fairness_lookback_days: int
    holiday_country: str
    holiday_subdivision: str
    my_role: str | None = None
    is_leader: bool = False
    member_count: int = 0


class TeamDetail(TeamOut):
    members: list[MemberOut]


class MemberAdd(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    display_name: str = ""
    role: Literal["leader", "member"] = "member"
    on_call: bool = True


class MemberUpdate(BaseModel):
    role: Literal["leader", "member"] | None = None
    on_call: bool | None = None


# --- Rotas ---------------------------------------------------------------------------------


class RotaCreate(BaseModel):
    name: str = ""
    start_date: date
    num_periods: int = Field(ge=1, le=104)
    period_days: int | None = Field(default=None, ge=1, le=90)
    handover_time: str | None = None

    @field_validator("handover_time")
    @classmethod
    def _hm(cls, v: str | None) -> str | None:
        return _check_hhmm(v)


class RotaUpdate(BaseModel):
    name: str | None = None
    start_date: date | None = None
    num_periods: int | None = Field(default=None, ge=1, le=104)
    period_days: int | None = Field(default=None, ge=1, le=90)
    handover_time: str | None = None
    availability_deadline: date | None = None

    @field_validator("handover_time")
    @classmethod
    def _hm(cls, v: str | None) -> str | None:
        return _check_hhmm(v)


class RotaOut(BaseModel):
    id: int
    team_id: int
    team_name: str
    name: str
    display_name: str
    start_date: date
    end_date: date  # inclusive last day
    num_periods: int
    period_days: int
    handover_time: str
    timezone: str
    status: str
    availability_deadline: date | None
    request_message: str
    requested_at: datetime | None
    generated_at: datetime | None
    published_at: datetime | None
    imported: bool
    eligible_count: int
    submitted_count: int
    my_submitted: bool
    i_am_eligible: bool
    open_swaps: int = 0


class PeriodOut(BaseModel):
    index: int
    start_date: date
    end_date: date  # inclusive
    start_at: datetime
    end_at: datetime
    owner_id: int | None


class DayOut(BaseModel):
    index: int
    date: date
    period_index: int
    start_at: datetime
    end_at: datetime
    user_ids: list[int | None]
    majority: int | None
    locked: bool
    holiday: str | None = None


class ShiftOut(BaseModel):
    id: int
    rota_id: int
    period_index: int
    user_id: int | None
    start_at: datetime
    end_at: datetime
    locked: bool
    source: str
    note: str


class RotaDetail(RotaOut):
    periods: list[PeriodOut]
    days: list[DayOut]
    shifts: list[ShiftOut]
    people: list[UserOut]
    # On-call members who haven't confirmed their dates yet.
    unsubmitted: list[UserOut] = Field(default_factory=list)
    shifts_visible: bool
    solver_info: dict[str, Any] | None = None


class RequestDates(BaseModel):
    deadline: date | None = None
    message: str = ""


class GenerateRequest(BaseModel):
    seed: int | None = None
    keep_locked: bool = True
    time_limit: float | None = Field(default=None, ge=0.5, le=120)


class AssignRequest(BaseModel):
    """Reassign part of a rota. Give either start_at/end_at, from_date/to_date (inclusive day
    slots) or period_index."""

    user_id: int | None
    start_at: datetime | None = None
    end_at: datetime | None = None
    from_date: date | None = None
    to_date: date | None = None
    period_index: int | None = None
    lock: bool = True
    note: str = ""


class LockRequest(BaseModel):
    locked: bool
    shift_ids: list[int] | None = None  # None = every shift in the rota


class AvailabilityEntry(BaseModel):
    user_id: int
    date: date
    kind: str
    note: str


class AvailabilityMember(BaseModel):
    user: UserOut
    on_call: bool
    role: str
    submitted_at: datetime | None
    comment: str


class AvailabilityMatrix(BaseModel):
    rota_id: int
    start_date: date
    end_date: date
    members: list[AvailabilityMember]
    entries: list[AvailabilityEntry]


class SubmitAvailability(BaseModel):
    comment: str = ""


class SpecialDayOut(BaseModel):
    id: int | None  # None for public holidays (not editable)
    date: date
    label: str
    source: Literal["public", "custom"]
    team_id: int | None = None
    team_name: str | None = None


class SpecialDayCreate(BaseModel):
    date: date
    label: str = Field(min_length=1, max_length=120)


# --- Availability ----------------------------------------------------------------------------


class UnavailabilityOut(BaseModel):
    date: date
    kind: str
    note: str


class UnavailabilityBulk(BaseModel):
    dates: list[date] = Field(min_length=1, max_length=800)
    kind: Literal["unavailable", "partial"] | None  # None clears the dates
    note: str = Field(default="", max_length=500)


# --- Schedules -----------------------------------------------------------------------------


class ScheduleShift(BaseModel):
    id: int
    rota_id: int
    rota_name: str
    team_id: int
    team_name: str
    period_index: int
    user: UserOut | None
    start_at: datetime
    end_at: datetime
    note: str


class TeamSchedule(BaseModel):
    team_id: int
    timezone: str
    on_call_now: ScheduleShift | None
    shifts: list[ScheduleShift]


# --- Swaps ---------------------------------------------------------------------------------


class SlotIn(BaseModel):
    rota_id: int
    start_at: datetime
    end_at: datetime


class SwapCreate(BaseModel):
    """The time to hand over: ``slots`` (separate days are fine), or one rota_id/start/end."""

    rota_id: int | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    slots: list[SlotIn] = Field(default_factory=list, max_length=120)
    note: str = Field(default="", max_length=1000)


class OfferCreate(BaseModel):
    """Slots offered in exchange; none means "I'll just cover it"."""

    rota_id: int | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    slots: list[SlotIn] = Field(default_factory=list, max_length=120)
    note: str = Field(default="", max_length=1000)


class SlotOut(BaseModel):
    rota_id: int
    start_at: datetime
    end_at: datetime


class SwapOfferOut(BaseModel):
    id: int
    offerer: UserOut
    rota_id: int | None
    start_at: datetime | None
    end_at: datetime | None
    slots: list[SlotOut]
    note: str
    status: str
    created_at: datetime
    warnings: list[str]


class SwapRequestOut(BaseModel):
    id: int
    team_id: int
    team_name: str
    rota_id: int
    rota_name: str
    requester: UserOut
    start_at: datetime
    end_at: datetime
    slots: list[SlotOut]
    note: str
    status: str
    created_at: datetime
    resolved_at: datetime | None
    offers: list[SwapOfferOut]
    can_offer: bool
    warnings: list[str]


# --- Misc ----------------------------------------------------------------------------------


class NotificationOut(_Out):
    id: int
    kind: str
    title: str
    body: str
    link: str
    created_at: UtcDatetime
    read_at: UtcDatetime | None


class MarkRead(BaseModel):
    ids: list[int] | None = None  # None = all


class AuditOut(BaseModel):
    id: int
    action: str
    summary: str
    actor: UserOut | None
    created_at: datetime
    data: dict[str, Any] | None
