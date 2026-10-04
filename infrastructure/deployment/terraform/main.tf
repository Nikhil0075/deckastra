terraform {
  required_version = ">= 1.5, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = "asia-south1"
}

# The first deployment was provisioned manually. Import blocks adopt its exact
# configuration. Secret versions and database passwords are never Terraform inputs.

variable "project_id" {
  type    = string
  default = "deckastra"
  validation {
    condition     = contains(["deckastra", "deckastra-prod"], var.project_id)
    error_message = "Select an existing Deckastra project."
  }
}
