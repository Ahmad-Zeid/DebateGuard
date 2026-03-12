from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from app import create_app
from config import Settings
from services.firestore_store import NullStore
from services.live_session import LiveSessionManager, MockLiveTransport


def test_history_endpoint_returns_saved_rounds() -> None:
    settings = Settings(app_env="test", google_genai_use_vertexai=False)
    store = NullStore()
    manager = LiveSessionManager(settings=settings, store=store, transport_factory=MockLiveTransport)
    app = create_app(settings=settings, session_manager=manager)
    client = TestClient(app)

    asyncio.run(
        store.save_round_report(
            "r-hist-1",
            {
                "sessionId": "s-hist",
                "topic": "AI Governance",
                "generatedAt": "2026-03-12T11:00:00Z",
                "rubric": {"argument_strength": 7},
                "summary": "Good round.",
            },
        )
    )

    response = client.get("/api/history?limit=5")
    assert response.status_code == 200
    payload = response.json()
    assert payload["rounds"]
    assert payload["rounds"][0]["roundId"] == "r-hist-1"
