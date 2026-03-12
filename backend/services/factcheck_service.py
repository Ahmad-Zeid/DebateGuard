from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from config import Settings
from schemas.factcheck import ClaimCandidate, GroundedFactcheckResult, RoundFactcheckRecord
from services.claim_detector import ClaimDetector
from utils.logging import get_logger

INTERRUPT_CONFIDENCE_THRESHOLD = 0.90
MAX_INTERRUPTS_PER_ROUND = 1
INTERRUPT_ELIGIBLE_CLASSES = {
    "numeric",
    "percentage",
    "date",
    "named_event",
    "study_report",
}

_DEMO_FALSE_STAT_FIXTURES: tuple[tuple[re.Pattern[str], dict[str, Any]], ...] = (
    (
        re.compile(
            r"\b(?:90\s*(?:%|percent)|ninety\s+percent)\s+of\s+social\s+media\s+users\s+are\s+bots\b",
            re.IGNORECASE,
        ),
        {
            "verdict": "unsupported",
            "corrected_fact": (
                "Public studies and platform transparency reports place likely inauthentic/bot-like "
                "account shares far below 90%, typically in the single digits to low double digits."
            ),
            "short_explanation": "The 90% figure is far above widely reported estimates and lacks credible support.",
            "citations": [
                "https://help.x.com/en/rules-and-policies/platform-manipulation",
                "https://www.pewresearch.org/internet/2018/04/09/bots-in-the-twittersphere/",
            ],
            "confidence": 0.97,
            "interrupt_now": True,
        },
    ),
    (
        re.compile(r"\bunemployment\s+(?:is|was)\s+50\s*%\b", re.IGNORECASE),
        {
            "verdict": "unsupported",
            "corrected_fact": "A 50% unemployment rate is not supported by mainstream official labor statistics in modern economies.",
            "short_explanation": "This claim conflicts with standard labor statistics published by national and multilateral agencies.",
            "citations": [
                "https://data.worldbank.org/indicator/SL.UEM.TOTL.ZS",
                "https://www.bls.gov/charts/employment-situation/civilian-unemployment-rate.htm",
            ],
            "confidence": 0.95,
            "interrupt_now": True,
        },
    ),
)


class FactcheckService:
    """Detects and verifies checkable factual claims with grounding support."""

    def __init__(self, settings: Settings, detector: ClaimDetector | None = None) -> None:
        self.settings = settings
        self.detector = detector or ClaimDetector()
        self.logger = get_logger("services.factcheck")

        prompt_path = Path(__file__).resolve().parents[1] / "prompts" / "factcheck_prompt.txt"
        self.prompt_template = prompt_path.read_text(encoding="utf-8")

        self._genai_client: Any | None = None

    def detect_claims(self, final_segment: str) -> list[ClaimCandidate]:
        return self.detector.extract(final_segment)

    async def verify_candidate(self, candidate: ClaimCandidate, demo_mode: bool) -> GroundedFactcheckResult:
        fixture = self._match_demo_fixture(candidate.claim) if demo_mode else None
        if fixture is not None:
            return fixture

        if not self.settings.google_genai_use_vertexai:
            return self._fallback_result(
                claim=candidate.claim,
                explanation="Grounded verifier disabled (GOOGLE_GENAI_USE_VERTEXAI=false).",
            )

        if not self.settings.google_cloud_project or not self.settings.google_cloud_location:
            return self._fallback_result(
                claim=candidate.claim,
                explanation="Grounded verifier unavailable due to missing Google Cloud project/location settings.",
            )

        try:
            return await asyncio.to_thread(self._verify_with_gemini_sync, candidate)
        except Exception as exc:  # noqa: BLE001 - convert to safe fallback
            self.logger.exception("Grounded fact-check call failed", extra={"claim": candidate.claim, "error": str(exc)})
            return self._fallback_result(
                claim=candidate.claim,
                explanation="Grounded verification failed; storing as report-only item.",
            )

    def apply_interrupt_policy(
        self,
        candidate: ClaimCandidate,
        result: GroundedFactcheckResult,
        interruptions_used: int,
    ) -> bool:
        if interruptions_used >= MAX_INTERRUPTS_PER_ROUND:
            return False

        if candidate.claim_class not in INTERRUPT_ELIGIBLE_CLASSES:
            return False

        if result.confidence < INTERRUPT_CONFIDENCE_THRESHOLD:
            return False

        if result.verdict not in {"unsupported", "disputed"}:
            return False

        return True

    def as_round_record(
        self,
        candidate: ClaimCandidate,
        result: GroundedFactcheckResult,
        interrupted_live: bool,
    ) -> RoundFactcheckRecord:
        return RoundFactcheckRecord(
            claim_id=candidate.claim_id,
            claim_class=candidate.claim_class,
            claim=result.claim,
            verdict=result.verdict,
            corrected_fact=result.corrected_fact,
            short_explanation=result.short_explanation,
            citations=result.citations,
            confidence=result.confidence,
            interrupt_now=result.interrupt_now,
            interrupted_live=interrupted_live,
        )

    def _verify_with_gemini_sync(self, candidate: ClaimCandidate) -> GroundedFactcheckResult:
        from google import genai

        if self._genai_client is None:
            self._genai_client = genai.Client(
                vertexai=True,
                project=self.settings.google_cloud_project,
                location=self.settings.google_cloud_location,
            )

        prompt = self.prompt_template.format(claim=candidate.claim, claim_class=candidate.claim_class)

        response = self._genai_client.models.generate_content(
            model=self.settings.factcheck_model,
            contents=prompt,
            config={
                "temperature": 0,
                "response_mime_type": "application/json",
                "tools": [{"google_search": {}}],
            },
        )

        raw_text = getattr(response, "text", None) or self._extract_text_from_response(response)
        payload = self._extract_json_payload(raw_text)
        grounded_citations = self._extract_grounding_citations(response)

        if "claim" not in payload:
            payload["claim"] = candidate.claim

        if "citations" not in payload or not payload["citations"]:
            payload["citations"] = grounded_citations
        else:
            payload["citations"] = self._merge_citations(payload["citations"], grounded_citations)

        parsed = GroundedFactcheckResult.model_validate(payload)
        return parsed

    def _match_demo_fixture(self, claim: str) -> GroundedFactcheckResult | None:
        for pattern, fixture_payload in _DEMO_FALSE_STAT_FIXTURES:
            if pattern.search(claim):
                payload = {**fixture_payload, "claim": claim}
                return GroundedFactcheckResult.model_validate(payload)
        return None

    def _fallback_result(self, claim: str, explanation: str) -> GroundedFactcheckResult:
        return GroundedFactcheckResult(
            claim=claim,
            verdict="not-checkable",
            corrected_fact=None,
            short_explanation=explanation,
            citations=[],
            confidence=0.0,
            interrupt_now=False,
        )

    def _extract_text_from_response(self, response: Any) -> str:
        as_dict = _as_dict(response)

        candidates = as_dict.get("candidates")
        if isinstance(candidates, list):
            for candidate in candidates:
                candidate_dict = candidate if isinstance(candidate, dict) else _as_dict(candidate)
                content = candidate_dict.get("content")
                content_dict = content if isinstance(content, dict) else _as_dict(content)
                parts = content_dict.get("parts")
                if not isinstance(parts, list):
                    continue
                texts: list[str] = []
                for part in parts:
                    part_dict = part if isinstance(part, dict) else _as_dict(part)
                    text = part_dict.get("text")
                    if isinstance(text, str):
                        texts.append(text)
                if texts:
                    return "\n".join(texts)

        return ""

    def _extract_json_payload(self, raw_text: str) -> dict[str, Any]:
        text = (raw_text or "").strip()
        if not text:
            raise ValueError("Verifier returned empty response")

        # Strip code fences if present.
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?", "", text, flags=re.IGNORECASE).strip()
            text = re.sub(r"```$", "", text).strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Try extracting the first JSON object from mixed text.
            match = re.search(r"\{[\s\S]*\}", text)
            if not match:
                raise
            return json.loads(match.group(0))

    def _extract_grounding_citations(self, response: Any) -> list[str]:
        as_dict = _as_dict(response)

        urls: list[str] = []

        candidates = as_dict.get("candidates")
        if isinstance(candidates, list):
            for candidate in candidates:
                candidate_dict = candidate if isinstance(candidate, dict) else _as_dict(candidate)
                grounding = candidate_dict.get("grounding_metadata") or candidate_dict.get("groundingMetadata")
                if grounding is None:
                    continue

                grounding_dict = grounding if isinstance(grounding, dict) else _as_dict(grounding)
                supports = grounding_dict.get("groundingSupports") or grounding_dict.get("grounding_supports")
                if not isinstance(supports, list):
                    continue

                for support in supports:
                    support_dict = support if isinstance(support, dict) else _as_dict(support)
                    chunks = support_dict.get("groundingChunkIndices") or support_dict.get("grounding_chunk_indices")
                    if not isinstance(chunks, list):
                        continue

                    all_chunks = grounding_dict.get("groundingChunks") or grounding_dict.get("grounding_chunks")
                    if not isinstance(all_chunks, list):
                        continue

                    for index in chunks:
                        if not isinstance(index, int):
                            continue
                        if index < 0 or index >= len(all_chunks):
                            continue
                        chunk_dict = all_chunks[index] if isinstance(all_chunks[index], dict) else _as_dict(all_chunks[index])
                        web = chunk_dict.get("web") or chunk_dict.get("web_source") or {}
                        web_dict = web if isinstance(web, dict) else _as_dict(web)
                        uri = web_dict.get("uri") or web_dict.get("url")
                        if isinstance(uri, str):
                            urls.append(uri)

        deduped = self._merge_citations([], urls)
        return deduped

    def _merge_citations(self, first: list[str] | Any, second: list[str]) -> list[str]:
        merged: list[str] = []
        seen: set[str] = set()

        for source in [first, second]:
            if not isinstance(source, list):
                continue
            for item in source:
                if not isinstance(item, str):
                    continue
                normalized = item.strip()
                if not normalized:
                    continue
                if normalized in seen:
                    continue
                seen.add(normalized)
                merged.append(normalized)

        return merged[:8]


def _as_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value

    if hasattr(value, "model_dump"):
        try:
            return value.model_dump(exclude_none=True, by_alias=True)
        except TypeError:
            return value.model_dump(exclude_none=True)

    if hasattr(value, "to_dict"):
        return value.to_dict()

    if hasattr(value, "__dict__"):
        return {k: v for k, v in vars(value).items() if not k.startswith("_")}

    return {}
