from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from schemas.events import (
    AudioChunkEvent,
    EventValidationError,
    MetricsDeliveryEvent,
    PingEvent,
    RoundStopEvent,
    SessionStartEvent,
    VideoSnapshotEvent,
    ErrorEvent,
    to_payload,
    parse_client_event,
)
from services.live_session import LiveSession, LiveSessionManager
from utils.logging import get_logger

router = APIRouter()
logger = get_logger("routes.live_ws")


@router.websocket("/ws/live")
async def live_ws(websocket: WebSocket) -> None:
    manager: LiveSessionManager = websocket.app.state.live_session_manager
    active_session: LiveSession | None = None

    await websocket.accept()

    try:
        while True:
            raw_message = await websocket.receive_text()

            parsed_payload: dict[str, Any]
            try:
                parsed_payload = json.loads(raw_message)
            except json.JSONDecodeError:
                await _send_raw_error(
                    websocket,
                    code="invalid_json",
                    message="WebSocket message must be valid JSON",
                )
                continue

            try:
                event = parse_client_event(parsed_payload)
            except EventValidationError as exc:
                await _send_raw_error(
                    websocket,
                    code="invalid_event",
                    message="Unsupported or malformed client event",
                    details={"validation_error": str(exc)},
                )
                continue

            if isinstance(event, SessionStartEvent):
                if active_session is not None:
                    await manager.close_session(active_session.session_id)
                    active_session = None

                try:
                    active_session = await manager.start_session(websocket, event)
                except Exception as exc:  # noqa: BLE001 - converted to wire error
                    logger.exception("Failed to start live session")
                    await _send_raw_error(
                        websocket,
                        code="session_start_failed",
                        message="Failed to initialize live session",
                        details={"error": str(exc)},
                    )
                continue

            if active_session is None:
                await _send_raw_error(
                    websocket,
                    code="session_not_started",
                    message="Send session.start before other events",
                )
                continue

            try:
                if isinstance(event, AudioChunkEvent):
                    await active_session.handle_audio_chunk(event)
                elif isinstance(event, VideoSnapshotEvent):
                    await active_session.handle_video_snapshot(event)
                elif isinstance(event, MetricsDeliveryEvent):
                    await active_session.handle_metrics_delivery(event)
                elif isinstance(event, RoundStopEvent):
                    await active_session.handle_round_stop(event)
                elif isinstance(event, PingEvent):
                    await active_session.handle_ping(event)
            except Exception as exc:  # noqa: BLE001 - converted to wire error
                logger.exception("Session event handling failed")
                await active_session.send_error(
                    code="event_handling_failed",
                    message="An error occurred while handling the event",
                    details={"error": str(exc), "event_type": event.type},
                )
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    finally:
        if active_session is not None:
            await manager.close_session(active_session.session_id)


async def _send_raw_error(
    websocket: WebSocket,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> None:
    await websocket.send_json(
        to_payload(
            ErrorEvent(
                code=code,
                message=message,
                details=details,
            )
        )
    )

