# DebateGuard - project brief

## One sentence
DebateGuard is a live debate practice coach that listens to spoken arguments, watches delivery cues from the webcam, fact-checks high-confidence claims in near real time using Google Search grounding, and delivers personalized coaching between rounds.

## Product goal
Build a hackathon-ready v1 for the Gemini Live Agent Challenge that is reliable, demoable, and clearly multimodal.

## Scope for v1
1. Live voice debate round with interruptible Gemini opponent
2. Browser webcam analysis for delivery metrics
3. Real-time fact-checking for a narrow class of factual claims only
4. One live correction max per round
5. End-of-round rubric with citations and drills
6. Cloud Run deployment with Firestore persistence
7. Terraform or deploy scripts for bonus points

## Hard non-goals
- No full 30fps video streaming into Live API
- No continuous raw video storage by default
- No broad truth engine that fact-checks opinions or predictions
- No complicated multi-user auth in v1
- No mobile app in v1
- No ADK migration in v1 unless the base system is already stable

## Recommended stack
- Frontend: React + TypeScript + Vite
- Styling: Tailwind
- Frontend state: Zustand or React context
- Browser media: Web Audio API + MediaDevices + AudioWorklet
- Local webcam analytics: MediaPipe Pose + Face Landmarker
- Backend: Python 3.11 + FastAPI + uvicorn
- Live model transport: google-genai SDK to Vertex AI Live API over WebSockets
- Fact checking: Gemini text model with Google Search grounding
- Data store: Firestore
- Deployment: Cloud Run
- Infra as code: Terraform
- Tests: pytest for backend, Playwright for frontend smoke tests

## Why this architecture
- We need a backend on Google Cloud for hackathon requirements and proof
- We want tight control over fact-check policy and report generation
- Live API only accepts sparse JPEG image input, so local webcam analytics must be separate from Live API
- Browser-side MediaPipe reduces latency and avoids shipping unnecessary video frames to the backend

## Monorepo structure
/
  frontend/
  backend/
  infra/
  docs/
  scripts/
  .github/workflows/
  README.md
  DOCS_MANIFEST.md
  HACKATHON_REQUIREMENTS.md
  PROJECT_BRIEF.md
  ACCEPTANCE_TESTS.md

## UX flow
1. User opens app, grants mic + webcam permissions
2. User chooses topic, stance, round length, and difficulty
3. User starts round
4. User speaks opening statement
5. Backend streams user audio to Live API and returns live model audio/text
6. Frontend runs MediaPipe locally and sends only aggregate delivery metrics plus sparse JPEG snapshots to backend
7. Backend monitors transcript segments for factual claim candidates
8. Fact-check worker uses Gemini + Google Search grounding on narrow claim classes
9. If confidence is very high and claim is safely verifiable, system interrupts once with a correction
10. At round end, backend generates a coaching rubric and stores report
11. UI shows scores, factual corrections, evidence links, and next drills

## Detailed system design

### Frontend responsibilities
- Capture microphone audio
- Resample to 16kHz PCM mono 16-bit little-endian
- Send audio chunks every 20-100ms over websocket to backend
- Capture webcam frames for local MediaPipe analysis at 10-15fps
- Send MediaPipe aggregate metrics every 2 seconds
- Send sparse JPEG snapshot to backend at max 1 fps for Live API visual context
- Play model audio streamed back from backend
- Show transcript, fact-check notices, rubric, citations, and debug panel
- Provide a deterministic demo mode with seeded debate topics

### Backend responsibilities
- Create and manage one Live API session per user session
- Bridge frontend websocket events to Vertex AI Live API
- Maintain session transcript and timestamps
- Run claim detection on completed transcript segments
- Call grounded Gemini text model for fact-checking
- Enforce fact-check interruption policy:
  - interrupt only for numeric/date/entity/study claims
  - interrupt only if confidence >= 0.90
  - max one interruption per round
- Generate end-of-round rubric as structured JSON
- Persist sessions, rounds, claims, and reports to Firestore
- Serve built frontend from the same Cloud Run service if convenient

### Live event protocol between frontend and backend
Client -> backend event types:
- session.start
- audio.chunk
- video.snapshot
- metrics.delivery
- round.stop
- ping

Backend -> client event types:
- session.ready
- transcript.partial
- transcript.final
- model.audio.chunk
- model.text.delta
- factcheck.alert
- round.report
- error

### Fact-check subsystem
- Claim detector should only extract candidates from final transcript segments
- Candidate classes:
  - percentages
  - counts
  - rankings
  - named events with dates
  - “study/statistic/report says” claims
- Grounded verification output schema:
  - claim
  - verdict: supported | disputed | unsupported | not-checkable
  - corrected_fact
  - short_explanation
  - citations[]
  - confidence
  - interrupt_now
- If interrupt_now is false, include the issue only in the round report

### Delivery analytics subsystem
Use browser-local MediaPipe outputs to compute:
- eye contact proxy
- head turn frequency
- slouch / shoulder tilt proxy
- speaking pace
- average pause length
- filler word density
- interruption recovery
Store aggregates, not raw media, by default.

### Rubric JSON schema
- argument_strength: 1-10
- evidence_quality: 1-10
- responsiveness: 1-10
- delivery: 1-10
- factual_accuracy: 1-10
- top_strengths: string[]
- top_issues: string[]
- cited_corrections: object[]
- next_drills: string[]
- one_sentence_coach_summary: string

## Data model
Firestore collections:
- sessions
- rounds
- claims
- reports

Minimal fields:
sessions/{sessionId}
- createdAt
- topic
- stance
- difficulty
- userLabel

rounds/{roundId}
- sessionId
- startedAt
- endedAt
- transcript
- deliveryMetrics
- interruptionCount

claims/{claimId}
- roundId
- claim
- verdict
- correctedFact
- citations
- confidence
- interruptedLive

reports/{reportId}
- roundId
- rubric
- generatedAt

## Environment variables
- GOOGLE_CLOUD_PROJECT
- GOOGLE_CLOUD_LOCATION
- GOOGLE_GENAI_USE_VERTEXAI=true
- LIVE_MODEL
- FACTCHECK_MODEL
- FIRESTORE_DATABASE
- APP_ENV
- DEBUG_SAVE_MEDIA=false

## Required docs/output artifacts in repo
- README with exact local and cloud run instructions
- docs/architecture.mmd and rendered SVG/PNG
- docs/demo-script.md
- docs/judging-checklist.md
- infra/terraform/*
- scripts/deploy.sh
- scripts/local-dev.sh

## Quality bar
- App starts locally with one command per service
- Cloud Run deploy works
- Debate round works with barge-in
- Fact-check fires on at least one seeded false stat in demo mode
- End-of-round rubric appears with citations
- Repo is readable, reproducible, and judged-friendly