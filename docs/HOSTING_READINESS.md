# Hosting phase, 2026-10-05

Use Google Cloud service URLs for now, as requested by the owner. Frontend work
continues independently. AI repair and paid evaluations are deferred; model
maps remain empty. See [the deferred AI backlog](AI_REVIEW_BACKLOG.md).

## Release safety

Backend releases preserve the deployed allowed web origins unless an operator
explicitly supplies a validated replacement. Production cannot silently fall
back to localhost on a first deployment. Migration runs before traffic moves.
The candidate API is tagged at zero serving traffic; readiness and disposable
Identity Platform sign-in, credits, Design Check, PDF/.mydeck export, private
downloads, package import, font links and deletion denial are tested against
that exact revision. Promotion targets its named revision, not `latest`.
Failed promotion/live readiness restores the prior named traffic allocation,
including splits. Concurrent operator traffic changes are refused. Temporary
test tags are removed; cleanup failure is reported.

This follows Google's [tagged-revision testing and rollback guidance](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration).
It is an API traffic recovery, not a database downgrade. Migrations and worker
changes must remain compatible with the previous API during deployment. A
failed worker deployment can leave the old API serving against an upgraded
schema. Destructive migrations require a separately planned recovery. On the
first ever service deployment there is no previous revision to restore.
Disposable cloud checks create real test records; account deletion queues
active-data cleanup after the existing 16-minute signed-link grace period.

## Web build and access

`docker/web.Dockerfile` now includes root TypeScript config and public auth
configuration and requires matching API URL/cloud-project build arguments.
`cloudbuild-web.yaml` builds only the web image. `web_hosting.py` deploys an exact
commit-tagged image using the web identity, checks HTML, adds the discovered
service hostname to Identity Platform, configures exact private-bucket CORS
and API origins, and promotes the tested revision. API origin updates undergo
the same disposable workflow check before receiving traffic. Existing origins,
Identity Platform domains and unrelated bucket CORS entries are preserved.

The manual GitHub workflow can also build/deploy the web app when its explicit
`deploy_web` option is selected. The deploy identity has only the Identity
Platform configuration/disposable-user permissions needed for those checks,
and bucket metadata/CORS permissions scoped to assets and exports; WIF still
trusts only this repository’s main branch.

The live audit found missing bucket CORS in both projects. Signed downloads and
uploads use Cloud Storage's XML endpoints, which [evaluate bucket CORS](https://docs.cloud.google.com/storage/docs/cross-origin).
Direct HTTP tests alone do not demonstrate browser access. The audit checks
real XML preflight responses without uploading an object; it also checks denied
unlisted API origins, private bucket access, SQL backup/PITR settings and auth.

```powershell
python infrastructure/deployment/audit_hosting.py --project deckastra --output .artifacts/hosting/development.json
python infrastructure/deployment/audit_hosting.py --project deckastra-prod --output .artifacts/hosting/production.json
```

Build source must be a reviewed Git snapshot, with temporary workflow
credentials excluded. Supply `_TAG=<full commit SHA>` and `_API_URL=<environment
API URL>` to the web build; use the existing attached build service account and
private build-source bucket. Then run:

```powershell
python infrastructure/deployment/web_hosting.py --project deckastra --tag FULL_COMMIT_SHA
```

## Remaining launch work

* Finish frontend integration and installed desktop acceptance. Development
  preview hosting is not acceptance of unfinished frontend changes.
* Publish privacy/terms with the actual operator identity/support address and
  move Google OAuth from owner-only Testing to the intended launch audience.
* Demonstrate operator alert receipt. The API currently omits verification
  state; [Google defines unspecified as unknown or not applicable](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.notificationChannels),
  so omission alone does not establish that an email verification is required.
* Resume independent AI qualification only when ready; keep unavailable tools
  consistent with account capabilities.
* Arabic text extraction in character-map-only PDF readers remains an export
  compatibility item. ActualText-aware readers already work; address it before
  claiming support for all PDF text-extraction tools.
* Billing/GST, Business features and signing/distribution remain separate
  launch decisions. No paid checkout is activated by hosting.

No custom domain or load balancer is required for the initial service URLs.
