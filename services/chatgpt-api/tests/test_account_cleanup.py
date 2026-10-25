from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import accounts as accounts_api
from api.app import create_app
from services import config as config_module
from services.account_service import AccountService
from services.internal_runtime import runtime_key
from services.storage.database_storage import DatabaseStorageBackend


def test_cleanup_endpoint_persists_only_confirmed_abnormal_accounts(
    tmp_path, monkeypatch
):
    database_url = f"sqlite:///{(tmp_path / 'accounts.sqlite3').as_posix()}"
    backend = DatabaseStorageBackend(database_url)
    backend.replace_accounts([
        {
            "access_token": "confirmed-invalid",
            "management_id": "acct-invalid",
            "email": "invalid@example.test",
            "status": "异常",
            "last_remote_check_result": "invalid",
        },
        {
            "access_token": "disabled",
            "management_id": "acct-disabled",
            "email": "disabled@example.test",
            "status": "禁用",
        },
        {
            "access_token": "transient-network",
            "management_id": "acct-network",
            "email": "network@example.test",
            "status": "异常",
            "last_remote_check_result": "error",
        },
        {
            "access_token": "unconfirmed-abnormal",
            "management_id": "acct-uncertain",
            "email": "uncertain@example.test",
            "status": "异常",
        },
    ])
    monkeypatch.setattr(config_module, "DATA_DIR", tmp_path)
    service = AccountService(backend)
    expected_removed_ids = [
        item["management_id"] for item in service.list_accounts()
        if item["access_token"] in {"confirmed-invalid", "disabled"}
    ]
    expected_retained_ids = {
        item["management_id"] for item in service.list_accounts()
        if item["access_token"] in {"transient-network", "unconfirmed-abnormal"}
    }
    monkeypatch.setattr(accounts_api, "account_service", service)
    headers = {
        "x-dreamyo-runtime-key": runtime_key(),
        "authorization": f"Bearer {runtime_key()}",
    }
    client = TestClient(create_app())
    assert client.get("/api/accounts/cleanup-abnormal").status_code == 401
    assert client.post("/api/accounts/cleanup-abnormal", json={}).status_code == 401
    transport = {"x-dreamyo-runtime-key": runtime_key()}
    assert client.get("/api/accounts/cleanup-abnormal", headers=transport).status_code == 401
    assert client.post("/api/accounts/cleanup-abnormal", headers=transport, json={}).status_code == 401
    rows = client.get("/api/accounts", headers=headers).json()["items"]
    invalid_row = next(row for row in rows if row["email"] == "invalid@example.test")
    assert invalid_row["status_label"] == "禁用"
    assert invalid_row["enabled"] is False
    network_row = next(row for row in rows if row["email"] == "network@example.test")
    assert network_row["status_label"] == "异常"
    assert network_row["enabled"] is True
    response = client.get("/api/accounts/cleanup-abnormal", headers=headers)
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview == {"count": 2, "scope": ["异常", "禁用"]}

    # The complete router must also route fixed paths before account IDs.
    source_app = FastAPI()
    source_app.include_router(accounts_api.create_router())
    source_preview = TestClient(source_app).get("/api/accounts/cleanup-abnormal", headers=headers)
    assert source_preview.status_code == 200, source_preview.text
    assert source_preview.json() == preview

    response = client.post("/api/accounts/cleanup-abnormal", headers=headers, json={})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["checked"] == 2
    assert result["removed"] == 2
    assert result["removed_ids"] == expected_removed_ids
    assert result["status_label"] == "已完成"

    # Read from a fresh service over the same SQLite repository to prove the
    # native persistence contract rather than only the process-local snapshot.
    persisted = AccountService(DatabaseStorageBackend(database_url)).list_accounts()
    assert {item["management_id"] for item in persisted} == expected_retained_ids

    repeated_response = client.post("/api/accounts/cleanup-abnormal", headers=headers, json={})
    assert repeated_response.status_code == 200, repeated_response.text
    repeated = repeated_response.json()
    assert repeated["removed"] == 0
    assert repeated["removed_ids"] == []
    refreshed = AccountService(DatabaseStorageBackend(database_url)).list_accounts()
    assert {item["management_id"] for item in refreshed} == expected_retained_ids
