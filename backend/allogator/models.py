"""Database models.

All datetimes are stored as *naive UTC*. Calendar dates (``Date``) are local to the rota's
timezone. A rota's shifts always tile the rota's full time range: gaps are represented by
shifts with ``user_id = NULL`` (uncovered time).
"""

from __future__ import annotations

import secrets
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def new_calendar_token() -> str:
    return secrets.token_urlsafe(24)


# Membership roles
ROLE_LEADER = "leader"
ROLE_MEMBER = "member"

# Rota lifecycle
ROTA_PLANNING = "planning"  # created, parameters editable
ROTA_COLLECTING = "collecting"  # "request for dates" sent, waiting on availability
ROTA_REVIEW = "review"  # draft schedule generated, leader reviewing/editing
ROTA_PUBLISHED = "published"  # visible to everyone
ROTA_STATUSES = (ROTA_PLANNING, ROTA_COLLECTING, ROTA_REVIEW, ROTA_PUBLISHED)

# Availability kinds
AVAIL_UNAVAILABLE = "unavailable"  # cannot cover (hard constraint)
AVAIL_PARTIAL = "partial"  # partially available; see note (soft constraint)
AVAIL_KINDS = (AVAIL_UNAVAILABLE, AVAIL_PARTIAL)

# Swap lifecycle
SWAP_OPEN = "open"
SWAP_ACCEPTED = "accepted"
SWAP_CANCELLED = "cancelled"

OFFER_PENDING = "pending"
OFFER_ACCEPTED = "accepted"
OFFER_DECLINED = "declined"
OFFER_WITHDRAWN = "withdrawn"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(200), default="")
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    email_notifications: Mapped[bool] = mapped_column(Boolean, default=True)
    calendar_token: Mapped[str] = mapped_column(String(64), unique=True, default=new_calendar_token)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    memberships: Mapped[list[Membership]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def name(self) -> str:
        return self.display_name or self.email.split("@")[0]


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    # Defaults used when a leader creates a new rota.
    default_period_days: Mapped[int] = mapped_column(Integer, default=7)
    default_num_periods: Mapped[int] = mapped_column(Integer, default=8)
    default_handover_weekday: Mapped[int] = mapped_column(Integer, default=0)  # 0 = Monday
    default_handover_time: Mapped[str] = mapped_column(String(5), default="09:00")
    # Scheduling preferences
    avoid_back_to_back: Mapped[bool] = mapped_column(Boolean, default=True)
    fairness_lookback_days: Mapped[int] = mapped_column(Integer, default=180)
    # Public holidays (ISO country code + optional subdivision, via the `holidays` package).
    # Holidays and custom special days are "unpopular" days that the scheduler shares out
    # fairly over time and that leaders get history-based hints for.
    holiday_country: Mapped[str] = mapped_column(String(8), default="", server_default="")
    holiday_subdivision: Mapped[str] = mapped_column(String(16), default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    memberships: Mapped[list[Membership]] = relationship(
        back_populates="team", cascade="all, delete-orphan"
    )
    rotas: Mapped[list[Rota]] = relationship(back_populates="team", cascade="all, delete-orphan")


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("team_id", "user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16), default=ROLE_MEMBER)
    # Whether this person takes part in the on-call rotation (leaders may opt out).
    on_call: Mapped[bool] = mapped_column(Boolean, default=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    team: Mapped[Team] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(back_populates="memberships")

    @property
    def is_leader(self) -> bool:
        return self.role == ROLE_LEADER


class Rota(Base):
    """A planning round: a contiguous run of on-call periods for one team."""

    __tablename__ = "rotas"

    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    start_date: Mapped[date] = mapped_column(Date)
    num_periods: Mapped[int] = mapped_column(Integer)
    period_days: Mapped[int] = mapped_column(Integer)
    handover_time: Mapped[str] = mapped_column(String(5), default="09:00")
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    status: Mapped[str] = mapped_column(String(16), default=ROTA_PLANNING)

    availability_deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    request_message: Mapped[str] = mapped_column(Text, default="")
    requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    generated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    solver_info: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    imported: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    team: Mapped[Team] = relationship(back_populates="rotas")
    shifts: Mapped[list[Shift]] = relationship(
        back_populates="rota", cascade="all, delete-orphan", order_by="Shift.start_at"
    )
    submissions: Mapped[list[AvailabilitySubmission]] = relationship(
        back_populates="rota", cascade="all, delete-orphan"
    )

    @property
    def end_date(self) -> date:
        """Exclusive end date."""
        return self.start_date + timedelta(days=self.num_periods * self.period_days)

    @property
    def last_date(self) -> date:
        return self.end_date - timedelta(days=1)

    @property
    def display_name(self) -> str:
        if self.name:
            return self.name
        return f"{self.start_date:%d %b %Y} – {self.last_date:%d %b %Y}"


class SpecialDay(Base):
    """A team-defined unpopular day (e.g. company shutdown, peak sales day, code freeze)."""

    __tablename__ = "special_days"
    __table_args__ = (UniqueConstraint("team_id", "day"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    day: Mapped[date] = mapped_column(Date)
    label: Mapped[str] = mapped_column(String(120))


class Shift(Base):
    __tablename__ = "shifts"
    __table_args__ = (Index("ix_shifts_rota_start", "rota_id", "start_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(ForeignKey("rotas.id", ondelete="CASCADE"))
    period_index: Mapped[int] = mapped_column(Integer)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    start_at: Mapped[datetime] = mapped_column(DateTime)
    end_at: Mapped[datetime] = mapped_column(DateTime)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    source: Mapped[str] = mapped_column(String(16), default="generated")
    note: Mapped[str] = mapped_column(Text, default="")

    rota: Mapped[Rota] = relationship(back_populates="shifts")
    user: Mapped[User | None] = relationship()


class Unavailability(Base):
    """A day a user cannot (or can only partially) cover. Personal, shared across teams."""

    __tablename__ = "unavailability"
    __table_args__ = (UniqueConstraint("user_id", "day"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    kind: Mapped[str] = mapped_column(String(16), default=AVAIL_UNAVAILABLE)
    note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class AvailabilitySubmission(Base):
    """A user's confirmation that their availability for a rota is complete."""

    __tablename__ = "availability_submissions"
    __table_args__ = (UniqueConstraint("rota_id", "user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(ForeignKey("rotas.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    comment: Mapped[str] = mapped_column(Text, default="")

    rota: Mapped[Rota] = relationship(back_populates="submissions")


class SwapRequest(Base):
    __tablename__ = "swap_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    rota_id: Mapped[int] = mapped_column(ForeignKey("rotas.id", ondelete="CASCADE"))
    requester_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    start_at: Mapped[datetime] = mapped_column(DateTime)
    end_at: Mapped[datetime] = mapped_column(DateTime)
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default=SWAP_OPEN)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    requester: Mapped[User] = relationship()
    rota: Mapped[Rota] = relationship()
    offers: Mapped[list[SwapOffer]] = relationship(
        back_populates="request", cascade="all, delete-orphan", order_by="SwapOffer.created_at"
    )
    slots: Mapped[list[SwapSlot]] = relationship(
        foreign_keys="SwapSlot.request_id",
        cascade="all, delete-orphan",
        order_by="SwapSlot.start_at",
    )


class SwapOffer(Base):
    """A response to a swap request: take the requested slot, optionally giving one back."""

    __tablename__ = "swap_offers"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(
        ForeignKey("swap_requests.id", ondelete="CASCADE"), index=True
    )
    offerer_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # The slot offered in exchange (NULL = "I'll just cover it").
    rota_id: Mapped[int | None] = mapped_column(
        ForeignKey("rotas.id", ondelete="CASCADE"), nullable=True
    )
    start_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default=OFFER_PENDING)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    request: Mapped[SwapRequest] = relationship(back_populates="offers")
    offerer: Mapped[User] = relationship()
    rota: Mapped[Rota | None] = relationship()
    slots: Mapped[list[SwapSlot]] = relationship(
        foreign_keys="SwapSlot.offer_id",
        cascade="all, delete-orphan",
        order_by="SwapSlot.start_at",
    )


class SwapSlot(Base):
    """One block of time in a swap request or offer, which may cover several separate days.

    The parent's ``rota_id``/``start_at``/``end_at`` hold the overall span; a parent without
    slot rows (made before slots existed) is a single slot of that span.
    """

    __tablename__ = "swap_slots"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int | None] = mapped_column(
        ForeignKey("swap_requests.id", ondelete="CASCADE"), nullable=True, index=True
    )
    offer_id: Mapped[int | None] = mapped_column(
        ForeignKey("swap_offers.id", ondelete="CASCADE"), nullable=True, index=True
    )
    rota_id: Mapped[int] = mapped_column(ForeignKey("rotas.id", ondelete="CASCADE"))
    start_at: Mapped[datetime] = mapped_column(DateTime)
    end_at: Mapped[datetime] = mapped_column(DateTime)

    rota: Mapped[Rota] = relationship()


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_read", "user_id", "read_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int | None] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"), nullable=True, index=True
    )
    rota_id: Mapped[int | None] = mapped_column(
        ForeignKey("rotas.id", ondelete="SET NULL"), nullable=True, index=True
    )
    actor_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(64))
    summary: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    actor: Mapped[User | None] = relationship()
