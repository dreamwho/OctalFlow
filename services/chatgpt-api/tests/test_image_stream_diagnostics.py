from __future__ import annotations

import pytest
from curl_cffi.requests import exceptions as curl_exceptions


def _prepare_image_attempt(monkeypatch, stream_fn):
    from services.config import config
    from services.protocol import conversation

    stages: list[tuple[str, dict[str, object]]] = []

    class FakeProfile:
        image_egress_reserved = False
        image_concurrency_limit = 0

    class FakeBackend:
        def __init__(self, *_args, **_kwargs):
            self.proxy_profile = FakeProfile()
            self.progress_callback = None

        @staticmethod
        def close():
            pass

        @staticmethod
        def _get_conversation(_conversation_id, **_kwargs):
            return {}

        @staticmethod
        def _conversation_poll_snapshot(_conversation):
            return {}, ""

        @staticmethod
        def _extract_image_tool_records(_conversation):
            return []

    monkeypatch.setattr(conversation.account_service, "get_available_access_token", lambda **_kwargs: "fixture-token")
    monkeypatch.setattr(conversation.account_service, "get_account", lambda _token: {"email": "fixture@example.test"})
    monkeypatch.setattr(conversation.account_service, "mark_image_result", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(conversation, "OpenAIBackendAPI", FakeBackend)
    monkeypatch.setattr(conversation.proxy_settings, "get_fallback_proxy_reference", lambda: "")
    monkeypatch.setattr(conversation.proxy_settings, "acquire_image_egress", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(conversation.realtime_monitor_service, "stage", lambda _call_id, event, **data: stages.append((event, data)))
    monkeypatch.setattr(
        type(config),
        "image_account_retry_enabled",
        property(lambda _self: False),
    )
    monkeypatch.setattr(conversation, "stream_image_outputs", stream_fn)
    return conversation, stages


@pytest.mark.parametrize("failure_code", ["no_image_generated", "image_tool_error"])
def test_completed_stream_semantic_failures_do_not_report_transport_interruption(monkeypatch, failure_code):
    from services.image_failure import ImageGenerationError, image_failure
    from services.protocol.conversation import ConversationRequest, ImageOutput
    from services.request_detail_view import build_request_timeline_presentation

    def semantic_stream(_backend, request, index, total):
        yield ImageOutput(
            kind="message",
            model=request.model,
            index=index,
            total=total,
            text="The image generation tool encountered an error. Please try again.",
            conversation_id="fixture-conversation",
            failure=image_failure(failure_code),
        )

    conversation, stages = _prepare_image_attempt(monkeypatch, semantic_stream)
    request = ConversationRequest(
        model="gpt-image-2.5",
        message_as_error=True,
        trace_image_perf=True,
        call_id="fixture-call",
    )

    with pytest.raises(ImageGenerationError) as raised:
        conversation._generate_single_image(request, 1, 1)

    assert raised.value.failure.code == failure_code
    failed_stages = [data for event, data in stages if event == "image_attempt_failed"]
    assert failed_stages
    assert all("stream_error_ms" not in data for data in failed_stages)
    assert build_request_timeline_presentation({}, ())["segments"] == []


def test_transport_interruption_keeps_existing_conversation_recovery_and_metric(monkeypatch):
    from services.image_failure import ImageGenerationError
    from services.protocol import conversation
    from services.protocol.conversation import ConversationRequest
    from services.request_detail_view import build_request_timeline_presentation

    conversation_id = "fixture-existing-conversation"

    def interrupted_events(*_args, **_kwargs):
        yield {"type": "conversation.event", "conversation_id": conversation_id}
        raise curl_exceptions.RequestException("fixture HTTP/2 stream reset")

    original_stream = conversation.stream_image_outputs
    monkeypatch.setattr(conversation, "conversation_events", interrupted_events)

    monkeypatch.setattr(
        conversation,
        "_image_stream_timeout_task_diagnostics",
        lambda *_args, **_kwargs: (None, "", [], ""),
    )
    conversation, stages = _prepare_image_attempt(
        monkeypatch,
        lambda backend, request, index, total: original_stream(backend, request, index, total),
    )
    request = ConversationRequest(
        model="gpt-image-2.5",
        message_as_error=True,
        trace_image_perf=True,
        call_id="fixture-call",
    )

    with pytest.raises(ImageGenerationError) as raised:
        conversation._generate_single_image(request, 1, 1)

    error = raised.value
    assert error.failure.code == "image_stream_interrupted"
    assert error.conversation_id == conversation_id
    assert error.stream_timeout_followup["conversation_id"] == conversation_id
    failed_stages = [data for event, data in stages if event == "image_attempt_failed"]
    assert failed_stages
    assert all("stream_error_ms" in data for data in failed_stages)
    assert failed_stages[-1]["stream_error_ms"] >= 0
    timeline = build_request_timeline_presentation({"stream_error_ms": 1}, ())
    upstream = next(segment for segment in timeline["segments"] if segment["key"] == "upstream")
    assert upstream["tone"] == "danger"


def test_wrapped_stream_recovery_failure_is_still_a_transport_failure():
    from services.image_failure import ImageGenerationError, image_failure
    from services.protocol.conversation import _is_image_transport_failure

    recovery_error = ImageGenerationError(
        "SSE stream interrupted",
        failure=image_failure("image_stream_interrupted"),
    )

    assert _is_image_transport_failure(recovery_error)
