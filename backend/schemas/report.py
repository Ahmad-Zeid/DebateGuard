from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ClaimVerdict = Literal["supported", "disputed", "unsupported", "not-checkable"]
ClaimClass = Literal["numeric", "percentage", "date", "ranking", "named_event", "study_report"]


class ReportCorrection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim: str = Field(min_length=1)
    claim_class: ClaimClass
    verdict: ClaimVerdict
    corrected_fact: str | None = None
    short_explanation: str = Field(min_length=1)
    citations: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    interrupt_now: bool = False
    interrupted_live: bool = False


class ReportRubric(BaseModel):
    """Strict rubric JSON contract for end-of-round reports."""

    model_config = ConfigDict(extra="forbid")

    argument_strength: int = Field(ge=1, le=10)
    evidence_quality: int = Field(ge=1, le=10)
    responsiveness: int = Field(ge=1, le=10)
    delivery: int = Field(ge=1, le=10)
    factual_accuracy: int = Field(ge=1, le=10)
    top_strengths: list[str] = Field(default_factory=list)
    top_issues: list[str] = Field(default_factory=list)
    cited_corrections: list[ReportCorrection] = Field(default_factory=list)
    next_drills: list[str] = Field(default_factory=list)
    one_sentence_coach_summary: str = Field(min_length=1)


class HistoryRoundItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    round_id: str
    session_id: str
    topic: str | None = None
    generated_at: str | None = None
    summary: str | None = None
    rubric: ReportRubric
