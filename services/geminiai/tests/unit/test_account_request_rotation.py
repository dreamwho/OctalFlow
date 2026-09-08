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


def test_each_request_selects_the_next_round_robin_account(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    first = store.save_account("first", "first@example.com", {"cookies": [], "origins": []})
    second = store.save_account("second", "second@example.com", {"cookies": [], "origins": []})

    class _AccountService:
        def __init__(self):
            self.active = first

        def get_active_account(self):
            return self.active

        async def activate_account(self, account_id, *_args, **_kwargs):
            self.active = store.get_account(account_id)
            return self.active

    class _Client:
        _session = object()

        def __init__(self, account_service):
            self.account_service = account_service
            self.accounts_used = []

        async def generate_image(self, **_kwargs):
            self.accounts_used.append(self.account_service.get_active_account().id)
            return _ImageOutput()

    async def scenario():
        account_service = _AccountService()
        client = _Client(account_service)
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
            for index in range(3):
                await handle_image_generation(ImageRequest(prompt=f"frame {index}"), client)
            assert client.accounts_used == [first.id, second.id, first.id]
        finally:
            (
                runtime_state.client,
                runtime_state.busy_lock,
                runtime_state.account_request_lock,
                runtime_state.account_service,
                runtime_state.rotator,
                runtime_state.snapshot_cache,
            ) = previous

    asyncio.run(scenario())


def test_concurrent_requests_keep_account_switch_and_generation_together(tmp_path):
    store = AccountStore(tmp_path / "accounts")
    first = store.save_account("first", "first@example.com", {"cookies": [], "origins": []})
    second = store.save_account("second", "second@example.com", {"cookies": [], "origins": []})

    class _AccountService:
        def __init__(self):
            self.active = first

        def get_active_account(self):
            return self.active

        async def activate_account(self, account_id, *_args, **_kwargs):
            self.active = store.get_account(account_id)
            return self.active

    class _Client:
        _session = object()

        def __init__(self, account_service):
            self.account_service = account_service
            self.accounts_used = []

        async def generate_image(self, **_kwargs):
            account_id = self.account_service.get_active_account().id
            await asyncio.sleep(0)
            assert self.account_service.get_active_account().id == account_id
            self.accounts_used.append(account_id)
            return _ImageOutput()

    async def scenario():
        account_service = _AccountService()
        client = _Client(account_service)
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
            await asyncio.gather(
                handle_image_generation(ImageRequest(prompt="first"), client),
                handle_image_generation(ImageRequest(prompt="second"), client),
            )
            assert client.accounts_used == [first.id, second.id]
        finally:
            (
                runtime_state.client,
                runtime_state.busy_lock,
                runtime_state.account_request_lock,
                runtime_state.account_service,
                runtime_state.rotator,
                runtime_state.snapshot_cache,
            ) = previous

    asyncio.run(scenario())
