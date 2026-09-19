from __future__ import annotations

import json
from collections.abc import Iterator


def iter_sse_events(chunks: Iterator[bytes]) -> Iterator[dict]:
    """Parse UTF-8 SSE frames across arbitrary network chunk boundaries."""
    buffer = ""
    data: list[str] = []
    event_name = "message"
    for chunk in chunks:
        buffer += chunk.decode("utf-8", errors="replace")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.rstrip("\r")
            if not line:
                if data:
                    yield _decode_event(event_name, "\n".join(data))
                data = []
                event_name = "message"
                continue
            if line.startswith(":"):
                continue
            field, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if field == "event":
                event_name = value or "message"
            elif field == "data":
                data.append(value)
    if data:
        yield _decode_event(event_name, "\n".join(data))


def _decode_event(event_name: str, value: str) -> dict:
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        payload = {"raw": value}
    return {"event": event_name, "data": payload}

