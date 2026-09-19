from __future__ import annotations

from datetime import datetime, timezone

from services.secret_crypto import (
    ACCOUNT_INDEX_PREFIX,
    CONFIGURATION_ENVELOPE_KEY,
    LEGACY_ACCOUNT_INDEX_PREFIX,
    LEGACY_CONFIGURATION_ENVELOPE_KEY,
    LEGACY_PREFIX,
    PREFIX,
    account_index_key,
    encrypt_configuration,
    encrypt_json,
)
from services.storage.configuration_repository import (
    ProxyConfigurationModel,
    ProxyConfigurationRepository,
)
from services.storage.database_storage import (
    AccountModel,
    DatabaseStorageBackend,
)


def _legacy_encrypted_json(value: dict[str, object]) -> str:
    return encrypt_json(value).replace(PREFIX, LEGACY_PREFIX, 1)


def _legacy_configuration(value: dict[str, object]) -> dict[str, str]:
    encrypted = encrypt_configuration(value)[CONFIGURATION_ENVELOPE_KEY]
    return {
        LEGACY_CONFIGURATION_ENVELOPE_KEY: encrypted.replace(
            PREFIX, LEGACY_PREFIX, 1
        )
    }


def test_legacy_database_rows_are_migrated_to_dreamyo_prefixes(tmp_path):
    database_url = f"sqlite:///{(tmp_path / 'chatgpt2api.db').as_posix()}"
    backend = DatabaseStorageBackend(database_url)
    token = "legacy-account-token"
    suffix = account_index_key(token).removeprefix(ACCOUNT_INDEX_PREFIX)

    session = backend.Session()
    try:
        session.add(
            AccountModel(
                access_token=f"{LEGACY_ACCOUNT_INDEX_PREFIX}{suffix}",
                data=_legacy_encrypted_json({"access_token": token, "email": "test@example.com"}),
            )
        )
        session.commit()
    finally:
        session.close()

    session = backend.Session()
    try:
        session.add(
            ProxyConfigurationModel(
                id=1,
                data=_legacy_configuration({"enabled": False}),
                updated_at=datetime.now(timezone.utc),
            )
        )
        session.commit()
    finally:
        session.close()

    ProxyConfigurationRepository(database_url=database_url)
    migrated = DatabaseStorageBackend(database_url)
    snapshot = migrated.load_accounts_snapshot()
    assert snapshot.items == [{"access_token": token, "email": "test@example.com"}]

    session = migrated.Session()
    try:
        row = session.query(AccountModel).one()
        assert row.access_token.startswith(ACCOUNT_INDEX_PREFIX)
        assert row.data.startswith(PREFIX)
        stored_proxy = session.query(ProxyConfigurationModel).one().data
        assert set(stored_proxy) == {CONFIGURATION_ENVELOPE_KEY}
        assert stored_proxy[CONFIGURATION_ENVELOPE_KEY].startswith(PREFIX)
    finally:
        session.close()
