from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from services.live_session import LiveSessionManager

router = APIRouter()


class HistoryResponse(BaseModel):
    rounds: list[dict[str, Any]] = Field(default_factory=list)


@router.get("/api/history", response_model=HistoryResponse)
async def history(request: Request, limit: int = Query(default=10, ge=1, le=50), session_id: str | None = None) -> HistoryResponse:
    manager: LiveSessionManager = request.app.state.live_session_manager
    rounds = await manager.store.list_recent_rounds(limit=limit, session_id=session_id)
    return HistoryResponse(rounds=rounds)
