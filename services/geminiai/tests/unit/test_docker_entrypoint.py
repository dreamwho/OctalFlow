import importlib.util
from pathlib import Path
from unittest.mock import Mock


def test_entrypoint_prepares_video_volume_before_dropping_privileges(monkeypatch, tmp_path):
    script = Path(__file__).resolve().parents[2] / "docker-entrypoint.py"
    spec = importlib.util.spec_from_file_location("geminiai_entrypoint", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    accounts = tmp_path / "accounts"
    temporary = tmp_path / "temporary"
    monkeypatch.setenv("AISTUDIO_ACCOUNTS_DIR", str(accounts))
    monkeypatch.setenv("AISTUDIO_TMP_DIR", str(temporary))
    prepared = []
    monkeypatch.setattr(module, "_harden_tree", prepared.append)
    monkeypatch.setattr(module.os, "geteuid", lambda: 0)
    monkeypatch.setattr(module.os, "setgroups", Mock())
    monkeypatch.setattr(module.os, "setgid", Mock())

    def drop_user(uid):
        assert uid == 10001
        assert prepared == [accounts, tmp_path / "videos", temporary]

    monkeypatch.setattr(module.os, "setuid", drop_user)
    monkeypatch.setattr(module.sys, "argv", ["entrypoint", "python"])
    monkeypatch.setattr(module.os, "execvp", Mock())
    module.main()
    module.os.execvp.assert_called_once_with("python", ["python"])
