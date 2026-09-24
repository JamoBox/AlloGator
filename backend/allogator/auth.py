"""Authentication (trusted reverse-proxy header, or dev mode) and permission helpers."""

from __future__ import annotations

import ipaddress
import logging
from datetime import timedelta

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import Membership, Rota, Team, User, utcnow

log = logging.getLogger(__name__)

DEV_USER_HEADER = "X-AlloGator-Dev-User"


def _client_trusted(request: Request) -> bool:
    nets = get_settings().trusted_proxy_networks
    if not nets:
        return True
    host = request.client.host if request.client else None
    if not host:
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(addr in net for net in nets)


def _identity(request: Request) -> tuple[str, str]:
    s = get_settings()
    if s.auth_mode == "dev":
        return (request.headers.get(DEV_USER_HEADER) or s.dev_default_user), ""
    if not _client_trusted(request):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Request did not come via a trusted proxy")
    email = request.headers.get(s.auth_email_header, "")
    if not email.strip():
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            f"Not signed in: missing {s.auth_email_header} header from the auth proxy",
        )
    return email, request.headers.get(s.auth_name_header, "")


def get_or_create_user(db: Session, email: str, name: str = "") -> User:
    email = email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, display_name=name.strip())
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            user = db.scalar(select(User).where(User.email == email))
            assert user is not None
    return user


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    email, name = _identity(request)
    user = get_or_create_user(db, email, name)
    s = get_settings()
    changed = False
    if user.email in s.admin_email_set and not user.is_admin:
        user.is_admin = True
        changed = True
    if name and not user.display_name:
        user.display_name = name.strip()
        changed = True
    now = utcnow()
    if user.last_seen_at is None or now - user.last_seen_at > timedelta(minutes=5):
        user.last_seen_at = now
        changed = True
    if changed:
        db.commit()
    if not user.active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your account has been deactivated")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admins only")
    return user


# --- Permission helpers ------------------------------------------------------------------


def membership_of(db: Session, team_id: int, user: User) -> Membership | None:
    return db.scalar(
        select(Membership).where(Membership.team_id == team_id, Membership.user_id == user.id)
    )


def get_team(db: Session, team_id: int) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Team not found")
    return team


def get_rota(db: Session, rota_id: int) -> Rota:
    rota = db.get(Rota, rota_id)
    if rota is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rota not found")
    return rota


def is_leader(db: Session, team_id: int, user: User) -> bool:
    if user.is_admin:
        return True
    m = membership_of(db, team_id, user)
    return bool(m and m.is_leader)


def require_member(db: Session, team_id: int, user: User) -> Membership | None:
    """Team member (or admin). Returns the membership, if any."""
    m = membership_of(db, team_id, user)
    if m is None and not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not a member of this team")
    return m


def require_leader(db: Session, team_id: int, user: User) -> None:
    if not is_leader(db, team_id, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only team leaders can do this")
