"""Freeze the restricted provider's process-scoped runtime before imports.

The provider deliberately binds its encrypted database and source auth mapping
when its modules first load.  Tests therefore share one disposable runtime
instead of letting whichever test imports a service first inherit caller
environment variables.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest


_TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="octalaicanvas-chatgpt-api-tests-"))
_TEST_RUNTIME_KEY = "fixture-runtime-key-0123456789abcdef"
_TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

os.environ.update({
    "OCTALAICANVAS_CHATGPT_DATA_DIR": str(_TEST_DATA_DIR),
    "OCTALAICANVAS_CHATGPT_API_KEY": _TEST_RUNTIME_KEY,
    "OCTALAICANVAS_ENCRYPTION_KEY": _TEST_ENCRYPTION_KEY,
})
for _name in (
    "CHATGPT2API_AUTH_KEY",
    "CHATGPT2API_BASE_URL",
    "OCTALAICANVAS_CHATGPT_PUBLIC_BASE_URL",
    "DATABASE_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
):
    os.environ.pop(_name, None)

# The restricted runtime is intentionally process-scoped.  Import it only
# after the disposable environment is complete, before any test-local
# monkeypatch can import and bind a different data directory.
from api.app import create_app as _create_app  # noqa: E402,F401


@pytest.fixture(scope="session")
def runtime_data_dir() -> Path:
    return _TEST_DATA_DIR


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    del session, exitstatus
    try:
        from services.application_database import dispose_all_database_engines

        dispose_all_database_engines()
    except Exception:
        pass
    shutil.rmtree(_TEST_DATA_DIR, ignore_errors=True)
