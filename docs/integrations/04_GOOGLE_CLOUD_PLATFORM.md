# 04 — Google Cloud Platform: hosting, accounts and language packs

Status: plan, 2026-10-01. Nothing here is built. `infrastructure/deployment/` is
empty today.
Related: every other plan in this folder uses a service defined here.

## 1. What is being asked

- Host the web application on Google Cloud.
- Manage accounts there.
- Supply the "packages" the app needs, such as language modules (fonts, voices,
  glossaries) and model packs.
- Satisfy the **AI Builder Cup 2026** requirement: the prototype is built on
  Google Cloud.

### Hackathon facts (from aibuildercup.com, read 2026-10-01)

- Organized by Hack2skill with Google Cloud. Total prize pool USD 30,000.
- Registration and team formation: Sept 1 – **Oct 11, 2026**. Building and
  submission: Sept 7 – **Oct 18, 2026**. Evaluation: Oct 19 – Nov 6.
  Finalists: Nov 7. Finale in **Singapore, Dec 4**.
- Teams of **2–4**; **working professionals aged 21+**; **JAPAC** only.
- The brief: start with a local problem, build on Google Cloud, show it can scale
  globally.
- The challenges page returned 404 when fetched. **Read the judging criteria after
  registering**, and adjust the demo to them.

## 2. Discovery: what the code expects from its environment

| Need | How the code reads it | Where |
| --- | --- | --- |
| Database | `DATABASE_URL` (PostgreSQL in production; SQLite on desktop) | `db/session.py` |
| Migrations | Alembic, `infrastructure/database/alembic.ini`, `npm run db:migrate` | `infrastructure/database/migrations` |
| Object storage | S3 API: `S3_ENDPOINT_URL`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ASSETS_BUCKET`; SigV4, path-style; presigned PUT and GET | `object_storage.py:83-134` |
| Sign-in | OIDC: `DECKASTRA_OIDC_ISSUER`, `DECKASTRA_OIDC_AUDIENCE`, `DECKASTRA_OIDC_AUTHORIZED_PARTIES` (or `DECKASTRA_OIDC_PUBLIC_KEY`) | `auth.py:115-186` |
| Environment | `DECKASTRA_ENV=production` (refuses local mode and dev tokens) | `auth.py`, `local_mode.py` |
| Exports | `python -m deckastra_api.export_worker`, a DB-polled job loop; it runs `apps/worker` (Node) which needs **Chromium** (Playwright) | `export_worker.py`, `export_service.py`, `apps/worker` |
| Export directory | `DECKASTRA_EXPORT_DIR` (read when an export runs) | `export_service.export_root()` |
| Worker command | `DECKASTRA_WORKER_CMD`, `DECKASTRA_WORKER_NODE` | `export_service.py` |
| Row locks | `supports_row_locks()`: true on Postgres, so claiming jobs is safe with several workers | `db/session.py` |
| Agent checkpoints | the PostgreSQL LangGraph saver on a server | `agent_service._checkpointer` |
| Model | Anthropic key or local llama.cpp; `DECKASTRA_INTELLIGENCE` is `local` or `cloud` | `agents/deckastra_agents/router.py` |
| Telemetry | OTLP HTTP/protobuf; off unless an endpoint or `DECKASTRA_TELEMETRY=1`; no user text in attributes | `telemetry.py` |
| Web app | Next.js, `NEXT_PUBLIC_API_URL` read in exactly one file | `apps/web/lib/client.ts` |
| Local services today | docker compose: Postgres, MinIO | `infrastructure/docker/docker-compose.yml` |

The product was designed to deploy: Postgres is the tested engine
(`POSTGRES_TEST_URL` in CI), storage is S3-shaped, sign-in is OIDC, and
exports are a separate worker. Most of the work is configuration and packaging.

## 3. Target architecture

```
                    ┌──────────── Cloud Load Balancing (HTTPS, custom domain) ───┐
 browser ──────────►│  /          → Cloud Run  web (Next.js standalone)           │
                    │  /v1, /api  → Cloud Run  api (FastAPI, uvicorn)             │
                    └────────────────────────────────────────────────────────────┘
                                   │                 │
         Identity Platform ◄───────┘ (OIDC tokens)   │
                                                     ▼
       Cloud SQL (Postgres 16) ◄──── api, export-worker, assistant (private IP)
       Cloud Storage buckets   ◄──── assets, exports, language packs (+ Cloud CDN)
       Secret Manager          ──►  env for api/worker
       Cloud Run  export-worker (Python + Node + Chromium), min instances 1
       Cloud Run  imaging  (OpenCV + LaMa; see 05), scale to zero
       Cloud Run  gemma    (L4 GPU, vLLM/Ollama; see 02), scale to zero
       Cloud Run  assistant (ADK; see 02)
       Vertex AI: Gemini (story/translation), Model Garden (Gemma)
       Cloud Translation v3 · Text-to-Speech (Chirp 3 HD) · Cloud Vision (OCR)
       Artifact Registry (images) · Cloud Build or GitHub Actions (WIF) · Cloud Logging/Trace
```

### 3.1 Services and images

| Service | Image | Notes |
| --- | --- | --- |
| `web` | `apps/web` Next.js `output: "standalone"` on node:24-slim | Build arg `NEXT_PUBLIC_API_URL`. Stateless. |
| `api` | Python 3.13 slim + `apps/api/requirements.txt` + `agents/` + `integrations/` + `generated/` schema + prompts | `uvicorn deckastra_api.main:app --host 0.0.0.0 --port $PORT`. `resource_root()` must find the migrations, schema and prompts; copy them to the same relative layout. |
| `export-worker` | **Playwright's official image, pinned by digest** (as CI's pixel job does) + Python + the api package | Runs `python -m deckastra_api.export_worker`. Keep `min-instances=1`, CPU always allocated, because it polls. Use the same image digest as CI, so exports match the pixel gate. |
| `migrate` | the `api` image | A **Cloud Run Job** running `alembic upgrade head`, executed before each deploy. The service never migrates on start: that is the desktop's rule, not the server's. |
| `imaging`, `gemma`, `assistant` | see 05 and 02 | GPU only where needed |

All images live in Artifact Registry. Add the Dockerfiles in
`infrastructure/deployment/docker/`.

### 3.2 Database: Cloud SQL for PostgreSQL

- Postgres 16, private IP, the Cloud SQL Auth Proxy sidecar or a unix socket:
  `DATABASE_URL=postgresql+psycopg://deckastra:<secret>@/deckastra?host=/cloudsql/<project>:<region>:<instance>`.
- Start with `db-custom-1-3840` for the hackathon; enable automatic backups and
  point-in-time recovery.
- The LangGraph Postgres checkpointer uses the same instance (a separate schema).

### 3.3 Storage: Cloud Storage

**Option 1 (fastest, no code): the S3-compatible XML API.** Create HMAC keys for
a service account, and set:
```
S3_ENDPOINT_URL=https://storage.googleapis.com
S3_REGION=auto
S3_ACCESS_KEY_ID=<HMAC access id>   S3_SECRET_ACCESS_KEY=<HMAC secret>  (Secret Manager)
S3_ASSETS_BUCKET=deckastra-<env>-assets
```
Two things to verify, because this code was only ever run against MinIO:
presigned **PUT** with a `Content-Type` condition, and **path-style** addressing
(`addressing_style: "path"` in `_client()`). Both should work with GCS
interoperability. Run `apps/api/tests/test_object_storage.py` against a real
bucket before relying on it.

**Option 2 (if Option 1 misbehaves): a native backend.** Add a third backend to
`object_storage.py` using `google-cloud-storage`, with V4 signed URLs from the
service account (IAM `signBlob`, no key files). Keep the same five functions
(`presigned_put`, `presigned_get`, `metadata`, `delete`, `read`).

- Buckets: `…-assets` (private, uniform access), `…-exports` (private; lifecycle
  deletes after 30 days), `…-packs` (public read through Cloud CDN, versioned
  and immutable object names).
- CORS on the assets bucket for the web origin (presigned PUT from the browser).

### 3.4 Accounts: Identity Platform

- Enable Google sign-in plus email/password (and SAML or OIDC for organizations
  later; see 03).
- Tokens are Firebase-style ID tokens:
  `DECKASTRA_OIDC_ISSUER=https://securetoken.google.com/<project-id>`,
  `DECKASTRA_OIDC_AUDIENCE=<project-id>`. The JWKS is discovered from the
  issuer, which `_jwks_client` already does. **Verify** that `_decode_oidc_token`
  reads the email and name claims Identity Platform uses (`email`, `name`,
  `sub` = `user_id`), and add a test with a real token shape.
- The web app signs in with the Firebase JS SDK and passes the ID token as the
  bearer. That is one new file behind the `session-store.ts` seam in
  `workspace-client`.
- **Multi-tenancy** (an Identity Platform tenant per organization) only when SSO
  per organization is needed.

### 3.5 Secrets and identity

- Secret Manager: the database password, HMAC secret, `ANTHROPIC_API_KEY`
  (optional), GitHub webhook secret, and `DECKASTRA_DEV_SECRET` (unused in
  production, and refused there).
- Each Cloud Run service has its **own service account** with least privilege:
  - `api`: Cloud SQL client, Storage object admin on the assets bucket, Vertex
    AI user, Translation user, TTS, Vision, secret accessor;
  - `export-worker`: Cloud SQL client, Storage on assets (read) and exports
    (write);
  - `web`: none.
- No JSON key files. Local development uses `gcloud auth application-default login`.

### 3.6 Google AI services (new clients)

| Service | Used by | New code |
| --- | --- | --- |
| Vertex AI Gemini | Generation graph (a new provider), translation rewrites (01), image style analysis (05) | `agents/deckastra_agents/vertex_model.py` implementing `ModelClient`; `router.py` gets `DECKASTRA_INTELLIGENCE=vertex`; `selected_provider()` answers `vertex`. **No fallback between providers**, the D3 rule. |
| Vertex AI Model Garden / Cloud Run GPU | Gemma 4 (02) | an endpoint URL |
| Cloud Translation v3 (Advanced) | 01 | `translation.py`; glossaries per workspace stored in GCS |
| Text-to-Speech (Chirp 3 HD) | 01 | `speech.py` |
| Cloud Vision (DOCUMENT_TEXT_DETECTION) | 05 | `image_localize.py` |

All calls go from the API or worker, never the browser. Each has a quota entry
(`quotas.py`) and a telemetry span with **no user text** (`telemetry.py` rule).

### 3.7 Exports on Cloud Run

- The export loop needs no change: it claims rows with `FOR UPDATE SKIP LOCKED`
  on Postgres. With `min-instances=1` it always has a poller.
- **Later:** replace polling with Cloud Tasks pushing `POST /internal/exports/run`
  to the worker, so it scales to zero. Keep the database row as the authority.
- Exports are written to the exports bucket, not the container filesystem.
  `export_root()` today is a local directory, so `run_job` needs to upload the
  artifact and record a storage key instead of `artifact_path` when a bucket is
  configured. **This is a real code change**, and a download route that streams
  from GCS (or redirects to a presigned GET).
- Fonts: the image must contain the fonts the renderer declares.
  `apps/worker/src/fonts.ts` embeds bundled families as `data:` URLs, so no
  system fonts are needed beyond them.

### 3.8 Observability

- Logs: stdout JSON to Cloud Logging (already the Cloud Run default).
- Traces and metrics: set the OTLP endpoint to an OpenTelemetry Collector sidecar
  exporting to Cloud Trace and Cloud Monitoring (or Google's OTLP endpoint).
  `telemetry.py` already speaks OTLP. The "no user text in attributes" rule
  holds unchanged.
- Uptime check on `/health`, which already reports the provider and migrations
  digest.

### 3.9 Networking and security

- An external HTTPS load balancer with a managed certificate for the custom
  domain; `/v1/*` goes to `api`, everything else to `web`. Same origin means no
  CORS for the app itself.
- Cloud Armor (optional): rate limits on `/v1/generate*` and `/v1/shared/*`.
- The GitHub webhook route stays HMAC-verified (it already refuses without a
  secret).

## 4. Language and model packs ("packages")

The desktop CSP forbids remote fonts, and the installer should stay small, so
large resources are **packs**, downloaded on demand and verified.

```
gs://deckastra-packs/ (served through Cloud CDN)
  index.json                       signed list of packs: id, version, bytes, sha256, licence
  languages/hi-IN/1.0.0/
     manifest.json                 fonts, TTS voices, glossary defaults, script rules
     fonts/NotoSansDevanagari-*.woff2, Mukta-*.woff2 …
  languages/ja-JP/1.0.0/ …         (CJK fonts are the big ones)
  models/gemma-4-e4b-q4/1.0.0/     GGUF + manifest (licence field required)
  sounds/core/1.0.0/               extra sound effects (01)
```

- **Integrity:** every file's sha256 is in the manifest. `index.json` is signed
  with an Ed25519 key whose public key is compiled into the app. The desktop
  refuses a pack that fails either check, the same posture as
  `install-model-pack.py` (which verifies against the published sha256).
- **Desktop:** a new main-process module `apps/desktop/src/main/packs.ts`
  downloads into `userData/packs/`, verifies, and exposes installed packs.
  Fonts from packs are served through the existing `deckastra://` protocol, so the
  CSP stays `'self'`. The renderer asks "which packs are installed" over IPC and
  never names a path. A "Languages & packs" section goes in the Intelligence
  drawer.
- **Web:** the web app loads pack fonts from the CDN origin (add it to the web
  CSP `font-src`), or bundles the few Indic fonts it needs directly.
- **Exports:** the worker image ships the language packs it supports, or reads
  them from the bucket at start.

## 5. CI/CD

- **GitHub Actions with Workload Identity Federation** (no service-account keys):
  1. run the existing test jobs;
  2. build images and push to Artifact Registry;
  3. run the `migrate` Cloud Run Job;
  4. deploy `api`, `export-worker` and `web` with `gcloud run deploy --image …@sha256:…`.
- Or Cloud Build triggers with the same steps.
- **Terraform** in `infrastructure/deployment/terraform/` for: project services,
  Cloud SQL, buckets and CORS, service accounts and IAM, Secret Manager entries
  (not values), Artifact Registry, Cloud Run services and jobs, the load balancer,
  and Identity Platform config.
- Environments: `dev` (scale to zero, smallest SQL) and `demo` (min instances 1
  on api and web during judging, so the first request is not a cold start).

## 6. Cost notes (check current prices before relying on them)

- Cloud Run: scale to zero for web and api in dev; pay per request.
- Cloud SQL is the fixed cost; the smallest tier is enough for a demo.
- GPU services (Gemma, LaMa): scale to zero, and expect a cold start of tens of
  seconds while weights load ("ready means answering" applies: poll readiness,
  not the port bind).
- New Google Cloud accounts receive free-trial credits, and hackathons often
  provide credits. Ask Hack2skill.

## 7. Work breakdown

| # | Task | Files |
| --- | --- | --- |
| 1 | Dockerfiles: web, api, export-worker, migrate | `infrastructure/deployment/docker/*.Dockerfile` |
| 2 | Terraform | `infrastructure/deployment/terraform/*` |
| 3 | GCS: verify S3 interop, or add a native backend | `object_storage.py`, `tests/test_object_storage.py` |
| 4 | Exports to a bucket and a download route | `export_service.py`, `export_routes.py` |
| 5 | Identity Platform claims + web sign-in | `auth.py`, `workspace-client/src/session-store.ts`, `apps/web` |
| 6 | Vertex model client + router | `agents/deckastra_agents/vertex_model.py`, `router.py` |
| 7 | Translation, speech and vision clients | see 01 and 05 |
| 8 | Packs: bucket layout, signing script, desktop downloader | `scripts/publish-pack.mjs`, `apps/desktop/src/main/packs.ts`, IPC, `ipc-guard.ts` |
| 9 | CI deploy workflow | `.github/workflows/deploy.yml` |
| 10 | Runbook | `docs/DEPLOYMENT_GCP.md` |

## 8. Phasing

| Phase | Scope | Estimate |
| --- | --- | --- |
| A | Images, Cloud SQL, GCS (interop), api + web + worker on Cloud Run, a manual deploy | 2–3 days |
| B | Identity Platform sign-in, secrets, exports to a bucket | 2 days |
| C | Vertex / Translation / TTS / Vision clients (as the features need them) | with 01 and 05 |
| D | Terraform + CI deploy + packs | 3–4 days |

For the hackathon, A + B plus the AI clients the demo uses give a public URL
running on Google Cloud. That is the minimum requirement.

## 9. Sources

- [AI Builder Cup 2026](https://aibuildercup.com/)
- [Chirp 3 HD voices](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd)
- [Supported TTS voices and languages](https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types)
