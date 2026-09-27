import json
import asyncio

from dola_api.contracts import AccountInspectRequest, VideoTask
from dola_api.session import CamoufoxSessionPool

from dola_api.task_store import decrypt_cookie, decrypt_secret, encrypt_cookie, encrypt_secret, load_state, save_state


def test_cookie_state_is_encrypted_and_round_trips(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("DOLA_TASK_ENCRYPTION_KEY", "test-provider-secret")
    encrypted = encrypt_cookie("sessionid=secret")
    assert "sessionid=secret" not in encrypted
    assert decrypt_cookie(encrypted) == "sessionid=secret"

    monkeypatch.setenv("DOLA_TASK_STATE_PATH", str(tmp_path / "tasks.json"))
    save_state([{"id": "dola-1", "status": "accepted"}], {"dola-1": {"cookieCiphertext": encrypted}})
    assert load_state()["tasks"][0]["id"] == "dola-1"
    assert "sessionid=secret" not in (tmp_path / "tasks.json").read_text()


def test_state_file_is_json_and_not_plaintext_cookie(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("DOLA_TASK_ENCRYPTION_KEY", "test-provider-secret")
    path = tmp_path / "tasks.json"
    monkeypatch.setenv("DOLA_TASK_STATE_PATH", str(path))
    save_state([], {"task": {"cookieCiphertext": encrypt_cookie("cookie=value")}})
    parsed = json.loads(path.read_text())
    assert parsed["tasks"] == []
    assert "cookie=value" not in path.read_text()


def test_managed_proxy_url_is_encrypted_in_task_state(monkeypatch) -> None:
    monkeypatch.setenv("DOLA_TASK_ENCRYPTION_KEY", "test-provider-secret")
    encrypted = encrypt_secret("http://proxy-user:secret@example.test:8080")
    assert "proxy-user" not in encrypted
    assert decrypt_secret(encrypted) == "http://proxy-user:secret@example.test:8080"


def test_rebind_recovers_task_after_provider_key_rotation(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("DOLA_TASK_ENCRYPTION_KEY", "persistent-test-key")
    monkeypatch.setenv("DOLA_TASK_STATE_PATH", str(tmp_path / "tasks.json"))
    pool = CamoufoxSessionPool()
    pool._loaded = True
    pool._tasks["dola-1"] = VideoTask(id="dola-1", model="dola-seedance-2-0-fast", status="failed", accountId="account-1", credentialVersion=2, conversationId="38417991441328913", error="task_state_cookie_unavailable")
    pool._task_meta["dola-1"] = {"conversationId": "38417991441328913", "accountId": "account-1", "credentialVersion": 2}
    asyncio.run(pool.rebind_task("dola-1", AccountInspectRequest(accountId="account-1", credentialVersion=2, cookie="sid=restored")))
    assert pool._tasks["dola-1"].status == "accepted"
    assert pool._task_meta["dola-1"]["cookie"] == "sid=restored"
    assert "sid=restored" not in (tmp_path / "tasks.json").read_text()
