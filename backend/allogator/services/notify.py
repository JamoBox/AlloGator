"""In-app notifications + email fan-out, and the audit log."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from fastapi import BackgroundTasks
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import AuditEvent, Notification, User
from .email import OutgoingEmail, send_emails


class Notifier:
    """Creates notifications in the current transaction; emails are sent after the response
    (via BackgroundTasks) so a slow SMTP server never blocks the UI."""

    def __init__(self, db: Session, background: BackgroundTasks | None = None) -> None:
        self.db = db
        self.background = background
        self._pending: list[OutgoingEmail] = []

    def notify(
        self,
        users: Iterable[User],
        kind: str,
        title: str,
        body: str = "",
        link: str = "",
        *,
        email: bool = True,
        exclude: Iterable[int] = (),
    ) -> int:
        excluded = set(exclude)
        base = get_settings().base_url
        count = 0
        seen: set[int] = set()
        for user in users:
            if user is None or user.id in excluded or user.id in seen or not user.active:
                continue
            seen.add(user.id)
            self.db.add(Notification(user_id=user.id, kind=kind, title=title, body=body, link=link))
            count += 1
            if email and user.email_notifications and "@" in user.email:
                self._pending.append(
                    OutgoingEmail(
                        to=user.email,
                        subject=f"[AlloGator] {title}",
                        text=body,
                        link=f"{base}{link}" if link else base,
                    )
                )
        return count

    def flush(self) -> None:
        """Queue pending emails. Call after the DB commit succeeds."""
        mails, self._pending = self._pending, []
        if not mails:
            return
        if self.background is not None:
            self.background.add_task(send_emails, mails)
        else:
            send_emails(mails)


def audit(
    db: Session,
    action: str,
    summary: str,
    *,
    actor: User | None = None,
    team_id: int | None = None,
    rota_id: int | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    db.add(
        AuditEvent(
            action=action,
            summary=summary,
            actor_id=actor.id if actor else None,
            team_id=team_id,
            rota_id=rota_id,
            data=data,
        )
    )
