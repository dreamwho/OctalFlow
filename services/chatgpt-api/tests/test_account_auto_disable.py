from __future__ import annotations

from services.account_service import AccountService
from services.storage.database_storage import DatabaseStorageBackend


def _account(token: str, **values: object) -> dict:
    return {
        "access_token": token,
        "refresh_token": f"refresh-{token}",
        "status": "正常",
        "quota": 1,
        "image_quota_unknown": False,
        **values,
    }


def _service(tmp_path, accounts: list[dict]) -> tuple[AccountService, DatabaseStorageBackend]:
    backend = DatabaseStorageBackend(f"sqlite:///{(tmp_path / 'accounts.sqlite3').as_posix()}")
    backend.replace_accounts(accounts)
    return AccountService(backend), backend


def test_startup_disables_persisted_confirmed_invalid_account(tmp_path) -> None:
    service, backend = _service(tmp_path, [
        _account("invalid", status="异常", last_remote_check_result="invalid"),
        _account("retryable", status="异常", last_remote_check_result="error"),
    ])

    persisted = {item["access_token"]: item for item in backend.load_accounts()}
    assert service._accounts["invalid"]["status"] == "禁用"
    assert persisted["invalid"]["status"] == "禁用"
    assert service._accounts["retryable"]["status"] == "异常"


def test_new_confirmed_invalid_is_persisted_disabled_and_not_selectable(tmp_path, monkeypatch) -> None:
    service, backend = _service(tmp_path, [_account("invalid")])
    monkeypatch.setattr("services.account_service.config", type("Config", (), {"auto_remove_invalid_accounts": False})())

    service.handle_invalid_token("invalid", "401", error="invalid credential")

    assert service._accounts["invalid"]["status"] == "禁用"
    assert backend.load_accounts()[0]["status"] == "禁用"
    assert service.get_text_access_token() == ""


def test_transient_verification_error_remains_retryable(tmp_path, monkeypatch) -> None:
    service, backend = _service(tmp_path, [_account("transient")])
    monkeypatch.setattr("services.account_service.config", type("Config", (), {"auto_remove_invalid_accounts": False})())

    assert service._record_remote_check_error("transient", "verify", "network timeout")

    persisted = backend.load_accounts()[0]
    assert persisted["status"] == "正常"
    assert persisted["last_remote_check_result"] == "error"


def test_manually_disabled_account_is_not_auto_removed(tmp_path, monkeypatch) -> None:
    service, backend = _service(tmp_path, [_account("manual", status="禁用")])
    monkeypatch.setattr("services.account_service.config", type("Config", (), {"auto_remove_invalid_accounts": True})())

    service.handle_invalid_token("manual", "401", error="invalid credential")

    assert service._accounts["manual"]["status"] == "禁用"
    assert backend.load_accounts()[0]["status"] == "禁用"


def test_auto_remove_invalid_accounts_still_removes_newly_invalid_account(tmp_path, monkeypatch) -> None:
    service, backend = _service(tmp_path, [_account("remove")])
    monkeypatch.setattr("services.account_service.config", type("Config", (), {"auto_remove_invalid_accounts": True})())

    assert service.handle_invalid_token("remove", "401", error="invalid credential")

    assert "remove" not in service._accounts
    assert backend.load_accounts() == []
