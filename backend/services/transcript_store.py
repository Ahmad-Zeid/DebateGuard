from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Literal

Role = Literal["user", "model"]


@dataclass
class TranscriptEntry:
    role: Role
    text: str
    is_final: bool
    created_at: str


class TranscriptStore:
    """In-memory transcript tracker for one debate round."""

    def __init__(self) -> None:
        self._entries: list[TranscriptEntry] = []
        self._model_delta_buffer: list[str] = []

    def add_partial(self, role: Role, text: str) -> None:
        self._entries.append(
            TranscriptEntry(
                role=role,
                text=text,
                is_final=False,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        )

    def add_final(self, role: Role, text: str) -> None:
        self._entries.append(
            TranscriptEntry(
                role=role,
                text=text,
                is_final=True,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        )

    def add_model_delta(self, delta_text: str) -> None:
        if not delta_text:
            return
        self._model_delta_buffer.append(delta_text)

    def finalize_model_buffer(self) -> str:
        final_text = "".join(self._model_delta_buffer).strip()
        self._model_delta_buffer.clear()
        if final_text:
            self.add_final("model", final_text)
        return final_text

    def final_entries(self) -> list[TranscriptEntry]:
        return [entry for entry in self._entries if entry.is_final]

    def final_text(self) -> str:
        parts = [f"{entry.role}: {entry.text}" for entry in self.final_entries()]
        return "\n".join(parts)

    def all_entries(self) -> list[dict[str, str | bool]]:
        return [asdict(entry) for entry in self._entries]
