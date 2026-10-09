# __generated__ by Terraform
# Please review these resources and move them into your main configuration files.

# __generated__ by Terraform
resource "google_sql_database_instance" "database" {
  backupdr_backup                                  = null
  database_version                                 = "POSTGRES_16"
  deletion_policy                                  = "DELETE"
  deletion_protection                              = true
  enforce_new_sql_network_architecture             = true
  final_backup_description                         = null
  include_replicas_for_major_version_upgrade       = null
  instance_type                                    = "CLOUD_SQL_INSTANCE"
  maintenance_version                              = "POSTGRES_16_15.R20260712.01_31"
  name                                             = "deckastra-postgres"
  node_count                                       = 0
  project                                          = var.project_id
  region                                           = "asia-south1"
  replica_names                                    = []
  root_password                                    = null # sensitive
  root_password_wo                                 = null
  root_password_wo_version                         = null
  switch_transaction_logs_to_cloud_storage_enabled = null
  replication_cluster {
    failover_dr_replica_name = null
  }
  settings {
    activation_policy                = "ALWAYS"
    auto_upgrade_enabled             = false
    availability_type                = "ZONAL"
    collation                        = null
    connector_enforcement            = "NOT_REQUIRED"
    data_disk_provisioned_iops       = 0
    data_disk_provisioned_throughput = 0
    deletion_protection_enabled      = false
    disk_autoresize                  = true
    disk_autoresize_limit            = 0
    disk_size                        = 10
    disk_type                        = "PD_SSD"
    edition                          = "ENTERPRISE"
    enable_dataplex_integration      = true
    enable_google_ml_integration     = false
    pricing_plan                     = "PER_USE"
    replication_lag_max_seconds      = 31536000
    retain_backups_on_delete         = false
    tier                             = "db-custom-1-3840"
    time_zone                        = null
    user_labels                      = {}
    backup_configuration {
      binary_log_enabled             = false
      enabled                        = true
      location                       = null
      point_in_time_recovery_enabled = true
      start_time                     = "20:00"
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }
    data_cache_config {
      data_cache_enabled = false
    }
    ip_configuration {
      allocated_ip_range                            = null
      custom_subject_alternative_names              = []
      enable_private_path_for_google_cloud_services = false
      ipv4_enabled                                  = true
      private_network                               = null
      server_ca_mode                                = "GOOGLE_MANAGED_INTERNAL_CA"
      server_ca_pool                                = null
      ssl_mode                                      = "ALLOW_UNENCRYPTED_AND_ENCRYPTED"
    }
    location_preference {
      follow_gae_application = null
      secondary_zone         = null
      zone                   = "asia-south1-c"
    }
  }
}

# __generated__ by Terraform from "projects/deckastra/locations/asia-south1/services/deckastra-export-worker"
resource "google_cloud_run_v2_service" "export_worker" {
  # bootstrap.py and GitHub Actions own runtime revisions and traffic.
  lifecycle { ignore_changes = [template, client, client_version, traffic] }
  annotations          = {}
  client               = "gcloud"
  client_version       = "573.0.0"
  custom_audiences     = []
  default_uri_disabled = false
  deletion_policy      = "DELETE"
  deletion_protection  = true
  description          = null
  iap_enabled          = false
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  labels               = {}
  launch_stage         = "GA"
  location             = "asia-south1"
  name                 = "deckastra-export-worker"
  project              = var.project_id
  tags                 = null
  scaling {
    manual_instance_count = 0
    max_instance_count    = 20
    min_instance_count    = 0
    scaling_mode          = null
  }
  template {
    annotations                      = {}
    encryption_key                   = null
    execution_environment            = null
    gpu_zonal_redundancy_disabled    = false
    health_check_disabled            = false
    labels                           = {}
    max_instance_request_concurrency = 1
    revision                         = null
    service_account                  = "deckastra-export-worker@${var.project_id}.iam.gserviceaccount.com"
    session_affinity                 = false
    timeout                          = "300s"
    containers {
      args             = []
      base_image_uri   = null
      command          = []
      depends_on       = []
      image            = "asia-south1-docker.pkg.dev/${var.project_id}/deckastra/export-worker:backend-20261004-r3"
      name             = null
      sandbox_launcher = false
      working_dir      = null
      env {
        name  = "DATABASE_URL"
        value = null
        value_source {
          secret_key_ref {
            secret  = "deckastra-database-url"
            version = "latest"
          }
        }
      }
      env {
        name  = "DECKASTRA_GCS_ASSETS_BUCKET"
        value = "${var.project_id}-assets"
      }
      env {
        name  = "DECKASTRA_GCS_EXPORTS_BUCKET"
        value = "${var.project_id}-exports"
      }
      env {
        name  = "DECKASTRA_SERVICE"
        value = "export-worker"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = "deckastra"
      }
      ports {
        container_port = 8080
        name           = "http1"
      }
      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "2Gi"
        }
        startup_cpu_boost = true
      }
      startup_probe {
        failure_threshold     = 1
        initial_delay_seconds = 0
        period_seconds        = 240
        timeout_seconds       = 240
        tcp_socket {
          port = 8080
        }
      }
      volume_mounts {
        mount_path = "/cloudsql"
        name       = "cloudsql"
        sub_path   = null
      }
    }
    scaling {
      max_instance_count = 1
      min_instance_count = 1
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = ["${var.project_id}:asia-south1:deckastra-postgres"]
      }
    }
  }
  traffic {
    percent  = 100
    revision = null
    tag      = null
    type     = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
  }
}

# __generated__ by Terraform from "projects/deckastra/locations/asia-south1/jobs/deckastra-migrate"
resource "google_cloud_run_v2_job" "migrate" {
  # bootstrap.py and GitHub Actions own runtime revisions and traffic.
  lifecycle { ignore_changes = [template, client, client_version] }
  annotations           = {}
  client                = "gcloud"
  client_version        = "573.0.0"
  deletion_policy       = "DELETE"
  deletion_protection   = true
  labels                = {}
  launch_stage          = "GA"
  location              = "asia-south1"
  name                  = "deckastra-migrate"
  project               = var.project_id
  run_execution_token   = null
  start_execution_token = null
  tags                  = null
  template {
    annotations = {}
    labels      = {}
    parallelism = 0
    task_count  = 1
    template {
      encryption_key                = null
      execution_environment         = "EXECUTION_ENVIRONMENT_GEN2"
      gpu_zonal_redundancy_disabled = false
      max_retries                   = 0
      service_account               = "deckastra-migrate@${var.project_id}.iam.gserviceaccount.com"
      timeout                       = "600s"
      containers {
        args        = []
        command     = []
        depends_on  = []
        image       = "asia-south1-docker.pkg.dev/${var.project_id}/deckastra/migrate:backend-20261004-r3"
        name        = null
        working_dir = null
        env {
          name  = "DATABASE_URL"
          value = null
          value_source {
            secret_key_ref {
              secret  = "deckastra-database-url"
              version = "latest"
            }
          }
        }
        resources {
          limits = {
            cpu    = "1000m"
            memory = "512Mi"
          }
        }
        volume_mounts {
          mount_path = "/cloudsql"
          name       = "cloudsql"
          sub_path   = null
        }
      }
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = ["${var.project_id}:asia-south1:deckastra-postgres"]
        }
      }
    }
  }
}

# __generated__ by Terraform from "projects/deckastra/locations/asia-south1/services/deckastra-api"
resource "google_cloud_run_v2_service" "api" {
  # bootstrap.py and GitHub Actions own runtime revisions and traffic.
  lifecycle { ignore_changes = [template, client, client_version, traffic] }
  annotations          = {}
  client               = "gcloud"
  client_version       = "573.0.0"
  custom_audiences     = []
  default_uri_disabled = false
  deletion_policy      = "DELETE"
  deletion_protection  = true
  description          = null
  iap_enabled          = false
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  labels               = {}
  launch_stage         = "GA"
  location             = "asia-south1"
  name                 = "deckastra-api"
  project              = var.project_id
  tags                 = null
  scaling {
    manual_instance_count = 0
    max_instance_count    = 20
    min_instance_count    = 0
    scaling_mode          = null
  }
  template {
    annotations                      = {}
    encryption_key                   = null
    execution_environment            = null
    gpu_zonal_redundancy_disabled    = false
    health_check_disabled            = false
    labels                           = {}
    max_instance_request_concurrency = 8
    revision                         = null
    service_account                  = "deckastra-api@${var.project_id}.iam.gserviceaccount.com"
    session_affinity                 = false
    timeout                          = "900s"
    containers {
      args             = []
      base_image_uri   = null
      command          = []
      depends_on       = []
      image            = "asia-south1-docker.pkg.dev/${var.project_id}/deckastra/api:backend-20261004-r3"
      name             = null
      sandbox_launcher = false
      working_dir      = null
      env {
        name  = "DATABASE_URL"
        value = null
        value_source {
          secret_key_ref {
            secret  = "deckastra-database-url"
            version = "latest"
          }
        }
      }
      env {
        name  = "DECKASTRA_ASSISTANT_MAX_COST_USD"
        value = "0.30"
      }
      env {
        name  = "DECKASTRA_CREDITS_ENABLED"
        value = "1"
      }
      env {
        name  = "DECKASTRA_DEVICE_SECRET"
        value = null
        value_source {
          secret_key_ref {
            secret  = "deckastra-device-secret"
            version = "latest"
          }
        }
      }
      env {
        name  = "DECKASTRA_ENV"
        value = "production"
      }
      env {
        name  = "DECKASTRA_GCS_ASSETS_BUCKET"
        value = "${var.project_id}-assets"
      }
      env {
        name  = "DECKASTRA_GCS_EXPORTS_BUCKET"
        value = "${var.project_id}-exports"
      }
      env {
        name  = "DECKASTRA_GCS_SERVICE_ACCOUNT"
        value = "deckastra-api@${var.project_id}.iam.gserviceaccount.com"
      }
      env {
        name  = "DECKASTRA_GLOBAL_DAILY_USD"
        value = "10"
      }
      env {
        name  = "DECKASTRA_OIDC_AUDIENCE"
        value = "deckastra"
      }
      env {
        name  = "DECKASTRA_OIDC_ISSUER"
        value = "https://securetoken.google.com/deckastra"
      }
      env {
        name  = "DECKASTRA_UPLOAD_SECRET"
        value = null
        value_source {
          secret_key_ref {
            secret  = "deckastra-upload-secret"
            version = "latest"
          }
        }
      }
      env {
        name  = "DECKASTRA_VERTEX_IDENTITY"
        value = "attached"
      }
      env {
        name  = "DECKASTRA_VERTEX_LOCATION"
        value = "global"
      }
      env {
        name  = "DECKASTRA_VERTEX_IMAGE_MODEL"
        value = ""
      }
      env {
        name  = "DECKASTRA_VERTEX_PRICES"
        value = jsonencode({})
      }
      env {
        name  = "DECKASTRA_TRANSLATION"
        value = "google"
      }
      env {
        name  = "DECKASTRA_TRANSLATION_USD_PER_MILLION"
        value = "20"
      }
      env {
        name  = "DECKASTRA_VERTEX_PROJECT"
        value = "deckastra"
      }
      env {
        name  = "DECKASTRA_WEB_ORIGINS"
        value = "http://localhost:3000"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = "deckastra"
      }
      ports {
        container_port = 8080
        name           = "http1"
      }
      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        startup_cpu_boost = true
      }
      startup_probe {
        failure_threshold     = 24
        initial_delay_seconds = 0
        period_seconds        = 5
        timeout_seconds       = 3
        http_get {
          path = "/ready"
          port = 8080
        }
      }
      volume_mounts {
        mount_path = "/cloudsql"
        name       = "cloudsql"
        sub_path   = null
      }
    }
    scaling {
      max_instance_count = 3
      min_instance_count = 0
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = ["${var.project_id}:asia-south1:deckastra-postgres"]
      }
    }
  }
  traffic {
    percent  = 100
    revision = null
    tag      = null
    type     = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
  }
}

# __generated__ by Terraform from "projects/deckastra/locations/asia-south1/repositories/deckastra"
resource "google_artifact_registry_repository" "images" {
  cleanup_policy_dry_run = false
  deletion_policy        = "DELETE"
  description            = null
  format                 = "DOCKER"
  kms_key_name           = null
  labels                 = {}
  location               = "asia-south1"
  mode                   = "STANDARD_REPOSITORY"
  project                = var.project_id
  repository_id          = "deckastra"
  vulnerability_scanning_config {
    enablement_config = null
  }
}

# __generated__ by Terraform from "projects/deckastra/instances/deckastra-postgres/databases/deckastra"
resource "google_sql_database" "app" {
  charset         = "UTF8"
  collation       = "en_US.UTF8"
  deletion_policy = "DELETE"
  instance        = "deckastra-postgres"
  name            = "deckastra"
  project         = var.project_id
}

# __generated__ by Terraform from "${var.project_id}-assets"
resource "google_storage_bucket" "assets" {
  default_event_based_hold    = false
  deletion_policy             = "DELETE"
  enable_object_retention     = false
  force_destroy               = false
  labels                      = {}
  location                    = "ASIA-SOUTH1"
  name                        = "${var.project_id}-assets"
  project                     = var.project_id
  public_access_prevention    = "enforced"
  requester_pays              = false
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  hierarchical_namespace {
    enabled = false
  }
  soft_delete_policy {
    retention_duration_seconds = 604800
  }
}

# __generated__ by Terraform from "${var.project_id}-build-source"
resource "google_storage_bucket" "build_source" {
  default_event_based_hold    = false
  deletion_policy             = "DELETE"
  enable_object_retention     = false
  force_destroy               = false
  labels                      = {}
  location                    = "ASIA-SOUTH1"
  name                        = "${var.project_id}-build-source"
  project                     = var.project_id
  public_access_prevention    = "enforced"
  requester_pays              = false
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  hierarchical_namespace {
    enabled = false
  }
  lifecycle_rule {
    action {
      storage_class = null
      type          = "Delete"
    }
    condition {
      age                                     = 5
      created_before                          = null
      custom_time_before                      = null
      days_since_custom_time                  = 0
      days_since_noncurrent_time              = 0
      matches_prefix                          = []
      matches_storage_class                   = []
      matches_suffix                          = []
      noncurrent_time_before                  = null
      num_newer_versions                      = 0
      send_age_if_zero                        = false
      send_days_since_custom_time_if_zero     = false
      send_days_since_noncurrent_time_if_zero = false
      send_num_newer_versions_if_zero         = false
      size_above_bytes                        = 0
      size_below_bytes                        = 0
      with_state                              = "ANY"
    }
  }
  soft_delete_policy {
    retention_duration_seconds = 604800
  }
}

# __generated__ by Terraform from "${var.project_id}-packs"
resource "google_storage_bucket" "packs" {
  default_event_based_hold    = false
  deletion_policy             = "DELETE"
  enable_object_retention     = false
  force_destroy               = false
  labels                      = {}
  location                    = "ASIA-SOUTH1"
  name                        = "${var.project_id}-packs"
  project                     = var.project_id
  public_access_prevention    = "enforced"
  requester_pays              = false
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  hierarchical_namespace {
    enabled = false
  }
  soft_delete_policy {
    retention_duration_seconds = 604800
  }
}

# __generated__ by Terraform from "${var.project_id}-exports"
resource "google_storage_bucket" "exports" {
  default_event_based_hold    = false
  deletion_policy             = "DELETE"
  enable_object_retention     = false
  force_destroy               = false
  labels                      = {}
  location                    = "ASIA-SOUTH1"
  name                        = "${var.project_id}-exports"
  project                     = var.project_id
  public_access_prevention    = "enforced"
  requester_pays              = false
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  hierarchical_namespace {
    enabled = false
  }
  lifecycle_rule {
    action {
      storage_class = null
      type          = "Delete"
    }
    condition {
      age                                     = 30
      created_before                          = null
      custom_time_before                      = null
      days_since_custom_time                  = 0
      days_since_noncurrent_time              = 0
      matches_prefix                          = []
      matches_storage_class                   = []
      matches_suffix                          = []
      noncurrent_time_before                  = null
      num_newer_versions                      = 0
      send_age_if_zero                        = false
      send_days_since_custom_time_if_zero     = false
      send_days_since_noncurrent_time_if_zero = false
      send_num_newer_versions_if_zero         = false
      size_above_bytes                        = 0
      size_below_bytes                        = 0
      with_state                              = "ANY"
    }
  }
  soft_delete_policy {
    retention_duration_seconds = 604800
  }
}
