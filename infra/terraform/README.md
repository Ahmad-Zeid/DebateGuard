# DebateGuard Terraform (Cloud Run + Firestore)

This Terraform stack provisions a production-ready baseline for DebateGuard on Google Cloud.

## What it creates
- Required API enablement:
  - `run.googleapis.com`
  - `artifactregistry.googleapis.com`
  - `cloudbuild.googleapis.com`
  - `firestore.googleapis.com`
  - `datastore.googleapis.com`
  - `aiplatform.googleapis.com`
  - `iam.googleapis.com`
  - `iamcredentials.googleapis.com`
- Cloud Run runtime service account
- Runtime IAM:
  - `roles/aiplatform.user` (Vertex AI)
  - `roles/datastore.user` (Firestore read/write)
- Cloud Run v2 service for the **single-container full app** (backend + built frontend)
- Optional public invoker binding (`allUsers`) when `allow_unauthenticated=true`
- Optional Firestore database creation (`create_firestore_database=true`)
- Optional deployer principal IAM (`deployer_member`) for CI/human deployers

## Prerequisites
- Terraform >= 1.5
- `gcloud` CLI installed and authenticated
- Artifact Registry + Cloud Build access in target project
- A pushed container image URI for `container_image`

## Quick start

1. Bootstrap project services:
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

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

2. Build and push the full app image from repo root:
```bash
gcloud artifacts repositories create debateguard \
  --repository-format=docker \
  --location=us-central1 \
  --description="DebateGuard container images" || true

gcloud builds submit . \
  --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/debateguard/debateguard:latest
```

3. Configure Terraform:
```bash
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars with your project/image values
```

4. Apply:
```bash
terraform init
terraform plan
terraform apply
```

5. Verify outputs:
```bash
terraform output cloud_run_service_url
terraform output runtime_service_account_email
```

## Notes
- Firestore default database can only be created once per project/region choice. If already initialized, keep `create_firestore_database=false`.
- For CI deployments, set `deployer_member` to your CI principal (for example GitHub Actions deploy service account).
