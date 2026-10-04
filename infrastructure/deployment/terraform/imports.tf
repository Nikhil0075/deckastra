import {
  to = google_artifact_registry_repository.images
  id = "projects/${var.project_id}/locations/asia-south1/repositories/deckastra"
}
import {
  to = google_sql_database_instance.database
  id = "${var.project_id}/deckastra-postgres"
}
import {
  to = google_sql_database.app
  id = "projects/${var.project_id}/instances/deckastra-postgres/databases/deckastra"
}
import {
  to = google_cloud_run_v2_service.api
  id = "projects/${var.project_id}/locations/asia-south1/services/deckastra-api"
}
import {
  to = google_cloud_run_v2_service.export_worker
  id = "projects/${var.project_id}/locations/asia-south1/services/deckastra-export-worker"
}
import {
  to = google_cloud_run_v2_job.migrate
  id = "projects/${var.project_id}/locations/asia-south1/jobs/deckastra-migrate"
}
import {
  to = google_storage_bucket.assets
  id = "${var.project_id}-assets"
}
import {
  to = google_storage_bucket.exports
  id = "${var.project_id}-exports"
}
import {
  to = google_storage_bucket.packs
  id = "${var.project_id}-packs"
}
import {
  to = google_storage_bucket.build_source
  id = "${var.project_id}-build-source"
}
