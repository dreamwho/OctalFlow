import asyncio

from aistudio_api.application.account_rotator import AccountRotator
from aistudio_api.infrastructure.account.account_store import AccountStore


def test_account_rotator_excludes_the_current_account(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    first = store.save_account("first", "first@example.com", {"cookies": [], "origins": []})
    second = store.save_account("second", "second@example.com", {"cookies": [], "origins": []})
    rotator = AccountRotator(store)

    selected = asyncio.run(rotator.get_next_account(exclude_account_ids={first.id}))

    assert selected is not None
    assert selected.id == second.id
