from __future__ import annotations

import re

from schemas.factcheck import ClaimCandidate, ClaimClass

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_WHITESPACE_RE = re.compile(r"\s+")

_PERCENT_RE = re.compile(r"\b\d{1,3}(?:\.\d+)?\s*%")
_NUMBER_RE = re.compile(r"\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\b")
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")

_DATE_RE = re.compile(
    r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
    r"\s+\d{1,2}(?:,\s*(?:19|20)\d{2})?\b",
    re.IGNORECASE,
)

_RANKING_RE = re.compile(
    r"\b(?:top\s+\d+|rank(?:ed|ing)?\s+(?:#?\d+|first|second|third|fourth|fifth)|"
    r"#\d+\b|(?:first|second|third|fourth|fifth)\s+(?:largest|smallest|highest|lowest|most|least))\b",
    re.IGNORECASE,
)

_STUDY_REPORT_RE = re.compile(
    r"\b(?:study|report|statistics?|survey|poll|paper|meta-analysis)\b"
    r"(?:[^.!?]{0,120})\b(?:says?|show(?:s|ed)?|find(?:s|ings)?|according\s+to)\b",
    re.IGNORECASE,
)

_EVENT_KEYWORDS = (
    "election",
    "war",
    "recession",
    "pandemic",
    "earthquake",
    "hurricane",
    "olympics",
    "world cup",
    "summit",
    "crash",
    "crisis",
    "treaty",
    "attack",
)


class ClaimDetector:
    """Extracts narrow, checkable claim candidates from final transcript segments."""

    def __init__(self, max_candidates_per_segment: int = 5) -> None:
        self.max_candidates_per_segment = max_candidates_per_segment

    def extract(self, final_segment: str) -> list[ClaimCandidate]:
        if not final_segment or not final_segment.strip():
            return []

        candidates: list[ClaimCandidate] = []
        seen: set[str] = set()

        for sentence in self._split_sentences(final_segment):
            claim_class = self._classify_sentence(sentence)
            if claim_class is None:
                continue

            normalized_key = sentence.lower()
            if normalized_key in seen:
                continue
            seen.add(normalized_key)

            candidates.append(
                ClaimCandidate(
                    claim=sentence,
                    claim_class=claim_class,
                    source_segment=final_segment.strip(),
                )
            )

            if len(candidates) >= self.max_candidates_per_segment:
                break

        return candidates

    def _split_sentences(self, text: str) -> list[str]:
        raw_segments = _SENTENCE_SPLIT_RE.split(text.strip())
        if len(raw_segments) == 1:
            raw_segments = [text.strip()]

        segments: list[str] = []
        for segment in raw_segments:
            normalized = _WHITESPACE_RE.sub(" ", segment).strip(" .!?\n\t")
            if normalized:
                segments.append(normalized)
        return segments

    def _classify_sentence(self, sentence: str) -> ClaimClass | None:
        lowered = sentence.lower()

        if _STUDY_REPORT_RE.search(sentence):
            return "study_report"

        if _RANKING_RE.search(sentence):
            return "ranking"

        if _PERCENT_RE.search(sentence):
            return "percentage"

        if self._looks_like_named_event(lowered):
            return "named_event"

        if _YEAR_RE.search(sentence) or _DATE_RE.search(sentence):
            return "date"

        if _NUMBER_RE.search(sentence):
            return "numeric"

        return None

    def _looks_like_named_event(self, lowered_sentence: str) -> bool:
        has_event_keyword = any(keyword in lowered_sentence for keyword in _EVENT_KEYWORDS)
        if not has_event_keyword:
            return False

        has_fact_anchor = bool(
            _YEAR_RE.search(lowered_sentence)
            or _NUMBER_RE.search(lowered_sentence)
            or _DATE_RE.search(lowered_sentence)
        )
        return has_fact_anchor
