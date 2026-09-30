import asyncio

from aistudio_api.api.schemas import ImageRequest
from aistudio_api.api.state import runtime_state
from aistudio_api.application.api_service import handle_image_generation
from aistudio_api.application.account_rotator import AccountRotator
from aistudio_api.infrastructure.account.account_store import AccountStore


class _ImageOutput:
    images = []
    text = ""
    usage = None


class _AccountService:
    def __init__(self, store, active):
        self._store = store
        self.active = active

    def get_active_account(self):
        return self.active

    async def activate_account(self, account_id, *_args, **_kwargs):
        self.active = self._store.get_account(account_id)
        return self.active


class _Client:
    _session = object()

    def __init__(self, account_service, *, yield_once=False):
        self.account_service = account_service
        self.accounts_used = []
        self._yield_once = yield_once

    async def generate_image(self, **_kwargs):
        account_id = self.account_service.get_active_account().id
        if self._yield_once:
            await asyncio.sleep(0)
            assert self.account_service.get_active_account().id == account_id
        self.accounts_used.append(account_id)
        return _ImageOutput()


def _make_store(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    first = store.save_account("first", "first@example.com", {"cookies": [], "origins": []})
    second = store.save_account("second", "second@example.com", {"cookies": [], "origins": []})
    return store, first, second


def _with_runtime(store, account_service, client, scenario):
    previous = (
        runtime_state.client,
        runtime_state.busy_lock,
        runtime_state.account_request_lock,
        runtime_state.account_service,
        runtime_state.rotator,
        runtime_state.snapshot_cache,
    )
    runtime_state.client = client
    runtime_state.busy_lock = asyncio.Semaphore(2)
    runtime_state.account_request_lock = asyncio.Lock()
    runtime_state.account_service = account_service
    runtime_state.rotator = AccountRotator(store)
    runtime_state.snapshot_cache = None
    try:
        return asyncio.run(scenario())
    finally:
        (
            runtime_state.client,
            runtime_state.busy_lock,
            runtime_state.account_request_lock,
            runtime_state.account_service,
            runtime_state.rotator,
            runtime_state.snapshot_cache,
        ) = previous


def test_each_request_reuses_the_active_account_while_available(tmp_path):
    store, first, _second = _make_store(tmp_path)
    account_service = _AccountService(store, first)
    client = _Client(account_service)

    async def scenario():
        for index in range(3):
            await handle_image_generation(ImageRequest(prompt=f"frame {index}"), client)
        assert client.accounts_used == [first.id, first.id, first.id]

    _with_runtime(store, account_service, client, scenario)


def test_cooldown_rotates_to_next_available_account_and_sticks(tmp_path):
    store, first, second = _make_store(tmp_path)
    account_service = _AccountService(store, first)
    client = _Client(account_service)

    async def scenario():
        runtime_state.rotator.record_rate_limited(first.id)
        await handle_image_generation(ImageRequest(prompt="after cooldown"), client)
        await handle_image_generation(ImageRequest(prompt="sticky"), client)
        assert client.accounts_used == [second.id, second.id]

    _with_runtime(store, account_service, client, scenario)


def test_concurrent_requests_keep_account_stable_during_generation(tmp_path):
    store, first, _second = _make_store(tmp_path)
    account_service = _AccountService(store, first)
    client = _Client(account_service, yield_once=True)

    async def scenario():
        await asyncio.gather(
            handle_image_generation(ImageRequest(prompt="first"), client),
            handle_image_generation(ImageRequest(prompt="second"), client),
        )
        assert client.accounts_used == [first.id, first.id]

    _with_runtime(store, account_service, client, scenario)
