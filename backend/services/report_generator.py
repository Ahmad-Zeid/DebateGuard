from __future__ import annotations

import re
from statistics import mean
from typing import Any

from schemas.factcheck import RoundFactcheckRecord
from schemas.report import ReportCorrection, ReportRubric

_WORD_RE = re.compile(r"\b[\w'-]+\b")
_NUMERIC_RE = re.compile(r"\b\d+(?:\.\d+)?\b")


def _clamp_score(value: float) -> int:
    return max(1, min(10, int(round(value))))


class ReportGenerator:
    """Builds end-of-round rubric JSON from transcript, fact-check, and delivery aggregates."""

    def generate(
        self,
        transcript_entries: list[dict[str, Any]],
        factcheck_records: list[RoundFactcheckRecord],
        delivery_metrics: list[dict[str, Any]],
    ) -> ReportRubric:
        final_entries = [entry for entry in transcript_entries if entry.get("is_final")]
        if not final_entries:
            final_entries = transcript_entries

        user_turns = [entry for entry in final_entries if entry.get("role") == "user"]
        model_turns = [entry for entry in final_entries if entry.get("role") == "model"]

        user_text = " ".join(str(entry.get("text", "")) for entry in user_turns).strip()
        user_word_count = len(_WORD_RE.findall(user_text))
        user_numeric_claim_signals = len(_NUMERIC_RE.findall(user_text))

        argument_strength = _clamp_score(3.5 + min(4.0, user_word_count / 45) + min(2.0, len(user_turns) * 0.5))

        disputed_count = len([record for record in factcheck_records if record.verdict in {"unsupported", "disputed"}])
        evidence_base = 5.0 + min(2.5, user_numeric_claim_signals * 0.2) - min(3.0, disputed_count * 1.0)
        evidence_quality = _clamp_score(evidence_base)

        turn_balance = min(len(user_turns), len(model_turns))
        responsiveness = _clamp_score(4.0 + min(4.0, turn_balance * 0.8) + (1.0 if len(model_turns) > 0 else 0.0))

        delivery = self._score_delivery(delivery_metrics)

        factual_accuracy = self._score_factual_accuracy(factcheck_records)

        cited_corrections = [
            ReportCorrection.model_validate(
                {
                    "claim": record.claim,
                    "claim_class": record.claim_class,
                    "verdict": record.verdict,
                    "corrected_fact": record.corrected_fact,
                    "short_explanation": record.short_explanation,
                    "citations": record.citations,
                    "confidence": record.confidence,
                    "interrupt_now": record.interrupt_now,
                    "interrupted_live": record.interrupted_live,
                }
            )
            for record in factcheck_records
            if record.verdict in {"unsupported", "disputed"}
        ]

        top_strengths = self._top_strengths(
            argument_strength=argument_strength,
            evidence_quality=evidence_quality,
            responsiveness=responsiveness,
            delivery=delivery,
            factual_accuracy=factual_accuracy,
            correction_count=len(cited_corrections),
        )

        top_issues = self._top_issues(
            evidence_quality=evidence_quality,
            delivery=delivery,
            factual_accuracy=factual_accuracy,
            correction_count=len(cited_corrections),
            delivery_metrics=delivery_metrics,
        )

        next_drills = self._next_drills(top_issues)

        coach_summary = (
            f"Strongest area: {max((argument_strength, 'argumentation'), (evidence_quality, 'evidence usage'), (responsiveness, 'responsiveness'), (delivery, 'delivery'), (factual_accuracy, 'factual accuracy'))[1]}; "
            f"next priority: {top_issues[0].lower() if top_issues else 'maintain consistency across argument and delivery'}."
        )

        return ReportRubric(
            argument_strength=argument_strength,
            evidence_quality=evidence_quality,
            responsiveness=responsiveness,
            delivery=delivery,
            factual_accuracy=factual_accuracy,
            top_strengths=top_strengths,
            top_issues=top_issues,
            cited_corrections=cited_corrections,
            next_drills=next_drills,
            one_sentence_coach_summary=coach_summary,
        )

    def _score_delivery(self, delivery_metrics: list[dict[str, Any]]) -> int:
        if not delivery_metrics:
            return 5

        values = [item.get("metrics", {}) for item in delivery_metrics if isinstance(item.get("metrics"), dict)]
        if not values:
            return 5

        def avg(key: str, default: float) -> float:
            numeric_values = [float(metrics[key]) for metrics in values if key in metrics and isinstance(metrics[key], (int, float))]
            return mean(numeric_values) if numeric_values else default

        eye_contact = avg("eye_contact_proxy", 0.5)
        filler_density = avg("filler_word_density", 0.08)
        slouch = avg("slouch_proxy", 0.35)
        pace = avg("speaking_pace_wpm", 135)
        pause_len = avg("average_pause_length_sec", 0.9)

        score = 5.0
        score += 2.0 * (eye_contact - 0.5)
        score += 1.5 * (0.12 - filler_density)
        score += 1.5 * (0.4 - slouch)

        pace_penalty = 0.0 if 105 <= pace <= 180 else 1.2
        pause_penalty = 0.0 if pause_len <= 1.6 else 0.8
        score -= pace_penalty + pause_penalty

        return _clamp_score(score)

    def _score_factual_accuracy(self, factcheck_records: list[RoundFactcheckRecord]) -> int:
        if not factcheck_records:
            return 7

        supported = len([record for record in factcheck_records if record.verdict == "supported"])
        disputed = len([record for record in factcheck_records if record.verdict in {"disputed", "unsupported"}])
        total = len(factcheck_records)

        accuracy_ratio = (supported - disputed * 0.6) / max(total, 1)
        return _clamp_score(6.5 + 3.0 * accuracy_ratio)

    def _top_strengths(
        self,
        argument_strength: int,
        evidence_quality: int,
        responsiveness: int,
        delivery: int,
        factual_accuracy: int,
        correction_count: int,
    ) -> list[str]:
        strengths: list[str] = []

        if argument_strength >= 7:
            strengths.append("Clear argument structure and coherent progression")
        if evidence_quality >= 7:
            strengths.append("Evidence usage was generally specific and relevant")
        if responsiveness >= 7:
            strengths.append("Good responsiveness to opponent turns")
        if delivery >= 7:
            strengths.append("Delivery metrics indicate stable pace and composure")
        if factual_accuracy >= 7 and correction_count == 0:
            strengths.append("No major factual corrections were required")

        if not strengths:
            strengths.append("Maintained continuous participation through the round")

        return strengths[:3]

    def _top_issues(
        self,
        evidence_quality: int,
        delivery: int,
        factual_accuracy: int,
        correction_count: int,
        delivery_metrics: list[dict[str, Any]],
    ) -> list[str]:
        issues: list[str] = []

        if evidence_quality <= 5:
            issues.append("Back key claims with more explicit evidence and source framing")
        if factual_accuracy <= 5 or correction_count > 0:
            issues.append("Several factual claims need stronger verification before use")
        if delivery <= 5:
            issues.append("Delivery consistency dropped (pace/posture/eye-contact variability)")

        if delivery_metrics:
            latest = delivery_metrics[-1].get("metrics", {}) if isinstance(delivery_metrics[-1], dict) else {}
            filler_density = latest.get("filler_word_density")
            if isinstance(filler_density, (int, float)) and filler_density > 0.08:
                issues.append("Filler density increased during critical argument segments")

        if not issues:
            issues.append("Increase specificity when citing studies, dates, and numeric claims")

        return issues[:3]

    def _next_drills(self, top_issues: list[str]) -> list[str]:
        drills: list[str] = []

        issue_blob = " ".join(top_issues).lower()
        if "factual" in issue_blob or "verification" in issue_blob:
            drills.append("Run a 60-second source-check pass before each major statistic")
        if "delivery" in issue_blob or "pace" in issue_blob or "eye-contact" in issue_blob:
            drills.append("Practice a 2-minute delivery drill with pace targets and posture resets")
        if "evidence" in issue_blob:
            drills.append("Use a claim-evidence-impact template for each rebuttal")
        if "filler" in issue_blob:
            drills.append("Record one round focusing on reducing filler words between claims")

        if not drills:
            drills.append("Rehearse concise rebuttal blocks with one verified source per claim")

        return drills[:4]
