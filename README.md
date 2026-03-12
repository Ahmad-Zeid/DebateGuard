# DebateGuard

DebateGuard is a live debate practice coach built for the Gemini Live Agent Challenge.

It combines:
- live voice debate with interruption support
- local webcam delivery analytics (MediaPipe in-browser)
- grounded factual corrections for narrow claim classes
- round-end rubric reporting with citations and drills
- Cloud Run + Firestore persistence

## Judge Quick Start (Fastest Path)

## Option A: Local demo (frontend + backend split)
```bash
bash scripts/local-dev.sh
```
Open `http://localhost:5173`.

## Option B: Cloud deploy (single Cloud Run service)
```bash
export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
export GOOGLE_CLOUD_LOCATION=us-central1
export SERVICE_NAME=debateguard
bash scripts/deploy.sh
```
Open the Cloud Run URL printed by the script.

## Deterministic Demo Tip
- In the UI, enable `Demo mode` before starting a round.
- In local/mock transport mode, the first user transcript is seeded to trigger a deterministic fact-check correction path.
- For cloud/Vertex mode, say the seeded claim verbatim from `docs/demo-script.md`.

## Architecture
- Diagram source: `docs/architecture.mmd`
- Render instructions: `docs/architecture-render.md`
- Cloud proof checklist: `docs/cloud-proof-checklist.md`

### Diagram highlights
- Browser frontend (React SPA)
- Local MediaPipe Face/Pose path in-browser
- WebSocket backend on FastAPI (`/ws/live`)
- Vertex AI Gemini Live API bridge
- Grounded fact-check model call (Gemini + Google Search grounding)
- Firestore persistence (`sessions`, `rounds`, `claims`, `reports`)
- Single Cloud Run service hosting frontend + backend

## Stack
- Frontend: React + TypeScript + Vite + Tailwind
- Backend: Python 3.11 + FastAPI + uvicorn + pytest
- Infra: Terraform + Google Cloud Run + Firestore
- AI SDK: Google GenAI SDK (Vertex mode in production)

## Repo Layout
- `frontend/` React app
- `backend/` FastAPI app + websocket live bridge
- `infra/terraform/` infra provisioning
- `scripts/deploy.sh` scripted Cloud deploy path
- `scripts/local-dev.sh` local dev runner
- `.github/workflows/ci.yml` tests + container build
- `.github/workflows/deploy-template.yml` manual deploy workflow template
- `docs/` architecture, demo script, judging checklist, cloud proof checklist

## Environment Variables

Backend runtime env vars (Cloud Run):
- `GOOGLE_GENAI_USE_VERTEXAI=true`
- `GOOGLE_CLOUD_PROJECT=<project-id>`
- `GOOGLE_CLOUD_LOCATION=<region>`
- `LIVE_MODEL=gemini-live-2.5-flash-preview`
- `FACTCHECK_MODEL=gemini-2.5-flash`
- `FIRESTORE_DATABASE=(default)`
- `APP_ENV=prod`
- `DEBUG_SAVE_MEDIA=false`

Local env examples:
- `backend/.env.example`
- `frontend/.env.example`

## Local Development

### Prerequisites
- Python 3.11+
- Node 20+
- npm

### Run backend manually
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

### Run frontend manually
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Set `VITE_API_BASE_URL=http://localhost:8000` for split local run.

## Cloud Deployment (Concrete)

## 1) gcloud setup
```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
gcloud config set run/region us-central1

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  datastore.googleapis.com \
  aiplatform.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com
```

## 2) Scripted deploy (recommended)
```bash
export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
export GOOGLE_CLOUD_LOCATION=us-central1
export SERVICE_NAME=debateguard
bash scripts/deploy.sh
```

Useful optional exports:
```bash
export LIVE_MODEL=gemini-live-2.5-flash-preview
export FACTCHECK_MODEL=gemini-2.5-flash
export FIRESTORE_DATABASE='(default)'
export CREATE_FIRESTORE_DATABASE=false
export ALLOW_UNAUTHENTICATED=true
export DEPLOYER_MEMBER='serviceAccount:github-actions-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com'
```

## 3) Terraform path
```bash
# build image first
gcloud builds submit . \
  --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/debateguard/debateguard:latest

cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# edit values
terraform init
terraform plan
terraform apply
```

## 4) Verify deployment
```bash
gcloud run services describe debateguard --region us-central1 --format='value(status.url)'
curl -s https://YOUR_SERVICE_URL/api/health
```

## Testing and Build

## Backend
```bash
cd backend
pytest
```

## Frontend
```bash
cd frontend
npm run check
npm run build
npm test
```

## Full container
```bash
docker build -t debateguard-local .
```

## Judge Demo Assets
- Script: `docs/demo-script.md`
- Criteria checklist: `docs/judging-checklist.md`
- Cloud proof capture list: `docs/cloud-proof-checklist.md`
- Screenshot/GIF guide + placeholders: `docs/media/screenshots/README.md`

Preview placeholders:
- `docs/media/screenshots/01-live-round-placeholder.svg`
- `docs/media/screenshots/02-factcheck-alert-placeholder.svg`
- `docs/media/screenshots/03-round-report-placeholder.svg`
- `docs/media/screenshots/04-cloud-proof-placeholder.svg`

## Troubleshooting

### Cloud Run revision fails to start
```bash
gcloud run services logs read debateguard --region us-central1 --limit 200
```
Ensure app binds to `PORT` (already handled in Docker CMD).

### 403 calling Vertex AI or Firestore
Verify runtime SA roles:
- `roles/aiplatform.user`
- `roles/datastore.user`

```bash
gcloud projects get-iam-policy YOUR_PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:debateguard-run-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --format="table(bindings.role, bindings.members)"
```

### Firestore DB missing
```bash
gcloud firestore databases list
gcloud firestore databases create --database='(default)' --location=nam5 --type=firestore-native
```
