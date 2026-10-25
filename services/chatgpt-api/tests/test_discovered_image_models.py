from __future__ import annotations

import pytest


DISCOVERED_IMAGE_MODEL = "gpt-image-2.7-2026-10"


def test_only_exact_snapshot_image_slugs_are_dynamic_image_models(monkeypatch):
    from services.config import config
    from utils.helper import is_supported_image_model, split_image_model

    monkeypatch.setattr(config, "get", lambda: {
        "model_catalog_snapshot": {
            "source": "upstream",
            "image_models": [DISCOVERED_IMAGE_MODEL],
            "chat_models": ["gpt-5-vision"],
        }
    })
    assert split_image_model(DISCOVERED_IMAGE_MODEL) == (None, DISCOVERED_IMAGE_MODEL)
    assert is_supported_image_model(DISCOVERED_IMAGE_MODEL)
    assert not is_supported_image_model("gpt-image-not-discovered")
    assert not is_supported_image_model("gpt-5-vision")
    assert not is_supported_image_model("gpt-image-2.7-2026-10 ")


def test_dynamic_model_enters_generation_and_backend_payload_keeps_slug(monkeypatch):
    from services.config import config
    from services.openai_backend_api import ChatRequirements, OpenAIBackendAPI
    from services.protocol import conversation
    from services.protocol.conversation import (
        ConversationRequest,
        ImageOutput,
        stream_image_outputs_with_pool,
    )

    monkeypatch.setattr(config, "get", lambda: {
        "model_catalog_snapshot": {
            "source": "upstream",
            "image_models": [DISCOVERED_IMAGE_MODEL],
        }
    })
    generation_calls: list[str] = []

    def fake_generate(request, _index, _total):
        generation_calls.append(request.model)
        return [ImageOutput(kind="result", model=request.model, index=1, total=1)]

    monkeypatch.setattr(conversation, "_generate_single_image", fake_generate)
    result = list(stream_image_outputs_with_pool(ConversationRequest(model=DISCOVERED_IMAGE_MODEL)))
    assert result[0].model == DISCOVERED_IMAGE_MODEL
    assert generation_calls == [DISCOVERED_IMAGE_MODEL]

    captured: dict[str, object] = {}

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"conduit_token": "local-fixture-conduit"}

    class FakeSession:
        @staticmethod
        def post(_url, *, json, **_kwargs):
            captured.update(json)
            return FakeResponse()

    backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
    backend.base_url = "http://local-fixture.invalid"
    backend.session = FakeSession()
    backend._image_headers = lambda *_args, **_kwargs: {}
    assert backend._prepare_image_conversation(
        "fixture prompt", ChatRequirements(token="fixture-requirements"), DISCOVERED_IMAGE_MODEL
    ) == "local-fixture-conduit"
    assert captured["model"] == DISCOVERED_IMAGE_MODEL


def test_unknown_catalog_image_slug_is_rejected_but_static_backend_mappings_remain(monkeypatch):
    from services.config import config
    from services.image_failure import ImageGenerationError
    from services.openai_backend_api import OpenAIBackendAPI
    from services.protocol import conversation
    from services.protocol.conversation import ConversationRequest, stream_image_outputs_with_pool

    monkeypatch.setattr(config, "get", lambda: {
        "model_catalog_snapshot": {
            "source": "upstream",
            "image_models": [],
        }
    })
    generation_calls: list[str] = []
    monkeypatch.setattr(
        conversation,
        "_generate_single_image",
        lambda request, *_args: generation_calls.append(request.model) or [],
    )
    with pytest.raises(ImageGenerationError, match="unsupported image model"):
        list(stream_image_outputs_with_pool(ConversationRequest(model="gpt-image-unlisted")))
    assert generation_calls == []

    backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
    assert backend._image_model_slug("gpt-image-2") == "gpt-5-3"
    assert backend._image_model_slug("gpt-image-2.5") == "auto"
    assert backend._image_model_slug("gpt-image-unlisted") == "auto"

