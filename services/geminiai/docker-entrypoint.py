#!/usr/bin/env python3
"""Prepare GeminiAI's private volume, then run the API as an unprivileged user."""

from __future__ import annotations

import os
import sys
from pathlib import Path


SERVICE_UID = 10001
SERVICE_GID = 10001


def _harden_tree(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for root, directories, files in os.walk(path, followlinks=False):
        root_path = Path(root)
        os.chown(root_path, SERVICE_UID, SERVICE_GID, follow_symlinks=False)
        os.chmod(root_path, 0o700, follow_symlinks=False)
        for name in directories:
            candidate = root_path / name
            if not candidate.is_symlink():
                os.chown(candidate, SERVICE_UID, SERVICE_GID, follow_symlinks=False)
                os.chmod(candidate, 0o700, follow_symlinks=False)
        for name in files:
            candidate = root_path / name
            if not candidate.is_symlink():
                os.chown(candidate, SERVICE_UID, SERVICE_GID, follow_symlinks=False)
                os.chmod(candidate, 0o600, follow_symlinks=False)


def main() -> None:
    accounts_dir = Path(os.environ.get("AISTUDIO_ACCOUNTS_DIR", "/data/accounts"))
    tmp_dir = Path(os.environ.get("AISTUDIO_TMP_DIR", "/tmp/aistudio"))

    if os.geteuid() == 0:
        _harden_tree(accounts_dir)
        _harden_tree(tmp_dir)
        os.setgroups([])
        os.setgid(SERVICE_GID)
        os.setuid(SERVICE_UID)

    if len(sys.argv) < 2:
        raise SystemExit("missing sidecar command")
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
