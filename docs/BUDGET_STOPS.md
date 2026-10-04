# Deckastra AI spending stops

Operator handoff, 2026-10-05. These controls do not guarantee an exact invoice ceiling. Gemini tasks remain disabled pending reviewed qualification.

## Live controls

| Control | Development | Production |
| --- | --- | --- |
| Immediate application ledger | Atomic account/device/global limits; global US$10/day | Same |
| Project budget | INR 5,000/month; email alerts at 50/90/100% | Same |
| Budget subscriber | Private `deckastra-budget-stop` Cloud Run service, authenticated Pub/Sub push | Same |
| Native Vertex spend cap | INR 5,000/month, gross costs; Configured in Console | Same |

The application reserves cost before a paid call, reconciles returned usage, and holds ambiguous calls. These limits protect requests made through Deckastra; they do not govern an owner's separate Cloud API use.

The existing whole-project budget now publishes to `projects/PROJECT/topics/deckastra-budget-stop`. Its private subscriber checks the exact billing account, budget ID, currency, amount, current monthly period and actual cost. At a reported INR 5,000 breach it disables `aiplatform.googleapis.com`, `translate.googleapis.com` and `texttospeech.googleapis.com`. Forecast-only, unrelated, stale and malformed messages do not stop services. Repeated breach deliveries are idempotent; partial shutdown failure returns 503 so Pub/Sub retries. It never automatically re-enables an API.

The subscriber's runtime has a custom service-disable/read role, logging and quota-consumer permissions. It cannot enable services, read decks, modify SQL or disconnect billing. Only the dedicated Pub/Sub identity can invoke it. Its service scales to zero. The separate push account has Cloud Run Invoker only on this service; the Pub/Sub service agent can mint that account's push token. The topic publisher is Google's billing-budget service account. Public Firebase keys allow only Identity Toolkit and Secure Token APIs.

Monitoring policies cover shutdown failure and budget notifications unacknowledged for fifteen minutes. The operator's email notification channel still needs Google's verification email confirmed. Logs contain event names, service names, outcome and Pub/Sub message IDs; no model prompts, deck content or credentials.

## Native Vertex caps

| Project | Native budget ID |
| --- | --- |
| `deckastra` | `29800a5b-f4fa-4d21-a9dc-e67867143550` |
| `deckastra-prod` | `0f0a06ae-fe85-4fbb-9009-99b72a576345` |

Both caps scope one project and the catalog's Vertex AI service `services/C7E2-9256-1C43`, exclude credits, use calendar-month periods, and notify billing administrators/project owners at 50/80/100%. Console editors confirmed **Configured**, INR 5,000, Monthly, Vertex AI, and the correct project. Preview API GET/list readbacks are inconsistent; verify these existing caps in Console before changing them. A subscriber redeploy does not recreate or lift a cap.

Google's native spend caps are Preview. They pause new service usage after gross estimated cost crosses the target; in-flight requests can finish and accrue charges. Enforcement is not instantaneous, and fixed infrastructure costs continue. An enforced cap requires manual lifting. See [Google's spend-cap documentation](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps). The evaluated Gemini model does not support fixed quota; the native spending stop is independent of that quota limitation.

Billing notifications arrive multiple times a day and can take hours; the subscriber responds to reported billing rather than measuring every request. Existing project budgets include credits, while the native Vertex caps use gross costs. Neither the subscriber nor the native Vertex cap stops Cloud SQL/storage baseline charges. See [programmatic budget notifications](https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications).

## Verification and deployment

The focused policy/runtime suite passed 27 tests. Rehearsals in both projects proved private access, authenticated Pub/Sub delivery, a below-budget forecast leaving APIs enabled, a real shutdown of all three APIs, duplicate delivery, API readiness during shutdown, and restoration of original service states. Ignored evidence is stored in `infrastructure/deployment/state/budget-stop-rehearsal-PROJECT.json`.

```powershell
python -m pytest infrastructure/deployment/tests/test_budget_stop.py -q
python infrastructure/deployment/configure_budget_stop.py --project deckastra --billing-account 0155DB-9F3B13-FC4952
python infrastructure/deployment/monitoring.py --project deckastra --email nikhilranjanmurmu75@gmail.com
```

Repeat for `deckastra-prod`. For first-time setup only, `--configure-native-cap` creates a missing native cap; confirm its amount, project, service and state in Console. Do not recreate an already configured cap just because a Preview API read omits it. The isolated subscriber build uploads an explicit allowlist of five source files, copies only its Python handler/policy and requirements into the image, and uses the existing attached build identity. The deployed image tag is a digest of those source files. Subscriber IAM, Pub/Sub, caps and alerts are scripted; they are outside the core Terraform module.

Rehearsal is an explicit operator action and requires an empty Gemini model map:

```powershell
python infrastructure/deployment/verify_budget_stop.py --project deckastra --exercise-shutdown
```

It briefly disables the three real AI APIs with a synthetic budget message through an isolated temporary topic/subscription. It removes test delivery resources before restoring only initially enabled APIs. It sends no model inference request. Do not run it during live paid AI use.

After a real breach, investigate usage and the budget first. Keep Gemini tasks disabled until qualification passes. The subscriber has no permission to resume services. An authorized owner can explicitly re-enable the three APIs, and an enforced native cap must separately be lifted in Cloud Billing. Re-enabling does not change the continuing charges for SQL, storage or already completed usage. The foundation provisioning command also enables APIs; do not use it as an accidental recovery from a budget stop.
