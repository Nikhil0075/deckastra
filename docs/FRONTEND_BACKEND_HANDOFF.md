# Frontend integration with the hosted backend

Use `infrastructure/deployment/public-auth.json` for environment configuration and the API's `/docs` for complete request schemas. `/ready` is a public operational check. Protected routes require `Authorization: Bearer <Identity Platform ID token>` and verified email. Development token headers are disabled in the hosted environments.

## Desktop

`window.deckastraAccount.state()`, `.signIn()` and `.signOut()` are separate preload APIs returning only `{signedIn, email, configured}`. Sign-in opens the system browser and requires no user API key. Never expose the ID token, refresh token, Google token or gateway secret to renderer JavaScript. The main-process gateway adds cloud authentication. Editing, deterministic checks, export and local MCP remain usable signed out.

The main process selects development while unpackaged, production while packaged; override with `DECKASTRA_CLOUD_ENV=dev|prod`. Native File > Open and the `.mydeck` file association read through the main process, import via the local sidecar and open the result without discarding another window's unsaved work. Expose a renderer Save copy action by requesting an export job with `kind: "mydeck"`; do not send local decks to cloud storage for ordinary file sharing. Renderer tests and installed desktop verification remain frontend/release work.

## Web and account state

Initialize Firebase Auth with the public `projectId`, `authDomain` and `apiKey`; Google provider sign-in uses the configured web client. For email-link authentication, use Identity Platform/Firebase's email-link methods and retain the email securely for completing the link. Use the resulting Identity Platform ID token on API requests. Add final frontend domains to authorized Identity Platform domains, OAuth origins and API CORS before deployment.

* `GET /v1/account`: user and available workspace/project IDs.
* `GET /v1/account/credits`: credit balance, allowance and current period.
* `GET /v1/account/capabilities`: each task's availability and configured-model reason. Render unavailable tasks honestly; the current model map is intentionally empty.
* `DELETE /v1/account` with `{"confirm":"DELETE"}`: returns a deletion receipt. Handle a shared-ownership conflict by offering ownership transfer. Sign out locally after an accepted request; poll `GET /v1/account/deletions/{receipt}` for its minimal status.

Do not show an active subscription or purchased-credit balance until Track 3's payment verification exists.

## Repaired assistant contracts

The backend accepts `task: "critique"` through `POST /v1/assistant/runs`. This is
read-only and accepts a read credential and viewer presentation access. Send
the current `expected_version_id`, a unique operation key, explicit selected
scope and the requested `locale`. Poll the run and display `result.critique`,
`result.summary` and `result.evidence`; critique does not create edit operations.
Each issue has supplied evidence IDs. Surface the recorded limitations: this
review uses source data and deterministic Design Check, not rendered-slide
vision. Add the task to the frontend shared task types and label mapping when
integrating this API. It remains unavailable until qualification is completed.

Wording tools return validated proposals and retain text formatting, links and
numbers. Narration preserves existing cue steps and recordings; localized
scripts and alt text use draft language entries with source hashes. Show draft
status and require normal proposal review. Generation now accepts an explicit
`locale` and records it as the generated document's source language. Appending a
different source language is rejected before inference; the UI can offer
replacement generation or translation overlays.

All AI availability must continue to follow the account capability response.
Automatic benchmark checks alone do not enable a task. The new independent
review pack is described in `docs/AI_RELIABILITY.md`.

## Files and export

Create an export with `POST /v1/presentations/{id}/exports`, JSON `{"kind":"pdf"|"pptx"|"mydeck"}` plus supported options. Poll `GET /v1/exports/{id}` and use `/v1/exports/{id}/download` only when completed. Downloads redirect to short-lived private GCS signed URLs. A failed job returns a safe error; do not surface internal object paths.

Create an import with `POST /v1/projects/{id}/imports`, JSON `{"size_bytes":n,"copy":true}`. PUT bytes to the returned upload URL with exactly the returned headers, then `POST /v1/imports/{id}/complete` and poll `GET /v1/imports/{id}`. `completed` has the new presentation ID; `existing` identifies a deck the user may already access; `failed` has a safe error. `copy:true` forces a new identity. Validate UI size before upload: hosted runtime limit is 128 MiB.

`GET /v1/font-packs/{japanese|korean|chinese|chinese-traditional}` is free and returns signed file links, sizes, checksums and a license link. Export-side downloads are automatic for the selected locale and reuse verified cached files offline. Do not upload a document merely to obtain a font pack.
