"""Harden /data permissions then drop privileges (mirrors geminiai entrypoint)."""

from __future__ import annotations

import os
import sys


def _harden(path: str, uid: int, gid: int) -> None:
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
        for root, dirs, files in os.walk(path):
            os.chown(root, uid, gid)
            os.chmod(root, 0o700)
            for name in dirs + files:
                full = os.path.join(root, name)
                os.chown(full, uid, gid)
                os.chmod(full, 0o700 if os.path.isdir(full) else 0o600)
    except OSError as exc:
        print(f"[entrypoint] harden {path} failed: {exc}", file=sys.stderr)


def main() -> int:
    uid, gid = 10011, 10011
    if os.getuid() == 0:
        _harden("/data/accounts", uid, gid)
        _harden("/data/tasks", uid, gid)
        os.setgid(gid)
        os.setuid(uid)
        os.environ["HOME"] = "/home/geminivids"
    cmd = sys.argv[1:]
    if not cmd:
        cmd = ["python", "-m", "geminivids_api.main", "server", "--host", "0.0.0.0", "--port", "8080"]
    os.execvp(cmd[0], cmd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
