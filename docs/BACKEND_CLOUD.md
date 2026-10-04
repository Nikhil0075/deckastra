# Deckastra backend and Google Cloud

Deployment handoff, 2026-10-05. Frontend integration and public launch remain separate work.

## Environments

| | Development | Production |
| --- | --- | --- |
| Google Cloud project | `deckastra` (524807414967) | `deckastra-prod` (794139896808) |
| API | https://deckastra-api-zit47xh5eq-el.a.run.app | https://deckastra-api-fwqqltaqta-el.a.run.app |
| Compute / SQL / storage region | `asia-south1` | `asia-south1` |
| Vertex location | `global`, tasks disabled pending qualification | `global`, tasks disabled pending qualification |

Owner: `nikhilranjanmurmu75@gmail.com`. Repository: https://github.com/Nikhil0075/deckastra.
Public Identity Platform configuration is in `infrastructure/deployment/public-auth.json`.
Its Firebase browser API keys and OAuth client IDs identify the application; they are not service-account credentials.
Desktop defaults to development in a checkout and production in a packaged application (`DECKASTRA_CLOUD_ENV` overrides).

Each environment has Cloud Run API, a private export/import/erasure worker, and a migration job; PostgreSQL 16; private assets, exports, font-pack and build-source buckets; Artifact Registry; Secret Manager; and distinct runtime/build/deployment service accounts. Attached service identities sign private download/upload URLs. No service-account key files are needed.

Google and email-link providers are configured in Identity Platform. Google OAuth consent remains in Testing, with the owner as a test user. Both Identity Platform projects allow the desktop OAuth client. Publish consent only after the domain, privacy policy and terms are ready. The web client uses the two Firebase `__/auth/handler` redirects. Desktop uses PKCE and a random localhost callback port; the API exchanges the code with Google's secret held in Secret Manager, returning only the Google identity token. Electron exchanges it for Identity Platform tokens and stores them with `safeStorage`; the renderer receives account metadata only.

## Verification

The local backend suite passed 825 tests (28 skipped, 14 slow tests deselected). Additional focused checks cover the new OAuth exchange, package import/export, font integrity and desktop credential handling. Hosted checks exercise verified identity, 60 initial credits, authenticated blank-deck creation, queued PDF export, private GCS download, `.mydeck` export and import as a copy, font-pack links, disabled AI, and deletion requests with immediate bearer-token denial. A Cloud Run check job verified PostgreSQL migration upgrade/downgrade and concurrent credit reservations against the real SQL service. Real Google browser PKCE sign-in successfully reached the account credits endpoint. Development active-data erasure has also completed after the signed-link grace period.

## Deployment and operations

Use `gcloud --configuration=deckastra` locally. `bootstrap.py` takes an explicit project and never assumes the active gcloud project. The scripts require Python dependencies from `apps/api/requirements.txt` and an authenticated deployment identity.

```powershell
gcloud builds submit --project=deckastra --configuration=deckastra --config=infrastructure/deployment/cloudbuild.yaml --substitutions=_REGION=asia-south1,_TAG=RELEASE_ID --service-account=projects/deckastra/serviceAccounts/deckastra-build@deckastra.iam.gserviceaccount.com --gcs-source-staging-dir=gs://deckastra-build-source/source
python infrastructure/deployment/bootstrap.py deploy --project deckastra --tag RELEASE_ID
python infrastructure/deployment/smoke_cloud.py --project deckastra
```

The migration completes before API traffic changes. The previous API revision keeps traffic while the new API and worker start. A deployment with an irreversible database migration must be recovered with a compatible image or a database restore, not a blind downgrade. The `.mydeck` migration refuses downgrade while package export rows exist.

GitHub deployment uses Workload Identity Federation restricted to repository ID `1404289067`, owner ID `75252681`, and `main`; there are no long-lived GitHub Google keys. Main pushes deploy development; manual dispatch selects development or production. CI uses PostgreSQL before deploying. The image tag is the Git commit SHA. `promote.yaml` copies already-built images to production for manual promotion.

Terraform imports the existing core resources with separate state prefixes `development` and `production` in the private, versioned `deckastra-terraform-state` bucket. This covers SQL, the database, Artifact Registry, Cloud Run services/job and four buckets. Terraform deliberately ignores runtime templates and traffic owned by the deployment script. IAM, WIF, secret creation, Identity Platform, budgets and monitoring are reproducible scripts, not all managed by this Terraform module. Never commit local state or credentials. The web Dockerfile is prepared; the unfinished web frontend is not deployed.

Readiness uptime checks, outage and 5xx alert policies, Cloud Trace export and Error Reporting are configured. Alert delivery depends on confirming Google's verification email for the owner's notification channel. Spans have a fixed attribute allowlist and exclude user prompts and deck text.

## Credits, privacy and storage

Free accounts receive 60 monthly credits, resetting lazily by calendar date. One credit is US$0.005 of configured model cost. The ledger reserves before calling a paid service, reconciles actual usage, refunds confirmed non-use and holds ambiguous calls. Verified email and per-account/per-device/global daily limits protect paid routes. Desktop AI requests send selected scope through a transient gateway; local decks remain in the sidecar. Cloud/web decks explicitly stored through the API persist in PostgreSQL and GCS. Completed assistant payloads expire after 24 hours, abandoned payloads after seven days; applied deck versions remain part of the saved deck.

Account deletion immediately rejects further bearer requests and queues removal of Identity Platform identity, owned cloud records and objects after a 16-minute grace period. Sole owners of shared workspaces must transfer ownership first. SQL backups and GCS soft-deleted objects have seven-day retention; deletion from active storage does not mean immediate physical removal from every backup. Local desktop files are unaffected by cloud account deletion.

The `.mydeck` reader validates paths, entries, digests, sizes, compression ratios, schema, references and asset formats before writing. Unknown package extras round-trip. Runtime import size is 128 MiB even though the exchange format allows larger containers. Private upload URLs are bounded and short-lived. Japanese, Korean, Simplified Chinese and Traditional Chinese Noto CJK 2.004 packs are published with checksums and the OFL license, cached locally for offline export after download.

## Remaining launch gates

* Connect frontend account/sign-in, credit/capability state, cloud deletion and package Save/Open flows (see `FRONTEND_BACKEND_HANDOFF.md`). Build and verify an installed desktop and deploy the finished web app with its final allowed origin.
* The approved US$30 evaluation ran 140 advanced-deck cases against `gemini-3.1-pro-preview`, global, MEDIUM thinking. The model ledger estimated US$5.407288 in returned usage and retained US$1.088102 for interrupted calls; this is not an invoice. Independent review is still required. See `docs/evaluations/2026-10-05/`; pin only the exact model/runtime/location from a passing reviewed report. Tasks remain disabled; no fallback model is selected.
* Billing budgets are INR 5,000 per project at 50/90/100% thresholds; they send alerts and **do not stop spending**. The app ledger enforces application limits. A separate effective Vertex quota/cost stop remains to be selected and verified before enabling AI; [the evaluated Gemini 3.1 Pro model does not support fixed quota](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro). Dynamic shared quota is not a monetary cap. Cloud SQL and the always-on worker incur baseline charges even with AI disabled.
* Finalize the operator's legal identity, domain, support address, privacy/terms/data-processing text and consent publication. Drafts are in `docs/legal/` and must not be published with placeholders.
* Paid subscriptions, top-ups, payment verification, GST registration/invoices, Business-tier launch decisions and signing/release credentials remain Track 3/4 work. There is no live paid checkout in this backend change.

Do not replace the disabled model map with a guessed model ID or treat an unreviewed benchmark as qualification.
