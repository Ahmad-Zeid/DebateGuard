#!/usr/bin/env bash
set -euo pipefail

: "${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT first}"

REGION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-debateguard}"
IMAGE_REPO="${IMAGE_REPO:-debateguard}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
IMAGE_URI="${REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/${IMAGE_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"

RUNTIME_SA_ID="${RUNTIME_SERVICE_ACCOUNT_ID:-debateguard-run-sa}"
RUNTIME_SA_EMAIL="${RUNTIME_SA_ID}@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"

ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-true}"
CREATE_FIRESTORE_DATABASE="${CREATE_FIRESTORE_DATABASE:-false}"
FIRESTORE_DATABASE="${FIRESTORE_DATABASE:-(default)}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"

LIVE_MODEL="${LIVE_MODEL:-gemini-live-2.5-flash-preview}"
FACTCHECK_MODEL="${FACTCHECK_MODEL:-gemini-2.5-flash}"
DEPLOYER_MEMBER="${DEPLOYER_MEMBER:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required but not installed." >&2
  exit 1
fi

echo "Using project: ${GOOGLE_CLOUD_PROJECT}"
echo "Using region:  ${REGION}"

gcloud config set project "$GOOGLE_CLOUD_PROJECT" >/dev/null

echo "Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  datastore.googleapis.com \
  aiplatform.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com

echo "Ensuring Artifact Registry repository exists..."
if ! gcloud artifacts repositories describe "$IMAGE_REPO" --location "$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$IMAGE_REPO" \
    --repository-format docker \
    --location "$REGION" \
    --description "DebateGuard images"
fi

echo "Ensuring runtime service account exists..."
if ! gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$RUNTIME_SA_ID" \
    --display-name "DebateGuard Cloud Run Runtime"
fi

echo "Granting runtime service account permissions..."
for role in roles/aiplatform.user roles/datastore.user; do
  gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" \
    --member "serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role "$role" >/dev/null
done

if [[ -n "$DEPLOYER_MEMBER" ]]; then
  echo "Granting deployer permissions to ${DEPLOYER_MEMBER}..."
  for role in roles/run.admin roles/artifactregistry.writer roles/cloudbuild.builds.editor; do
    gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" \
      --member "$DEPLOYER_MEMBER" \
      --role "$role" >/dev/null
  done

  gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA_EMAIL" \
    --member "$DEPLOYER_MEMBER" \
    --role roles/iam.serviceAccountUser >/dev/null
fi

if [[ "$CREATE_FIRESTORE_DATABASE" == "true" ]]; then
  echo "Ensuring Firestore database ${FIRESTORE_DATABASE} exists..."
  if ! gcloud firestore databases describe --database="$FIRESTORE_DATABASE" >/dev/null 2>&1; then
    gcloud firestore databases create \
      --database="$FIRESTORE_DATABASE" \
      --location="$FIRESTORE_LOCATION" \
      --type=firestore-native
  fi
fi

echo "Building and pushing full app image: ${IMAGE_URI}"
gcloud builds submit . --tag "$IMAGE_URI"

if [[ "$ALLOW_UNAUTHENTICATED" == "true" ]]; then
  INVOKER_FLAG="--allow-unauthenticated"
else
  INVOKER_FLAG="--no-allow-unauthenticated"
fi

echo "Deploying Cloud Run service ${SERVICE_NAME}..."
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --service-account "$RUNTIME_SA_EMAIL" \
  --port 8080 \
  $INVOKER_FLAG \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT},GOOGLE_CLOUD_LOCATION=${REGION},GOOGLE_GENAI_USE_VERTEXAI=true,LIVE_MODEL=${LIVE_MODEL},FACTCHECK_MODEL=${FACTCHECK_MODEL},FIRESTORE_DATABASE=${FIRESTORE_DATABASE},APP_ENV=prod,DEBUG_SAVE_MEDIA=false"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')"

echo ""
echo "Deployment complete."
echo "Service URL: ${SERVICE_URL}"
echo "Image:       ${IMAGE_URI}"
echo "Runtime SA:  ${RUNTIME_SA_EMAIL}"
