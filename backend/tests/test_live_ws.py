import base64

from fastapi.testclient import TestClient

from app import create_app
from config import Settings
from services.firestore_store import NullStore
from services.live_session import LiveSessionManager, MockLiveTransport


def _test_client() -> TestClient:
    settings = Settings(
        app_env="test",
        google_genai_use_vertexai=False,
        live_model="mock-live",
        factcheck_model="mock-factcheck",
    )
    manager = LiveSessionManager(
        settings=settings,
        store=NullStore(),
        transport_factory=MockLiveTransport,
    )
    app = create_app(settings=settings, session_manager=manager)
    return TestClient(app)


def test_websocket_requires_session_start() -> None:
    client = _test_client()

    with client.websocket_connect("/ws/live") as ws:
        ws.send_json({"type": "ping", "nonce": "no-session"})
        payload = ws.receive_json()
        assert payload["type"] == "error"
        assert payload["code"] == "session_not_started"


def test_websocket_lifecycle_round_trip() -> None:
    client = _test_client()
    audio_b64 = base64.b64encode(b"\x00" * 640).decode("ascii")

    with client.websocket_connect("/ws/live") as ws:
        ws.send_json(
            {
                "type": "session.start",
                "session_id": "s-test",
                "round_id": "r-test",
                "demo_mode": False,
            }
        )

        ready = ws.receive_json()
        assert ready["type"] == "session.ready"
        assert ready["session_id"] == "s-test"

        ws.send_json({"type": "audio.chunk", "chunk_b64": audio_b64})

        received_types: set[str] = set()
        for _ in range(6):
            event = ws.receive_json()
            received_types.add(event["type"])

        assert "transcript.partial" in received_types
        assert "transcript.final" in received_types
        assert "model.text.delta" in received_types
        assert "model.audio.chunk" in received_types

        ws.send_json({"type": "ping", "nonce": "ping-1"})
        heartbeat = ws.receive_json()
        assert heartbeat["type"] == "session.ready"
        assert heartbeat["heartbeat"] is True
        assert heartbeat["nonce"] == "ping-1"

        ws.send_json({"type": "round.stop"})
        report = ws.receive_json()
        assert report["type"] == "round.report"
        assert report["round_id"] == "r-test"
        assert "rubric" in report


def test_demo_mode_emits_seeded_factcheck_alert() -> None:
    client = _test_client()
    audio_b64 = base64.b64encode(b"\x00" * 640).decode("ascii")

    with client.websocket_connect("/ws/live") as ws:
        ws.send_json(
            {
                "type": "session.start",
                "session_id": "s-demo",
                "round_id": "r-demo",
                "demo_mode": True,
            }
        )

        ready = ws.receive_json()
        assert ready["type"] == "session.ready"

        ws.send_json({"type": "audio.chunk", "chunk_b64": audio_b64})

        found_alert = None
        for _ in range(10):
            event = ws.receive_json()
            if event["type"] == "factcheck.alert":
                found_alert = event
                break

        assert found_alert is not None
        assert found_alert["interrupt_now"] is True
        assert found_alert["confidence"] >= 0.9
        assert found_alert["citations"]
