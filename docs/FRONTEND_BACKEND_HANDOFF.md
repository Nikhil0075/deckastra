# Frontend integration with the hosted backend

Use `infrastructure/deployment/public-auth.json` for environment configuration and the API's `/docs` for complete request schemas. `/ready` is a public operational check. Protected routes require `Authorization: Bearer <Identity Platform ID token>` and verified email. Development token headers are disabled in the hosted environments.

## Desktop

`window.deckastraAccount.state()`, `.signIn()` and `.signOut()` are separate preload APIs returning only `{signedIn, email, configured}`. Sign-in opens the system browser and requires no user API key. Never expose the ID token, refresh token, Google token or gateway secret to renderer JavaScript. The main-process gateway adds cloud authentication. Editing, deterministic checks, export and local MCP remain usable signed out.

The main process selects development while unpackaged, production while packaged; override with `DECKASTRA_CLOUD_ENV=dev|prod`. Native File > Open and the `.mydeck` file association read through the main process, import via the local sidecar and open the result without discarding another window's unsaved work. Expose a renderer Save copy action by requesting an export job with `kind: "mydeck"`; do not send local decks to cloud storage for ordinary file sharing. Renderer tests and installed desktop verification remain frontend/release work.

## Web and account state

Initialize Firebase Auth with the public `projectId`, `authDomain` and `apiKey`; Google provider sign-in uses the configured web client. For email-link authentication, use Identity Platform/Firebase's email-link methods and retain the email securely for completing the link. Use the resulting Identity Platform ID token on API requests. Add final frontend domains to authorized Identity Platform domains, OAuth origins and API CORS before deployment.

* `GET /v1/account`: user and available workspace/project IDs.
* `GET /v1/account/credits`: credit balance, allowance and current period.
* `GET /v1/account/capabilities`: paid image-generation availability and its configured-media reason. No text-model tasks are exposed.
* `DELETE /v1/account` with `{"confirm":"DELETE"}`: returns a deletion receipt. Handle a shared-ownership conflict by offering ownership transfer. Sign out locally after an accepted request; poll `GET /v1/account/deletions/{receipt}` for its minimal status.

Do not show an active subscription or purchased-credit balance until Track 3's payment verification exists.

## Paid media contract

`POST /v1/assistant/infer` accepts only `task: "image"` and always requests
image output. The desktop private gateway forwards that bounded request; it does
not expose planning, authoring, critique, research, translation, or other text
tasks. Deterministic tidy and motion, exports, Cloud Translation, and spoken
narration remain on their dedicated surfaces.

## Files and export

Create an export with `POST /v1/presentations/{id}/exports`, JSON `{"kind":"pdf"|"pptx"|"mydeck"}` plus supported options. Poll `GET /v1/exports/{id}` and use `/v1/exports/{id}/download` only when completed. Downloads redirect to short-lived private GCS signed URLs. A failed job returns a safe error; do not surface internal object paths.

Create an import with `POST /v1/projects/{id}/imports`, JSON `{"size_bytes":n,"copy":true}`. PUT bytes to the returned upload URL with exactly the returned headers, then `POST /v1/imports/{id}/complete` and poll `GET /v1/imports/{id}`. `completed` has the new presentation ID; `existing` identifies a deck the user may already access; `failed` has a safe error. `copy:true` forces a new identity. Validate UI size before upload: hosted runtime limit is 128 MiB.

`GET /v1/font-packs/{japanese|korean|chinese|chinese-traditional}` is free and returns signed file links, sizes, checksums and a license link. Export-side downloads are automatic for the selected locale and reuse verified cached files offline. Do not upload a document merely to obtain a font pack.
