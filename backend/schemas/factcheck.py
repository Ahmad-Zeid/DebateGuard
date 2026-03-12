from __future__ import annotations

from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

ClaimClass = Literal[
    "numeric",
    "percentage",
    "date",
    "ranking",
    "named_event",
    "study_report",
]

Verdict = Literal["supported", "disputed", "unsupported", "not-checkable"]


class ClaimCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim_id: str = Field(default_factory=lambda: str(uuid4()))
    claim: str = Field(min_length=3)
    claim_class: ClaimClass
    source_segment: str = Field(min_length=1)


class GroundedFactcheckResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim: str = Field(min_length=3)
    verdict: Verdict
    corrected_fact: str | None = None
    short_explanation: str = Field(min_length=1)
    citations: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    interrupt_now: bool = False

    @field_validator("citations")
    @classmethod
    def normalize_citations(cls, value: list[str]) -> list[str]:
        deduped: list[str] = []
        seen: set[str] = set()

        for citation in value:
            normalized = (citation or "").strip()
            if not normalized:
                continue
            if normalized in seen:
                continue
            seen.add(normalized)
            deduped.append(normalized)

        return deduped[:8]


class RoundFactcheckRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim_id: str
    claim_class: ClaimClass
    claim: str
    verdict: Verdict
    corrected_fact: str | None = None
    short_explanation: str
    citations: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    interrupt_now: bool = False
    interrupted_live: bool = False
