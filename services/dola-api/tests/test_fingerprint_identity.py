import json

from dola_api.fingerprint_identity import (
    http_headers,
    load_or_create_http_identity,
    remember_egress_ip,
    stored_egress_ip,
)
from dola_api.query import _headers


def test_http_identity_persists_per_account(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLA_PROFILE_DIR", str(tmp_path))
    first = load_or_create_http_identity("acct-1")
    assert first and first["os"] in {"macos", "windows", "linux"}
    assert first["chromeMajor"] in {"143", "144", "145", "146"}
    assert first["locale"] and first["acceptLanguage"]
    assert len(first["window"]) == 2 and all(value > 0 for value in first["window"])
    # 同一账号再次读取必须得到完全一致的身份，不能重复随机。
    assert load_or_create_http_identity("acct-1") == first
    # 不同账号允许不同身份（不做强断言，只验证文件各自独立落盘）。
    (tmp_path / "acct-1" / "http-identity.json").exists()
    assert load_or_create_http_identity("acct-2")
    (tmp_path / "acct-2" / "http-identity.json").exists()


def test_http_identity_reuses_camoufox_preset_os(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLA_PROFILE_DIR", str(tmp_path))
    root = tmp_path / "acct-3"
    root.mkdir(parents=True)
    (root / "fingerprint-preset.json").write_text(json.dumps({"version": 2, "targetOs": "windows", "preset": {}}), encoding="utf-8")
    identity = load_or_create_http_identity("acct-3")
    assert identity["os"] == "windows"
    assert http_headers(identity)["secCHUAPlatform"] == '"Windows"'


def test_http_headers_cover_ua_language_and_client_hints(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLA_PROFILE_DIR", str(tmp_path))
    identity = load_or_create_http_identity("acct-4")
    overrides = http_headers(identity)
    assert overrides["userAgent"].startswith("Mozilla/5.0 (")
    assert f"Chrome/{identity['chromeMajor']}.0.0.0" in overrides["userAgent"]
    assert overrides["acceptLanguage"] == identity["acceptLanguage"]
    assert "Chromium" in overrides["secCHUA"]
    assert overrides["secCHUAPlatform"]
    assert http_headers(None) == {}
    assert http_headers({"os": "macos"}) == {}


def test_headers_use_identity_overrides_and_keep_legacy_defaults():
    base = _headers("a=1")
    assert base["user-agent"].endswith("Chrome/146.0.0.0 Safari/537.36")
    assert base["accept-language"] == "zh-CN,zh;q=0.9"
    assert base["sec-ch-ua-platform"] == '"Windows"'

    desktop = _headers("a=1", http_identity={"userAgent": "UA-Desktop", "acceptLanguage": "zh-CN,zh;q=0.9"})
    assert desktop["user-agent"] == "UA-Desktop"
    assert desktop["accept-language"] == "zh-CN,zh;q=0.9"
    assert desktop["sec-ch-ua-platform"] == '"Windows"'

    randomized = _headers("a=1", http_identity={"userAgent": "UA-Random", "acceptLanguage": "ja-JP,ja;q=0.9", "secCHUA": '"Not-A.Brand";v="24", "Chromium";v="143"', "secCHUAPlatform": '"macOS"'})
    assert randomized["user-agent"] == "UA-Random"
    assert randomized["accept-language"] == "ja-JP,ja;q=0.9"
    assert randomized["sec-ch-ua"] == '"Not-A.Brand";v="24", "Chromium";v="143"'
    assert randomized["sec-ch-ua-platform"] == '"macOS"'


def test_egress_ip_freezes_per_proxy(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLA_PROFILE_DIR", str(tmp_path))
    identity = load_or_create_http_identity("acct-5")
    remember_egress_ip(identity, "acct-5", "http://p1", "1.1.1.1")
    assert stored_egress_ip("acct-5") == ("1.1.1.1", "http://p1")
    # 相同代理继续使用冻结 IP；更换代理后会更新记录。
    remember_egress_ip(identity, "acct-5", "http://p2", "2.2.2.2")
    assert stored_egress_ip("acct-5") == ("2.2.2.2", "http://p2")
    assert stored_egress_ip("unknown") == (None, None)


def test_submit_persists_http_identity_on_task_meta(monkeypatch, tmp_path):
    import asyncio

    import dola_api.session as session_module
    from dola_api.contracts import VideoRequest

    monkeypatch.setenv("DOLA_PROFILE_DIR", str(tmp_path))
    pool = session_module.CamoufoxSessionPool()

    async def noop():
        return None

    async def fail_submit(*_args, **_kwargs):
        raise AssertionError("background submit must not run in this test")

    monkeypatch.setattr(pool, "_ensure_loaded", noop)
    monkeypatch.setattr(pool, "_persist", noop)
    monkeypatch.setattr(pool, "_run_page_submit", fail_submit)

    explicit = asyncio.run(pool.submit(VideoRequest(model="dola-seedance-2-5", prompt="p", duration=5, cookie="sid=1", accountId="desk-1", userAgent="UA-Desktop", acceptLanguage="zh-CN,zh;q=0.9")))
    assert pool._task_meta[explicit.id]["httpIdentity"] == {"userAgent": "UA-Desktop", "acceptLanguage": "zh-CN,zh;q=0.9"}
    assert "randomFingerprint" not in pool._task_meta[explicit.id]

    random_task = asyncio.run(pool.submit(VideoRequest(model="dola-seedance-2-5", prompt="p", duration=5, cookie="sid=1", accountId="random-1", randomFingerprint=True)))
    identity = pool._task_meta[random_task.id]["httpIdentity"]
    assert identity["userAgent"].startswith("Mozilla/5.0 (")
    assert identity["acceptLanguage"]
    assert pool._task_meta[random_task.id]["randomFingerprint"] is True

    legacy = asyncio.run(pool.submit(VideoRequest(model="dola-seedance-2-5", prompt="p", duration=5, cookie="sid=1", accountId="plain-1")))
    assert "httpIdentity" not in pool._task_meta[legacy.id]
    assert "randomFingerprint" not in pool._task_meta[legacy.id]
