from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas.report import ReportRubric


def test_report_rubric_accepts_valid_payload() -> None:
    rubric = ReportRubric.model_validate(
        {
            "argument_strength": 7,
            "evidence_quality": 6,
            "responsiveness": 8,
            "delivery": 6,
            "factual_accuracy": 7,
            "top_strengths": ["Clear structure"],
            "top_issues": ["Need more citations"],
            "cited_corrections": [
                {
                    "claim": "90% of social media users are bots",
                    "claim_class": "percentage",
                    "verdict": "unsupported",
                    "corrected_fact": "Estimates are much lower.",
                    "short_explanation": "Claim is inflated.",
                    "citations": ["https://example.com/source"],
                    "confidence": 0.95,
                    "interrupt_now": True,
                    "interrupted_live": True,
                }
            ],
            "next_drills": ["Practice verified-stat rebuttals"],
            "one_sentence_coach_summary": "Solid flow with room to improve evidence quality.",
        }
    )

    assert rubric.argument_strength == 7
    assert rubric.cited_corrections[0].verdict == "unsupported"


def test_report_rubric_rejects_out_of_range_scores() -> None:
    with pytest.raises(ValidationError):
        ReportRubric.model_validate(
            {
                "argument_strength": 12,
                "evidence_quality": 6,
                "responsiveness": 8,
                "delivery": 6,
                "factual_accuracy": 7,
                "top_strengths": [],
                "top_issues": [],
                "cited_corrections": [],
                "next_drills": [],
                "one_sentence_coach_summary": "Summary",
            }
        )


def test_report_rubric_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        ReportRubric.model_validate(
            {
                "argument_strength": 7,
                "evidence_quality": 6,
                "responsiveness": 8,
                "delivery": 6,
                "factual_accuracy": 7,
                "top_strengths": [],
                "top_issues": [],
                "cited_corrections": [],
                "next_drills": [],
                "one_sentence_coach_summary": "Summary",
                "unexpected": "field",
            }
        )
