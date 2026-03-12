from __future__ import annotations

import asyncio
import base64
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Protocol
from uuid import uuid4

from fastapi import WebSocket

from config import Settings
from schemas.events import (
    AudioChunkEvent,
    FactcheckAlertEvent,
    MetricsDeliveryEvent,
    ModelAudioChunkEvent,
    ModelTextDeltaEvent,
    PingEvent,
    RoundReportEvent,
    RoundStopEvent,
    ServerEvent,
    SessionReadyEvent,
    SessionStartEvent,
    VideoSnapshotEvent,
    TranscriptFinalEvent,
    TranscriptPartialEvent,
    to_payload,
)
from services.firestore_store import FirestoreStore, NullStore, RoundPersistenceStore
from services.transcript_store import TranscriptStore
from schemas.factcheck import RoundFactcheckRecord
from services.factcheck_service import FactcheckService
from services.report_generator import ReportGenerator
from utils.audio import decode_b64_payload, encode_b64_payload, is_small_chunk, pcm16_duration_ms
from utils.logging import get_logger


@dataclass
class LiveTransportEvent:
    kind: str
    role: str | None = None
    text: str | None = None
    audio_bytes: bytes | None = None
    mime_type: str | None = None


class LiveTransport(Protocol):
    async def start(self) -> None: ...

    async def send_audio_chunk(self, audio_bytes: bytes, mime_type: str) -> None: ...

    async def send_video_snapshot(self, image_bytes: bytes, mime_type: str) -> None: ...

    async def interrupt(self) -> None: ...

    async def receive(self) -> AsyncIterator[LiveTransportEvent]: ...

    async def close(self) -> None: ...


class MockLiveTransport:
    """Local/test transport with deterministic behavior and no external calls."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[LiveTransportEvent | None] = asyncio.Queue()
        self._closed = False
        self._demo_mode = False
        self._seeded_demo_claim_emitted = False

    async def start(self) -> None:
        return None

    def set_demo_mode(self, demo_mode: bool) -> None:
        self._demo_mode = demo_mode

    async def send_audio_chunk(self, audio_bytes: bytes, mime_type: str) -> None:  # noqa: ARG002
        length_hint = max(1, len(audio_bytes) // 320)

        # Deterministic seeded false-stat transcript for local demo reliability.
        if self._demo_mode and not self._seeded_demo_claim_emitted:
            transcript_text = "90% of social media users are bots."
            self._seeded_demo_claim_emitted = True
        else:
            transcript_text = f"mock-user-audio-{length_hint}"

        await self._queue.put(LiveTransportEvent(kind="transcript.partial", role="user", text=transcript_text))
        await self._queue.put(LiveTransportEvent(kind="transcript.final", role="user", text=transcript_text))
        await self._queue.put(LiveTransportEvent(kind="model.text.delta", role="model", text="Mock model response."))
        await self._queue.put(
            LiveTransportEvent(
                kind="model.audio.chunk",
                role="model",
                audio_bytes=b"\x00\x00\x00\x00",
                mime_type="audio/pcm;rate=24000",
            )
        )
        await self._queue.put(LiveTransportEvent(kind="turn.complete"))

    async def send_video_snapshot(self, image_bytes: bytes, mime_type: str) -> None:  # noqa: ARG002
        return None

    async def interrupt(self) -> None:
        await self._queue.put(LiveTransportEvent(kind="turn.complete"))

    async def receive(self) -> AsyncIterator[LiveTransportEvent]:
        while not self._closed:
            event = await self._queue.get()
            if event is None:
                break
            yield event

    async def close(self) -> None:
        self._closed = True
        await self._queue.put(None)


class VertexLiveTransport:
    """Google GenAI Vertex Live API transport wrapper."""

    def __init__(self, settings: Settings, model: str) -> None:
        self._settings = settings
        self._model = model
        self._logger = get_logger("services.vertex_live")
        self._client = None
        self._session_ctx = None
        self._session = None
        self._genai_types = None

    async def start(self) -> None:
        try:
            from google import genai
            from google.genai import types as genai_types

            self._genai_types = genai_types
            self._client = genai.Client(
                vertexai=True,
                project=self._settings.google_cloud_project,
                location=self._settings.google_cloud_location,
            )

            config = {
                "response_modalities": ["AUDIO", "TEXT"],
                "input_audio_transcription": {},
                "output_audio_transcription": {},
            }
            self._session_ctx = self._client.aio.live.connect(model=self._model, config=config)
            self._session = await self._session_ctx.__aenter__()
        except Exception as exc:
            self._logger.exception("Failed to start Vertex Live session")
            raise RuntimeError("Unable to establish Vertex Live session") from exc

    async def send_audio_chunk(self, audio_bytes: bytes, mime_type: str) -> None:
        if self._session is None or self._genai_types is None:
            raise RuntimeError("Live session is not initialized")

        blob = self._genai_types.Blob(data=audio_bytes, mime_type=mime_type)
        await self._session.send_realtime_input(audio=blob)

    async def send_video_snapshot(self, image_bytes: bytes, mime_type: str) -> None:
        if self._session is None or self._genai_types is None:
            raise RuntimeError("Live session is not initialized")

        blob = self._genai_types.Blob(data=image_bytes, mime_type=mime_type)
        await self._session.send_realtime_input(video=blob)

    async def interrupt(self) -> None:
        if self._session is None:
            return

        if hasattr(self._session, "interrupt"):
            await self._session.interrupt()
            return

        # Fallback for SDK versions without explicit interrupt method.
        try:
            await self._session.send_realtime_input(audio_stream_end=True)
        except Exception:
            self._logger.debug("Live session interruption fallback was not supported")

    async def receive(self) -> AsyncIterator[LiveTransportEvent]:
        if self._session is None:
            raise RuntimeError("Live session is not initialized")

        async for raw_event in self._session.receive():
            for normalized_event in self._normalize_raw_event(raw_event):
                yield normalized_event

    async def close(self) -> None:
        if self._session_ctx is None:
            return
        await self._session_ctx.__aexit__(None, None, None)
        self._session_ctx = None
        self._session = None

    def _normalize_raw_event(self, raw_event: Any) -> list[LiveTransportEvent]:
        data = _as_dict(raw_event)
        if not data:
            return []

        server_content = _first_key(data, "serverContent", "server_content")
        if not isinstance(server_content, dict):
            return []

        normalized: list[LiveTransportEvent] = []

        input_transcription = _first_key(server_content, "inputTranscription", "input_transcription")
        if isinstance(input_transcription, dict):
            text = _first_key(input_transcription, "text")
            if isinstance(text, str) and text.strip():
                is_final = bool(_first_key(input_transcription, "isFinal", "is_final", "final"))
                normalized.append(
                    LiveTransportEvent(
                        kind="transcript.final" if is_final else "transcript.partial",
                        role="user",
                        text=text,
                    )
                )

        output_transcription = _first_key(server_content, "outputTranscription", "output_transcription")
        if isinstance(output_transcription, dict):
            text = _first_key(output_transcription, "text")
            if isinstance(text, str) and text.strip():
                is_final = bool(_first_key(output_transcription, "isFinal", "is_final", "final"))
                normalized.append(
                    LiveTransportEvent(
                        kind="transcript.final" if is_final else "transcript.partial",
                        role="model",
                        text=text,
                    )
                )

        model_turn = _first_key(server_content, "modelTurn", "model_turn")
        if isinstance(model_turn, dict):
            parts = _first_key(model_turn, "parts")
            if isinstance(parts, list):
                for part in parts:
                    if not isinstance(part, dict):
                        continue
                    part_text = _first_key(part, "text")
                    if isinstance(part_text, str) and part_text:
                        normalized.append(
                            LiveTransportEvent(
                                kind="model.text.delta",
                                role="model",
                                text=part_text,
                            )
                        )

                    inline_data = _first_key(part, "inlineData", "inline_data")
                    if isinstance(inline_data, dict):
                        mime_type = _first_key(inline_data, "mimeType", "mime_type")
                        audio_data = _first_key(inline_data, "data")

                        audio_bytes: bytes | None = None
                        if isinstance(audio_data, str):
                            try:
                                audio_bytes = base64.b64decode(audio_data)
                            except Exception:
                                self._logger.debug("Unable to decode model audio chunk from base64")
                        elif isinstance(audio_data, bytes):
                            audio_bytes = audio_data

                        if audio_bytes:
                            normalized.append(
                                LiveTransportEvent(
                                    kind="model.audio.chunk",
                                    role="model",
                                    audio_bytes=audio_bytes,
                                    mime_type=(mime_type if isinstance(mime_type, str) else "audio/pcm;rate=24000"),
                                )
                            )

        if bool(_first_key(server_content, "turnComplete", "turn_complete")):
            normalized.append(LiveTransportEvent(kind="turn.complete"))

        return normalized


class LiveSession:
    """Coordinates one frontend websocket with one live model session."""

    def __init__(
        self,
        websocket: WebSocket,
        settings: Settings,
        session_id: str,
        round_id: str,
        transport: LiveTransport,
        store: RoundPersistenceStore,
        factcheck_service: FactcheckService,
        report_generator: ReportGenerator,
    ) -> None:
        self.websocket = websocket
        self.settings = settings
        self.session_id = session_id
        self.round_id = round_id
        self.transport = transport
        self.store = store
        self.factcheck_service = factcheck_service
        self.report_generator = report_generator

        self.logger = get_logger("services.live_session")
        self.transcript_store = TranscriptStore()
        self.delivery_metrics: list[dict[str, Any]] = []

        self._factcheck_interruptions = 0
        self._barge_in_count = 0
        self._model_speaking = False
        self._closed = False
        self._last_snapshot_mono = 0.0
        self._demo_mode = False
        self._topic: str | None = None
        self._stance: str | None = None
        self._difficulty: str | None = None
        self._round_started_at: str | None = None

        self._receive_task: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()
        self._factcheck_alerts: list[dict[str, Any]] = []
        self._factcheck_records: list[RoundFactcheckRecord] = []

    async def start(self, event: SessionStartEvent) -> None:
        self._demo_mode = event.demo_mode
        self._topic = event.topic
        self._stance = event.stance
        self._difficulty = event.difficulty
        self._round_started_at = datetime.now(timezone.utc).isoformat()

        transport_set_demo_mode = getattr(self.transport, "set_demo_mode", None)
        if callable(transport_set_demo_mode):
            transport_set_demo_mode(event.demo_mode)
        await self.transport.start()
        await self.store.save_session_start(
            self.session_id,
            {
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "topic": event.topic,
                "stance": event.stance,
                "difficulty": event.difficulty,
                "userLabel": event.user_label,
                "metadata": event.metadata,
            },
        )

        await self.store.save_round_start(
            self.round_id,
            {
                "sessionId": self.session_id,
                "topic": event.topic,
                "stance": event.stance,
                "difficulty": event.difficulty,
                "startedAt": self._round_started_at,
            },
        )

        self._receive_task = asyncio.create_task(self._consume_transport_events())
        await self.send_event(
            SessionReadyEvent(
                session_id=self.session_id,
                round_id=self.round_id,
                live_model=self.settings.live_model,
                factcheck_model=self.settings.factcheck_model,
            )
        )

    async def handle_audio_chunk(self, event: AudioChunkEvent) -> None:
        audio_bytes = decode_b64_payload(event.chunk_b64, "chunk_b64")

        duration_ms = pcm16_duration_ms(audio_bytes, sample_rate_hz=event.sample_rate_hz)
        if not is_small_chunk(duration_ms):
            self.logger.warning(
                "Audio chunk duration outside recommended 20-100ms range",
                extra={
                    "session_id": self.session_id,
                    "round_id": self.round_id,
                    "duration_ms": round(duration_ms, 2),
                },
            )

        if self._model_speaking:
            self._barge_in_count += 1
            await self.transport.interrupt()
            self._model_speaking = False

        await self.transport.send_audio_chunk(audio_bytes, event.mime_type)

    async def handle_video_snapshot(self, event: VideoSnapshotEvent) -> None:
        now = time.monotonic()
        if (now - self._last_snapshot_mono) < 1.0:
            self.logger.debug(
                "Dropping snapshot to enforce <= 1 FPS",
                extra={"session_id": self.session_id, "round_id": self.round_id},
            )
            return

        if not event.mime_type.startswith("image/jpeg"):
            raise ValueError("video.snapshot must use image/jpeg")

        image_bytes = decode_b64_payload(event.image_b64, "image_b64")
        self._last_snapshot_mono = now
        await self.transport.send_video_snapshot(image_bytes, event.mime_type)

    async def handle_metrics_delivery(self, event: MetricsDeliveryEvent) -> None:
        self.delivery_metrics.append(
            {
                "receivedAt": datetime.now(timezone.utc).isoformat(),
                "metrics": event.metrics,
            }
        )

    async def handle_round_stop(self, event: RoundStopEvent) -> None:
        final_model_text = self.transcript_store.finalize_model_buffer()
        if final_model_text:
            await self.send_event(TranscriptFinalEvent(role="model", text=final_model_text))

        report_event = self._build_round_report()
        await self.send_event(report_event)

        claim_payloads = [record.model_dump() for record in self._factcheck_records]
        await self.store.save_claims(self.round_id, claim_payloads)

        round_payload = {
            "sessionId": self.session_id,
            "topic": self._topic,
            "stance": self._stance,
            "difficulty": self._difficulty,
            "startedAt": self._round_started_at,
            "endedAt": datetime.now(timezone.utc).isoformat(),
            "transcript": self.transcript_store.all_entries(),
            "deliveryMetrics": self.delivery_metrics,
            "interruptionCount": self._factcheck_interruptions,
            "bargeInCount": self._barge_in_count,
            "reason": event.reason,
            "rubric": report_event.rubric,
            "citedCorrections": report_event.cited_corrections,
            "generatedAt": report_event.ts,
            "summary": report_event.rubric.get("one_sentence_coach_summary"),
        }
        await self.store.save_round_report(self.round_id, round_payload)

    async def handle_ping(self, event: PingEvent) -> None:
        await self.send_event(
            SessionReadyEvent(
                session_id=self.session_id,
                round_id=self.round_id,
                live_model=self.settings.live_model,
                factcheck_model=self.settings.factcheck_model,
                heartbeat=True,
                nonce=event.nonce,
            )
        )

    async def send_event(self, event: ServerEvent) -> None:
        async with self._send_lock:
            await self.websocket.send_json(to_payload(event))

    async def send_error(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        from schemas.events import ErrorEvent

        await self.send_event(ErrorEvent(code=code, message=message, details=details))

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True

        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass

        await self.transport.close()

    async def _consume_transport_events(self) -> None:
        try:
            async for transport_event in self.transport.receive():
                await self._handle_transport_event(transport_event)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.logger.exception(
                "Live transport receive loop crashed",
                extra={"session_id": self.session_id, "round_id": self.round_id},
            )
            await self.send_error(
                code="live_transport_receive_failed",
                message="Live model stream encountered an error",
            )

    async def _handle_transport_event(self, event: LiveTransportEvent) -> None:
        if event.kind == "transcript.partial":
            role = "model" if event.role == "model" else "user"
            text = event.text or ""
            self.transcript_store.add_partial(role, text)
            await self.send_event(TranscriptPartialEvent(role=role, text=text))
            return

        if event.kind == "transcript.final":
            role = "model" if event.role == "model" else "user"
            text = event.text or ""
            self.transcript_store.add_final(role, text)
            await self.send_event(TranscriptFinalEvent(role=role, text=text))
            if role == "user":
                await self._maybe_emit_factcheck_alert(text)
            return

        if event.kind == "model.text.delta":
            self._model_speaking = True
            text = event.text or ""
            self.transcript_store.add_model_delta(text)
            await self.send_event(ModelTextDeltaEvent(text=text))
            return

        if event.kind == "model.audio.chunk":
            self._model_speaking = True
            audio_bytes = event.audio_bytes or b""
            await self.send_event(
                ModelAudioChunkEvent(
                    chunk_b64=encode_b64_payload(audio_bytes),
                    mime_type=event.mime_type or "audio/pcm;rate=24000",
                )
            )
            return

        if event.kind == "turn.complete":
            self._model_speaking = False
            final_text = self.transcript_store.finalize_model_buffer()
            if final_text:
                await self.send_event(TranscriptFinalEvent(role="model", text=final_text))

    async def _maybe_emit_factcheck_alert(self, text: str) -> None:
        candidates = self.factcheck_service.detect_claims(text)
        if not candidates:
            return

        for candidate in candidates:
            result = await self.factcheck_service.verify_candidate(candidate, demo_mode=self._demo_mode)
            should_interrupt = self.factcheck_service.apply_interrupt_policy(
                candidate,
                result,
                interruptions_used=self._factcheck_interruptions,
            )

            result = result.model_copy(update={"interrupt_now": should_interrupt})

            round_record = self.factcheck_service.as_round_record(
                candidate,
                result,
                interrupted_live=should_interrupt,
            )
            self._factcheck_records.append(round_record)

            if not should_interrupt:
                continue

            alert = FactcheckAlertEvent(
                claim=result.claim,
                verdict=result.verdict,
                corrected_fact=result.corrected_fact,
                short_explanation=result.short_explanation,
                citations=result.citations,
                confidence=result.confidence,
                interrupt_now=True,
            )
            self._factcheck_interruptions += 1
            self._factcheck_alerts.append(to_payload(alert))
            await self.send_event(alert)

    def _build_round_report(self) -> RoundReportEvent:
        rubric = self.report_generator.generate(
            transcript_entries=self.transcript_store.all_entries(),
            factcheck_records=self._factcheck_records,
            delivery_metrics=self.delivery_metrics,
        )

        cited_corrections = [correction.model_dump() for correction in rubric.cited_corrections]

        return RoundReportEvent(
            session_id=self.session_id,
            round_id=self.round_id,
            rubric=rubric.model_dump(),
            cited_corrections=cited_corrections,
        )


class LiveSessionManager:
    """Holds active websocket<->live-model sessions."""

    def __init__(
        self,
        settings: Settings,
        store: RoundPersistenceStore | None = None,
        transport_factory: Callable[[], LiveTransport] | None = None,
        factcheck_service: FactcheckService | None = None,
        report_generator: ReportGenerator | None = None,
    ) -> None:
        self.settings = settings
        self.logger = get_logger("services.live_session_manager")
        self.sessions: dict[str, LiveSession] = {}
        self.factcheck_service = factcheck_service or FactcheckService(settings=settings)
        self.report_generator = report_generator or ReportGenerator()

        if store is not None:
            self.store = store
        elif settings.google_cloud_project and settings.app_env.lower() != "test":
            self.store = FirestoreStore(settings)
        else:
            self.store = NullStore()

        if transport_factory is not None:
            self.transport_factory = transport_factory
        elif settings.google_genai_use_vertexai:
            self.transport_factory = lambda: VertexLiveTransport(settings=settings, model=settings.live_model)
        else:
            self.transport_factory = MockLiveTransport

    async def start_session(self, websocket: WebSocket, event: SessionStartEvent) -> LiveSession:
        session_id = event.session_id or str(uuid4())
        round_id = event.round_id or str(uuid4())

        if session_id in self.sessions:
            await self.sessions[session_id].close()
            del self.sessions[session_id]

        session = LiveSession(
            websocket=websocket,
            settings=self.settings,
            session_id=session_id,
            round_id=round_id,
            transport=self.transport_factory(),
            store=self.store,
            factcheck_service=self.factcheck_service,
            report_generator=self.report_generator,
        )
        self.sessions[session_id] = session

        try:
            await session.start(event)
        except Exception:
            self.sessions.pop(session_id, None)
            raise

        return session

    async def close_session(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, None)
        if session is None:
            return
        await session.close()


def _as_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value

    if hasattr(value, "model_dump"):
        try:
            return value.model_dump(exclude_none=True, by_alias=True)
        except TypeError:
            return value.model_dump(exclude_none=True)

    if hasattr(value, "to_dict"):
        return value.to_dict()

    if hasattr(value, "__dict__"):
        return {k: v for k, v in vars(value).items() if not k.startswith("_")}

    return {}


def _first_key(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in data:
            return data[key]
    return None
