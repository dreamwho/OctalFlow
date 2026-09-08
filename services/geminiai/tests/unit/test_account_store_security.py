import stat

import pytest

from aistudio_api.infrastructure.account.account_store import (
    AccountStore,
    InvalidAccountIdError,
)


def _storage_state() -> dict:
    return {"cookies": [{"name": "SID", "value": "redacted"}], "origins": []}


def test_account_store_rejects_path_traversal_and_writes_private_files(tmp_path):
    store = AccountStore(tmp_path / "accounts")

    with pytest.raises(InvalidAccountIdError):
        store.save_account(
            name="unsafe",
            email=None,
            storage_state=_storage_state(),
            account_id="../../outside",
        )

    account = store.save_account(name="safe", email=None, storage_state=_storage_state())
    account_dir = tmp_path / "accounts" / account.id

    assert store.get_auth_path_optional("../../outside") is None
    assert stat.S_IMODE((tmp_path / "accounts").stat().st_mode) == 0o700
    assert stat.S_IMODE(account_dir.stat().st_mode) == 0o700
    for path in (tmp_path / "accounts" / "registry.json", account_dir / "auth.json", account_dir / "meta.json"):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_account_deletion_only_removes_the_registered_exact_account_directory(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    first = store.save_account(name="first", email="first@example.test", storage_state=_storage_state())
    second = store.save_account(name="second", email="second@example.test", storage_state=_storage_state())

    assert store.delete_account("../" + second.id) is False
    assert (tmp_path / "accounts" / second.id / "auth.json").is_file()

    assert store.delete_account(first.id) is True
    assert not (tmp_path / "accounts" / first.id).exists()
    assert (tmp_path / "accounts" / second.id / "auth.json").is_file()


def test_account_store_refuses_a_symlinked_account_directory(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    target = tmp_path / "outside"
    target.mkdir()
    (tmp_path / "accounts" / "acc_blocked").symlink_to(target, target_is_directory=True)

    with pytest.raises(InvalidAccountIdError):
        store.save_account(
            name="blocked",
            email=None,
            storage_state=_storage_state(),
            account_id="acc_blocked",
        )

    assert not (target / "auth.json").exists()


def test_account_deletion_unlinks_a_tampered_symlink_without_touching_its_target(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    account = store.save_account(name="delete", email=None, storage_state=_storage_state())
    account_dir = tmp_path / "accounts" / account.id
    target = tmp_path / "outside"
    target.mkdir()

    account_dir.rename(tmp_path / "original-account")
    account_dir.symlink_to(target, target_is_directory=True)

    assert store.delete_account(account.id) is True
    assert target.is_dir()
    assert not account_dir.exists()
