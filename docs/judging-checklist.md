# Judging Checklist (Mapped to Official Criteria)

Use this checklist before submitting your final demo/video package.

## Stage 1 Eligibility (Pass/Fail)
- [ ] New next-generation AI agent experience (not a basic wrapper).
- [ ] Multimodal input/output beyond text-only interaction.
- [ ] Uses Gemini Live API or ADK (this project uses Gemini Live API).
- [ ] Hosted on Google Cloud.
- [ ] Uses a Gemini model.
- [ ] Built with Google GenAI SDK or ADK.
- [ ] Uses at least one Google Cloud service beyond model calls (Firestore).

## Stage 2 Weighted Judging Criteria

### 1) Technical Implementation & Performance (30%)
- [ ] Live websocket round runs end-to-end with transcript + model audio.
- [ ] Audio chunking is low-latency (20-100ms chunks, 16k PCM).
- [ ] User interruption / barge-in works reliably.
- [ ] Fact-check pipeline runs on final transcript segments only.
- [ ] Round report JSON is generated and rendered without schema errors.
- [ ] Error handling/logging is visible and stable in demo.

### 2) Agent Design (25%)
- [ ] Agent behavior is coherent: debate, rebuttal, correction, summary.
- [ ] Multimodal interaction is meaningful (voice + local delivery analytics + live model audio).
- [ ] Interruption policy is explicit and enforced (max one live correction per round).
- [ ] Fact-check claims are narrow and measurable (numeric/date/ranking/event/study classes).

### 3) Potential Impact (25%)
- [ ] Problem statement is clear and real (debate coaching + factual reliability).
- [ ] Demo shows practical value for users (actionable corrections + next drills).
- [ ] Session history shows repeated-use value across rounds.

### 4) Responsible AI (10%)
- [ ] No emotion-reading claims.
- [ ] Correction behavior is confidence-gated and citation-backed.
- [ ] Privacy note shown: webcam landmarks processed locally; raw video not stored by default.
- [ ] Uncertain claims are deferred to round report rather than live interruption.

### 5) Demo & Presentation (10%)
- [ ] Demo video is under 4 minutes.
- [ ] Real software in real time (no mockups).
- [ ] Includes seeded false-stat correction moment with citations.
- [ ] Includes Cloud Run + Firestore proof cutaway.

## Submission Completeness
- [ ] Public repository is accessible.
- [ ] README has exact local + cloud reproduction steps.
- [ ] Architecture diagram included (`docs/architecture.mmd`).
- [ ] Demo script included (`docs/demo-script.md`).
- [ ] Cloud proof checklist included (`docs/cloud-proof-checklist.md`).
- [ ] Terraform path and script deploy path both present.

## Bonus Alignment
- [ ] Deployment automation via Terraform and/or script is working.
- [ ] Optional build write-up/content included if desired.
