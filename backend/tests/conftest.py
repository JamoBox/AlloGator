from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from allogator import db as db_module
from allogator.config import get_settings
from allogator.services.email import OUTBOX


@pytest.fixture
def settings_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ALLOGATOR_DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("ALLOGATOR_AUTH_MODE", "dev")
    monkeypatch.setenv("ALLOGATOR_BASE_URL", "https://allogator.test")
    monkeypatch.setenv("ALLOGATOR_SOLVER_TIME_LIMIT_SECONDS", "5")
    monkeypatch.setenv("ALLOGATOR_SOLVER_STALL_SECONDS", "0.5")
    monkeypatch.setenv("ALLOGATOR_SOLVER_WORKERS", "4")
    monkeypatch.setenv("ALLOGATOR_STATIC_DIR", str(tmp_path / "no-static"))
    get_settings.cache_clear()
    db_module.init_engine()
    OUTBOX.clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def app(settings_env):
    from allogator.main import create_app

    return create_app()


class Api:
    """Tiny helper: api.as_("a@x.com").get(...)."""

    def __init__(self, client: TestClient, email: str = "leader@example.com") -> None:
        self.client = client
        self.email = email

    def as_(self, email: str) -> Api:
        return Api(self.client, email)

    def _h(self, kw):
        headers = kw.pop("headers", {}) or {}
        headers["X-AlloGator-Dev-User"] = self.email
        return headers

    def request(self, method: str, url: str, expect: int | None = 200, **kw):
        r = self.client.request(method, url, headers=self._h(kw), **kw)
        if expect is not None:
            assert r.status_code == expect, f"{method} {url} -> {r.status_code}: {r.text}"
        return r

    def get(self, url, expect=200, **kw):
        return self.request("GET", url, expect, **kw)

    def post(self, url, expect=200, **kw):
        return self.request("POST", url, expect, **kw)

    def patch(self, url, expect=200, **kw):
        return self.request("PATCH", url, expect, **kw)

    def delete(self, url, expect=204, **kw):
        return self.request("DELETE", url, expect, **kw)


@pytest.fixture
def api(app) -> Iterator[Api]:
    with TestClient(app) as client:
        yield Api(client)


@pytest.fixture
def db(settings_env, api):
    session = db_module.session_factory()()
    try:
        yield session
    finally:
        session.close()
