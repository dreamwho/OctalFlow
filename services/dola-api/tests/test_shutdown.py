"""Leak-prevention contracts: submission jobs are cancellable and the
parent watchdog exits the provider once the spawning desktop app is gone.
"""

import asyncio

from dola_api.session import CamoufoxSessionPool


def test_close_all_sessions_cancels_tracked_submit_jobs():
    async def scenario():
        pool = CamoufoxSessionPool()
        started = asyncio.Event()

        async def hanging_job():
            started.set()
            await asyncio.sleep(60)

        job = asyncio.create_task(hanging_job())
        pool._submit_jobs["t1"] = job
        await started.wait()
        await asyncio.wait_for(pool.close_all_sessions(), timeout=5)
        assert job.cancelled()
        assert pool._submit_jobs == {}

    asyncio.run(scenario())


def test_parent_watchdog_exits_after_parent_death(monkeypatch):
    from dola_api import app as app_module

    outcome: dict[str, object] = {}

    async def fake_close():
        outcome["closed"] = True

    monkeypatch.setattr(app_module.pool, "close_all_sessions", fake_close)
    monkeypatch.setattr(app_module.os, "_exit", lambda code: outcome.setdefault("code", code))

    original_sleep = asyncio.sleep

    async def fast_sleep(_seconds):
        await original_sleep(0)

    monkeypatch.setattr(app_module.asyncio, "sleep", fast_sleep)

    async def scenario():
        # A pid no live process can own: liveness probe misses twice, the
        # watchdog closes sessions and force-exits.
        await asyncio.wait_for(app_module._parent_watchdog(99999999), timeout=15)

    asyncio.run(scenario())
    assert outcome.get("closed") is True
    assert outcome.get("code") == 0
