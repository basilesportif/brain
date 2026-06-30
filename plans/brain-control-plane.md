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
- the exact Slack manifest contract, scopes, events, and adapter behavior under
  codex-chat's `slack-app/`; Brain owns the human setup/install runbook;
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

## Slack manifest, setup runbook, and install metadata boundary

Brain owns the human Slack setup/install runbook at
`docs/slack-setup-runbook.md`, including Slack UI steps, install-to-workspace,
secret handoff, env writes/restart semantics, and live canaries. The Slack
manifest contract stays in `codex-chat` because it is coupled to the Slack
adapter and Events API handler. Brain's web UI should be able to access,
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
- expose model-provider configuration status for `codex-chat`: main-loop startup model/provider/profile, subagent default model/provider/profile, per-dispatch override policy and allowlists, service-tier mode, and provider env-key presence metadata;
- render, copy, and download the codex-chat-owned Slack manifest using Brain's public Events URL;
- show resolved repo-registry entries for `brain`, `codex-chat`,
  `assistant-agent-logic`, and `assistant-agent-data` as read-only context;
- show deployed refs, resolved commit SHAs, service names, env file paths, and
  health-check endpoints as metadata;
- show whether local registry pointers match canonical private deployment
  ledger entries;
- clearly separate source checkout, deploy checkout, and private data paths.

### Initial Slack setup wizard plan

The first Brain-admin Slack setup wizard should be a guided wrapper over the
current safe primitives, not a new runtime owner:

1. Confirm the concrete Brain instance, codex-chat checkout/service, and public
   Brain Events URL.
2. Render the codex-chat-owned no-secret manifest and offer copy/download.
3. Guide the operator through Slack app creation/update, manifest paste/upload,
   scope review, and install/reinstall to workspace.
4. Collect `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` as write-only values,
   showing only presence metadata afterward.
5. Require plan-first restart semantics for `codex-chat.service` after env
   writes.
6. Walk through public-channel, DM, private-channel, and MPIM live canaries and
   record non-secret outcomes.

Further instructions are coming for both the admin UI redesign and the Slack
setup wizard redesign; keep this initial wizard plan intentionally conservative
until those instructions arrive.

### Slack installation administration

- render the `codex-chat`-owned Slack manifest for the deployed or selected
  `codex-chat` ref;
- validate that Events API URLs, redirect URLs, scopes, and events match the
  deployed service configuration;
- record non-secret install metadata and workspace mappings;
- verify token/signing-secret presence by metadata only;
- run safe Slack canary plans and display results without exposing token values.

### Future Slack callback/test-event telemetry plan

Status: read-only telemetry plus manual canary rollup implemented as of 2026-06-30. The runtime side remains
strictly observational: `codex-chat` emits append-only, redacted Slack telemetry
observations into its own state directory, and Brain reads the resulting summary
for admin display. Brain still must not claim to own Slack runtime behavior,
signature verification, idempotency, queueing, or Slack Web API sends.

#### 2026-06-29 read-only telemetry slice

This slice intentionally avoids active canaries, Slack API calls from Brain,
runtime retries, queue changes, message routing changes, or secret/body storage.

Implemented/target contract:

- `codex-chat` records metadata-only observations for Slack Events API inbound
  outcomes: last inbound timestamp, event/team/channel/user/type metadata,
  accepted event, duplicate, ignored reason, rejected reason, response class,
  and text length only. It never stores Slack request bodies, challenge values,
  message text, headers, signatures, signing secrets, bot/app tokens, channel
  names, or user names.
- `codex-chat` records outbound reply attempt/success/failure metadata around
  existing Slack reply sends. These hooks are non-blocking and best-effort; a
  telemetry write failure logs a warning and must not affect Slack send control
  flow or error propagation.
- `codex-chat` writes `data/state/slack_telemetry/<day>.jsonl` plus
  `data/state/slack_telemetry/summary.json` under the configured state dir.
  Summary schema starts at `schemaVersion: 1` and includes counters plus
  `lastInboundEvent`, `lastAcceptedEvent`, `lastIgnoredOrRejected`,
  `lastOutboundAttempt`, `lastOutboundSuccess`, `lastOutboundFailure`,
  `lastContextDecision`, and `lastSubagentRouting`.
- Brain exposes `GET /api/admin/brain/slack/telemetry`, which reads the
  `codex-chat` summary file only, sanitizes it again, and returns health,
  recent canary status, source path, counters, and redacted last-observation
  fields for the Clerk-protected admin UI.
- Brain now also exposes `GET/POST /api/admin/brain/slack/canary` and a Clerk-protected
  Slack visibility/canary panel. The panel persists manual operator outcomes in
  Brain private local state (default: next to the audit log as `slack-canary.json`)
  and correlates them with redacted codex-chat telemetry: context source, fallback
  codes, output channel/thread target, inbound/outbound counters, recent errors,
  and subagent callback routing. Brain still does not send Slack messages or run
  active canaries.
- The codex-chat telemetry `recentCanary` field remains `not_observable` until a
  future active canary runner writes dedicated runtime canary markers. Manual
  Brain outcomes are operator-entered status, not automatic Slack proof.

Guardrails:

- Telemetry hooks must be append-only/read-only from Brain's perspective and
  best-effort from `codex-chat`; they must not change Slack ack timing,
  signature verification, normalization, idempotency, enqueue semantics,
  outbound retry behavior, or exception propagation.
- Tests must assert no side effects and no storage/display of message bodies or
  Slack tokens/signatures.
- Deployment of the `codex-chat` telemetry hooks requires a normal
  `codex-chat` restart after build. Brain UI changes may be rebuilt/restarted
  independently through `brain-admin.service`.

#### Boundary and ownership

Brain may observe and report external/control-plane status for Slack callbacks:
public URL reachability, reverse-proxy handoff, event metadata recorded by
`codex-chat`, test-event outcomes, canary status, and recent failure summaries.
Brain may proxy raw Slack requests to `codex-chat` and may record redacted
metadata about that proxy path. Brain must not become the Slack runtime engine,
must not parse business event bodies for runtime behavior, and must not verify
Slack signatures unless a later explicit architecture decision moves that
responsibility. `codex-chat` remains the Slack Events API signature verifier,
idempotency owner, ack/queue/runtime executor, adapter normalizer, and message
send/reply engine.

The preferred integration is a small `codex-chat` runtime-health export or
internal admin endpoint that emits already-verified, redacted metadata. If Brain
observes at the reverse proxy layer, it records only transport metadata and the
upstream result; it does not treat an unverified Slack payload as trusted.

#### Proposed data model

Add Brain private-workspace records, with migrations before durable use:

- `slack_callback_observations`: `id`, `deploymentId`, `teamIdHash`,
  `enterpriseIdHash`, `appIdHash`, `requestKind` (`url_verification`,
  `event_callback`, `slash_command`, `interactive`, `canary`, `unknown`),
  `receivedAt`, `brainProxyTraceId`, `codexChatTraceId`, `httpMethod`,
  `path`, `statusCode`, `upstreamStatusCode`, `ackLatencyMs`,
  `runtimeAccepted` (`yes`, `no`, `unknown`), `signatureVerifiedBy`
  (`codex-chat`, `not_applicable`, `unknown`), `outcome`, `errorClass`,
  `redactionVersion`, `metadataOnly: true`.
- `slack_test_events`: `id`, `deploymentId`, `requestedByAdminId`,
  `createdAt`, `completedAt`, `targetKind` (`slack_url_verification`,
  `public_channel`, `dm`, `private_channel`, `mpim`), `targetRefHash`,
  `testMessageNonceHash`, `expectedCallbackKind`, `result`, `latencyMs`,
  `codexChatRunId`, `observationIds`, `notesRedacted`.
- `slack_callback_health_rollups`: `deploymentId`, `windowStart`,
  `windowEnd`, `totalCallbacks`, `verifiedCallbacks`, `failedCallbacks`,
  `timeoutCallbacks`, `p50AckLatencyMs`, `p95AckLatencyMs`,
  `lastSuccessAt`, `lastFailureAt`, `state`, `reasons`.

Raw Slack headers, signatures, tokens, signing secrets, message text, user text,
file names, channel names, and payload bodies are not stored in Brain. Team,
channel, user, enterprise, app, callback IDs, event IDs, and nonces should be
hashed or reduced to stable opaque references unless an operator explicitly
configures non-sensitive display aliases.

#### Events to capture

Capture only metadata needed to answer “is Slack reaching the running runtime and
is the runtime accepting it?”:

- Slack URL verification challenge request observed and `codex-chat` response
  status/latency, without storing the challenge value.
- Event callback observed, upstream ack status, ack latency, `codex-chat`
  verification result, enqueue/accepted/rejected outcome, duplicate/idempotency
  classification, and coarse event type.
- Runtime canary send attempt, Slack API result class, expected callback
  observation, and timeout/no-callback result.
- Reverse-proxy/network failures: unavailable upstream, non-2xx responses,
  timeout, body-too-large, method/path mismatch, and Caddy/Brain route mismatch.
- Configuration drift observations: public Events URL mismatch, expected path
  mismatch, required env presence changed, selected `codex-chat` ref changed.

#### API and UI surfaces

Potential Brain APIs:

- `GET /api/admin/brain/slack/callback-health` returns current rollup, recent
  redacted observations, state, reasons, and `codex-chat` runtime-health source.
- `GET /api/admin/brain/slack/callback-observations?window=...` returns a
  paginated metadata-only event list for admins.
- `POST /api/admin/brain/slack/test-event` creates a canary plan or starts an
  approved test flow. It requires an exact approval phrase and delegates runtime
  send/receive work to `codex-chat`.
- `GET /api/admin/brain/slack/test-events/:id` returns redacted progress and
  final outcome.

UI additions:

- Mission Control Slack Health card: health state, last verified callback, last
  failure, p95 ack latency, and whether telemetry comes from `codex-chat` or
  Brain proxy metadata.
- Slack Setup verification step: URL verification/test-event status with clear
  “runtime verification is codex-chat-owned” copy.
- Slack diagnostics page: recent observations, filters by event kind/outcome,
  rollup windows, and copyable redacted incident summary.
- Canary runner: choose public channel/DM/private channel/MPIM where Brain has
  non-secret metadata for the target; display planned action before calling
  `codex-chat`; never expose tokens.

#### Privacy and redaction rules

- Never store or display raw `SLACK_SIGNING_SECRET`, bot/app tokens,
  `X-Slack-Signature`, request bodies, challenge strings, authorization headers,
  message text, file content, user-provided text, channel names, or user names.
- Hash Slack IDs with a Brain-private salt when a stable join key is needed;
  rotate/redact according to the private workspace retention policy.
- Store coarse event types and result classes, not payload bodies.
- Keep raw runtime logs in `codex-chat` if they exist; Brain stores links or
  trace IDs plus redacted summaries.
- Default retention: short operational window for observations (for example
  7-30 days) and longer aggregate rollups with no re-identifiable payload data.
- All admin reads and test-event starts are audited with actor, deployment,
  approval phrase result, and redacted target references.

#### Health states

- `not_configured`: required Slack env/settings or public URL are missing.
- `configured_presence_only`: required values are present, but no live callback
  telemetry has been observed in the current window.
- `url_verified`: Slack URL verification reached `codex-chat` successfully.
- `healthy`: recent callback/test-event succeeded and ack latency is within SLO.
- `degraded`: callbacks arrive but failures, duplicate rejections, or latency are
  above threshold.
- `failing`: recent callbacks/test-events fail, time out, or cannot reach
  `codex-chat`.
- `stale`: no callback has been observed beyond the configured freshness window.
- `unknown`: telemetry source is unavailable or schema version is unsupported.

#### Canary and test flow

1. Brain renders a canary plan: target deployment, public Events URL, selected
   canary kind, redacted target reference, expected callback type, timeout, and
   exact approval phrase.
2. After approval, Brain asks `codex-chat` to execute the runtime action or
   records a Slack URL verification attempt initiated by the operator in Slack.
3. `codex-chat` verifies Slack signatures and emits redacted observation/runtime
   metadata with trace IDs.
4. Brain correlates the test event with observations by nonce hash/trace ID,
   updates the result, and shows success, degraded, timeout, or failed with
   redacted reasons.
5. The UI offers next actions: inspect recent observations, rerun canary, review
   manifest URL, check env presence, or run plan-first restart.

#### Rollout steps

1. Document and agree on the `codex-chat` health/telemetry contract first,
   including schema versioning and redaction tests.
2. Add `codex-chat` metadata emission or an internal admin endpoint; verify it
   is post-signature-verification and contains no payload bodies or secrets.
3. Add Brain data migrations/store, ingestion, redaction tests, and retention
   pruning.
4. Add read-only Brain health APIs and UI rollups behind a feature flag; keep the
   existing presence-only UI labels until live data exists.
5. Add approved canary/test-event creation that delegates runtime execution to
   `codex-chat`; ship first with dry-run/plan mode, then live canaries.
6. Backfill no raw data; start observations only after deployment.
7. Promote health state from `configured_presence_only` to live states in the UI
   after successful production canaries and operator review.

### Model-provider defaults and override control plane

Brain should become the operator-facing UI/control plane for `codex-chat` model-provider defaults and policies. `codex-chat` remains the runtime owner for actually resolving a dispatch, enforcing allowlists, launching Codex child processes, and reporting status/detail metadata.

Brain's future model-provider administration should:

- edit redacted `codex-chat` config/env metadata for main-loop startup model/provider/profile and subagent default model/provider/profile;
- manage provider override policy, including per-dispatch override enablement, allowed Codex profiles, allowed model-provider IDs, allowed behavior profiles, and service-tier mode;
- show provider API-key/env-key presence only, never raw values;
- make clear that the main loop remains OpenAI until an operator applies a startup-time provider/model change and restarts `codex-chat`;
- support a subagent pilot workflow first, including one-off per-dispatch override testing for a selected model/provider before promoting it to a default;
- render planned config/env diffs and require explicit approval before writes or restarts;
- after apply/restart, display the active main-loop selection, subagent defaults, recent dispatch overrides, and any allowlist denials from `codex-chat` status/detail surfaces.

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
- [x] Make the web UI a settings-management surface for recurring admin work,
      not merely an occasional setup wizard.
      Initial state-aware operator console includes Slack Setup Mode, Mission
      Control, grouped settings, manifest affordances, and plan-first operations.
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
- [x] Fail closed when Clerk keys or allowed admin emails are absent.

### Phase 2 — move Slack/admin install metadata and contract rendering into Brain

- [x] Add a stable no-secrets way for Brain to render/validate the
      `codex-chat` Slack manifest from a selected `codex-chat` checkout.
- [x] Display Slack manifest and Events API/redirect URL validation in Brain.
      Current validation is config/presence-oriented; live callback health is
      future work below.
- [ ] Store non-secret Slack install metadata in Brain's private workspace.
- [x] Keep manifest ownership and adapter semantics in `codex-chat`.
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

See also `plans/2026-06-27-brain-admin-ui-redesign.md` for the plan-only redesign of the current admin UI information architecture, responsive layout, Slack/settings organization, manifest affordances, deploy/restart safety controls, and audit/status feedback.

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

Status as of 2026-06-30: the visibility/manual canary slice is complete enough
to unblock Phase 5 capability-control-plane planning and UI scaffolding. Brain
shows redacted codex-chat Slack telemetry and a manual/admin-entered Slack canary
rollup; it still does not send Slack messages or change Slack runtime behavior.

- [x] Add initial Slack health/status visibility: Mission Control now shows
      redacted codex-chat Slack telemetry plus a manual visibility/canary rollup.
      Telegram/provider/queue/loop/monitor depth remains future work.
- [ ] Add model-provider defaults UI for `codex-chat`, covering main-loop
      startup settings, subagent defaults, per-dispatch override policy,
      allowlists, env-key presence metadata, and approved apply/restart flow.
- [x] Display safe manual Slack canary outcomes without exposing token values;
      current slice is read-only/manual and does not make Brain send Slack messages.
      Future work: active/scheduled canary runner and automatic Slack proof markers.
- [ ] Record operation outcomes and make failures visible in the admin UI.
- [ ] Keep runtime execution and adapter behavior in `codex-chat`.

### Phase 5 — capability and audit control plane

Status as of 2026-06-30: Phase 5 can start now. The first surface should be a
separate Brain UI tab/section named **Capabilities**, distinct from Slack setup,
Mission Control, Runtime Config, and Audit Log. Start with read-only/manual
control-plane vocabulary before enforcement: a capability catalog, grant model,
resource/action selectors, and audit event shape. No live Slack behavior should
change in this slice.

First MVP Brain UI surface:

- read-only capability catalog grouped by family, for example Slack source
  context, cross-surface output, subagent/repo operations, and administration;
- grant vocabulary for subject, capability ID, resource selector, action, source,
  grantor, expiry/revocation, and reason;
- audit vocabulary for grant proposals, grant/revoke decisions, observed checks,
  denials, output sends, and admin changes;
- clear read-only/manual labels until the model has been validated against real
  Slack/Telegram/admin workflows.

Constraints for Phase 5 startup:

- no breaking current Slack behavior, routing, ack timing, or manual canary flow;
- no secret exposure in UI, logs, audit events, repo files, or prompts;
- capability enforcement must be explicit, fail-closed, and audited when it is
  introduced; prompt text alone is not enforcement;
- manual/admin-only changes come first; do not add self-service grant flows until
  the vocabulary and audit model are validated;
- keep the catalog/store read-only until the model is validated and reviewed;
- `codex-chat` remains the runtime enforcement point for tools, adapter reads,
  output sends, and subagent dispatch; Brain owns admin/catalog/audit surfaces.

First implementation slice after this planning pass:

1. Add/keep the Brain UI **Capabilities** tab with a read-only catalog and grant
   vocabulary.
2. Add a read-only local/private catalog store schema and loader, with seed data
   only; no grant writes and no runtime decisions.
3. Define the first audit event shape (`capability.catalog.viewed`,
   `capability.grant.proposed`, `capability.check.observed`) with redacted
   metadata and correlation IDs.
4. Wire tests around no-secret rendering and no live enforcement paths.

- [ ] Implement Brain-owned actor, bundle, grant, temporary approval, and
      revocation administration after the read-only model is validated.
- [ ] Import or query runtime audit/capability-check records from `codex-chat`.
- [ ] Add audit search by actor, resource, run, subagent, output target, and
      capability.
- [ ] Require explicit admin capabilities for all sensitive Brain actions, only
      after audited enforcement semantics are approved.

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
