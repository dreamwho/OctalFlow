#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import tempfile
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source = Path(args.database)
    output = Path(args.output)
    if source.is_symlink() or not source.is_file() or output.exists():
        raise SystemExit("GPTAPI 私有数据源或输出文件无效")

    with tempfile.TemporaryDirectory(prefix="dreamyo-private-settings-") as temporary:
        snapshot = Path(temporary) / "snapshot.db"
        with sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True) as src, sqlite3.connect(snapshot) as dst:
            src.backup(dst)
        with sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"accounts", "proxy_configuration"}.issubset(tables):
                raise SystemExit("GPTAPI 数据库缺少账号或通用代理配置")
            account_rows = db.execute("SELECT data FROM accounts ORDER BY id").fetchall()
            proxy_row = db.execute("SELECT data, updated_at FROM proxy_configuration WHERE id = 1").fetchone()
            if proxy_row is None:
                raise SystemExit("GPTAPI 数据库缺少通用代理配置")
            accounts = [row["data"] for row in account_rows]
            if any(not isinstance(value, str) or not value.startswith(("dreamyo-secret:v1:", "octalaicanvas-secret:v1:")) for value in accounts):
                raise SystemExit("GPTAPI 账号数据不是受保护的密文")
            configuration = json.loads(proxy_row["data"])
            if not isinstance(configuration, dict) or len(configuration) != 1 or not isinstance(configuration.get("_dreamyo_encrypted_v1", configuration.get("_octalaicanvas_encrypted_v1")), str):
                raise SystemExit("GPTAPI 通用代理配置不是受保护的密文")
            payload = {
                "version": 1,
                "accounts": accounts,
                "proxyConfiguration": {"data": configuration, "updatedAt": proxy_row["updated_at"]},
            }

    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(output, 0o600)


if __name__ == "__main__":
    main()
