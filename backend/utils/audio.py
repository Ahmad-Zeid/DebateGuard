from __future__ import annotations

import base64
from typing import Final

PCM16_BYTES_PER_SAMPLE: Final[int] = 2


def decode_b64_payload(data_b64: str, field_name: str) -> bytes:
    try:
        return base64.b64decode(data_b64, validate=True)
    except Exception as exc:  # noqa: BLE001 - include decoding failures cleanly
        raise ValueError(f"Invalid base64 in '{field_name}'") from exc


def encode_b64_payload(raw_bytes: bytes) -> str:
    return base64.b64encode(raw_bytes).decode("ascii")


def pcm16_duration_ms(
    chunk: bytes,
    sample_rate_hz: int = 16000,
    channels: int = 1,
) -> float:
    if sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be positive")
    if channels <= 0:
        raise ValueError("channels must be positive")
    bytes_per_second = sample_rate_hz * channels * PCM16_BYTES_PER_SAMPLE
    return (len(chunk) / bytes_per_second) * 1000.0


def is_small_chunk(duration_ms: float, minimum_ms: int = 20, maximum_ms: int = 100) -> bool:
    return minimum_ms <= duration_ms <= maximum_ms
