# Brain admin UI redesign — React operator console

Date: 2026-07-04
Status: plan; not implemented.

## Execution model (how this plan is implemented)

Every implementation part of this plan is executed by a dispatched **Codex CLI
sub-agent running GPT-5.5 at xhigh reasoning effort with fast mode** (via the
`codex-dispatch` skill: `codex exec -C <worktree> --model gpt-5.5
-c model_reasoning_effort='"xhigh"' --enable fast_mode`), one part at a time,
scoped to a single sequencing step (§8) or a coherent slice of one. **Do NOT
use Opus sub-agents** — steps 1–4 and slice 5a were Opus-implemented before
this switch; everything from here on goes to Codex. **Fable supervises and is
the code reviewer**: it writes each dispatch brief, and after Codex finishes it
runs a formal code review of the resulting diff (correctness,
security/secret-echo, adherence to this plan's invariants in §9, tests, and the
fail-closed safety rails in §6.5) before the work is committed. Fable fixes or
re-dispatches anything the review rejects (fix rounds resume the same Codex
session via `codex exec resume <session-id>`); nothing lands unreviewed. Codex
never commits; Fable commits after review. The same model applies to the
codex-chat-side steps (§6.3, §6.7). Progress is tracked with checkboxes added
per step as work starts, so a crashed or limit-capped session can resume
without repeating work.

### Progress (checkboxes are the source of truth for resume)

- [x] Step 1 — Brain backend: §6.1 status, §6.2 setup state, §6.4 env schema + validated writes (Opus-implemented, Fable-reviewed: 10 review findings fixed; env-write approval gate retained until step 4)
- [x] Step 2 — Brain backend: §6.5 reads (summary, catalog, users, paginated audit, dry-run authorize) (Opus-implemented, Fable-reviewed: 10 findings fixed incl. anonymized synthetic fixture, dry-run parity, fail-closed store load, anchored audit cursor; dry-run verified against 4 real logged decisions)
- [x] Step 3 — Brain backend: §6.5 writes (store migration + backup, grant/identity mutations, impact preview, audit events) (Opus-implemented, Fable-reviewed: 10 confirmed findings fixed — migration retains any subject holding active grants incl. system:codex-chat-runtime, exact-token placeholder matching, migration self-lockout rail, per-group default broad selectors + preview caveat, suspended-subject admins excluded, in-process mutation queue, non-fatal audit-append failure, unknown-capability 400, invalid-body 400, double-revoke no-op; 61/61 tests; migration dry-run + real-run verified against a copy of the live store: runtime subject and both active enforcing grants retained, only zeroed seed subjects + example grant removed)
- [x] Step 4 — Frontend: React/Vite app at `/admin-v2` (Opus-implemented, Fable-reviewed in two slices). 4a: scaffold + Clerk (@clerk/clerk-react) + path-safe static serving with SPA fallback + Home + Settings; 10 review findings + legacy env-guard finding fixed (server env gate accepts legacy phrase OR confirmed:true, confirmation pins read state, server-exposed confirmationKeys, injected no-store shell, realpath containment, per-key writable, 403 taxonomy, auth-aware polling). 4b: Setup wizard, Users, Operations + Playwright smoke; 10 review findings fixed by replacing the client-side revoke resolution with backend support — GET /users exposes exact grant entries across all active subjects, atomic revoke_batch mutation with single combined impact preview, storeHash pinning with 409 re-preview, per-capability revoke only on individual grants (group/bundle render read-only 'granted via'), preview-gated confirm, busy-inert dialogs, confirmed Reconfigure with provenance retention, read-only service info + on-click restart handshake, synthetic e2e email. 66/66 web tests, UI + root builds, e2e smoke green.
- [x] Step 5 — codex-chat: §6.3 structured logging + agent tail, §6.7 IPC config command; Brain reroutes env writes — DONE 2026-07-06. Slice 5a on codex-chat branch admin-ui-step5 (`4f15c14` + fix-round `26e2bd9`, pushed): runtime-events log (ring buffer + per-day JSONL + pub/sub, monotonic seq), SSE tail (ingest-key auth, immediate flush, seq/Last-Event-ID cursors), token-file IPC auth on mutating commands, set_config validated from ENV_OVERRIDE_SPECS with atomic systemd-safe env-store writes, system.config.write in the capability matrix, additive code:"unauthorized" on auth rejections; 395 tests. Slice 5b on this branch (`0315a50`): codex-chat-ipc.ts client (token auth, typed UNAVAILABLE/FAILED + mayHaveApplied, exported timeout), four env handlers rerouted IPC-first (fieldErrors→400 with unknown_key/invalid_type taxonomy, bootstrap fallback ONLY on socket/token-absent, 502 + structured log otherwise, presence derived from request entries), empty-string clears delete lines on BOTH paths, shared fake-IPC test helper, test emails swept to example.com; 82 tests. Both slices: Codex-GPT-5.5-implemented/fixed, Fable 10-finding reviews, Fable re-verified + committed. TOML writers (writeOpenRouterCodexProfile, writeCodexChatProviderConfig) remain direct-disk with TODO(§6.7) — need a future codex-chat TOML IPC command. Merged main (`a280a8d`): enforcing-grant startup normalization coexists with the new store writer; legacy path retires in step 8. DEPLOY: codex-chat 5a/fix must deploy before or with Brain 5b (Brain reads <codex-chat>/data/run/ipc.token; bootstrap fallback covers service-down).

- [ ] Step 6 — Verify: all retained workflows end-to-end against live enforcement
- [ ] Step 7 — Cut over `/admin` to the new app
- [ ] Step 8 — Remove old console, canary store/endpoints, stale placeholder types
Supersedes the UI direction of `plans/2026-06-27-brain-admin-ui-redesign.md` (that
plan's implemented server-rendered console is the starting point being replaced).
Security boundaries and write-only/presence-only semantics from that plan and
`docs/brain-admin-service.md` are carried forward unchanged except where noted.

## 0. Critical context: capability enforcement is LIVE

This plan was first drafted assuming a read-only, non-enforcing capability store
with enforcement "coming later." That is no longer true. codex-chat has landed
central authorization (`codex-chat/src/capabilities.ts`: `authorize()`,
`authorizeOrThrow()`, `authorizeOutput()`), fail-closed across surfaces, with
`enforcementEnabled` **defaulting to true** in its config schema. Two consequences
shape everything below:

1. **Grant/identity writes have real blast radius.** A revoke denies a real person
   across Telegram/Slack/subagents instantly; an invalid store write can fail-close
   the whole assistant (`assertBrainCapabilitySourceAvailable` throws when the store
   is missing/invalid while enforcement is on).
2. **Brain's admin-side capability model is stale.** `apps/web/src/capabilities.ts`
   still models the old non-enforcing foundation: hardcoded
   `enforcement: "non_enforcing"`, `writesEnabled: false`, `enforcementEnabled:
   false`, placeholder subjects. Meanwhile codex-chat's authorizer **denies** any
   grant whose `enforcement` field is not `"enforcing"`. The two schemas have
   drifted; the redesign must collapse them (§6.5) before shipping writes.

The Users/grants/audit surface is therefore a **production control surface for a
fail-closed system**, not a display of seed data.

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
2. **Capability enforcement is live** (§0). The UI must be designed around *managing
   and changing* grants against the enforced store, with the safety rails in §6.5.
3. **Grant management is group-level by default.** Admin grants/revokes broad
   capability groups (Projects, CRM, Calendar, Slack, Todos, Finance, Health,
   Capability-admin). Individual-grant editing goes behind an "Advanced" expander.
   The group list is data from the catalog endpoint, never hardcoded in the UI.
4. **Identity links (Telegram/Slack) are manual.** Admin assigns identifying info to
   a user; that is the linking mechanism and is considered secure enough. The
   proof-source/metadata columns are overkill — drop them from the default view.
5. **Capability audit matters.** Needed at minimum to verify the system works. Keep a
   real audit view (real events only — no schema placeholders or sample events).
   Enforcement records every allow/deny decision, so the audit surface must be
   denial-centric and paginated (§5.5, §6.5).
6. **A capabilities API is critical and wanted ASAP.** Today only a read-only
   `GET /api/admin/brain/capabilities` summary exists; write endpoints are in scope
   — with the §6.5 rigor, since writes hit the live enforced store.
7. **Slack setup completion state:** backend adds an explicit persisted flag from
   day one (see §6.2).
8. **The manual telemetry/canary checklist is not useful.** Replace it entirely with
   structured logging that agents can inspect when something goes wrong (§6.3).
9. **Structured status endpoint: approved.** Build it; the UI renders only it for
   health.
10. **Env vars:** keep editable in the UI (they change over time), but backend must
    tag secret/required and validate on write. Secrets stay write-only. Writes move
    from Brain touching codex-chat's env file on disk to a codex-chat-owned config
    interface (§6.7), with direct-disk retained as a bootstrap fallback only.
11. **Restart is the only lifecycle operation surfaced in the UI.** No deploy/rollback
    flows. (The server-side `codex-chat/operation` endpoint keeps its deploy support;
    the UI simply doesn't surface it.)
12. **Live log streaming is for agents only**, not shown in the admin UI.
13. **Stack:** React + Vite frontend consuming the Brain admin API, authenticated
    with Clerk (Google).
14. **Drop entirely:** Handbook editor, prompt editor, business-rules JSON editors.
15. **Raw/debug views:** keep, but behind a single persisted "Debug" toggle,
    default off.

**Placeholders are removed — hard requirement, not assumption.** The seed
placeholders in `apps/web/src/capabilities.ts` (`slack:workspace:T00000000`,
`slack:user:…`, `slack:channel:…`, `system:codex-chat-runtime` subjects; the
`status: "example"` channel grant; `addable_placeholder` identities) are actively
dangerous in a fail-closed store: they look grantable but map to nothing the
enforcer understands. Remove them from seeds and migrate them out of existing
stores. Placeholder *catalog groups* (Finance, Health) stay in the catalog as
ordinary not-yet-connected groups.

**ASSUMPTION A2 — roles:** Only the admin (Clerk-allowlisted, fail-closed, per
`admin-auth.ts`) sees this console at all. Non-admin users have no admin UI in this
phase. Multi-admin roles are out of scope.

## 3. Repo ownership (who builds what)

This plan touches both repos; the Brain/codex-chat boundary does not move:

- **Brain (`apps/web`)** owns: the React app, all `/api/admin/brain/*` endpoints
  (existing + new status/setup/env-schema/capabilities/audit), the capability store
  write path, Clerk auth, and serving the built frontend. Brain remains the **only**
  write surface for grants (codex-chat enforcement plan Phase 8).
- **codex-chat** owns: the enforced runtime store schema and `authorize()` decision
  semantics (the source of truth Brain must write compatibly against), structured
  runtime event logging (§6.3) — it already writes the Slack telemetry summary
  Brain reads at `<codex-chat>/data/state/slack_telemetry/summary.json` — plus the
  agent-only live tail endpoint on its loopback `api.ts` gateway. codex-chat
  exposes **no** grant write APIs and stays read-only against the store.
- Brain continues to reach codex-chat out-of-band (telemetry summary + capability
  decision files, systemd restart command, and — until §6.7 lands — the env file) —
  the redesign adds **no** new HTTP coupling to codex-chat's gateway. §6.7 replaces
  the direct env-file writes with a codex-chat-owned local IPC command.
- Cleanup: remove stale generated `dist/admin-*` artifacts in codex-chat that
  reference removed admin routes, so the new UI can never hit dead routes.

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
  operation result), Capability enforcement. Each card shows: state dot
  (ok/warn/error), one-line message, last-checked timestamp, and at most one
  contextual action button (e.g., Slack in error → "Fix Slack setup" → `/setup`).
- **Capability enforcement card** is a security-posture signal: enforcement
  enabled, store present + schema-valid + last-loaded, and recent denial count
  ("N denials in last hour" → links to the audit view filtered to denials). Store
  unreachable/invalid while enforcement is on renders as **error** — in that state
  the assistant is down.
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

Designed for N users; N=1 must not look broken. This is live authorization
management: every change here takes effect at codex-chat's next side-effect check.

- **User list:** one row per person — name, status, identity chips (e.g.,
  `telegram ✓ slack ✓`), granted-groups summary (e.g., "6/8 groups"). "Add user"
  button (creates person, then link identities + grant groups).
- **User detail (expand or subpage):**
  - **Identities:** simple list of provider + external ID + linked date. Buttons:
    "Link identity" (provider dropdown + identifier field) and "Unlink". No
    proof-source/metadata columns in the default view (Debug toggle reveals raw
    identity records; proofs keep being written server-side — they just aren't
    default UI). Unlinking shows the same impact preview as a revoke, since it
    denies that surface for the person.
  - **Capabilities:** the catalog groups as toggle rows — group name, child count,
    granted x/y, and a single grant/revoke-group control. Expanding a group lists
    child capabilities read-only by default; an "Advanced: edit individual grants"
    expander enables per-capability grant/revoke.
  - **Impact preview on every grant/revoke/unlink confirm dialog:** "revoking
    group X denies operations […] for user Y on [surfaces]" — computed server-side
    from the same decision logic the enforcer uses (§6.5 dry-run endpoint).
- **Enforcement indicator:** there is no "enforcement off" banner (there is no off
  state to advertise). The page shows the live enforcement health from the status
  endpoint; a store problem renders as a blocking error, not a silent degrade.
- **Remove:** the 25-row flat grants table as a default view (it's one seed bundle
  expanded), all placeholder subjects, bundle-internals columns
  (`source: bundle:owner_all_seed_expanded · system:admin_seed` — Debug-only), and
  per-row enforcement pills.

### 5.5 Operations (`/operations`)

- **Restart:** target service shown, one "Restart codex-chat" button → single
  confirm dialog → result toast + audit entry. **Keep the server-side exact-approval
  contract unchanged** — the client sends the exact approval phrase
  (`restart codex-chat.service`) programmatically after the confirm dialog. The
  plan-first server behavior, self-service refusal (never restarts
  `brain-admin.service`), redaction, and audit all stay. Remove from the default UI:
  the plan-state panel, operation dropdown, "run without fresh plan" checkbox, and
  redacted-operation-log expander (Debug toggle may expose the raw operation log).
- **Audit:** one merged feed of real events — service operations (restarts, setting
  writes, from Brain's existing admin audit JSONL) and capability audit events
  (grant/revoke/link/unlink from Brain; allow/deny decisions from codex-chat's
  capability decision records). Enforcement makes this **high-volume and
  denial-centric**:
  - Default view: recent **denials** (the actionable signal in a fail-closed
    system); allows behind a filter.
  - Server-side pagination + filters by outcome/actor/operation/type — never an
    unbounded feed.
  - Columns: time, actor, action, target, result, reason. No schema-preview rows,
    no "writes enabled" metadata, no sample-event JSON (Debug toggle reveals raw
    JSONL paths).

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

Components: `brain`, `slack`, `model`, `service`, `capability_enforcement`. All
health interpretation happens server-side (reusing the existing derivations in
`slackTelemetrySummary`, env presence, and last-operation state); the client
renders, never computes. The `capability_enforcement` component reports:
enforcement enabled, store present + schema-valid + last-loaded time, and
recent-denial count; store unreachable/invalid while enforcing = `error`.

### 6.2 Slack setup state (Brain)

Persisted `setupComplete` flag in Brain-private state from day one (no env-var
inference as the source of truth — setup state and enforcement state must not both
be guessed). Exposed via the status endpoint (slack component) and a small
`GET /api/admin/brain/slack/setup` used by the wizard for per-step done/not-done.
Step-4 verification reads codex-chat telemetry (`lastAcceptedEvent` +
`lastOutboundSuccess` in the existing summary — no new codex-chat work needed).
Wizard completion persists the flag; "Reconfigure" clears it.

### 6.3 Structured logging replaces canary/telemetry (codex-chat)

- codex-chat emits JSON-lines events for everything the manual checklist tried to
  capture (inbound accepted/rejected, context decisions, outbound
  attempts/success/failure, subagent routing, redaction checks) to an append-only
  log under `data/state/`, extending the existing telemetry-summary writer. This
  complements the capability decision records the enforcement work already
  persists. No message bodies or secrets in events.
- codex-chat adds an **agent-only** live tail endpoint (SSE or WebSocket) on its
  loopback `api.ts` gateway, API-key-authenticated like `/api/ingest/audio`. The
  admin UI never uses it and Brain does not proxy it.
- Brain keeps reading only summary/decision files for `/status`. After the new UI
  ships, remove Brain's canary store (`slack-canary.json`), its GET/POST
  `/api/admin/brain/slack/canary` endpoints, and the manual-checklist persistence.

### 6.4 Env metadata + validated writes (Brain)

- `GET /api/admin/brain/env/schema`: `[{ key, group, required, secret, description }]`
  — the UI derives all env rendering from this. Source of truth is a schema module
  next to `env-file.ts`, covering the keys the current UI hardcodes (Slack group,
  OpenRouter, model, feature flags) plus an `other` group for unrecognized keys
  present in the env file.
- Writes validate server-side and return field-level errors. Secret values stay
  write-only: API returns presence only, never values. The env-write approval-phrase
  gate is dropped server-side **only when the new React client (with its confirm
  dialog) ships in step 4** — not in step 1, because the legacy console posts env
  writes on a single click and would otherwise have no confirmation at all during
  the transition. The **operation** approval phrase is NOT dropped (§5.5).
- Longer term, codex-chat owns the env schema (`config.ts` zod schema is the real
  source of truth for which keys exist/are required); Brain's schema module is an
  interim measure until §6.7 lets codex-chat validate its own config writes. Keep
  Brain's copy minimal and clearly marked as derived.

### 6.7 codex-chat-owned config write interface (replaces direct-disk env writes)

Brain today writes codex-chat's private storage directly: `admin-service.ts`
hardcodes `/home/tim/.config/codex-chat/env` and merges the file format itself
(`env-file.ts`). That couples Brain to another repo's on-disk format — the kind of
boundary violation Brain's own README forbids — and assumes co-location, blocking a
future remote Brain. Replace it:

- **codex-chat** adds a config-management command on its existing local IPC socket
  (`LocalIpcServer`, `src/ipc.ts`): `set-config { entries }` → validates against
  codex-chat's own schema (`config.ts`), persists atomically to its own env store,
  and returns `{ ok, fieldErrors?, restartRequired }`. Secrets transit the local
  socket write-only and are never returned.
- **Auth caveat:** the IPC socket currently has **no authentication** (socket file
  permissions only), and the enforcement plan's Phase 6 mandates token-mapped IPC
  auth. The config command must land behind that IPC authentication (or, at
  minimum, strict socket ownership/permissions until Phase 6 lands) — a privileged
  config writer on an unauthenticated socket would be a regression.
- **Brain** calls this interface from `POST /api/admin/brain/codex-chat/env` (and
  the model/OpenRouter writers) instead of touching the file. Brain still owns
  restart via the existing operation path; the interface contract is "persist +
  report restart-needed," since env changes only take effect on restart anyway.
- **Direct-disk write is retained as a bootstrap/fallback only** — codex-chat can't
  persist its own config when it isn't running yet. Clearly marked, not the
  default.
- Local IPC is deliberately preferred over a new HTTP route: codex-chat's
  `ApiGateway` refuses non-loopback binding and is browser/Slack-facing; a
  privileged config endpoint there would need new server-to-server auth. IPC is
  the existing same-host privileged channel.
- Sequence this *after* the core §6.1–6.5 work — it's a real cross-repo change,
  not free, and the direct-disk path keeps working meanwhile.

**Appendix — code sites to reroute (verified against current source):**

- Core writer: `apps/web/src/env-file.ts:58` `writeMergedEnvFile()` — already
  atomic (temp-file mode `0o600` → rename) but writes codex-chat's private env
  file directly. All env writers funnel through it; it becomes the fallback-only
  path.
- The four env write handlers, each calling
  `writeMergedEnvFile(config.codexChatEnvFile, …)`:
  1. `handleMainLoopModelWrite` — write at `admin-service.ts:823`
     (`POST /api/admin/brain/codex-chat/main-model`)
  2. `handleOpenRouterSettingsWrite` — write at `admin-service.ts:1003`
     (`POST /api/admin/brain/openrouter/settings`)
  3. `handleEnvWrite` — write at `admin-service.ts:1050`
     (`POST /api/admin/brain/codex-chat/env`)
  4. `handleSlackSettingsWrite` — write at `admin-service.ts:1081`
     (`POST /api/admin/brain/slack/settings`)
- Two config writers with the same rationale (codex-chat/Codex should own these
  writes + validation): `writeOpenRouterCodexProfile` (`admin-service.ts:1222`,
  Codex profile under `codexHomePath`) and `writeCodexChatProviderConfig`
  (`admin-service.ts:1245`, provider TOML at `config.codexChatConfigFile`).
- `config.codexChatEnvFile` (default `/home/tim/.config/codex-chat/env`,
  `admin-service.ts:134`) becomes a fallback pointer, not the default target.
- Explicitly NOT rerouted: `handleOperation` (restart/deploy — Brain keeps owning
  restart) and `writeSlackCanaryStore` (Brain's own store, being deleted per §7,
  not migrated).

### 6.5 Capabilities API (Brain — critical, ASAP)

**One canonical schema.** codex-chat's enforced runtime store is the source of
truth; Brain's admin API reads and writes *that* shape. Delete Brain's parallel
placeholder-foundation types in `apps/web/src/capabilities.ts` — do not render or
invent statuses the enforcer doesn't understand. Concretely, grants Brain writes
must carry `enforcement: "enforcing"` (the authorizer denies anything else),
resource selectors, and `expiresAt`/group semantics matching
`codex-chat/src/capabilities.ts` evaluation. A migration converts the existing
store: drop placeholder subjects/grants, convert retained grants to enforcing form,
back up the pre-migration store.

**Write-path safety rails** (writes hit the live fail-closed store):

- **Atomic, schema-validated, backed-up writes.** Validate against the canonical
  store schema *before* persisting (an invalid store fail-closes the whole
  assistant); temp-file-then-rename (the `writeCapabilityStore` helper pattern
  exists); retain a last-known-good copy for one-step rollback.
- **Impact preview:** every grant/revoke/unlink confirm computes and displays the
  resulting denials/allows for the affected user before the write commits.
- **Dry-run authorize:** `POST /api/admin/brain/capabilities/check` — "would
  subject Y be allowed operation X on resource R?" — evaluated with the same
  semantics as codex-chat's `authorize()`, so the admin can verify before and
  after a change. Highest-value single addition for operating a fail-closed
  system, and cheap because the decision logic exists.
- **Refuse dangerous writes:** reject any write that would leave the store
  schema-invalid or would self-lock-out the admin (revoking the admin's own
  capability-admin access); surface store-unreachable as an error, never a
  silent success.
  Append-only capability audit events for every mutation
  (`capability.grant.applied`, `capability.grant.revoked`, `identity.link.*` —
  vocabulary already defined in `AUDIT_EVENT_TYPES`).

**Endpoints** (all under `/api/admin/brain/`):

- `GET /users` (people with identity + grant summaries), `POST /users`
- `POST /users/:id/identities`, `DELETE /users/:id/identities/:identityId`
  (manual link/unlink: provider + external identifier; server records a
  `manual_admin` proof)
- `GET /capabilities/catalog` (groups → children; the canonical group list the UI
  renders — never hardcoded client-side)
- `POST /users/:id/grants`, `DELETE /users/:id/grants/:grantId` — accepting
  **either** a group id (expands to children server-side, per group semantics) or
  an individual capability id — one API serves both group toggles and advanced
  per-grant editing.
- `POST /capabilities/check` (dry-run authorize, above)
- `GET /audit?type=capability|operations&outcome=&actor=&operation=&cursor=&limit=`
  merged feed with server-side pagination (Brain admin audit JSONL + Brain
  capability audit JSONL + codex-chat capability decision records).

### 6.6 Frontend app + serving (Brain)

- New Vite + React + TypeScript app at `apps/web/ui/` in the pnpm workspace;
  `pnpm run build` builds it after `tsc -b`.
- **Shared types / generated client:** backend and frontend are both TS — share
  request/response types (or a zod-derived client) so "client renders, never
  computes" is type-enforced, not convention. Single error taxonomy from the API:
  field-level validation, store-unavailable, auth — with route-level error and
  loading boundaries in the app.
- **One data-fetching layer** with cache + optimistic writes that reconcile against
  server state (React Query or equivalent) — grant toggles feel instant but always
  settle to what the enforcer actually sees.
- **Clerk migration:** move from CDN `<script>` tags + JSON config blob
  (`admin-page.ts`) to `@clerk/clerk-react`; explicit task, not a drop-in. Same
  fail-closed model: the API rejects non-allowlisted users regardless of what the
  SPA renders; sign-in and access-denied remain server-gated.
- `admin-service.ts` gains a small static handler serving the built assets under
  `/admin` (SPA fallback to `index.html` for the five routes). During development,
  Vite dev server proxies `/api/admin/brain/*` to the local admin service.
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
- All placeholder subjects/rows in capabilities and audit (and their seeds).

Nothing is deleted server-side until the replacement is verified (§8 sequencing).

## 8. Sequencing (reversible steps — do not reorder)

Each step is independently deployable and rollback-safe; the old UI keeps working
until step 6. Because enforcement is live, the old "exercise writes while
non-enforcing" safety net no longer exists — its replacement is: **reads + status +
dry-run authorize first, verified against live enforcement, then writes** behind
the §6.5 rails.

1. **Brain backend:** ship §6.1 status, §6.2 setup state, §6.4 env schema +
   validated writes. Old UI untouched. Extend `admin-service.test.ts`.
2. **Brain backend:** ship §6.5 **reads** — canonical-schema summary, catalog,
   users, paginated audit, dry-run authorize — against the live enforced store.
   Verify dry-run answers match observed codex-chat decisions. Old UI untouched.
3. **Brain backend:** ship §6.5 **writes** — store migration (backed up), atomic
   validated write path, grant/identity mutations with impact preview + audit
   events. Rollback story: restore last-known-good store copy (mirrors the
   enforcement plan's own revert contract).
4. **Frontend:** new React/Vite app with Clerk auth at a parallel path
   (`/admin-v2`): Home + Settings first, then Setup, Users, Operations. Old console
   remains the default. Playwright smoke extends to the new app.
5. **codex-chat:** §6.3 structured logging + agent tail endpoint, and §6.7 IPC
   config command behind IPC auth (its own commits in that repo; `pnpm test` +
   build there); remove stale `dist/admin-*` artifacts. Brain then reroutes env
   writes to the IPC path, keeping direct-disk as the marked bootstrap fallback.
   Brain canary system still present (dual-write period).
6. **Verify:** admin uses `/admin-v2` exclusively for a period; confirm every
   retained workflow (setup, secret write, restart, grant change with impact
   preview, identity link/unlink, dry-run check, denial-centric audit review)
   works end-to-end against live enforcement.
7. **Cut over:** make the new app the default `/admin`; keep the old console
   reachable at a fallback path for one release.
8. **Remove:** old server-rendered console, canary store + endpoints,
   handbook/prompt/business-rules editors, stale placeholder types in
   `capabilities.ts`.

## 9. Invariants

These keep the console safe and maintainable as it grows to N users:

1. The client never computes health or authorization; it renders server decisions.
2. One capability schema — the enforced runtime store codex-chat evaluates. Brain
   writes it; nothing else does; no parallel admin-side model.
3. Every store write is schema-validated, atomic, audited, and backed up
   (last-known-good retained). A write can never leave the store in a state that
   fail-closes the assistant.
4. Secrets are write-only end to end: never echoed by the API, never prefilled,
   never logged — including across the §6.7 IPC boundary.
5. codex-chat owns its own config/env and the capability schema; Brain
   orchestrates, it does not reach into codex-chat's private storage (the marked
   §6.7 bootstrap fallback excepted).

## 10. Out of scope (explicitly)

- Changes to codex-chat's enforcement semantics, operation matrix, or authorizer
  (owned by `codex-chat/plans/2026-07-04-brain-capability-enforcement-plan.md`;
  this plan writes the store those semantics read).
- Multi-admin roles or a non-admin user-facing UI.
- Deploy/rollback operations beyond restart in the UI.
- Any visual re-theming beyond what the simplification implies — dark theme and
  current styling are reused.
- Changes to codex-chat's runtime behavior or its loopback gateway beyond the §6.3
  logging/tail additions and dist cleanup.
