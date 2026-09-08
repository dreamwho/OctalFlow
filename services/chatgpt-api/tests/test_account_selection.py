from __future__ import annotations

from threading import Condition, Lock
from types import SimpleNamespace

import pytest

import services.account_service as account_service_module
from services.account_service import AccountService, ImageAccountSelectionError


def _account(token: str, *, status: str = "正常", account_type: str = "plus") -> dict:
    return {
        "access_token": token,
        "refresh_token": f"refresh-{token}",
        "status": status,
        "type": account_type,
        "image_quota_unknown": True,
        "quota": 0,
    }


@pytest.fixture
def selector(monkeypatch: pytest.MonkeyPatch) -> AccountService:
    service = object.__new__(AccountService)
    service._lock = Lock()
    service._image_slot_condition = Condition(service._lock)
    service._accounts = {
        "token-a": _account("token-a"),
        "token-b": _account("token-b"),
    }
    service._image_inflight = {}
    service._token_aliases = {}
    service._index = 0
    monkeypatch.setattr(service, "_refresh_accounts_snapshot_if_stale", lambda **_kwargs: False)
    monkeypatch.setattr(
        service,
        "ensure_access_token",
        lambda access_token, **_kwargs: access_token,
    )
    monkeypatch.setattr(
        account_service_module,
        "config",
        SimpleNamespace(image_account_concurrency=1),
    )
    return service


def test_text_selection_is_round_robin_and_refreshes_selected_credentials(selector: AccountService) -> None:
    assert [selector.get_text_access_token() for _ in range(3)] == [
        "token-a",
        "token-b",
        "token-a",
    ]


def test_image_selection_remote_preflight_skips_limited_account(selector: AccountService, monkeypatch: pytest.MonkeyPatch) -> None:
    def remote_info(token: str, _event: str, *, image_scope: bool = False) -> dict:
        assert image_scope is True
        account = dict(selector._accounts[token])
        if token == "token-a":
            account.update(status="限流", image_quota_unknown=False, quota=0)
        else:
            account.update(status="正常", image_quota_unknown=False, quota=3)
        return account

    monkeypatch.setattr(selector, "fetch_remote_info", remote_info)
    selected = selector.get_available_access_token()

    assert selected == "token-b"
    assert selector._image_inflight == {"token-b": 1}
    selector.release_image_slot(selected)
    assert selector._image_inflight == {}


def test_image_selection_reports_quota_exhaustion_only_after_all_remote_checks(
    selector: AccountService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def remote_info(token: str, _event: str, *, image_scope: bool = False) -> dict:
        assert image_scope is True
        account = dict(selector._accounts[token])
        account.update(status="限流", image_quota_unknown=False, quota=0)
        return account

    monkeypatch.setattr(selector, "fetch_remote_info", remote_info)

    with pytest.raises(ImageAccountSelectionError) as error:
        selector.get_available_access_token()

    assert error.value.kind == "quota_exhausted"
    assert selector._image_inflight == {}


def test_image_selection_applies_model_plan_filter_before_remote_preflight(
    selector: AccountService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    selector._accounts["token-a"]["type"] = "plus"
    selector._accounts["token-b"]["type"] = "pro"
    checked: list[str] = []

    def remote_info(token: str, _event: str, *, image_scope: bool = False) -> dict:
        assert image_scope is True
        checked.append(token)
        account = dict(selector._accounts[token])
        account.update(status="正常", image_quota_unknown=False, quota=1)
        return account

    monkeypatch.setattr(selector, "fetch_remote_info", remote_info)

    assert selector.get_available_access_token(plan_type="pro") == "token-b"
    assert checked == ["token-b"]
