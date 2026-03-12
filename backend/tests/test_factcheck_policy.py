import asyncio

import pytest

from config import Settings
from schemas.factcheck import ClaimCandidate, GroundedFactcheckResult
from services.factcheck_service import FactcheckService


def _candidate(claim_class: str = "numeric") -> ClaimCandidate:
    return ClaimCandidate(
        claim="The unemployment rate is 50%.",
        claim_class=claim_class,
        source_segment="The unemployment rate is 50%.",
    )


def _result(confidence: float, verdict: str = "unsupported") -> GroundedFactcheckResult:
    return GroundedFactcheckResult(
        claim="The unemployment rate is 50%.",
        verdict=verdict,
        corrected_fact="Official sources show a much lower rate.",
        short_explanation="The claim is not supported by official labor data.",
        citations=["https://www.bls.gov/charts/employment-situation/civilian-unemployment-rate.htm"],
        confidence=confidence,
        interrupt_now=False,
    )


def test_interrupt_policy_requires_confidence_threshold_and_class_gate() -> None:
    service = FactcheckService(
        settings=Settings(app_env="test", google_genai_use_vertexai=False),
    )

    assert service.apply_interrupt_policy(_candidate("numeric"), _result(0.95), interruptions_used=0) is True
    assert service.apply_interrupt_policy(_candidate("numeric"), _result(0.89), interruptions_used=0) is False
    assert service.apply_interrupt_policy(_candidate("ranking"), _result(0.99), interruptions_used=0) is False
    assert service.apply_interrupt_policy(_candidate("numeric"), _result(0.99), interruptions_used=1) is False
    assert service.apply_interrupt_policy(_candidate("numeric"), _result(0.99, verdict="supported"), interruptions_used=0) is False


@pytest.mark.parametrize(
    "claim_text",
    [
        "90% of social media users are bots.",
        "Ninety percent of social media users are bots, according to recent statistics.",
    ],
)
def test_demo_fixture_returns_deterministic_grounded_correction(claim_text: str) -> None:
    service = FactcheckService(
        settings=Settings(app_env="test", google_genai_use_vertexai=False),
    )

    candidate = ClaimCandidate(
        claim=claim_text,
        claim_class="percentage",
        source_segment=claim_text,
    )

    result = asyncio.run(service.verify_candidate(candidate, demo_mode=True))

    assert result.verdict == "unsupported"
    assert result.confidence >= 0.9
    assert result.citations
    assert "social media users are bots" in result.claim.lower()


def test_non_demo_without_vertex_returns_report_only_fallback() -> None:
    service = FactcheckService(
        settings=Settings(app_env="test", google_genai_use_vertexai=False),
    )
    candidate = _candidate("numeric")

    result = asyncio.run(service.verify_candidate(candidate, demo_mode=False))

    assert result.verdict == "not-checkable"
    assert result.interrupt_now is False
    assert result.confidence == 0.0
