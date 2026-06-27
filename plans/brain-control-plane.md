# Brain web/admin control-plane plan

Date: 2026-06-26
Status: architecture decision and phased implementation plan; Phase 3 skeleton started

## Decision

Brain is the long-term project home and always-on web/admin control plane for
`codex-chat` and company-brain operations. Distinguish the abstract Brain
project/repo from each concrete Brain instance: an instance runs as a web
service and owns env/settings for the local or remote `codex-chat`,
`assistant-agent-logic`, workspace, env files, and services it controls. The
repo registry is useful context, not the source of truth for a running instance.
The current concrete instance for this conversation is `tim-main-brain` on
`codex-chat-assistant-1` (`178.104.208.141`), serving
`https://brain.decisive-outcomes.com/admin` via `brain-admin.service`.
`codex-chat` remains the servant runtime: it owns channel/runtime adapters, the exact Slack manifest contract,
Slack Events API handling, `ActorContext`/`OutputTarget` runtime behavior,
Slack send/reply behavior, and subagent/runtime orchestration. Slack is another
`codex-chat` surface adapter, not a separate Brain runtime.

Brain should grow from CLI/setup orchestration into a persistent admin service
that can inspect, configure, deploy, restart, and audit the servant stack while
preserving repository boundaries. This is not an occasional setup screen: the
Brain web/admin UI should become a heavily used settings-management surface for
day-to-day control-plane operations. It may also host a guided, sequential
Brain setup/install workflow from the web UI, while still allowing setup from
Codex sessions when that is faster or easier for the operator. The control plane
may render or use contracts owned by `codex-chat` (for example the Slack
manifest), but it must not silently fork those contracts or become the source
of truth for adapter semantics.

## Ownership boundaries

### Brain owns long-term admin/control-plane concerns

Brain should eventually own:

- the always-on web/admin service and project/control-plane home;
- heavily used settings-management workflows for everyday admin operations;
- guided/sequential Brain setup and install flows in the web UI, with
  Codex-session setup remaining available as an operator-friendly alternative;
- Slack installation metadata records, workspace mappings, and non-secret
  install state;
- environment/configuration management, including secret-reference metadata and
  safe rendering of service env files without printing secret values;
- deploy, update, rollback, restart, and health-check orchestration for
  `codex-chat` and related repos;
- Clerk authentication policy, server-side admin allowlists, and fail-closed
  admin authorization defaults;
- capability, bundle, approval, revocation, and audit administration;
- job, queue, loop, monitor, and subagent operational views;
- `assistant-agent-logic` checkout/ref/version selection and validation for a
  deployed servant stack;
- canonical deployment metadata and operations history in the private Brain
  workspace ledger.

### `codex-chat` keeps runtime adapter and contract concerns

`codex-chat` remains responsible for:

- Slack adapter implementation and Slack Events API request verification,
  idempotency, fast ack, queuing, and event normalization;
- Slack send/reply/progress rendering behavior;
- the exact Slack manifest contract, scopes, events, and adapter runbook in
  `slack-app/`;
- `ActorContext`, `OutputTarget`, `RunContext`, conversation/session behavior,
  runtime-owned Slack tools, and output routing semantics;
- subagent, loop, monitor, and runtime orchestration behavior;
- Telegram and future surface adapters unless/until a generic Brain runtime
  component deliberately graduates.

### `assistant-agent-logic` keeps assistant behavior

Assistant workflows, prompts, skills, scripts, and company-brain domain behavior
remain in `assistant-agent-logic`. Brain may select and validate the checkout
used by a deployment, but should not vendor or rewrite those workflows as
control-plane code.

## Slack manifest and install metadata boundary

The Slack manifest contract stays in `codex-chat` because it is coupled to the
Slack adapter and Events API handler. Brain's web UI should be able to access,
render, validate, and copy/download that manifest by calling a stable contract
surface exposed by the checked-out `codex-chat` version. The public Slack Events URL is `https://brain.decisive-outcomes.com/api/slack/events`; Brain reverse-proxies that raw request to codex-chat's internal API on `127.0.0.1:49346` without taking over signature verification or runtime behavior. Acceptable manifest contract sources include:

1. a checked-in manifest/template path under `codex-chat/slack-app/`;
2. a no-secrets validation/render command in `codex-chat`; or
3. a small package/export if the manifest contract later needs typed reuse.

Brain should store Slack install metadata separately from the manifest contract:
workspace/team IDs, enterprise IDs, installer/admin actors, install timestamps,
selected channel mappings, configured redirect/event URLs, health state, and
secret-reference names. Raw Slack tokens and signing secrets must remain in the
private secret store/env layer and must never be committed or displayed.

This separation lets Brain show an install/admin experience without making the
Brain repo the owner of Slack adapter details.

## Removed codex-chat admin surface

The Clerk-protected `/admin/codex-chat/`, codex-chat-hosted `/admin`, and
`/api/admin/codex-chat/*` bootstrap surfaces are retired for this transition.
Brain owns `/admin`, `/api/admin/brain/*`, and the external Slack app surface on `brain.decisive-outcomes.com`; codex-chat keeps internal runtime APIs such
as Slack Events and audio ingest. This is intentionally breaking rather than a
compatibility redirect period.

Brain can still render/validate the codex-chat-owned Slack manifest by using the
selected codex-chat checkout's no-secret `slack-app/` scripts or a future stable
package/export. Durable operations and policy belong in Brain.

## Target Brain web/admin service

The always-on Brain service should provide a Clerk-authenticated admin UI and
API with these modules:

### Stack overview

- show the concrete Brain instance name/host/IP and explicitly state that
  instance env/settings are authoritative for that running service;
- show local or remote `codex-chat` host/IP/path/service/env/config selected by
  the instance, not by stale repo-registry deployment records;
- expose an explicit Slack settings panel for `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, optional `SLACK_APP_TOKEN`, `CODEX_CHAT_SLACK_ENABLED`, `CODEX_CHAT_SLACK_EVENTS_PATH`, and `CODEX_CHAT_BASE_URL`, with values write-only and presence-only;
- render, copy, and download the codex-chat-owned Slack manifest using Brain's public Events URL;
- show resolved repo-registry entries for `brain`, `codex-chat`,
  `assistant-agent-logic`, and `assistant-agent-data` as read-only context;
- show deployed refs, resolved commit SHAs, service names, env file paths, and
  health-check endpoints as metadata;
- show whether local registry pointers match canonical private deployment
  ledger entries;
- clearly separate source checkout, deploy checkout, and private data paths.

### Slack installation administration

- render the `codex-chat`-owned Slack manifest for the deployed or selected
  `codex-chat` ref;
- validate that Events API URLs, redirect URLs, scopes, and events match the
  deployed service configuration;
- record non-secret install metadata and workspace mappings;
- verify token/signing-secret presence by metadata only;
- run safe Slack canary plans and display results without exposing token values.

### Environment and secrets metadata

- manage env var names, secret-reference names, file paths, required/optional
  flags, and validation status;
- render env/config diffs as redacted metadata;
- require explicit approval before writing service env files;
- never print, diff, or store raw secret values in git, logs, audit records, or
  browser responses.

### Deploy/restart orchestration

- select `codex-chat` and `assistant-agent-logic` refs/branches/tags/SHAs;
- clone/fetch/update checkouts using repo-registry authority;
- install dependencies from the selected checkout lockfiles;
- build and smoke-test before restart;
- render systemd/reverse-proxy/update plans;
- gate live restart/rollback/health actions with explicit approvals;
- record requested refs and resolved SHAs in the deployment ledger.

### Health and operations

- display `codex-chat` HTTP/service health, Slack Events API readiness,
  Telegram readiness, queue depth, subagent status, loop/monitor status, and
  recent failed jobs;
- support restart, rollback, retry failed operation, and canary actions through
  audited control-plane operations;
- preserve `codex-chat` as the runtime executor for adapter and subagent work.

### Capability, approval, and audit administration

- manage actors, identity mappings, dashboard admins, Slack users, Telegram
  users, and system actors;
- create capability bundles and expand them into individual auditable grants;
- support temporary grants and approval flows;
- browse grant creation/use/denial/revocation audit records;
- show which run/subagent/tool/output event used or was denied a capability;
- fail closed when no allowed dashboard admins are configured.

### Assistant logic checkout selection

- show the `assistant-agent-logic` checkout selected for each deployment;
- validate package dependencies and required workflow modules;
- record selected ref and resolved SHA;
- let operators compare available refs before applying a deployment;
- never copy assistant workflows into Brain as the canonical implementation.

## Data model sketch

The private Brain workspace should eventually hold durable records for:

- deployments: stack ID, environment, service names, selected refs, resolved
  SHAs, status, health state, and last operation IDs;
- Slack installs: workspace/team metadata, enterprise metadata, app IDs,
  installer/admin actor IDs, event/redirect URL metadata, secret-reference names,
  and validation state;
- environment metadata: required keys, secret refs, destination files, ownership,
  permissions, validation timestamps, and redacted hashes where safe;
- capabilities: grants, bundles, subjects, resources, expirations, and grantor
  metadata;
- audit events: inbound admin action, plan rendering, approval, config write,
  deploy action, restart, health check, capability change, and runtime audit
  summaries imported or linked from `codex-chat`.

JSON export/import is acceptable for early prototypes and tests, but long-term
operation should use a durable store with migrations, indexes, and revocation
history. The canonical deployment ledger described in `docs/control-plane.md`
remains the first deployment-state source of truth while the richer store is
introduced.

## Phased implementation plan

### Phase 0 — document boundaries and keep bootstrap safe

- [x] Keep `codex-chat` as the production servant runtime.
- [x] Keep Brain as the setup/control-plane repository.
- [x] Retire the `codex-chat` admin page instead of preserving bootstrap
      compatibility.
- [ ] Add explicit Brain/codex-chat links so contributors find this plan before
      extending admin surfaces.

### Phase 1 — promote Brain to the long-running web/admin control plane

This is the next strategic implementation phase. Build Brain as the persistent
server process/web app and orchestrator/control-plane on the server, not as a
late cleanup after more `codex-chat` admin surface grows. The first version can
be incremental, but it should establish Brain as the operator home for heavily
used settings management and daily control-plane actions.

- [x] Add a Brain web service skeleton that can run persistently behind Clerk.
      Initial implementation: `@brain/web` exposes `brain-web-admin` /
      `pnpm run brain-admin` with server-side Clerk auth and fail-closed email
      allowlist.
- [ ] Make the web UI a settings-management surface for recurring admin work,
      not merely an occasional setup wizard.
- [ ] Design the tradeoff between guided/sequential Brain setup/install flows in
      the web UI and setup driven from Codex sessions; support both paths when
      each is the easier operator experience.
- [ ] Resolve repo-registry and deployment-ledger metadata read-only.
- [ ] Show deployed `codex-chat` and `assistant-agent-logic` refs/SHAs, service
      names, health metadata, and safe env-key presence.
- [x] Own Clerk/admin policy, server-side allowlists, and fail-closed defaults
      for the initial Brain admin service.
- [ ] Start the Brain-owned private records for install metadata, env/deploy
      metadata, operations history, capability/audit planning, and selected
      `assistant-agent-logic` checkout/ref/version.
- [ ] Fail closed when Clerk keys or allowed admin emails are absent.

### Phase 2 — move Slack/admin install metadata and contract rendering into Brain

- [ ] Add a stable no-secrets way for Brain to render/validate the
      `codex-chat` Slack manifest from a selected `codex-chat` checkout.
- [ ] Display Slack manifest and Events API/redirect URL validation in Brain.
- [ ] Store non-secret Slack install metadata in Brain's private workspace.
- [ ] Keep manifest ownership and adapter semantics in `codex-chat`.
- [x] Remove reliance on the `codex-chat` `/admin/codex-chat/` page; migrate
      near-term admin/control-plane functions into Brain instead of expanding
      that page.

### Phase 3 — env/config and deploy/restart orchestration

- [x] Add redacted env/config metadata views and validation.
      Initial implementation shows codex-chat env key presence only and keeps
      values write-only.
- [x] Render deploy/restart/update plans for `codex-chat` and
      `assistant-agent-logic` without mutating by default.
      Initial operation API exposes a dry-run plan endpoint and configurable
      deploy/restart command display.
- [x] Gate config writes and service operations with explicit approvals.
- [x] Add approved restart orchestration for `codex-chat.service`.
      Rollback remains future work; restart is guarded against targeting the
      Brain service itself.
- [ ] Clone/fetch/update selected checkouts using repo-registry authority,
      install dependencies from lockfiles, and record requested refs plus
      resolved SHAs in the private deployment ledger.


## Phase 3 implementation note — 2026-06-27

The first real Brain-owned HTTP/admin skeleton has started in `apps/web`. It is
not a codex-chat admin expansion. Current capabilities are intentionally narrow:

- Clerk-protected `/admin` and `/api/admin/brain/*` routes with fail-closed
  server-side email allowlist.
- health/settings views for Brain auth, concrete instance host/IP/workspace
  paths, local codex-chat host/IP/path/service/env/config metadata, repo-registry
  read-only context, and operation configuration.
- write-only codex-chat env/config entry writes with an allowlist and explicit
  approval phrase.
- approved plan/deploy/restart operation APIs for `codex-chat.service`, with
  deployment command supplied by server env and audit records that do not include
  secret values.

2026-06-27 clarification: the `tim-main-brain` deployed instance runs beside the active local
`codex-chat.service` on `codex-chat-assistant-1` (`178.104.208.141`) and should
show/control `/home/tim/pkg/tim/codex-chat`,
`/home/tim/pkg/tim/assistant-agent-logic`, and
`/home/tim/.assistant-claude/workspace` from instance settings/env. Do not treat
repo-registry remote deploy targets as authoritative for this instance.

Remaining Phase 3 work: richer rollback, checkout/ref selection, lockfile
install/build orchestration, assistant-agent-logic validation from selected refs,
and canonical deployment-ledger writes beyond the initial JSONL audit trail.

### Phase 4 — health, status, canaries, and operations

- [ ] Add Slack, Telegram, provider, queue, loop/monitor, and subagent
      health/status views.
- [ ] Run safe Slack canary plans and display outcomes without exposing token
      values.
- [ ] Record operation outcomes and make failures visible in the admin UI.
- [ ] Keep runtime execution and adapter behavior in `codex-chat`.

### Phase 5 — capability and audit control plane

- [ ] Implement Brain-owned actor, bundle, grant, temporary approval, and
      revocation administration.
- [ ] Import or query runtime audit/capability-check records from `codex-chat`.
- [ ] Add audit search by actor, resource, run, subagent, output target, and
      capability.
- [ ] Require explicit admin capabilities for all sensitive Brain actions.

### Phase 6 — keep codex-chat runtime-only

- [x] Move durable Slack install metadata, env management, deploy/restart,
      health dashboards, Clerk/admin policy, capability, and audit operations to
      Brain's side of the boundary for this transition.
- [x] Leave `codex-chat` with runtime APIs/contracts only where necessary.
- [ ] Treat Brain as the operator entrypoint for company-brain control-plane
      work and `codex-chat` as the runtime adapter/service implementation.

## Non-goals and guardrails

- Do not vendor `codex-chat`, `assistant-agent-logic`, or
  `assistant-agent-data` into Brain.
- Do not reimplement Slack adapter behavior or fork the Slack manifest contract
  in Brain.
- Do not store raw Slack, Clerk, Telegram, provider, or SSH secrets in Brain git,
  browser responses, logs, or audit text.
- Do not move assistant/company-brain prompts or skills into Brain.
- Do not restore the removed `codex-chat` bootstrap admin page or compatibility redirects; Brain owns admin.
- Do not run live deploy/restart/health mutations without explicit approval and
  redacted audit records.
