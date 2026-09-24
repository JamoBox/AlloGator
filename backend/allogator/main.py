from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import me, misc, rotas, swaps, teams
from .config import get_settings
from .db import get_engine
from .migrate import upgrade_database

log = logging.getLogger("allogator")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    if s.auto_migrate:
        upgrade_database(get_engine())
    if s.auth_mode == "dev":
        log.warning("AlloGator is running in DEV auth mode: anyone can act as any user.")
    elif not s.trusted_proxies:
        log.warning(
            "Trusting the %s header from any client. Make sure AlloGator is only reachable "
            "through your auth proxy, or set ALLOGATOR_TRUSTED_PROXIES.",
            s.auth_email_header,
        )
    yield


def create_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    app = FastAPI(title="AlloGator", version=__version__, lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)
    for r in (me.router, teams.router, rotas.router, swaps.router, misc.router):
        app.include_router(r)

    static = get_settings().resolved_static_dir
    if static is not None:
        _mount_spa(app, static)
    return app


class ImmutableStaticFiles(StaticFiles):
    """Built assets have content hashes in their names, so browsers can cache them forever."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def _mount_spa(app: FastAPI, static: Path) -> None:
    index = static / "index.html"
    if (static / "assets").is_dir():
        app.mount("/assets", ImmutableStaticFiles(directory=static / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str, request: Request):
        if path.startswith("api/") or path == "api":
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = (static / path).resolve()
        if path and candidate.is_file() and static.resolve() in candidate.parents:
            return FileResponse(candidate)
        if not index.is_file():
            raise HTTPException(404)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = create_app()
