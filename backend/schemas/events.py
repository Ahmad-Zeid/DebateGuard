from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Union
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class EventValidationError(ValueError):
    pass


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ClientBaseEvent(StrictModel):
    type: str


class SessionStartEvent(ClientBaseEvent):
    type: Literal["session.start"]
    session_id: str | None = None
    round_id: str | None = None
    topic: str | None = None
    stance: str | None = None
    difficulty: str | None = None
    user_label: str | None = None
    demo_mode: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class AudioChunkEvent(ClientBaseEvent):
    type: Literal["audio.chunk"]
    chunk_b64: str
    mime_type: str = "audio/pcm;rate=16000"
    sample_rate_hz: int = 16000
    seq: int | None = None


class VideoSnapshotEvent(ClientBaseEvent):
    type: Literal["video.snapshot"]
    image_b64: str
    mime_type: str = "image/jpeg"
    width: int | None = None
    height: int | None = None


class MetricsDeliveryEvent(ClientBaseEvent):
    type: Literal["metrics.delivery"]
    metrics: dict[str, Any]


class RoundStopEvent(ClientBaseEvent):
    type: Literal["round.stop"]
    reason: str | None = None


class PingEvent(ClientBaseEvent):
    type: Literal["ping"]
    nonce: str | None = None


ClientEvent = Annotated[
    Union[
        SessionStartEvent,
        AudioChunkEvent,
        VideoSnapshotEvent,
        MetricsDeliveryEvent,
        RoundStopEvent,
        PingEvent,
    ],
    Field(discriminator="type"),
]

CLIENT_EVENT_ADAPTER = TypeAdapter(ClientEvent)


def parse_client_event(payload: dict[str, Any]) -> ClientEvent:
    try:
        return CLIENT_EVENT_ADAPTER.validate_python(payload)
    except ValidationError as exc:
        raise EventValidationError(str(exc)) from exc


class ServerBaseEvent(StrictModel):
    type: str
    event_id: str = Field(default_factory=lambda: str(uuid4()))
    ts: str = Field(default_factory=_utc_now_iso)


class SessionReadyEvent(ServerBaseEvent):
    type: Literal["session.ready"] = "session.ready"
    session_id: str
    round_id: str
    live_model: str
    factcheck_model: str
    heartbeat: bool = False
    nonce: str | None = None


class TranscriptPartialEvent(ServerBaseEvent):
    type: Literal["transcript.partial"] = "transcript.partial"
    role: Literal["user", "model"]
    text: str


class TranscriptFinalEvent(ServerBaseEvent):
    type: Literal["transcript.final"] = "transcript.final"
    role: Literal["user", "model"]
    text: str


class ModelAudioChunkEvent(ServerBaseEvent):
    type: Literal["model.audio.chunk"] = "model.audio.chunk"
    chunk_b64: str
    mime_type: str = "audio/pcm;rate=24000"


class ModelTextDeltaEvent(ServerBaseEvent):
    type: Literal["model.text.delta"] = "model.text.delta"
    text: str


class FactcheckAlertEvent(ServerBaseEvent):
    type: Literal["factcheck.alert"] = "factcheck.alert"
    claim: str
    verdict: Literal["supported", "disputed", "unsupported", "not-checkable"]
    corrected_fact: str | None = None
    short_explanation: str
    citations: list[str] = Field(default_factory=list)
    confidence: float
    interrupt_now: bool = False


class RoundReportEvent(ServerBaseEvent):
    type: Literal["round.report"] = "round.report"
    session_id: str
    round_id: str
    rubric: dict[str, Any]
    cited_corrections: list[dict[str, Any]] = Field(default_factory=list)


class ErrorEvent(ServerBaseEvent):
    type: Literal["error"] = "error"
    code: str
    message: str
    details: dict[str, Any] | None = None


ServerEvent = Union[
    SessionReadyEvent,
    TranscriptPartialEvent,
    TranscriptFinalEvent,
    ModelAudioChunkEvent,
    ModelTextDeltaEvent,
    FactcheckAlertEvent,
    RoundReportEvent,
    ErrorEvent,
]


def to_payload(event: ServerEvent) -> dict[str, Any]:
    return event.model_dump(exclude_none=True)
