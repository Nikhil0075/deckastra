# 03 — Organizations, groups and a shared library

Status: plan, 2026-10-01. Nothing here is built.
Related: [04](04_GOOGLE_CLOUD_PLATFORM.md) (sign-in through Identity Platform),
[06](06_FILE_MANAGER_AND_MYDECK_PACKAGE.md) (the file manager shows this
structure).

## 1. What is being asked

A company (say 200 employees) uses Deckastra together:

- people belong to an **organization**;
- anyone can form a **group** of 4–5 people with a **shared project**;
- decks, assets and themes have **access by role**;
- someone can **publish** an asset (a logo, a photo, a template, a theme) so it is
  available to the whole organization.

## 2. Discovery: what exists

| Fact | Where |
| --- | --- |
| `users`, `auth_identities` (OIDC), `workspaces` (with `origin` local/cloud), `workspace_members` (role, `confirmed_at`), `projects`, `presentations`, `assets` (`workspace_id`), `themes` (`workspace_id`), `presentation_shares`, `workspace_quotas`, `user_preferences` | `apps/api/deckastra_api/db/models.py` |
| The role ladder and the resolve chain `User → Workspace → Project → Presentation`, by membership and role, never by `owner_id`. Missing and forbidden both answer 404. | `apps/api/deckastra_api/auth.py:594-712` |
| `resolve_workspace_access` **requires a `Role`**, so a new route cannot skip the check | `auth.py:654` |
| A cached membership is not authorization. `membership_status()` has six states. | `auth.py:460` (D5.4) |
| OIDC sign-in exists (`DECKASTRA_OIDC_ISSUER`, `_AUDIENCE`, `_AUTHORIZED_PARTIES`) | `auth.py:115-186` |
| `provision_personal_account` creates a personal workspace on first sign-in, and handles the sign-in race with a savepoint | `auth.py:238` |
| Moving a deck between workspaces: editor on both sides, no pending proposals, assets travel if not shared | `routes.py` `POST /v1/presentations/{id}/move`, D5.1/D5.5 |
| Assets are scoped to one workspace and reference-counted from every stored version | `assets.py` |
| Rendering and exports read assets **scoped to the presentation's own workspace** | `assets.inline_for_render` |
| Agent grants never carry `manage` or `approve`. Sharing is not an agent tool. | `grants.py`, `apps/mcp-server/src/tools.ts` |
| Concurrency is optimistic (`expected_version_id`, 409, three-way merge in `reconcile.ts`). There is no real-time co-editing. | `store.commit_transaction`, `editor-ui/src/lib/reconcile.ts` |
| Release 0.9.0-beta.1 is local-only and single-user | `docs/RELEASE_NOTES_0.9.0-beta.1.md` |

**Consequence:** this is the cloud product. The desktop takes part by signing in
and mirroring (D5.6 bootstrap), and none of it applies in local mode.

## 3. The model

```
Organization  (Acme, 200 people, domain acme.com)
 ├── members           role: owner | admin | member | guest
 ├── groups            "Q4 Pitch Team" (5 people), "Design" (12 people)
 ├── workspaces        each owned by the org; a group's shared space is a workspace
 │    └── projects → presentations
 └── library           published assets, themes and templates, visible org-wide
                       (or to named groups)
```

**Key decision: a group's shared project is a workspace owned by the
organization, with the group granted a role on it.** The alternative, a new
"team" object holding projects directly, would need a second copy of every
workspace rule: quotas, themes, the asset scope, sync origin, and membership
freshness. Reusing workspaces keeps one resolve chain.

### 3.1 Tables (one Alembic revision per group of tables)

```
organizations(id, name, slug, created_by, sso_required bool, created_at, updated_at)
organization_members(org_id, user_id, role, status: invited|active|suspended,
                     invited_by, joined_at)                PK(org_id, user_id)
organization_domains(org_id, domain, verified_at, auto_join_role)
groups(id, org_id, name, description, created_by)          UNIQUE(org_id, name)
group_members(group_id, user_id, role: manager|member)     PK(group_id, user_id)
workspace_grants(workspace_id, group_id, role)             PK(workspace_id, group_id)
project_grants(project_id, principal_type: user|group, principal_id, role)
workspaces.organization_id  (nullable FK; null = personal)
library_items(id, org_id, kind: asset|theme|template, ref_id,
              visibility: org|groups, published_by, published_at,
              status: active|withdrawn, title, tags)
library_item_groups(item_id, group_id)
audit_events(id, org_id, actor_id, action, target_type, target_id, at, detail_json)
organization_quotas(org_id, …)   same shape as workspace_quotas, applied first
```

`assets` gains `organization_id` (nullable). A constraint requires **exactly one**
of `workspace_id` or `organization_id`: an asset is owned by exactly one scope.

### 3.2 Effective role: one function

`auth.effective_role(session, user_id, workspace_id, project_id=None) -> Role | None`
is the **maximum** of:

1. the direct `workspace_members` role (including `membership_status` rules);
2. roles from `workspace_grants` for every group the user is an *active* member
   of, in an *active* organization membership;
3. roles from `project_grants` (user or group) when a project is named;
4. org `owner` or `admin` ⇒ `admin` on every org workspace, for administration.
   Content access still goes through a grant, so an admin sees decks only
   because an explicit rule gives them that.

`resolve_workspace_access`, `resolve_project_access` and
`resolve_presentation_access` call it. They are the only three callers. The 404
rule is unchanged.

**Suspending a person** in the organization removes every derived role in one
place, because `effective_role` requires `status = active`.

**Tests** (`apps/api/tests/test_org_access.py`):
- a group member reads the group's project;
- a non-member gets 404;
- a removed member gets 404 on the next request;
- a project grant does not leak to sibling projects;
- a guest cannot see the library;
- an agent grant cannot publish.

### 3.3 The shared library

- **Publishing is an explicit act**, the same class of decision as sharing:
  `POST /v1/orgs/{id}/library` `{kind, ref_id, visibility, group_ids?}` needs
  editor role on the source workspace **and** the org permission `publish`
  (members may publish by default; admins can restrict it to admins). No agent
  grant carries it, and an MCP test asserts the absence.
- **Assets are copied, not moved:** publishing creates a new asset row with
  `organization_id` set, and copies the bytes to `org/<org_id>/…` in storage.
  The source deck keeps citing its own copy. This avoids the D5.5 problem ("a file
  two decks use cannot travel with one of them").
- **Using a library asset in a deck:** the deck's asset manifest cites the org
  asset id. `inline_for_render`, the blob route and the shared-link asset route
  gain one rule: an asset is readable for a presentation if it is in the
  presentation's workspace, **or** it is an active library item of the
  workspace's organization visible to that workspace (org-wide, or a granted
  group). The same 404 applies otherwise.
- **Withdrawal:** withdrawing a library item stops *new* uses. Decks that already
  cite it keep rendering: removing a logo from 40 decks is a bigger decision,
  and it gets its own "replace everywhere" admin action, which produces one
  proposal per deck.
- **Themes:** the org can mark a library theme as the **brand default** for new
  decks in its workspaces (extends `themes.py` default adoption). Brand rules
  (allowed fonts and colours) already exist as checks and become org policy.
- **Templates:** a library template is a deck. "New from template" is
  `deck_copy.duplicate_document` into the chosen project.
- **Reference counting** for org assets recounts across every workspace in the
  org (`assets.recount` walks the org's decks). An org asset is never swept while
  it is published.

### 3.4 Groups in practice

- Any member can create a group (configurable), invite org members, and click
  **Create shared space**. That makes a workspace owned by the org, grants the
  group `editor`, and creates a default project.
- A group manager adds or removes members. Access follows immediately through
  `effective_role`.
- Leaving or deleting a group does **not** delete the workspace. It is reassigned
  to the org, and an admin decides.

### 3.5 Five people editing one deck

The current model is optimistic concurrency with conflict review. For small
groups, add two cheap things before any real-time engine:

1. **Presence:** `POST /v1/presentations/{id}/presence` (heartbeat every 15 s,
   30 s TTL). The editor shows avatars and "Asha is editing slide 4". Presence
   is not stored in the document, because it fails the "everyone agrees on it"
   test (CLAUDE.md, "The schema is the product").
2. **Faster head watching:** `watchHeadMs` from 4 s down to 2 s when others are
   present, so an adopted outside change arrives quickly. Adoption already
   refuses to replace unsaved work.

Real-time co-editing (CRDT or OT) is out of scope, and a separate project.

### 3.6 Sign-in and provisioning

- **Identity Platform** (see 04) issues OIDC tokens. `auth.py` already verifies
  OIDC.
- **Domain auto-join:** a verified `organization_domains.domain` lets a new user
  with that email domain join as `member` on first sign-in, inside
  `provision_personal_account`'s savepoint.
- **Invitations:** email link with a signed token that expires in 7 days
  (`POST /v1/orgs/{id}/invitations`). Accepting is idempotent.
- **SSO required** (`organizations.sso_required`): password sign-in is refused
  for members. SAML through Identity Platform comes later. SCIM provisioning is
  a later phase.

### 3.7 Administration

- **Routes (`org_routes.py`, new):** orgs, members (invite, role, suspend),
  groups, grants, domains, library, audit, quotas.
- **Audit:** membership changes, grants, publish and withdraw, deck moves, and
  share links created. Audit events carry **ids, never content**, the same rule
  as telemetry.
- **Admin screen** (web only at first): `apps/web/app/org/...` routes using
  `editor-ui` primitives (Tabs, Section, Select, StatusChip).

## 4. Client and UI changes

| Area | Change | Files |
| --- | --- | --- |
| Contracts | `Organization`, `Group`, `LibraryItem`, `EffectiveAccess`; `AccountWorkspace.organizationId`, `access.via: "member" \| "group:<name>" \| "project"` | `workspace-contracts/src/orgs.ts` (new), `session.ts`, `roles.ts` |
| Client | `client.orgs.*`, `client.library.*`, `client.presence.*` | `workspace-client/src/http.ts` |
| Deck list | Sidebar: Personal / organization name → Shared spaces (groups) → Projects; a "Library" entry | `components/DeckList.tsx`, `lib/deck-list.ts` |
| Add library | A "Organization" tab beside Shapes and Icons: published images, logos and themes | `shell/AddLibrary.tsx` |
| Theme gallery | Org themes first, the brand default marked | `ThemeGallery.tsx` |
| Share panel | "People in Acme" picker (grant a user or group on the project) beside the link | `SharePanel.tsx` |
| Presence | Avatars in the AppBar | `shell/AppBar.tsx`, new `lib/presence.ts` |
| MCP | `workspace_list` shows the org and group; no publish tool, no grant tool | `apps/mcp-server/src/tools.ts` |

## 5. Quotas

- The org quota applies first, then the workspace quota. Storage is still a
  level, recounted from assets (including org assets). Generation, tokens,
  speech characters (01) and image localizations (05) are counted per workspace
  and summed to the org.

## 6. Desktop

- A signed-in desktop mirrors the workspaces the person can reach (D5.6
  `bootstrap.adopt`). Org and group roles arrive as mirrored memberships with
  `confirmed_at`, and D5.4's windows apply (stale after 7 days, lapsed after 30).
- Library assets needed by mirrored decks are pulled with the decks. D5.6 names
  "assets are not pulled with their decks" as open; this plan needs it closed.
- Nothing org-related works in local mode, and the UI says so, the same pattern
  as `capabilities.sharing`.

## 7. Phasing

| Phase | Scope | Estimate |
| --- | --- | --- |
| A | orgs, members, invitations, `effective_role`, group → workspace grants, tests | 5–6 days |
| B | Deck list and share panel UI, presence | 3–4 days |
| C | Library (assets, themes, templates), render authorization rule, publish UI | 4–5 days |
| D | Admin screen, audit, domain auto-join, SSO required, org quotas | 4–5 days |

**For the hackathon:** show it as a roadmap slide. At most do phase A with a
seeded demo org. The authorization change is the riskiest code in the product,
and it deserves more than a hackathon week.

## 8. Risks

- **Authorization drift:** everything goes through `effective_role`, with a test
  matrix (role × grant path × resource type).
- **Library leakage** across orgs: the render rule checks
  `library_items.org_id == workspace.organization_id`, with a test that uses two
  orgs.
- **Brand theme locking** frustrating people: start with "default", not
  "enforced".
