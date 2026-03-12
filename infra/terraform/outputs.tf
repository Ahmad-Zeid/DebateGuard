output "cloud_run_service_url" {
  description = "Public URL of the Cloud Run service"
  value       = google_cloud_run_v2_service.app.uri
}

output "runtime_service_account_email" {
  description = "Runtime service account email"
  value       = google_service_account.run_runtime.email
}

output "runtime_service_account_name" {
  description = "Runtime service account resource name"
  value       = google_service_account.run_runtime.name
}

output "project_id" {
  description = "Project used by this stack"
  value       = var.project_id
}
