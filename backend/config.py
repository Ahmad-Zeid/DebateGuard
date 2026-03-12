from __future__ import annotations

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_env: str = Field(default="local", validation_alias="APP_ENV")
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")

    google_genai_use_vertexai: bool = Field(
        default=False,
        validation_alias="GOOGLE_GENAI_USE_VERTEXAI",
    )
    google_cloud_project: str | None = Field(
        default=None,
        validation_alias="GOOGLE_CLOUD_PROJECT",
    )
    google_cloud_location: str | None = Field(
        default=None,
        validation_alias="GOOGLE_CLOUD_LOCATION",
    )

    live_model: str = Field(
        default="gemini-live-2.5-flash-preview",
        validation_alias="LIVE_MODEL",
    )
    factcheck_model: str = Field(
        default="gemini-2.5-flash",
        validation_alias="FACTCHECK_MODEL",
    )

    firestore_database: str = Field(
        default="(default)",
        validation_alias="FIRESTORE_DATABASE",
    )
    debug_save_media: bool = Field(default=False, validation_alias="DEBUG_SAVE_MEDIA")
    backend_port: int = Field(default=8000, validation_alias="BACKEND_PORT")

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "prod"

    @model_validator(mode="after")
    def validate_production_vertex_requirements(self) -> "Settings":
        if self.is_production and not self.google_genai_use_vertexai:
            raise ValueError("GOOGLE_GENAI_USE_VERTEXAI must be true in production")

        if self.is_production and self.google_genai_use_vertexai:
            if not self.google_cloud_project:
                raise ValueError("GOOGLE_CLOUD_PROJECT is required in production Vertex mode")
            if not self.google_cloud_location:
                raise ValueError("GOOGLE_CLOUD_LOCATION is required in production Vertex mode")

        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
