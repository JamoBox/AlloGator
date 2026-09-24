"""Outbound email via SMTP. Without ``ALLOGATOR_SMTP_HOST`` emails are logged and kept in an
in-memory outbox (visible in dev mode), which also makes them easy to assert on in tests."""

from __future__ import annotations

import logging
import smtplib
import ssl
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.message import EmailMessage
from html import escape

from ..config import get_settings

log = logging.getLogger(__name__)


@dataclass
class OutgoingEmail:
    to: str
    subject: str
    text: str
    link: str = ""
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


OUTBOX: deque[OutgoingEmail] = deque(maxlen=200)


def _html(mail: OutgoingEmail) -> str:
    paragraphs = "".join(f"<p>{escape(p)}</p>" for p in mail.text.split("\n\n") if p.strip())
    button = (
        f'<p><a href="{escape(mail.link)}" style="background:#2f9e44;color:#fff;'
        f'padding:10px 16px;border-radius:6px;text-decoration:none">Open AlloGator</a></p>'
        if mail.link
        else ""
    )
    return (
        '<div style="font-family:system-ui,sans-serif;max-width:560px;color:#222">'
        f'<h2 style="color:#2b8a3e">{escape(mail.subject)}</h2>{paragraphs}{button}'
        '<p style="color:#888;font-size:12px">Sent by AlloGator. You can turn off email '
        "notifications from your profile.</p></div>"
    )


def send_emails(mails: list[OutgoingEmail]) -> None:
    if not mails:
        return
    s = get_settings()
    if not s.smtp_host:
        for mail in mails:
            OUTBOX.append(mail)
            log.info("[email:console] to=%s subject=%s\n%s", mail.to, mail.subject, mail.text)
        return
    try:
        if s.smtp_ssl:
            server: smtplib.SMTP = smtplib.SMTP_SSL(
                s.smtp_host, s.smtp_port, context=ssl.create_default_context(), timeout=20
            )
        else:
            server = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20)
        with server:
            if s.smtp_starttls and not s.smtp_ssl:
                server.starttls(context=ssl.create_default_context())
            if s.smtp_username:
                server.login(s.smtp_username, s.smtp_password)
            for mail in mails:
                msg = EmailMessage()
                msg["From"] = s.smtp_from
                msg["To"] = mail.to
                msg["Subject"] = mail.subject
                body = mail.text + (f"\n\n{mail.link}" if mail.link else "")
                msg.set_content(body)
                msg.add_alternative(_html(mail), subtype="html")
                try:
                    server.send_message(msg)
                except smtplib.SMTPException:
                    log.exception("Failed to send email to %s", mail.to)
    except (OSError, smtplib.SMTPException):
        log.exception("SMTP connection failed; %d email(s) not sent", len(mails))
