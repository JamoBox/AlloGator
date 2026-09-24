from __future__ import annotations

import ipaddress
import logging
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Runtime configuration, read from ``ALLOGATOR_*`` environment variables (or a .env file)."""

    model_config = SettingsConfigDict(env_prefix="ALLOGATOR_", env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./allogator.db"
    auto_migrate: bool = True

    # Public URL of the web UI; used to build links in emails and calendar feed URLs.
    base_url: str = "http://localhost:8000"

    # --- Authentication -------------------------------------------------------------------
    # "header": trust an identity header injected by an authenticating reverse proxy
    #           (oauth2-proxy, Pomerium, Cloudflare Access, ...). The app MUST NOT be reachable
    #           except through that proxy.
    # "dev":    no authentication; the UI offers a user switcher. Never use in production.
    auth_mode: Literal["header", "dev"] = "header"
    auth_email_header: str = "X-Forwarded-Email"
    auth_name_header: str = "X-Forwarded-Preferred-Username"
    # Optional comma-separated list of proxy IPs/CIDRs allowed to assert identity headers.
    trusted_proxies: str = ""
    dev_default_user: str = "leader@example.com"

    # Comma-separated emails that are always global admins.
    admin_emails: str = ""
    # When true, any signed-in user may create a team (and becomes its leader).
    open_team_creation: bool = True

    # --- Email ------------------------------------------------------------------------------
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "AlloGator <allogator@localhost>"
    smtp_starttls: bool = True
    smtp_ssl: bool = False

    # --- Scheduling -------------------------------------------------------------------------
    solver_time_limit_seconds: float = 20.0
    # Stop searching once the best rota hasn't improved for this long.
    solver_stall_seconds: float = 2.0
    solver_workers: int = 8

    # Built frontend to serve (the SPA). Empty = autodetect ../frontend/dist.
    static_dir: str = ""

    @field_validator("base_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @property
    def admin_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    @property
    def trusted_proxy_networks(self) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
        nets = []
        for part in self.trusted_proxies.split(","):
            part = part.strip()
            if part:
                nets.append(ipaddress.ip_network(part, strict=False))
        return nets

    @property
    def resolved_static_dir(self) -> Path | None:
        if self.static_dir:
            p = Path(self.static_dir)
            return p if p.is_dir() else None
        candidate = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
        return candidate if candidate.is_dir() else None


@lru_cache
def get_settings() -> Settings:
    return Settings()
