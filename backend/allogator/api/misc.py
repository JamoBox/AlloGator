"""Notifications, admin, config, calendar feed and dev-mode helpers."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .. import __version__
from ..auth import get_current_user, require_admin
from ..config import get_settings
from ..db import get_db
from ..models import Membership, Notification, User, utcnow
from ..schemas import AdminUserOut, AdminUserUpdate, MarkRead, NotificationOut, UserOut
from ..services.email import OUTBOX
from ..services.ics import build_calendar
from .me import my_published_shifts

router = APIRouter(tags=["misc"])


@router.get("/api/health")
def health():
    return {"status": "ok"}


@router.get("/api/config")
def app_config():
    s = get_settings()
    return {
        "version": __version__,
        "auth_mode": s.auth_mode,
        "email_enabled": bool(s.smtp_host),
        "open_team_creation": s.open_team_creation,
        "base_url": s.base_url,
        "logout_url": s.logout_url,
    }


# --- Notifications -------------------------------------------------------------------------


@router.get("/api/notifications", response_model=list[NotificationOut])
def list_notifications(
    unread_only: bool = False,
    limit: int = 50,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    q = q.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(min(limit, 200))
    return list(db.scalars(q))


@router.get("/api/notifications/unread-count")
def unread_count(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    n = db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == user.id, Notification.read_at.is_(None)
        )
    )
    return {"count": n or 0}


@router.post("/api/notifications/read")
def mark_read(
    body: MarkRead, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    q = (
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=utcnow())
    )
    if body.ids is not None:
        q = q.where(Notification.id.in_(body.ids))
    db.execute(q)
    db.commit()
    return {"ok": True}


# --- Admin ---------------------------------------------------------------------------------


@router.get("/api/admin/users", response_model=list[AdminUserOut])
def admin_users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    counts = dict(
        db.execute(
            select(Membership.user_id, func.count(Membership.id)).group_by(Membership.user_id)
        )
        .tuples()
        .all()
    )
    users = db.scalars(select(User).order_by(User.email))
    return [
        AdminUserOut(
            id=u.id,
            email=u.email,
            display_name=u.display_name,
            name=u.name,
            is_admin=u.is_admin,
            active=u.active,
            created_at=u.created_at,
            last_seen_at=u.last_seen_at,
            team_count=counts.get(u.id, 0),
        )
        for u in users
    ]


@router.patch("/api/admin/users/{user_id}", response_model=UserOut)
def admin_update_user(
    user_id: int,
    body: AdminUserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if u.id == admin.id and (body.is_admin is False or body.active is False):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't demote or disable yourself")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(u, k, v)
    db.commit()
    return UserOut(
        id=u.id, email=u.email, display_name=u.display_name, name=u.name, is_admin=u.is_admin
    )


# --- Calendar subscription feed ------------------------------------------------------------
# Unauthenticated by design (calendar apps can't sign in); the URL contains a secret token.
# Configure the auth proxy to let /ical/* through (e.g. oauth2-proxy --skip-auth-route).


@router.get("/ical/{token}.ics", include_in_schema=False)
def calendar_feed(token: str, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.calendar_token == token))
    if user is None or not user.active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown calendar")
    shifts = my_published_shifts(db, user, utcnow() - timedelta(days=90), None, None)
    return Response(
        build_calendar(shifts, name=f"On-call: {user.name}", personal=True),
        media_type="text/calendar",
    )


# --- Dev mode --------------------------------------------------------------------------------


def _dev_only() -> None:
    if get_settings().auth_mode != "dev":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


@router.get("/api/dev/users", response_model=list[UserOut], dependencies=[Depends(_dev_only)])
def dev_users(db: Session = Depends(get_db)):
    return [
        UserOut(
            id=u.id, email=u.email, display_name=u.display_name, name=u.name, is_admin=u.is_admin
        )
        for u in db.scalars(select(User).where(User.active).order_by(User.display_name, User.email))
    ]


@router.get("/api/dev/outbox", dependencies=[Depends(_dev_only)])
def dev_outbox():
    return [
        {
            "to": m.to,
            "subject": m.subject,
            "text": m.text,
            "link": m.link,
            "created_at": m.created_at,
        }
        for m in reversed(OUTBOX)
    ]


@router.post("/api/dev/seed", dependencies=[Depends(_dev_only)])
def dev_seed(db: Session = Depends(get_db)):
    from ..demo import seed_demo

    return seed_demo(db)
