from __future__ import annotations


def test_runtime_snapshot_preserves_unknown_samples_and_redacts_paths(monkeypatch):
    from services import runtime_environment_service as runtime

    monkeypatch.setattr(runtime, "is_containerized", lambda: False)
    monkeypatch.setattr(runtime, "_network_rates", lambda: (None, None))
    monkeypatch.setattr(runtime, "_read_memory", lambda **kwargs: (None, None, "system"))
    monkeypatch.setattr(runtime, "_read_process_memory", lambda: None)
    monkeypatch.setattr(runtime, "_read_process_cpu_percent", lambda capacity: None)
    sample = runtime._capture_snapshot()
    assert sample["memory_percent"] is None
    assert sample["process_memory_percent"] is None
    assert sample["network_rx_bytes_per_sec"] is None
    assert sample["process_cpu_percent"] is None
    assert sample["runtime_mode"] == "native"
    assert "data_dir" not in sample
    assert "environment" not in sample


def test_runtime_snapshot_uses_real_capacity_and_sample_cache(monkeypatch):
    from services import runtime_environment_service as runtime

    monkeypatch.setattr(runtime, "_RUNTIME_SNAPSHOT_CACHE", None)
    calls = []
    def capture():
        calls.append(True)
        return {"process_cpu_percent": 2.5}
    monkeypatch.setattr(runtime, "_capture_snapshot", capture)
    first = runtime.snapshot()
    first["process_cpu_percent"] = 99
    assert runtime.snapshot()["process_cpu_percent"] == 2.5
    assert len(calls) == 1
    assert runtime._percentage(50, 200) == 25
    assert runtime._percentage(None, 200) is None


def test_container_memory_limits_and_cpu_quota_are_respected(monkeypatch):
    from services import runtime_environment_service as runtime

    monkeypatch.setattr(runtime.os, "name", "posix")
    monkeypatch.setattr(runtime, "_read_linux_memory", lambda: (8000, 4000))
    monkeypatch.setattr(runtime, "_read_cgroup_memory", lambda: (2000, 1000))
    monkeypatch.setattr(runtime.os, "cpu_count", lambda: 8)
    monkeypatch.setattr(runtime, "_read_cgroup_cpu_quota", lambda: 1.5)
    assert runtime._read_memory(containerized=True) == (2000, 1000, "container")
    assert runtime._read_cpu_capacity(containerized=True) == 1.5
