# Cloud Proof Checklist (Hackathon Recording)

Use this checklist while screen recording so judges can verify real Google Cloud usage.

## A. Before recording (prep)
1. Confirm project and account:
```bash
gcloud config list project
gcloud auth list
```
2. Confirm required APIs enabled:
```bash
gcloud services list --enabled --filter="name:(run.googleapis.com OR firestore.googleapis.com OR aiplatform.googleapis.com OR cloudbuild.googleapis.com OR artifactregistry.googleapis.com OR datastore.googleapis.com)"
```
3. Confirm service is deployed:
```bash
gcloud run services describe debateguard --region us-central1 --format="value(status.url,spec.template.spec.serviceAccountName)"
```
4. Confirm Firestore database exists:
```bash
gcloud firestore databases list
```

## B. What to show in the recording
1. Cloud Run service details page in GCP Console:
- Service name (`debateguard` or your configured name)
- Region
- URL
- Latest revision
2. Cloud Run revision environment variables:
- `GOOGLE_GENAI_USE_VERTEXAI=true`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION`
- `LIVE_MODEL`
- `FACTCHECK_MODEL`
- `FIRESTORE_DATABASE`
3. Runtime service account and IAM roles:
- show service account email
- show roles include:
  - `roles/aiplatform.user`
  - `roles/datastore.user`
4. Live app run from Cloud Run URL:
- open the deployed URL in browser
- start a debate round
- show transcript updates and at least one model response
- show fact-check alert (if triggered)
- show round report UI
5. Firestore persistence proof in Console:
- open Firestore Data
- show documents being created/updated in collections:
  - `sessions`
  - `rounds`
  - `claims`
  - `reports`
6. Cloud logging proof:
- open Cloud Run logs
- show requests during live demo window (timestamps visible)

## C. Optional CLI proof snippets to capture
Run these in terminal during or right after demo:

```bash
# URL + revision + runtime SA
gcloud run services describe debateguard --region us-central1 \
  --format="yaml(status.url,status.latestReadyRevisionName,spec.template.spec.serviceAccountName)"

# Recent Cloud Run logs
gcloud run services logs read debateguard --region us-central1 --limit 50

# Firestore collections snapshot (high-level)
gcloud firestore databases list
```

## D. Final upload package recommendation
Include:
1. Screen recording video (single uninterrupted run preferred)
2. 3-5 screenshots:
- Cloud Run service details
- Revision env vars
- Service account IAM roles
- Firestore collections/documents
- Cloud logs
3. Short text note with:
- project ID
- Cloud Run URL
- region
- commit hash / timestamp of demo build

