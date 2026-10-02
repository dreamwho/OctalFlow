import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from geminivids_api.infrastructure.account_store import (  # noqa: E402
    AccountStore,
    parse_cookie_string_to_storage_state,
)


def _store(tmp_path):
    return AccountStore(tmp_path / "accounts")


def test_save_list_activate_delete_roundtrip(tmp_path):
    store = _store(tmp_path)
    meta = store.save_account("acc1", {"cookies": [{"name": "SID", "value": "x"}]}, email="a@gmail.com")
    assert store.list_accounts()[0].id == meta.id
    assert store.get_active_account().id == meta.id
    state = store.load_storage_state(meta.id)
    assert state["cookies"][0]["name"] == "SID"
    assert store.delete_account(meta.id) is True
    assert store.list_accounts() == []


def test_email_dedupe_updates_same_account(tmp_path):
    store = _store(tmp_path)
    first = store.save_account("one", {"cookies": []}, email="dup@gmail.com")
    second = store.save_account("two", {"cookies": []}, email="dup@gmail.com")
    assert first.id == second.id
    assert len(store.list_accounts()) == 1


def test_cookie_parser_requires_auth_cookies():
    try:
        parse_cookie_string_to_storage_state("NID=abc; OTZ=def")
        raise AssertionError("should raise")
    except ValueError:
        pass
    state = parse_cookie_string_to_storage_state("SID=abc; SAPISID=def; NID=x")
    names = {c["name"] for c in state["cookies"]}
    assert names == {"SID", "SAPISID", "NID"}
    assert all(c["domain"] == ".google.com" for c in state["cookies"])
