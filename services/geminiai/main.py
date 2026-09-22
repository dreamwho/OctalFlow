#!/usr/bin/env python3
"""Unified local entrypoint."""

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

if __name__ == "__main__":
    # Python's resource tracker restarts the frozen executable with a -c payload.
    # PyInstaller's hook can miss this child on Python 3.14; dispatch only its
    # exact built-in tracker command before the application's CLI parses argv.
    if len(sys.argv) == 3 and sys.argv[1] == "-c":
        tracker = re.fullmatch(r"from multiprocessing\.resource_tracker import main;main\((\d+)\)", sys.argv[2])
        if tracker:
            from multiprocessing.resource_tracker import main as tracker_main

            tracker_main(int(tracker.group(1)))
            sys.exit(0)
    from multiprocessing import freeze_support

    freeze_support()
    from aistudio_api.main import main

    main()
