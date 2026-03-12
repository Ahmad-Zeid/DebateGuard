from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from config import Settings, get_settings
from routes.history import router as history_router
from routes.live_ws import router as live_ws_router
from services.live_session import LiveSessionManager
from utils.logging import configure_logging


class HealthResponse(BaseModel):
    status: str
    service: str
    env: str


def _frontend_dist_dir() -> Path:
    # In Cloud Run container we copy frontend build output to /app/static.
    return Path(__file__).resolve().parent / "static"


def create_app(
    settings: Settings | None = None,
    session_manager: LiveSessionManager | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="DebateGuard API",
        version="0.3.0",
        description="DebateGuard backend for Gemini Live Agent Challenge",
    )

    app.state.settings = settings
    app.state.live_session_manager = session_manager or LiveSessionManager(settings=settings)

    @app.get("/api/health", response_model=HealthResponse)
    def api_health() -> HealthResponse:
        return HealthResponse(status="ok", service="debateguard-backend", env=settings.app_env)

    @app.get("/healthz", response_model=HealthResponse)
    def healthz() -> HealthResponse:
        return HealthResponse(status="ok", service="debateguard-backend", env=settings.app_env)

    app.include_router(live_ws_router)
    app.include_router(history_router)

    frontend_dist = _frontend_dist_dir()
    if frontend_dist.exists():

        @app.get("/{full_path:path}", include_in_schema=False)
        def serve_frontend(full_path: str) -> FileResponse:
            normalized_path = full_path.lstrip("/")
            if normalized_path == "":
                return FileResponse(frontend_dist / "index.html")

            # Keep non-existent API-like paths as 404 instead of serving SPA index.
            if normalized_path.startswith(("api/", "ws/", "healthz")):
                raise HTTPException(status_code=404, detail="Not found")

            candidate = (frontend_dist / normalized_path).resolve()
            if frontend_dist.resolve() not in candidate.parents and candidate != frontend_dist.resolve():
                raise HTTPException(status_code=404, detail="Not found")

            if candidate.is_file():
                return FileResponse(candidate)

            return FileResponse(frontend_dist / "index.html")

    else:

        @app.get("/", response_model=HealthResponse)
        def root() -> HealthResponse:
            return HealthResponse(status="ok", service="debateguard-backend", env=settings.app_env)

    return app


app = create_app()
