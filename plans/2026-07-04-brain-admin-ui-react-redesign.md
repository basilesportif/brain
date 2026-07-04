# Brain admin UI redesign — React operator console

Date: 2026-07-04
Status: plan; not implemented.
Supersedes the UI direction of `plans/2026-06-27-brain-admin-ui-redesign.md` (that
plan's implemented server-rendered console is the starting point being replaced).
Security boundaries and write-only/presence-only semantics from that plan and
`docs/brain-admin-service.md` are carried forward unchanged except where noted.

## 1. Diagnosis (why this redesign)

The current `/admin` console (`apps/web/src/admin-page.ts`, server-rendered HTML/CSS/JS
in one TypeScript module) is a full exposure of the backend: raw JSON blobs, raw env
tables, per-row telemetry dumps, a manual "canary" checklist with Save buttons, and
dozens of stacked sections across two endless pages. The admin's verdict, which this
plan takes as the mandate:

- Way overcomplicated for the functionality it provides.
- Not concise; the same information (Slack health, env state, telemetry) appears 3–4
  times in different formats.
- The UI should be a purpose-built operator console, **not** a database/system
  inspector. Raw data belongs in logs and APIs that AI agents inspect — not on the
  admin's screen.

## 2. Confirmed facts and decisions (from the admin)

These are settled. Do not re-litigate them; build to them.

1. **Single admin today (Tim), but multiple users are imminent.** A second user
   already exists and will be added once this works; dozens of users are plausible.
   Capabilities UI must be designed for N users, with N=1 working today.
2. **Capability enforcement is turning on as soon as possible.** The current store is
   read-only/non-enforcing; the UI must be designed around *managing and changing*
   grants, not just displaying seed data. See §6.5 and the codex-chat enforcement
   plan (`codex-chat/plans/2026-07-04-brain-capability-enforcement-plan.md`) — its
   Phase 0 requires Brain to pre-create grants, so Brain's grant-write API is a
   prerequisite for enforcement, not just a UI nicety.
3. **Grant management is group-level by default.** Admin grants/revokes broad
   capability groups (Projects, CRM, Calendar, Slack, Todos, Finance, Health,
   Capability-admin). Individual-grant editing goes behind an "Advanced" expander.
4. **Identity links (Telegram/Slack) are manual.** Admin assigns identifying info to
   a user; that is the linking mechanism and is considered secure enough. The
   proof-source/metadata columns are overkill — drop them from the default view.
5. **Capability audit matters.** Needed at minimum to verify the system works. Keep a
   real audit view (real events only — no schema placeholders or sample events).
6. **A capabilities API is critical and wanted ASAP.** Today only a read-only
   `GET /api/admin/brain/capabilities` summary exists; write endpoints are in scope.
7. **Slack setup completion state:** backend adds an explicit persisted flag;
   initially inferred from env presence + telemetry (see §6.2).
8. **The manual telemetry/canary checklist is not useful.** Replace it entirely with
   structured logging that agents can inspect when something goes wrong (§6.3).
9. **Structured status endpoint: approved.** Build it; the UI renders only it for
   health.
10. **Env vars:** keep editable in the UI (they change over time), but backend must
    tag secret/required and validate on write. Secrets stay write-only.
11. **Restart is the only lifecycle operation surfaced in the UI.** No deploy/rollback
    flows. (The server-side `codex-chat/operation` endpoint keeps its deploy support;
    the UI simply doesn't surface it.)
12. **Live log streaming is for agents only**, not shown in the admin UI.
13. **Stack:** React + Vite frontend consuming the Brain admin API, authenticated
    with Clerk (Google).
14. **Drop entirely:** Handbook editor, prompt editor, business-rules JSON editors.
15. **Raw/debug views:** keep, but behind a single persisted "Debug" toggle,
    default off.

**ASSUMPTION A1 — placeholders:** The seed-data placeholders in
`apps/web/src/capabilities.ts` (`slack:workspace:T00000000`, `slack:user:…`,
`slack:channel:…`, `system:codex-chat-runtime` subjects; the `status: "example"`
channel grant; placeholder finance/health rows in default views) are speculative
scaffolding. Remove them from the UI, and remove the placeholder *subjects* from the
seed + migrate them out of existing stores. If channel-scoped subjects become real
when enforcement lands, they enter as ordinary subjects — no special placeholder
rendering. (Placeholder *catalog groups* — Finance, Health — stay in the catalog but
render as ordinary not-yet-connected groups.)

**ASSUMPTION A2 — roles:** Only the admin (Clerk-allowlisted, fail-closed, per
`admin-auth.ts`) sees this console at all. Non-admin users have no admin UI in this
phase. Multi-admin roles are out of scope.

## 3. Repo ownership (who builds what)

This plan touches both repos; the Brain/codex-chat boundary does not move:

- **Brain (`apps/web`)** owns: the React app, all `/api/admin/brain/*` endpoints
  (existing + new status/setup/env-schema/capabilities/audit), the capability store
  and its new write path, Clerk auth, and serving the built frontend.
- **codex-chat** owns: structured runtime event logging (§6.3) — it already writes
  the Slack telemetry summary Brain reads at
  `<codex-chat>/data/state/slack_telemetry/summary.json` — plus the agent-only live
  tail endpoint on its loopback `api.ts` gateway. codex-chat exposes **no** grant
  write APIs and remains read-only against the capability store (enforcement plan
  Phase 8).
- Brain continues to reach codex-chat out-of-band (env file, TOML config, telemetry
  summary file, systemd restart command) — the redesign adds **no** new HTTP coupling
  to codex-chat's gateway.

## 4. Target information architecture

Replace the two monolithic scroll pages with **five routes** in the React app:

| Route | Purpose | Replaces |
|---|---|---|
| `/` Home | At-a-glance status + primary actions | Overview, Mission Control, System Health, Slack Health, telemetry panels, header pill soup |
| `/setup` | Slack setup wizard (only while incomplete) | 10-step wizard, Slack API settings banner (duplicated twice today) |
| `/settings` | Connections, model, and all configuration | Slack settings table, OpenRouter section, Env & Config, Manifest |
| `/users` | Users, identities, capability grants, catalog | Capabilities & Users page (Users, Identities, Grants, Catalog) |
| `/operations` | Restart + audit | Deploy/Restart, Audit/Feedback, capability audit |

A single global **Debug toggle** (persisted in localStorage) reveals raw-JSON
links/panels across all routes. Default off.

## 5. Screen-by-screen specification

### 5.1 Home (`/`)

One screen, no scrolling on desktop. Content is exactly the response of the new
`GET /api/admin/brain/status` (§6.1) rendered as status cards:

- **Cards:** Brain service, Slack, Model/OpenRouter, Service (restart pending, last
  operation result), Capability store. Each card shows: state dot (ok/warn/error),
  one-line message, last-checked timestamp, and at most one contextual action button
  (e.g., Slack in error → "Fix Slack setup" → `/setup`).
- **Header:** replace the current five status pills with the single worst-state
  indicator + service name. Clicking it goes Home.
- **No raw telemetry, no JSON, no duplicated health summaries.** If the status
  endpoint can't express something, fix the endpoint, don't add a panel.

### 5.2 Setup (`/setup`)

- Rendered as a route only while `slack.setupComplete === false`. Once complete,
  `/setup` redirects Home, and Home's Slack card shows "Connected ✓ · Reconfigure"
  (Reconfigure re-opens the wizard deliberately).
- Compress the 10 steps to 5 by merging steps that are one real-world action:
  1. Confirm public base URL + events path (was steps 1–2)
  2. Enter required secrets (write-only fields; was step 3)
  3. Download/copy manifest + install app in Slack (was steps 4–5; keep one "Open
     Slack App Settings" button here — remove the duplicated banner elsewhere)
  4. Configure Event Subscriptions + verify callback + send test event (was steps
     6–8; verification is automatic via the status endpoint, not a checkbox)
  5. Restart if needed (was step 9; deep-links to `/operations`)
- Drop step 10 (manual install-metadata notes) entirely.
- Step state is binary done/not-done, derived from backend state — no
  attention_needed/complete pill taxonomy, no per-step evidence JSON, no "skip for
  session" machinery. A single "Skip setup" link exits to Home (wizard reappears
  while incomplete).

### 5.3 Settings (`/settings`)

Three groups on one page:

1. **Connections (Slack):** the 5–6 Slack keys only. Each row: key, plain-language
   description, status (set / not set), and for secrets a write-only input (never
   echoes value). Uses env metadata from §6.4 — the UI hardcodes nothing about which
   keys are secret/required.
2. **Model:** main-loop model preset dropdown + OpenRouter key (write-only) +
   subagent defaults. Show active preset and "restart required" note after change,
   with a link to `/operations`. Drop the multi-field "pending selection / rollback
   option" panel; a simple current → pending diff line suffices.
3. **All configuration (collapsed expander):** the full tagged env list. Same row
   treatment as Connections. Validation errors from the API render inline. Remove
   the env-write approval-phrase free-text ritual; a standard confirm dialog on
   secret overwrite is enough (server change in §6.4).

Manifest handling shrinks to one "Download Slack manifest" button inside the wizard
(§5.2 step 3) — remove the render/validate/edit-draft manifest section.

### 5.4 Users (`/users`)

Designed for N users; N=1 must not look broken.

- **User list:** one row per person — name, status, identity chips (e.g.,
  `telegram ✓ slack ✓`), granted-groups summary (e.g., "6/8 groups"), enforcement
  badge while enforcement is off. "Add user" button (creates person, then link
  identities + grant groups).
- **User detail (expand or subpage):**
  - **Identities:** simple list of provider + external ID + linked date. Buttons:
    "Link identity" (provider dropdown + identifier field) and "Unlink". No
    proof-source/metadata columns in the default view (Debug toggle reveals raw
    identity records; proofs keep being written server-side — they just aren't
    default UI).
  - **Capabilities:** the 8 catalog groups as toggle rows — group name, child count,
    granted x/y, and a single grant/revoke-group control. Expanding a group lists
    child capabilities read-only by default; an "Advanced: edit individual grants"
    expander enables per-capability grant/revoke. This is the primary management
    surface once enforcement is on.
- **Remove:** the 25-row flat grants table as a default view (it's one seed bundle
  expanded), all placeholder subjects (A1), bundle-internals columns
  (`source: bundle:owner_all_seed_expanded · system:admin_seed` — Debug-only), and
  the `non_enforcing` pill on every row (show enforcement mode **once**, as a
  page-level banner, until enforcement is on; then remove the banner).

### 5.5 Operations (`/operations`)

- **Restart:** target service shown, one "Restart codex-chat" button → single
  confirm dialog → result toast + audit entry. **Keep the server-side exact-approval
  contract unchanged** — the client sends the exact approval phrase
  (`restart codex-chat.service`) programmatically after the confirm dialog. The
  plan-first server behavior, self-service refusal (never restarts
  `brain-admin.service`), redaction, and audit all stay. Remove from the default UI:
  the plan-state panel, operation dropdown, "run without fresh plan" checkbox, and
  redacted-operation-log expander (Debug toggle may expose the raw operation log).
- **Audit:** one merged feed of real events only — service operations (restarts,
  setting writes, from Brain's existing admin audit JSONL) and capability audit
  events (grant/revoke/link/unlink, and capability checks once enforcement is on).
  Columns: time, actor, action, target, result. A simple text filter. No
  schema-preview rows, no "writes enabled: no" metadata, no sample-event JSON (Debug
  toggle reveals raw JSONL path + sample).

## 6. Backend changes (build these first)

All additive; existing endpoints stay until the new UI is verified against the new
ones. All new Brain endpoints live under the existing `/api/admin/brain/*` prefix so
they inherit the Clerk fail-closed auth in `admin-service.ts`/`admin-auth.ts` and
existing Caddy routing — no bare `/api/*` namespace.

### 6.1 `GET /api/admin/brain/status` (Brain)

Structured status for Home. Shape:

```json
{ "components": [
  { "id": "slack", "state": "ok|warn|error", "message": "one line",
    "lastChecked": "ISO8601", "action": { "label": "Fix Slack setup", "route": "/setup" } }
]}
```

Components: `brain`, `slack`, `model`, `service`, `capability_store`. All health
interpretation happens server-side (reusing the existing derivations in
`slackTelemetrySummary`, env presence, capability-store metadata, and last-operation
state); the client renders, never computes.

### 6.2 Slack setup state (Brain)

Persisted `setupComplete` boolean in Brain-private state, exposed via the status
endpoint (slack component) and a small `GET /api/admin/brain/slack/setup` used by
the wizard for per-step done/not-done. Initial derivation: required env vars present
**and** codex-chat telemetry shows at least one accepted inbound event and one
outbound success (`lastAcceptedEvent` + `lastOutboundSuccess` in the existing
telemetry summary — no new codex-chat work needed for this). Later persisted
explicitly on wizard completion; "Reconfigure" clears it.

### 6.3 Structured logging replaces canary/telemetry (codex-chat)

- codex-chat emits JSON-lines events for everything the manual checklist tried to
  capture (inbound accepted/rejected, context decisions, outbound
  attempts/success/failure, subagent routing, redaction checks) to an append-only
  log under `data/state/`, extending the existing telemetry-summary writer. No
  message bodies or secrets in events.
- codex-chat adds an **agent-only** live tail endpoint (SSE or WebSocket) on its
  loopback `api.ts` gateway, API-key-authenticated like `/api/ingest/audio`. The
  admin UI never uses it and Brain does not proxy it.
- Brain keeps reading only the summary file for `/status`. After the new UI ships,
  remove Brain's canary store (`slack-canary.json`), its GET/POST
  `/api/admin/brain/slack/canary` endpoints, and the manual-checklist persistence.

### 6.4 Env metadata + validated writes (Brain)

- `GET /api/admin/brain/env/schema`: `[{ key, group, required, secret, description }]`
  — the UI derives all env rendering from this. Source of truth is a schema module
  next to `env-file.ts`, covering the keys the current UI hardcodes (Slack group,
  OpenRouter, model, feature flags) plus an `other` group for unrecognized keys
  present in the env file.
- Writes validate server-side and return field-level errors. Secret values stay
  write-only: API returns presence only, never values. The env-write approval-phrase
  gate is dropped server-side in the same change (client confirm dialog replaces
  it); the **operation** approval phrase is NOT dropped (§5.5).

### 6.5 Capabilities API (Brain — critical, ASAP)

This is a real store-layer change, not just new routes: `capabilities.ts` currently
hardcodes `writesEnabled: false` and `schemaVersion: 2` at the type level, and the
store is seeded/normalized read-only. Work:

- **Store v3:** bump `schemaVersion`, make `writesEnabled` real, add an atomic write
  path (the `writeCapabilityStore` temp-file+rename helper exists) and append-only
  capability audit events (`capability.grant.applied`, `capability.grant.revoked`,
  `identity.link.*` — the event vocabulary already exists in `AUDIT_EVENT_TYPES`).
  Migration drops placeholder subjects/grants (A1).
- **Grant shape stays aligned with the codex-chat enforcement plan:** keep resource
  selectors, `expiresAt`, group-implies-children semantics, and per-grant
  `enforcement` field so flipping enforcement requires no schema change. Grants
  written by this API are exactly what enforcement Phase 0 pre-creates.
- **Endpoints** (all under `/api/admin/brain/`):
  - `GET /users` (people with identity + grant summaries), `POST /users`
  - `POST /users/:id/identities`, `DELETE /users/:id/identities/:identityId`
    (manual link/unlink: provider + external identifier; server records a
    `manual_admin` proof)
  - `GET /capabilities/catalog` (groups → children; already derivable from
    `CAPABILITY_CATALOG`)
  - `POST /users/:id/grants`, `DELETE /users/:id/grants/:grantId` — accepting
    **either** a group id (expands to children server-side, per existing group
    semantics) or an individual capability id — one API serves both group toggles
    and advanced per-grant editing.
  - `GET /audit?type=capability|operations&limit=…` merged real-events feed (Brain
    admin audit JSONL + capability audit JSONL; later also codex-chat capability
    decisions once enforcement writes them).
- Grant writes must work now (non-enforcing) so the management UI is exercised
  before enforcement flips on. Enforcement activation itself is the codex-chat
  plan's job, not this one's.

### 6.6 Frontend app + serving (Brain)

- New Vite + React + TypeScript app at `apps/web/ui/` in the pnpm workspace;
  `pnpm run build` builds it after `tsc -b`. Clerk via `@clerk/clerk-react`
  (replacing the CDN `<script>` tags), publishable key injected the same way the
  current page embeds its config blob.
- `admin-service.ts` gains a small static handler serving the built assets under
  `/admin` (SPA fallback to `index.html` for the five routes). During development,
  Vite dev server proxies `/api/admin/brain/*` to the local admin service.
- Same fail-closed model: the API rejects non-allowlisted users regardless of what
  the SPA renders; sign-in and access-denied remain server-gated.
- **No CSS framework.** Port the existing dark theme (the CSS custom properties and
  component classes in `admin-page.ts`'s `css()`) into plain CSS / CSS Modules as
  the app's base stylesheet; no re-theming beyond what simplification implies. At
  most, headless unstyled primitives (e.g. Radix) for the fiddly accessible widgets
  (confirm dialogs, group toggles, expanders), styled with the existing tokens —
  and even that is optional.

## 7. Deletions summary (from the UI)

Remove outright, with no replacement UI:

- Manual canary checklist (~12 items: status dropdowns, evidence pointers, notes,
  Save buttons) and its rollup panel → replaced by structured logging (§6.3).
- Raw `/health`, `/settings`, `/slack/settings`, `/slack/telemetry` JSON panels →
  Debug toggle links only.
- Handbook, prompt, and business-rules editors (admin confirmed; these move to
  file/agent editing).
- Manifest draft editor and view-JSON expander.
- Duplicate "Open Slack App Settings" banner outside the wizard.
- Session-scoped "Slack skipped" feedback cards and reload-reset semantics.
- Header pill row (allowlisted / brain ok / telemetry stale / restart not pending).
- All placeholder subjects/rows in capabilities and audit (and their seeds, per A1).

Nothing is deleted server-side until the replacement is verified (§8 sequencing).

## 8. Sequencing (reversible steps — do not reorder)

Each step is independently deployable and rollback-safe; the old UI keeps working
until step 6.

1. **Brain backend:** ship §6.1 status, §6.2 setup state, §6.4 env schema +
   validated writes. Old UI untouched. Extend `admin-service.test.ts`.
2. **Brain backend:** ship §6.5 capabilities API — store v3 + reads first, then
   writes. Old UI untouched. Store migration is backed up before first write.
3. **Frontend:** new React/Vite app with Clerk auth at a parallel path
   (`/admin-v2`): Home + Settings first, then Setup, Users, Operations. Old console
   remains the default. Playwright smoke extends to the new app.
4. **codex-chat:** §6.3 structured logging + agent tail endpoint (its own commit in
   that repo; `pnpm test` + build there). Brain canary system still present
   (dual-write period).
5. **Verify:** admin uses `/admin-v2` exclusively for a period; confirm every
   retained workflow (setup, secret write, restart, grant change, identity link,
   audit review) works end-to-end.
6. **Cut over:** make the new app the default `/admin`; keep the old console
   reachable at a fallback path for one release.
7. **Remove:** old server-rendered console, canary store + endpoints,
   handbook/prompt/business-rules editors, placeholder seed rows.

## 9. Out of scope (explicitly)

- Turning capability enforcement on (owned by
  `codex-chat/plans/2026-07-04-brain-capability-enforcement-plan.md`; this plan only
  ensures the store/API/UI are ready for it).
- Multi-admin roles or a non-admin user-facing UI.
- Deploy/rollback operations beyond restart in the UI.
- Any visual re-theming beyond what the simplification implies — dark theme and
  current styling are reused.
- Changes to codex-chat's runtime behavior, adapters, or its loopback gateway
  beyond the §6.3 logging/tail additions.
