"""Entrypoint for the independent Dola desktop provider binary."""

import os
from multiprocessing import freeze_support

import uvicorn

from dola_api.app import app


if __name__ == "__main__":
    freeze_support()
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["DOLA_PROVIDER_PORT"]), access_log=False)
