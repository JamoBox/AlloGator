"""Command line: `allogator serve | migrate | seed-demo | make-admin EMAIL`."""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="allogator", description="AlloGator on-call planner")
    sub = parser.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="Run the web server")
    serve.add_argument("--host", default="0.0.0.0")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--reload", action="store_true")
    sub.add_parser("migrate", help="Apply database migrations")
    seed = sub.add_parser("seed-demo", help="Create a demo team with sample data (dev mode)")
    seed.add_argument("--force", action="store_true", help="Seed even outside dev auth mode")
    admin = sub.add_parser("make-admin", help="Grant global admin to a user (by email)")
    admin.add_argument("email")
    args = parser.parse_args(argv)

    dev = False
    if args.cmd == "seed-demo":
        from .config import get_settings

        dev = get_settings().auth_mode == "dev"
        if not dev and not args.force:
            print(
                "Refusing to seed demo data: ALLOGATOR_AUTH_MODE is not 'dev', so this may be a "
                "real database. Pass --force to seed it anyway (the demo leader is not made an "
                "admin).",
                file=sys.stderr,
            )
            return 1
        if not dev:
            print("Warning: seeding demo data into a non-dev database.", file=sys.stderr)

    if args.cmd == "serve":
        import uvicorn

        uvicorn.run(
            "allogator.main:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
            proxy_headers=True,
        )
        return 0

    from .db import get_engine, session_factory
    from .migrate import upgrade_database

    upgrade_database(get_engine())
    if args.cmd == "migrate":
        print("Database is up to date.")
        return 0

    db = session_factory()()
    try:
        if args.cmd == "seed-demo":
            from .demo import seed_demo

            print(seed_demo(db, admin=dev))
        elif args.cmd == "make-admin":
            from .auth import get_or_create_user

            user = get_or_create_user(db, args.email)
            user.is_admin = True
            db.commit()
            print(f"{user.email} is now an admin.")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
