locals {
  required_services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "firestore.googleapis.com",
    "datastore.googleapis.com",
    "aiplatform.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com"
  ]

  runtime_project_roles = {
    vertex_access    = "roles/aiplatform.user"
    firestore_access = "roles/datastore.user"
  }

  deployer_project_roles = var.deployer_member == "" ? toset([]) : toset([
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/cloudbuild.builds.editor"
  ])
}

resource "google_project_service" "required" {
  for_each           = toset(local.required_services)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "run_runtime" {
  project      = var.project_id
  account_id   = var.runtime_service_account_id
  display_name = "DebateGuard Cloud Run Runtime"

  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "runtime_permissions" {
  for_each = local.runtime_project_roles
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.run_runtime.email}"
}

resource "google_project_iam_member" "deployer_project_roles" {
  for_each = local.deployer_project_roles
  project  = var.project_id
  role     = each.value
  member   = var.deployer_member
}

resource "google_service_account_iam_member" "deployer_service_account_user" {
  count              = var.deployer_member == "" ? 0 : 1
  service_account_id = google_service_account.run_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = var.deployer_member
}

resource "google_firestore_database" "default" {
  count       = var.create_firestore_database ? 1 : 0
  project     = var.project_id
  name        = var.firestore_database
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service" "app" {
  project  = var.project_id
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.run_runtime.email
    timeout         = "${var.request_timeout_seconds}s"

    scaling {
      min_instance_count = var.min_instance_count
      max_instance_count = var.max_instance_count
    }

    containers {
      image = var.container_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.container_cpu
          memory = var.container_memory
        }
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }

      env {
        name  = "GOOGLE_GENAI_USE_VERTEXAI"
        value = "true"
      }

      env {
        name  = "FIRESTORE_DATABASE"
        value = var.firestore_database
      }

      env {
        name  = "APP_ENV"
        value = "prod"
      }

      env {
        name  = "DEBUG_SAVE_MEDIA"
        value = "false"
      }

      env {
        name  = "LIVE_MODEL"
        value = var.live_model
      }

      env {
        name  = "FACTCHECK_MODEL"
        value = var.factcheck_model
      }

      dynamic "env" {
        for_each = var.additional_env_vars
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  traffic {
    percent = 100
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
  }

  deletion_protection = false

  depends_on = [
    google_project_service.required,
    google_project_iam_member.runtime_permissions,
    google_firestore_database.default,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.allow_unauthenticated ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
