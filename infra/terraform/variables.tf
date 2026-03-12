variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "region" {
  description = "Cloud Run region"
  type        = string
  default     = "us-central1"
}

variable "service_name" {
  description = "Cloud Run service name"
  type        = string
  default     = "debateguard"
}

variable "container_image" {
  description = "Full container image URI to deploy"
  type        = string
}

variable "runtime_service_account_id" {
  description = "Account ID (not email) for Cloud Run runtime service account"
  type        = string
  default     = "debateguard-run-sa"
}

variable "allow_unauthenticated" {
  description = "If true, internet clients can invoke the service"
  type        = bool
  default     = true
}

variable "create_firestore_database" {
  description = "Create Firestore database if one does not already exist"
  type        = bool
  default     = false
}

variable "firestore_location" {
  description = "Firestore location (for example nam5)"
  type        = string
  default     = "nam5"
}

variable "firestore_database" {
  description = "Firestore database ID"
  type        = string
  default     = "(default)"
}

variable "live_model" {
  description = "Gemini Live model name"
  type        = string
  default     = "gemini-live-2.5-flash-preview"
}

variable "factcheck_model" {
  description = "Gemini text model for fact checking"
  type        = string
  default     = "gemini-2.5-flash"
}

variable "min_instance_count" {
  description = "Minimum Cloud Run instances"
  type        = number
  default     = 0
}

variable "max_instance_count" {
  description = "Maximum Cloud Run instances"
  type        = number
  default     = 3
}

variable "container_cpu" {
  description = "CPU limit for Cloud Run container"
  type        = string
  default     = "1"
}

variable "container_memory" {
  description = "Memory limit for Cloud Run container"
  type        = string
  default     = "1Gi"
}

variable "request_timeout_seconds" {
  description = "Request timeout in seconds"
  type        = number
  default     = 300
}

variable "additional_env_vars" {
  description = "Additional plain-text environment variables for the service"
  type        = map(string)
  default     = {}
}

variable "deployer_member" {
  description = "Optional IAM principal (for example serviceAccount:ci@project.iam.gserviceaccount.com) that can deploy and act as runtime SA"
  type        = string
  default     = ""
}
