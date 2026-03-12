from __future__ import annotations

import logging
from logging.config import dictConfig


LOG_FORMAT = (
    "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
)


def configure_logging(level: str = "INFO") -> None:
    """Configure a simple, judge-friendly log format for app and websocket events."""

    dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "standard": {
                    "format": LOG_FORMAT,
                }
            },
            "handlers": {
                "default": {
                    "class": "logging.StreamHandler",
                    "formatter": "standard",
                }
            },
            "root": {
                "handlers": ["default"],
                "level": level.upper(),
            },
        }
    )


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
