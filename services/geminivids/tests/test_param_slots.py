import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from geminivids_api.param_slots import (  # noqa: E402
    InvalidVideoParams,
    build_param_slots,
)


def test_slot_mapping_matrix():
    assert build_param_slots("16:9", "720p", 10)[4] == 1
    assert build_param_slots("9:16", "720p", 4)[4] == 2
    assert build_param_slots("16:9", "1080p", 6)[4] == 5
    assert build_param_slots("9:16", "1080p", 10)[4] == 6


def test_duration_slot():
    assert build_param_slots("16:9", "720p", 7)[8] == 7


def test_invalid_params_rejected():
    for args in (("1:1", "720p", 5), ("16:9", "4k", 5), ("16:9", "720p", 3), ("16:9", "720p", 11), ("16:9", "720p", "8")):
        try:
            build_param_slots(*args)
            raise AssertionError(f"should reject {args}")
        except InvalidVideoParams:
            pass
