"""协议体构建与响应解析单测（不触网）。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from geminivids_api.protocol import (  # noqa: E402
    DEFAULT_PARAM_SLOTS,
    VidsProtocolError,
    build_generate_body,
    compute_sapisidhash,
    load_google_cookie_header,
    parse_generate_response,
)


def test_build_body_structure():
    body = json.loads(build_generate_body("DOC123", "hello world", 7))
    assert body[0] == 374
    ctx = body[2]
    assert len(ctx) == 41
    assert ctx[0] == 9 and ctx[6] == "0" and ctx[11] == [24, 0] and ctx[13] == "en" and ctx[19] == 1 and ctx[40] == 0
    assert ctx[4].startswith("goog_")
    # doc id 落在 slot 8 的 flix mime 引用
    ref = json.dumps(ctx[8])
    assert "DOC123" in ref and "application/vnd.google-apps.flix" in ref
    # prompt 位于 body[3][3]
    assert body[3] == [None, None, None, [[[None, None, "hello world"]]]]
    # 参数槽位于 body[4][15]，时长覆盖到末位
    assert body[4][15][8] == 7
    assert body[5] == [1, None, [[None, "1", 1189]]]
    assert body[6] == 1


def test_build_body_request_id_randomized():
    a = build_generate_body("D", "p", 5)
    b = build_generate_body("D", "p", 5)
    assert json.loads(a)[2][4] != json.loads(b)[2][4]


def test_parse_response_extracts_media():
    media = (
        '"40e6971ac6ceacd200065cc6926fbce5053aac3e752fe331","bard_storage","temp_data","lookup_temp_data",'
        '"https://contribution-rt.usercontent.google.com/download?c=abc&filename=video.mp4&opi=1",1920,1080,["6"]'
    )
    result = parse_generate_response(f'[[[[[{media}]]]]]')
    assert result.width == 1920 and result.height == 1080
    assert result.duration_seconds == 6
    assert result.media_url.startswith("https://contribution-rt.usercontent.google.com/download?c=abc")
    assert result.storage_key == "40e6971ac6ceacd200065cc6926fbce5053aac3e752fe331"


def test_parse_response_without_media_raises():
    try:
        parse_generate_response("[[null]]")
        raise AssertionError("should raise")
    except VidsProtocolError:
        pass


def test_cookie_header_scoped_to_google_com():
    state = {
        "cookies": [
            {"name": "SID", "value": "s1", "domain": ".google.com", "path": "/"},
            {"name": "SAPISID", "value": "sap", "domain": ".google.com", "path": "/"},
            {"name": "OSID", "value": "leak", "domain": ".docs.google.com", "path": "/"},
            {"name": "SID", "value": "yt", "domain": ".youtube.com", "path": "/"},
        ]
    }
    header = load_google_cookie_header(state)
    assert "SID=s1" in header and "SAPISID=sap" in header
    assert "OSID" not in header and "yt" not in header


def test_cookie_header_requires_auth_cookies():
    try:
        load_google_cookie_header({"cookies": [{"name": "NID", "value": "x", "domain": ".google.com", "path": "/"}]})
        raise AssertionError("should raise")
    except VidsProtocolError:
        pass


def test_sapisidhash_format():
    value = compute_sapisidhash("sap")
    assert value.startswith("SAPISIDHASH ")
    parts = value.split(" ")[1].split("_")
    assert len(parts) == 2 and parts[0].isdigit() and len(parts[1]) == 40


def test_default_slots_shape():
    assert DEFAULT_PARAM_SLOTS[8] == 10
    assert len(DEFAULT_PARAM_SLOTS) == 9


def test_generate_body_with_materials_shape():
    import json

    from geminivids_api.protocol import VidsMaterial, build_generate_body

    material = VidsMaterial(token="AVL_test", name="图片 1", material_id="UUID-1")
    body = json.loads(build_generate_body("doc1", "hello", 5, materials=[material]))
    assert body[0] == 376
    slot = body[2][25]
    entry = slot[0][0]
    assert entry[7][0] == "UUID-1"
    inner = entry[7][1][11]
    assert inner[8][3] == "AVL_test" and inner[8][4] == 1
    assert inner[13] == "图片 1"
    segments = body[3][3][0]
    assert segments[0] == [None, None, "hello"]
    assert segments[1] == [None, None, " "]
    assert segments[2][7][1] == [None, None, "图片 1"]
    assert segments[2][7][2][7] == ["UUID-1"]


def test_generate_body_text_only_unchanged():
    import json

    from geminivids_api.protocol import build_generate_body

    body = json.loads(build_generate_body("doc1", "hello", 5))
    assert body[0] == 374
    assert body[2][25] is None
    assert body[3][3] == [[[None, None, "hello"]]]
