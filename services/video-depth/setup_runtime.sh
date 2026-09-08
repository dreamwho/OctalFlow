#!/bin/sh
set -eu

RUNTIME_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN=${1:-python3}
VENV_DIR="$RUNTIME_DIR/.venv"

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install -r "$RUNTIME_DIR/requirements.txt"
"$VENV_DIR/bin/python" "$RUNTIME_DIR/download_model.py"
"$VENV_DIR/bin/python" -c "import torch, transformers, PIL"

echo "视频深度运行时已准备完成：$VENV_DIR"
