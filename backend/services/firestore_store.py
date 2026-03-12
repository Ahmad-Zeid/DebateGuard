from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Protocol

from config import Settings
from utils.logging import get_logger


class RoundPersistenceStore(Protocol):
    async def save_session_start(self, session_id: str, payload: dict[str, Any]) -> None: ...

    async def save_round_start(self, round_id: str, payload: dict[str, Any]) -> None: ...

    async def save_claims(self, round_id: str, claims: list[dict[str, Any]]) -> None: ...

    async def save_round_report(self, round_id: str, payload: dict[str, Any]) -> None: ...

    async def list_recent_rounds(self, limit: int = 10, session_id: str | None = None) -> list[dict[str, Any]]: ...


class NullStore:
    """In-memory store for local/testing environments."""

    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._rounds: dict[str, dict[str, Any]] = {}
        self._reports: dict[str, dict[str, Any]] = {}
        self._claims: dict[str, dict[str, Any]] = {}

    async def save_session_start(self, session_id: str, payload: dict[str, Any]) -> None:
        self._sessions[session_id] = {**self._sessions.get(session_id, {}), **payload}

    async def save_round_start(self, round_id: str, payload: dict[str, Any]) -> None:
        self._rounds[round_id] = {**self._rounds.get(round_id, {}), **payload}

    async def save_claims(self, round_id: str, claims: list[dict[str, Any]]) -> None:
        for claim in claims:
            claim_id = str(claim.get("claim_id") or claim.get("claimId") or f"{round_id}-{len(self._claims) + 1}")
            self._claims[claim_id] = {**claim, "roundId": round_id}

    async def save_round_report(self, round_id: str, payload: dict[str, Any]) -> None:
        self._rounds[round_id] = {**self._rounds.get(round_id, {}), **payload}
        self._reports[round_id] = {
            "roundId": round_id,
            "sessionId": payload.get("sessionId"),
            "topic": payload.get("topic"),
            "rubric": payload.get("rubric", {}),
            "citedCorrections": payload.get("citedCorrections", []),
            "generatedAt": payload.get("generatedAt") or datetime.now(timezone.utc).isoformat(),
            "summary": payload.get("summary"),
        }

    async def list_recent_rounds(self, limit: int = 10, session_id: str | None = None) -> list[dict[str, Any]]:
        reports = list(self._reports.values())
        if session_id:
            reports = [item for item in reports if item.get("sessionId") == session_id]

        reports.sort(key=lambda item: str(item.get("generatedAt") or ""), reverse=True)
        return reports[: max(1, min(limit, 50))]


class FirestoreStore:
    """Firestore-backed persistence for sessions/rounds/claims/reports."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._logger = get_logger("services.firestore")
        self._client = None

    def _ensure_client(self):
        if self._client is not None:
            return self._client

        from google.cloud import firestore  # imported lazily for testability

        self._client = firestore.Client(
            project=self._settings.google_cloud_project,
            database=self._settings.firestore_database,
        )
        return self._client

    async def save_session_start(self, session_id: str, payload: dict[str, Any]) -> None:
        await asyncio.to_thread(self._save_session_start_sync, session_id, payload)

    async def save_round_start(self, round_id: str, payload: dict[str, Any]) -> None:
        await asyncio.to_thread(self._save_round_start_sync, round_id, payload)

    async def save_claims(self, round_id: str, claims: list[dict[str, Any]]) -> None:
        await asyncio.to_thread(self._save_claims_sync, round_id, claims)

    async def save_round_report(self, round_id: str, payload: dict[str, Any]) -> None:
        await asyncio.to_thread(self._save_round_report_sync, round_id, payload)

    async def list_recent_rounds(self, limit: int = 10, session_id: str | None = None) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._list_recent_rounds_sync, limit, session_id)

    def _save_session_start_sync(self, session_id: str, payload: dict[str, Any]) -> None:
        try:
            client = self._ensure_client()
            client.collection("sessions").document(session_id).set(payload, merge=True)
        except Exception:
            self._logger.exception("Failed to persist session start", extra={"session_id": session_id})

    def _save_round_start_sync(self, round_id: str, payload: dict[str, Any]) -> None:
        try:
            client = self._ensure_client()
            client.collection("rounds").document(round_id).set(payload, merge=True)
        except Exception:
            self._logger.exception("Failed to persist round start", extra={"round_id": round_id})

    def _save_claims_sync(self, round_id: str, claims: list[dict[str, Any]]) -> None:
        try:
            client = self._ensure_client()
            for claim in claims:
                claim_id = str(claim.get("claim_id") or claim.get("claimId") or f"{round_id}-{id(claim)}")
                payload = {**claim, "roundId": round_id}
                client.collection("claims").document(claim_id).set(payload, merge=True)
        except Exception:
            self._logger.exception("Failed to persist claims", extra={"round_id": round_id})

    def _save_round_report_sync(self, round_id: str, payload: dict[str, Any]) -> None:
        try:
            client = self._ensure_client()
            client.collection("rounds").document(round_id).set(payload, merge=True)

            report_payload = {
                "roundId": round_id,
                "sessionId": payload.get("sessionId"),
                "topic": payload.get("topic"),
                "rubric": payload.get("rubric", {}),
                "citedCorrections": payload.get("citedCorrections", []),
                "generatedAt": payload.get("generatedAt"),
                "summary": payload.get("summary"),
            }
            client.collection("reports").document(round_id).set(report_payload, merge=True)
        except Exception:
            self._logger.exception("Failed to persist round report", extra={"round_id": round_id})

    def _list_recent_rounds_sync(self, limit: int, session_id: str | None) -> list[dict[str, Any]]:
        try:
            from google.cloud import firestore

            client = self._ensure_client()
            query = client.collection("reports")
            if session_id:
                query = query.where("sessionId", "==", session_id)
            query = query.order_by("generatedAt", direction=firestore.Query.DESCENDING).limit(max(1, min(limit, 50)))

            documents = query.stream()
            return [document.to_dict() for document in documents]
        except Exception:
            self._logger.exception(
                "Failed to load recent round history",
                extra={"limit": limit, "session_id": session_id},
            )
            return []
