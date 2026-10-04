terraform {
  backend "gcs" {
    bucket = "deckastra-terraform-state"
    prefix = "development"
  }
}
