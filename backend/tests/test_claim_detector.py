import pytest

from services.claim_detector import ClaimDetector


@pytest.mark.parametrize(
    "text,expected_class",
    [
        ("Inflation was 8.2% last year.", "percentage"),
        ("The city has 120000 residents.", "numeric"),
        ("In 2021, exports increased.", "date"),
        ("This country is ranked #1 in coffee exports.", "ranking"),
        ("The 2008 financial crisis began in 2007.", "named_event"),
        ("A recent study says screen time is rising.", "study_report"),
    ],
)
def test_claim_detector_extracts_narrow_classes(text: str, expected_class: str) -> None:
    detector = ClaimDetector()
    claims = detector.extract(text)

    assert claims, "Expected at least one claim candidate"
    assert claims[0].claim_class == expected_class


def test_claim_detector_ignores_non_checkable_opinion() -> None:
    detector = ClaimDetector()
    claims = detector.extract("I feel this policy is better for society.")
    assert claims == []
