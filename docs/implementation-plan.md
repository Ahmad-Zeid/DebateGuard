# DebateGuard Implementation Plan (Scaffold Phase)

## Scope statement
This document captures constraints from the official docs listed in `DOCS_MANIFEST.md` and translates them into implementation rules for DebateGuard v1.

No business logic is implemented in this phase. This is architecture and scaffold planning only.

## Non-negotiable technical constraints
1. Live audio input/output specs (Gemini Live API)
- Input audio to Live API: `raw 16-bit PCM`, `16kHz`, mono.
- Output audio from Live API: `raw 16-bit PCM`, `24kHz`, mono.
- Implementation impact: browser audio pipeline must resample mic audio to 16kHz PCM before streaming.

2. Small audio chunks
- Official best practices recommend sending audio in small chunks (`20-40ms`) for lower latency.
- Implementation impact: frontend AudioWorklet emits chunked frames; websocket client batches into <=100ms max payloads.

3. Sparse image snapshots only
- Live API video input guidance: send high-quality JPEG frames at `1 FPS`.
- Live API is not a full CV pipeline; do not stream dense raw video.
- Implementation impact: send sparse `video.snapshot` events only, capped at 1 FPS.

4. Local MediaPipe analysis
- MediaPipe Pose/Face Landmarker supports browser-side processing and `VIDEO`/live mode.
- `detect()` / `detectForVideo()` calls are synchronous and can block if misused.
- Implementation impact: run MediaPipe locally in browser loop and send aggregate delivery metrics every 2 seconds; never store raw video by default.

5. Live interruption guardrail
- Product rule from brief/acceptance: maximum one live fact correction per round.
- Implementation impact: backend policy gate enforces `interruption_count <= 1` and only for high-confidence factual classes.

6. Cloud Run deployment
- Challenge and Cloud docs require hosted backend on Google Cloud.
- Cloud Run deployment path must be reproducible via script and/or Terraform.
- Implementation impact: backend containerized for Cloud Run (`port 8080`) with deployment scripts.

7. Firestore persistence
- DebateGuard v1 data persistence target is Firestore (`sessions`, `rounds`, `claims`, `reports`).
- Implementation impact: backend storage abstraction should default to Firestore in cloud environments.

8. Infrastructure-as-code / scripted deploy bonus
- Bonus criteria includes automated cloud deployment (scripted and/or IaC).
- Implementation impact: maintain both `scripts/deploy.sh` and `infra/terraform/` track.

## Additional official-doc constraints
- Use Google GenAI SDK for Live API and grounded generation.
- Use Google Search tool for factual grounding and capture grounding metadata/citations.
- Keep realtime session handling over WebSockets.
- Ensure authentication/project setup via `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and Vertex AI mode.

## Implementation phases
1. Phase 0: Scaffold (current)
- Monorepo structure, starter apps, env templates, docs, scripts, CI baseline.

2. Phase 1: Live transport foundation
- WebSocket gateway.
- Frontend mic capture/resample/chunk streaming.
- Backend bridge to Vertex Live API.
- Real-time transcript + model audio playback.

3. Phase 2: Delivery analytics + snapshot path
- Browser MediaPipe integration for delivery metrics.
- Sparse JPEG snapshot transport (<=1 FPS).
- UI debug panel for metrics and stream health.

4. Phase 3: Fact-check policy engine
- Claim detection on finalized transcript segments.
- Grounded verification via Gemini + Google Search tool.
- One-interruption-max enforcement.

5. Phase 4: End-of-round coaching report
- Rubric JSON generation.
- Firestore persistence across session/round/claim/report docs.
- Report UI with citations and drills.

6. Phase 5: Production hardening for submission
- Retry/reconnect handling.
- Logging and error surface quality.
- Demo-mode deterministic seed path.
- Final README and demo video packaging.

## Source references (official docs)
- Gemini Live API: https://ai.google.dev/gemini-api/docs/live-api
- Vertex Live API SDK start: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/get-started-sdk
- Vertex Live API best practices: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/best-practices
- Google Search grounding: https://ai.google.dev/gemini-api/docs/google-search
- MediaPipe Pose Landmarker: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
- MediaPipe Face Landmarker (Web): https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js
- Cloud Run FastAPI deployment: https://docs.cloud.google.com/run/docs/quickstarts/build-and-deploy/deploy-python-fastapi-service
- Gemini Live Agent Challenge rules/resources:
  - https://geminiliveagentchallenge.devpost.com/resources
  - https://geminiliveagentchallenge.devpost.com/rules

