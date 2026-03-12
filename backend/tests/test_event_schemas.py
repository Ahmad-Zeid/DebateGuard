import pytest

from schemas.events import (
    AudioChunkEvent,
    EventValidationError,
    MetricsDeliveryEvent,
    PingEvent,
    RoundStopEvent,
    SessionStartEvent,
    VideoSnapshotEvent,
    parse_client_event,
)


def test_parse_session_start_event() -> None:
    event = parse_client_event(
        {
            "type": "session.start",
            "topic": "Climate policy",
            "stance": "pro",
            "demo_mode": True,
        }
    )
    assert isinstance(event, SessionStartEvent)
    assert event.demo_mode is True


@pytest.mark.parametrize(
    "payload,event_type",
    [
        (
            {"type": "audio.chunk", "chunk_b64": "AAECAw=="},
            AudioChunkEvent,
        ),
        (
            {"type": "video.snapshot", "image_b64": "AAECAw=="},
            VideoSnapshotEvent,
        ),
        (
            {"type": "metrics.delivery", "metrics": {"pace": 130}},
            MetricsDeliveryEvent,
        ),
        (
            {"type": "round.stop", "reason": "user_clicked_end"},
            RoundStopEvent,
        ),
        (
            {"type": "ping", "nonce": "abc123"},
            PingEvent,
        ),
    ],
)
def test_parse_supported_events(payload, event_type) -> None:  # noqa: ANN001
    event = parse_client_event(payload)
    assert isinstance(event, event_type)


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "audio.chunk"},
        {"type": "video.snapshot"},
        {"type": "unknown.event"},
        {},
    ],
)
def test_parse_invalid_events_raise(payload: dict) -> None:
    with pytest.raises(EventValidationError):
        parse_client_event(payload)
