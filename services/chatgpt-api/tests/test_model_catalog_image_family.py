"""gpt-image-2.5 家族必须归类为图片模型（用于 GPTAPI 渠道的图片能力目录）。"""

from __future__ import annotations

from services.model_catalog_service import (
    FALLBACK_IMAGE_MODELS,
    GPT_IMAGE_25_IMAGE_MODELS,
)


def test_gpt_image_25_family_is_part_of_the_image_model_catalog():
    for model in GPT_IMAGE_25_IMAGE_MODELS:
        assert model in FALLBACK_IMAGE_MODELS
        assert model.startswith("gpt-image-2.5")


def test_family_members_are_unique_and_keep_catalog_order_after_gpt_image_2():
    assert len(GPT_IMAGE_25_IMAGE_MODELS) == len(set(GPT_IMAGE_25_IMAGE_MODELS))
    assert FALLBACK_IMAGE_MODELS[0] == "gpt-image-2"
