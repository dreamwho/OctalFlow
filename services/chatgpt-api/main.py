"""Loopback-only entrypoint for the internal ChatGPT provider runtime."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from services.internal_runtime import initialize_runtime_environment


initialize_runtime_environment()

from api.app import create_app


app = create_app()


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Octal Canvas ChatGPT provider")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8046)
    return parser.parse_args()


if __name__ == "__main__":
    import uvicorn

    args = _arguments()
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        access_log=False,
        log_level="info",
    )
