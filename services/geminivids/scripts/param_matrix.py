#!/usr/bin/env python3
"""Param slot matrix runner v2: valid structure, observe output dims/duration."""
from __future__ import annotations
import json, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from geminivids_api.protocol import DEFAULT_PARAM_SLOTS, VidsProtocolClient

STATE = "/tmp/gvids-capture/fresh-auth.json"
DOC_ID = "1W3CDzxkjsVq-8oS8wt2mwoqdgpO6wEPvDgiW9H5szHo"
OUT_DIR = pathlib.Path("/tmp/gvids-capture/matrix2")
REPORT = OUT_DIR / "report.jsonl"
PROMPTS = [
    "A calm koi pond seen from above, orange fish gliding between lily pads",
    "Slow motion steam rising from a fresh cup of coffee on a wooden table",
    "A paper boat sailing across a rain puddle reflecting the sky",
    "Colorful hot air balloons drifting over green hills at sunrise",
    "Close-up of dew drops on a spider web sparkling in golden light",
    "A retro train crossing an old stone bridge in autumn forest",
]

def slots(**kw):
    s = list(DEFAULT_PARAM_SLOTS)
    for k, v in kw.items():
        s[int(k[1:])] = v
    return s

COMBOS = [
    ("F1_p4_2_d4", slots(p4=2), 4),
    ("F2_p3_1_d8", slots(p3=1), 8),
    ("F3_p1_13_d6", slots(p1=13), 6),
    ("F4_p0_1_d5", slots(p0=1), 5),
    ("F5_p1_11_d7", slots(p1=11), 7),
]

def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    client = VidsProtocolClient(json.load(open(STATE)))
    for i, (label, s, dur) in enumerate(COMBOS):
        row = {"label": label, "slots": s, "duration_req": dur}
        t0 = time.time()
        try:
            result = client.generate(DOC_ID, PROMPTS[i % len(PROMPTS)], duration_seconds=dur, param_slots=s)
            row.update(width=result.width, height=result.height,
                       duration=result.duration_seconds,
                       elapsed_s=round(time.time() - t0, 1),
                       url=result.media_url[:110])
            try:
                data = client.download(result.media_url)
                p = OUT_DIR / f"{label}.mp4"
                p.write_bytes(data)
                row["file_size"] = len(data)
            except Exception as exc:
                row["download_error"] = str(exc)[:150]
        except Exception as exc:
            row["error"] = str(exc)[:200]
            row["elapsed_s"] = round(time.time() - t0, 1)
        with REPORT.open("a") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(json.dumps(row, ensure_ascii=False), flush=True)
        time.sleep(3)
    return 0

if __name__ == "__main__":
    sys.exit(main())
