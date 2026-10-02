#!/usr/bin/env python3
"""Google Vids (docs.google.com/videos) protocol capture tool.

Drives a persistent Camoufox profile through the Vids UI while recording every
network exchange (URL, headers, POST bodies, response bodies) to a JSONL session
log. Actions are chained via repeated --action flags and executed in order.

Usage:
  .venv/bin/python scripts/capture.py \
    --action goto=https://docs.google.com/videos/u/0/ \
    --action wait=4 --action shot=home --action aria

Action forms:
  goto=URL                 navigate and wait for load
  wait=SECONDS             sleep
  shot=NAME                save screenshot to shots/NAME.png
  aria                     dump aria snapshot of body to shots/NAME.aria.txt (name=last shot)
  click-text=TEXT          click first visible element containing TEXT
  click-selector=CSS       click css selector
  fill=CSS::TEXT           set input value
  press=KEY                keyboard press (Enter, Tab, ...)
  type=TEXT                type literal text into focused element
  scroll=DY                scroll window by DY pixels
  reload                   reload page
  eval=JS                  evaluate JS and print result
  import-cookies=PATH      add cookies from a Playwright storage_state json (run once on a fresh profile)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import pathlib
import sys
import time
import traceback

ROOT = pathlib.Path(__file__).resolve().parent
CAPTURE_DIR = pathlib.Path(os.environ.get("GVIDS_CAPTURE_DIR", "/tmp/gvids-capture"))
PROFILE_DIR = CAPTURE_DIR / "profile"
SHOTS_DIR = CAPTURE_DIR / "shots"
LOG_DIR = CAPTURE_DIR / "logs"
MAX_BODY = int(os.environ.get("GVIDS_CAPTURE_MAX_BODY", "40000"))

SENSITIVE_HEADERS = {"cookie", "authorization", "x-goog-authuser"}


def _now() -> str:
    return _dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", action="append", default=[])
    parser.add_argument("--headed", action="store_true", default=os.environ.get("GVIDS_HEADED", "") != "0")
    parser.add_argument("--width", type=int, default=1680)
    parser.add_argument("--height", type=int, default=1050)
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args()

    for d in (SHOTS_DIR, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)

    session_id = _now()
    log_path = LOG_DIR / f"session-{session_id}.jsonl"

    from camoufox.sync_api import Camoufox

    entries: list[dict] = []

    def record(kind: str, **payload) -> None:
        entry = {"t": time.time(), "kind": kind, **payload}
        entries.append(entry)
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def redact(headers: dict | None) -> dict:
        if not headers:
            return {}
        out = {}
        for k, v in headers.items():
            lk = k.lower()
            if lk == "cookie":
                out[k] = f"<{len(str(v))} chars>"
            elif lk in SENSITIVE_HEADERS:
                out[k] = str(v)[:24] + "..."
            else:
                out[k] = v
        return out

    if True:
        with Camoufox(
            headless=not args.headed,
            persistent_context=True,
            user_data_dir=str(PROFILE_DIR),
            window=(args.width, args.height),
            locale="zh-CN",
        ) as context:
            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(args.timeout * 1000)

            def on_request(request) -> None:
                try:
                    post = request.post_data
                except Exception:
                    post = None
                body = None
                if post:
                    body = post[:MAX_BODY]
                record(
                    "request",
                    method=request.method,
                    url=request.url,
                    headers=redact(request.headers),
                    post_data=body,
                )

            def on_response(response) -> None:
                url = response.url
                if "temporaryblob" in url or "upload" in url:
                    try:
                        hdrs = {k: v for k, v in (response.headers or {}).items()}
                    except Exception:
                        hdrs = {}
                    try:
                        body_txt = response.text()[:2000] if (response.headers or {}).get("content-type", "") not in ("application/octet-stream",) else "<binary>"
                    except Exception as exc:
                        body_txt = f"<body error {exc}>"
                    record("upload_response", status=response.status, url=url, headers=hdrs, body=body_txt)
                if any(k in url for k in ("usercontent", "accounts.google.com", "SetOSID", "ServiceLogin")):
                    try:
                        sc = response.headers.get("set-cookie", "")
                        loc = response.headers.get("location", "")
                    except Exception:
                        sc = loc = ""
                    record(
                        "auth_hop",
                        status=response.status,
                        url=url[:200],
                        location=loc[:200],
                        set_cookie=sc[:300],
                    )
                ct = (response.headers or {}).get("content-type", "")
                interesting = (
                    "batchexecute" in url
                    or "json" in ct
                    or "protobuf" in ct
                    or "text/plain" in ct
                )
                if not interesting:
                    return
                try:
                    raw = response.body()
                except Exception as exc:
                    record("response_error", url=url, error=str(exc))
                    return
                snippet = raw[:MAX_BODY]
                record(
                    "response",
                    status=response.status,
                    url=url,
                    content_type=ct,
                    body=snippet.decode("utf-8", "replace"),
                )

            page.on("request", on_request)
            page.on("response", on_response)

            def do_goto(url: str) -> None:
                print(f"[goto] {url}")
                page.goto(url, wait_until="domcontentloaded", timeout=args.timeout * 1000)
                try:
                    page.wait_for_load_state("networkidle", timeout=15_000)
                except Exception:
                    pass

            def do_click_text(text: str) -> None:
                print(f"[click-text] {text!r}")
                candidates = [
                    page.get_by_role("button", name=text, exact=False),
                    page.get_by_role("menuitem", name=text, exact=False),
                    page.get_by_role("link", name=text, exact=False),
                    page.get_by_text(text, exact=False),
                ]
                for loc in candidates:
                    try:
                        loc.first.click(timeout=6_000)
                        print(f"  -> clicked role/text {text!r}")
                        return
                    except Exception:
                        continue
                for selector in (
                    f"button:has-text(\"{text}\")",
                    f"[role=button]:has-text(\"{text}\")",
                    f"a:has-text(\"{text}\")",
                    f"[role=menuitem]:has-text(\"{text}\")",
                    f"div[role]:has-text(\"{text}\")",
                    f"span:text-is(\"{text}\")",
                ):
                    loc = page.locator(selector).filter(visible=True)
                    try:
                        if loc.count() > 0:
                            loc.first.click(timeout=8_000)
                            print(f"  -> clicked via {selector}")
                            return
                    except Exception:
                        continue
                raise RuntimeError(f"no clickable element for text {text!r}")

            def do_shot(name: str) -> None:
                path = SHOTS_DIR / f"{name}.png"
                page.screenshot(path=str(path))
                print(f"[shot] {path}")

            def do_aria(name: str) -> None:
                try:
                    snap = page.locator("body").aria_snapshot()
                except Exception as exc:
                    snap = f"<aria snapshot failed: {exc}>"
                path = SHOTS_DIR / f"{name}.aria.txt"
                path.write_text(snap, encoding="utf-8")
                print(f"[aria] {path} ({len(snap)} chars)")

            last_shot = ["page"]

            for raw_action in args.action:
                action, _, value = raw_action.partition("=")
                try:
                    if action == "goto":
                        do_goto(value)
                    elif action == "wait":
                        time.sleep(float(value))
                    elif action == "shot":
                        last_shot[0] = value
                        do_shot(value)
                    elif action == "aria":
                        do_aria(last_shot[0])
                    elif action == "click-text":
                        do_click_text(value)
                    elif action == "click-selector":
                        print(f"[click-selector] {value}")
                        page.click(value, timeout=10_000)
                    elif action == "upload":
                        # value = PATH[,index] ; uploads to the nth hidden input[type=file]
                        path, _, idx = value.partition(",")
                        files = page.locator("input[type=file]")
                        target = files.nth(int(idx) if idx else 0)
                        target.set_input_files(path, timeout=15_000)
                        print(f"[upload] {path} -> input[{idx or 0}]")
                    elif action == "focus-last-tab":
                        deadline = time.time() + 8
                        while time.time() < deadline and len(context.pages) < 2:
                            time.sleep(0.3)
                        print(f"[focus-last-tab] pages={len(context.pages)}")
                        target = context.pages[-1]
                        if target is not page:
                            page = target
                            page.set_default_timeout(args.timeout * 1000)
                            page.on("request", on_request)
                            page.on("response", on_response)
                            try:
                                page.bring_to_front()
                            except Exception:
                                pass
                        print(f"  -> focused {page.url[:120]}")
                    elif action == "vids-create":
                        prompt = value
                        print(f"[vids-create] prompt={prompt!r}")
                        page.get_by_role("tab", name="创建").click(timeout=8_000)
                        time.sleep(1)
                        try:
                            page.get_by_role("button", name="展开", exact=True).click(timeout=2_500)
                            time.sleep(1)
                        except Exception:
                            pass
                        # remove all attached materials
                        while True:
                            rm = page.get_by_role("button", name="移除图片 1")
                            try:
                                rm.click(timeout=3_000)
                                time.sleep(0.6)
                            except Exception:
                                break
                        box = None
                        for box_name in ("指定您想如何使用这些素材", "描述您的视频"):
                            try:
                                box = page.get_by_role("textbox", name=box_name, exact=False).first
                                box.click(timeout=5_000)
                                break
                            except Exception:
                                box = None
                                continue
                        if box is None:
                            raise RuntimeError("prompt textbox not found")
                        box.click(timeout=8_000)
                        page.keyboard.press("Meta+a")
                        page.keyboard.press("Backspace")
                        time.sleep(0.4)
                        page.keyboard.type(prompt, delay=12)
                        time.sleep(1)
                        do_shot("vids-typed")
                        panel = page.get_by_role("tabpanel", name="创建")
                        gen = panel.get_by_role("button", name="生成", exact=True)
                        gen.click(timeout=8_000)
                        print("  -> clicked 生成 in 创建 tabpanel")
                    elif action == "vids-full":
                        # vids-full=PROMPT|res=1080p|orient=横屏|dur=5|model=Omni
                        parts = value.split("|")
                        prompt = parts[0]
                        opts = dict(p.split("=", 1) for p in parts[1:] if "=" in p)
                        res = opts.get("res")
                        orient = opts.get("orient")
                        dur = opts.get("dur")
                        print(f"[vids-full] prompt={prompt[:50]!r} opts={opts}")
                        page.get_by_role("tab", name="创建").click(timeout=8_000)
                        time.sleep(1)
                        try:
                            page.get_by_role("button", name="展开", exact=True).click(timeout=2_500)
                            time.sleep(1)
                        except Exception:
                            pass
                        while True:
                            try:
                                page.get_by_role("button", name="移除图片 1").click(timeout=3_000)
                                time.sleep(0.5)
                            except Exception:
                                break
                        box = None
                        for box_name in ("指定您想如何使用这些素材", "描述您的视频"):
                            try:
                                cand = page.get_by_role("textbox", name=box_name, exact=False).first
                                cand.click(timeout=5_000)
                                box = cand
                                break
                            except Exception:
                                continue
                        if box is None:
                            raise RuntimeError("prompt textbox not found")
                        page.keyboard.press("Meta+a")
                        page.keyboard.press("Backspace")
                        time.sleep(0.3)
                        page.keyboard.type(prompt, delay=10)
                        time.sleep(1.5)
                        do_shot("vf-typed")
                        # settings now visible
                        try:
                            st_btn = None
                            for cand in (
                                page.get_by_role("button", name="生成设置", exact=False),
                                page.get_by_text("生成设置", exact=False),
                            ):
                                try:
                                    cand.first.click(timeout=5_000)
                                    st_btn = cand
                                    break
                                except Exception:
                                    continue
                            if st_btn is None:
                                raise RuntimeError("settings button not found after typing")
                            time.sleep(1)
                            do_shot("vf-settings-open")
                            if res:
                                try:
                                    page.get_by_text("720p", exact=False).first.click(timeout=4_000)
                                    time.sleep(1)
                                    do_shot("vf-res-menu")
                                    page.get_by_text(res, exact=False).first.click(timeout=4_000)
                                    time.sleep(1)
                                except Exception as exc:
                                    print(f"  [vids-full] res change failed: {exc}")
                            if orient:
                                try:
                                    page.get_by_role("radio", name=orient, exact=False).first.click(timeout=4_000)
                                    time.sleep(0.6)
                                except Exception as exc:
                                    print(f"  [vids-full] orient change failed: {exc}")
                            if dur:
                                try:
                                    loc = page.get_by_role("slider", name="视频时长", exact=False).first
                                    loc.click(timeout=4_000)
                                    for _ in range(40):
                                        raw = loc.get_attribute("aria-valuenow")
                                        cur = int(float(raw or "0"))
                                        if cur == int(dur):
                                            break
                                        page.keyboard.press("ArrowLeft" if cur > int(dur) else "ArrowRight")
                                        time.sleep(0.15)
                                except Exception as exc:
                                    print(f"  [vids-full] duration change failed: {exc}")
                            do_shot("vf-settings-applied")
                            # close popover so generate button clickable
                            page.keyboard.press("Escape")
                            time.sleep(0.8)
                        except Exception as exc:
                            print(f"  [vids-full] settings stage issue: {exc}")
                        panel = page.get_by_role("tabpanel", name="创建")
                        gen = panel.get_by_role("button", name="生成", exact=True)
                        gen.click(timeout=10_000)
                        print("  -> clicked 生成")
                    elif action == "vids-expand":
                        try:
                            page.get_by_role("button", name="展开", exact=True).click(timeout=3_000)
                            print("[vids-expand] expanded")
                            time.sleep(1)
                        except Exception:
                            print("[vids-expand] already expanded")
                    elif action == "slider-aria":
                        name, _, target = value.partition("::")
                        target = int(target)
                        print(f"[slider-aria] {name!r} -> {target}")
                        loc = page.get_by_role("slider", name=name, exact=False).first
                        loc.click(timeout=8_000)
                        for _ in range(40):
                            raw = loc.get_attribute("aria-valuenow")
                            try:
                                cur = int(float(raw or "0"))
                            except ValueError:
                                break
                            if cur == target:
                                break
                            key = "ArrowLeft" if cur > target else "ArrowRight"
                            page.keyboard.press(key)
                            time.sleep(0.15)
                        print(f"  -> slider now {loc.get_attribute('aria-valuenow')}")
                    elif action == "click-aria":
                        role, _, name = value.partition("::")
                        print(f"[click-aria] {role} {name!r}")
                        page.get_by_role(role, name=name, exact=False).first.click(timeout=10_000)
                    elif action == "mouse-aria":
                        role, _, name = value.partition("::")
                        loc = page.get_by_role(role, name=name, exact=False).first
                        loc.wait_for(state="visible", timeout=10_000)
                        box = loc.bounding_box()
                        print(f"[mouse-aria] {role} {name!r} box={box}")
                        if box:
                            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                            time.sleep(0.15)
                            page.mouse.down()
                            time.sleep(0.05)
                            page.mouse.up()
                    elif action == "fill-aria":
                        name, _, text = value.partition("::")
                        print(f"[fill-aria] {name!r} <- {text!r}")
                        loc = page.get_by_role("textbox", name=name, exact=False).first
                        loc.click(timeout=12_000)
                        page.keyboard.type(text, delay=15)
                    elif action == "fill":
                        css, _, text = value.partition("::")
                        print(f"[fill] {css} <- {text!r}")
                        page.fill(css, text, timeout=10_000)
                    elif action == "press":
                        print(f"[press] {value}")
                        page.keyboard.press(value)
                    elif action == "type":
                        print(f"[type] {value!r}")
                        page.keyboard.type(value, delay=30)
                    elif action == "scroll":
                        page.evaluate(f"window.scrollBy(0, {int(value)})")
                    elif action == "reload":
                        page.reload(wait_until="domcontentloaded")
                    elif action == "eval":
                        result = page.evaluate(value)
                        print(f"[eval] {json.dumps(result, ensure_ascii=False, default=str)[:4000]}")
                        record("eval", source=value, result=str(result)[:4000])
                    elif action == "import-cookies":
                        state = json.loads(pathlib.Path(value).read_text(encoding="utf-8"))
                        cookies = state.get("cookies", [])
                        context.add_cookies(cookies)
                        print(f"[import-cookies] added {len(cookies)} cookies")
                    else:
                        raise RuntimeError(f"unknown action {action!r}")
                except Exception as exc:
                    print(f"[action-error] {raw_action!r}: {exc}")
                    traceback.print_exc()
                    record("action_error", action=raw_action, error=str(exc))
                    safe = raw_action.split("=")[0]
                    try:
                        do_shot(f"error-{safe}-{session_id}")
                    except Exception:
                        pass

            try:
                do_shot(f"final-{session_id}")
            except Exception:
                pass
            print(f"requests captured: {len(entries)}")
            print(f"log: {log_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
