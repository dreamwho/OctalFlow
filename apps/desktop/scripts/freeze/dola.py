"""Standalone Dola runtime entrypoint for the desktop package."""

import os

import uvicorn

from dola_api.app import app


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["DOLA_PROVIDER_PORT"]), access_log=False)
