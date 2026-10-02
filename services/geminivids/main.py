"""Backward-compatible wrapper: geminiai-style top-level entrypoint."""

from geminivids_api.main import main

if __name__ == "__main__":
    raise SystemExit(main())
