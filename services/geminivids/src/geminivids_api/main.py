"""Unified CLI entrypoint: server (default)."""

from __future__ import annotations

import argparse


def main() -> int:
    parser = argparse.ArgumentParser(prog="geminivids-api")
    sub = parser.add_subparsers(dest="command")
    srv = sub.add_parser("server")
    srv.add_argument("--host", default=None)
    srv.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    if args.command == "server":
        import uvicorn
        from geminivids_api.config import settings

        uvicorn.run("geminivids_api.api.app:app",
                    host=args.host or settings.host,
                    port=args.port or settings.port,
                    log_level="info")
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
