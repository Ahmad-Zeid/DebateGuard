from __future__ import annotations

import asyncio
import sys
import types

from config import Settings
from services.firestore_store import FirestoreStore


class _FakeDocument:
    def __init__(self, storage: dict[str, dict[str, dict]], collection: str, doc_id: str) -> None:
        self._storage = storage
        self._collection = collection
        self._doc_id = doc_id

    def set(self, payload: dict, merge: bool = True) -> None:  # noqa: FBT001
        current = self._storage[self._collection].get(self._doc_id, {})
        self._storage[self._collection][self._doc_id] = {**current, **payload} if merge else dict(payload)


class _FakeSnapshot:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def to_dict(self) -> dict:
        return dict(self._payload)


class _FakeQuery:
    def __init__(self, documents: list[dict]) -> None:
        self._documents = documents

    def where(self, field: str, op: str, value: str):  # noqa: ANN001
        assert op == "=="
        return _FakeQuery([doc for doc in self._documents if doc.get(field) == value])

    def order_by(self, field: str, direction=None):  # noqa: ANN001
        descending = str(direction).upper().endswith("DESCENDING")
        return _FakeQuery(sorted(self._documents, key=lambda item: str(item.get(field) or ""), reverse=descending))

    def limit(self, count: int):
        return _FakeQuery(self._documents[:count])

    def stream(self):
        return [_FakeSnapshot(doc) for doc in self._documents]


class _FakeCollection(_FakeQuery):
    def __init__(self, storage: dict[str, dict[str, dict]], name: str) -> None:
        self._storage = storage
        self._name = name
        super().__init__(list(storage[name].values()))

    def document(self, doc_id: str) -> _FakeDocument:
        return _FakeDocument(self._storage, self._name, doc_id)


class _FakeClient:
    def __init__(self) -> None:
        self.storage = {
            "sessions": {},
            "rounds": {},
            "claims": {},
            "reports": {},
        }

    def collection(self, name: str) -> _FakeCollection:
        return _FakeCollection(self.storage, name)


def test_firestore_store_persists_all_entities_and_lists_history(monkeypatch):
    fake_google = types.ModuleType("google")
    fake_cloud = types.ModuleType("google.cloud")
    fake_firestore = types.SimpleNamespace(Query=types.SimpleNamespace(DESCENDING="DESCENDING"))
    fake_cloud.firestore = fake_firestore

    monkeypatch.setitem(sys.modules, "google", fake_google)
    monkeypatch.setitem(sys.modules, "google.cloud", fake_cloud)

    settings = Settings(app_env="test", google_genai_use_vertexai=False)
    store = FirestoreStore(settings)

    fake_client = _FakeClient()
    monkeypatch.setattr(store, "_ensure_client", lambda: fake_client)

    asyncio.run(store.save_session_start("s1", {"topic": "AI Regulation"}))
    asyncio.run(store.save_round_start("r1", {"sessionId": "s1", "startedAt": "2026-03-12T10:00:00Z"}))
    asyncio.run(
        store.save_claims(
            "r1",
            [
                {"claim_id": "c1", "claim": "X", "verdict": "unsupported"},
                {"claim_id": "c2", "claim": "Y", "verdict": "supported"},
            ],
        )
    )
    asyncio.run(
        store.save_round_report(
            "r1",
            {
                "sessionId": "s1",
                "topic": "AI Regulation",
                "generatedAt": "2026-03-12T10:05:00Z",
                "rubric": {"argument_strength": 7},
                "citedCorrections": [{"claim": "X"}],
                "summary": "Good momentum.",
            },
        )
    )

    # Additional round for ordering/filtering check.
    fake_client.collection("reports").document("r2").set(
        {
            "roundId": "r2",
            "sessionId": "s1",
            "generatedAt": "2026-03-12T10:06:00Z",
            "rubric": {"argument_strength": 8},
        },
        merge=True,
    )

    assert fake_client.storage["sessions"]["s1"]["topic"] == "AI Regulation"
    assert fake_client.storage["rounds"]["r1"]["sessionId"] == "s1"
    assert fake_client.storage["claims"]["c1"]["roundId"] == "r1"
    assert fake_client.storage["reports"]["r1"]["summary"] == "Good momentum."

    history = asyncio.run(store.list_recent_rounds(limit=2, session_id="s1"))
    assert len(history) == 2
    assert history[0]["roundId"] == "r2"
    assert history[1]["roundId"] == "r1"
