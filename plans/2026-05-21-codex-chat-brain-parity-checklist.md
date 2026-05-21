# Codex-chat -> Brain parity checklist

Date: 2026-05-21  
Status: living migration checklist; supervisor/Telegram bootstrap parity slices added

## Scope and constraints

Sources inspected:

- Current Brain repo in `/home/tim/pkg/tim/brain`.
- Current `codex-chat` repo in `/home/tim/pkg/tim/codex-chat`, limited to source, tests, examples, docs, and behavior packs. No private data, logs, generated artifacts, or secrets were copied.

Hard constraints for this parity track:

- Do **not** implement a persistent turn replay/idempotency store in Brain. Use provider-native resume handles where available and degrade gracefully after restarts.
- Keep real Claude Code SDK/subagent wiring out of scope for now; maintain typed/injectable seams only.
- Do not deploy, install services, mutate crontabs, contact live Telegram, or start live providers from default checks.
- Keep private workspace data, tokens, logs, Telegram IDs, generated artifacts, and deployment notes outside this repo.

## Priority order

1. Safe validation/smoke commands that prove Brain boundaries without live side effects.
2. Directive compatibility needed by existing assistant behavior packs.
3. Telegram live-runtime readiness behind explicit token/API boundaries.
4. Codex provider/app-server parity behind provider package boundaries.
5. Subagent lifecycle parity, including cancellation/steering and result routing.
6. Operations docs/checks for health, logs, update, fresh-server setup, and migration smoke tests.

## Feature-by-feature checklist

Legend:

- `[x]` parity slice implemented or intentionally satisfied.
- `[~]` partial parity exists; replacement can be smoke-tested but is not full live parity.
- `[ ]` remaining gap before replacing current `codex-chat`.

### 1. Telegram live runtime

- [x] Channel-neutral inbound/outbound protocol exists; Telegram maps updates, messages, callbacks, conversations, replies, attachments, and admin allowlists into Brain events/actions.
- [x] Telegram outbound intent mapping covers text, clarifications, artifacts, typing/status, reactions, and edits.
- [x] Token loading supports literal/env/file refs with redacted metadata checks.
- [x] Polling offset persistence stores only Telegram provider-native update offsets.
- [x] Webhook skeleton validates Telegram secret-token headers.
- [~] Live polling/webhook can be assembled through adapter seams, and `brainctl run/start --foreground` can now host the runtime supervisor with explicit Telegram polling flags; systemd/live cutover validation remains pending.
- [~] Voice/audio/video attachment download and upload boundaries exist; OpenAI transcription parity from `codex-chat` is not ported.
- [~] Pairing/admin bootstrap flow has adapter-owned one-time `/pair <code>` state and paired user/chat allowlist support; operator UX/live Telegram validation remains pending.
- [~] Supervisor command intercepts exist for `logs`, `agents`, `agent status/kill/steer`, `employee*`, `health`, and deploy/update safe seams; full live queueing plus timeout/restart notifications remain pending.

### 2. Directives and assistant-visible actions

- [x] `brain-actions` directive blocks are parsed, stripped from clean text, and validated.
- [x] Legacy ```codex-chat fences are accepted for migration compatibility.
- [x] Legacy `send_image` and `send_document` normalize to generic `send_artifact`.
- [x] Legacy Telegram `chatId` and `replyToMessageId` fields normalize into Brain outbound targets.
- [x] Legacy `cancel_job`, `steer_subagent`, and `notify_owner` directives normalize to generic Brain actions.
- [x] Runtime consumes `dispatch_subagent`, `cancel_subagent`, and `steer_subagent` through the subagent lifecycle/control port when configured.
- [x] `brainctl directives check` validates directive blocks without executing them.
- [x] Streaming-safe pre-execution parity for provider-emitted reactions/status while a provider turn is still streaming; supervisor dispatches those transient actions before final text.
- [ ] BLOCKED/PENDING: User-facing action merge/ack behavior equivalent to `codex-chat` dispatch follow-up summaries still needs live behavior comparison.
- [ ] BLOCKED BY DESIGN: Persistent stored action/idempotency behavior is intentionally **not** ported; replacement prompts must rely on provider output discipline and runtime best effort only.

### 3. Codex provider and app-server live behavior

- [x] Codex provider package hides `exec` and `app-server` mechanics behind runtime-core provider contracts.
- [x] `exec` transport shells out to `codex exec --json`, streams JSONL deltas/finals/status/errors, captures last-message artifacts, supports image attachments, cancellation, and provider-native resume arguments.
- [x] `app-server` transport owns JSON-RPC/WebSocket connection, app-server spawn, initialize, thread start/resume, turn start, deltas/finals, interrupt, steer, health, and resume handle seams.
- [x] `brainctl provider check codex` can instantiate stub, exec, or app-server boundaries without sending real user turns by default.
- [~] Current app-server protocol is best-effort against the observed `codex-chat` seam; it needs a live compatibility pass before cutover.
- [~] Provider-native resume handles are exposed; no Brain turn replay store will be added.
- [ ] BLOCKED/PENDING: Service-level Codex crash detection, restart notification, context reset messaging, and active-user notification parity need live provider/runtime validation.
- [ ] BLOCKED/PENDING: Live app-server memory/log introspection parity needs a guarded live app-server pass.

### 4. Subagents

- [x] File and memory job stores, lifecycle queue, concurrency, timeout, cancellation, steering hooks, terminal states, hydration abandonment, active snapshots, and short-ref resolution exist.
- [x] Provider-backed subagent executor runs child work through provider abstraction with artifact dirs and image attachments.
- [x] Runtime dispatches subagents from directives and records job IDs.
- [x] Runtime now consumes normalized cancel/steer directives through the lifecycle control port.
- [~] Static and provider-backed executors are covered by tests; full `codex-chat` child process backend parity is not ported.
- [x] Result routes (`return_to_main`, `send_to_user`, `send_progress_and_return`, `send_to_admins`, `store_only`, `silent`) are modeled and supervisor delivery exists for completed child results without adding persistent turn replay.
- [~] Telegram/CLI command intercept parity exists for `agents`, `agent status`, `agent kill`, and `agent steer`; backend switching is a safe acknowledged seam and rich formatting remains partial.
- [~] Employee/durable-agent runtime parity: durable Employee lifecycle records and chat commands (`employees`, `employee status/start/stop/steer`) exist, but real Employee app-server processes remain out of scope.

### 5. Loops and monitors

- [x] Loop and monitor schemas exist.
- [x] Automation runtime validates loop/monitor health and supports safe no-host-scheduler dry runs.
- [x] `brainctl automation validate/run/due` exercises definitions without crontab or watcher side effects.
- [~] Dispatch-subagent loops can be dry-run and unit-tested; no running supervisor dispatch port is installed.
- [ ] BLOCKED/PENDING: Crontab sync parity, monitor tailing/parsing, IPC loop enqueue, and monitor-triggered subagent/user notifications remain unimplemented.

### 6. Workspace and assistant packs

- [x] Private workspace boundary is explicit; `workspace/`, `private/`, and `data/` stay placeholder-only in git.
- [x] Workspace config schema enforces single-primary entrypoint, secret-free prompt context, and originating-entrypoint routing.
- [x] Assistant pack schema validates manifests and public-safe skill/prompt/workflow hygiene.
- [x] Core assistant pack contains portable runtime-boundary prompt/workflow/setup guidance.
- [~] Existing `codex-chat/behavior` prompts and subagent profiles are not fully ported; Telegram-specific language needs migration into adapter docs or generic Brain vocabulary.
- [ ] BLOCKED BY PRIVATE DATA BOUNDARY: Workspace-local overlays, personal assistant memory, and repo-registry controller state must remain private and be mounted/configured at runtime.

### 7. Generated web pages

- [x] `@brain/web` validates static page packages, rejects path traversal/symlinks/secret-like files/content, publishes to runtime directories, updates a manifest, and prunes by TTL.
- [x] Defaults are portable and local; maintainer-specific `me.galebach.com` paths/domains are not baked in.
- [~] Publisher primitives exist, but `brainctl web` wrappers and live host integration are not implemented.
- [ ] BLOCKED/PENDING: Full `codex-chat-web` publisher deployment path, manifest authority checks, and hosted URL smoke tests remain pending.

### 8. Deployment, health, logs, update

- [x] Docs define self-host, deployment, runtime config, testing, provider, web publisher, and private-boundary principles.
- [x] `brainctl doctor`, `config validate`, `secrets check`, `pack validate`, `provider check`, `entrypoint check`, `runtime status`, `runtime smoke`, `directives check`, and automation checks exist.
- [~] `doctor` validates config, pack, private boundaries, toolchain, and a temporary subagent lifecycle self-test.
- [~] Long-running supervisor shape exists via `brainctl run` and `brainctl start --foreground`; `brainctl start` defaults to a dry-run plan. Full service/systemd equivalence remains pending.
- [~] `brainctl health` CLI inspects config/state/log readiness and supervisor health is available in-process; no HTTP endpoint or full live auth matrix yet.
- [x] Non-mutating operations seams render systemd service units plus preflight/update/restart/rollback/post-update smoke command plans through `brainctl operations plan/systemd`.
- [~] Supervisor JSONL logs, `brainctl logs`, chat `logs`/`introspect`, and deploy/update safe command seams exist; installing/uninstalling systemd units and executing update/rollback remain pending by design.

### 9. Fresh-server setup

- [x] Docs and assistant-pack skill describe local/remote setup questions, private workspace directories, server prerequisites, provider choice, Telegram bootstrap, secret metadata checks, and no-secrets summaries.
- [~] `brainctl setup` creates local private directory scaffolding only.
- [~] Fresh Ubuntu bootstrap automation remains partial: systemd templates and service env metadata/smoke planning exist, but remote bootstrap, reverse-proxy/webhook guidance, and remote smoke execution remain pending.

### 10. Migration and smoke tests

- [x] Unit tests cover runtime bridge, directives, subagents, automation, providers, Telegram adapter, assistant packs, and web publisher.
- [x] `brainctl runtime smoke` provides a deterministic no-network fake entrypoint -> runtime -> fake provider -> dispatch test sourced from workspace config.
- [x] `brainctl directives check` provides behavior-pack directive validation without executing actions.
- [~] Migration map exists in prior runtime port plan and this checklist; full cutover smoke matrix is still pending.
- [~] Additional no-network supervisor smoke covers command intercepts, logs, health, Telegram pairing, subagent status/cancel/steer, subagent result delivery, operations planning, and guarded live-readiness planning; live cutover smoke remains pending for Telegram sends, Codex turns, monitor/web/update rollback execution, and real Employee lifecycle.

## Implemented in this pass

- Added this concrete parity checklist.
- Added legacy directive normalization for Telegram target fields, `cancel_job`, `steer_subagent`, and `notify_owner`.
- Added origin-target filling for partial outbound targets so legacy reply/reaction directives can inherit the active entrypoint conversation without hardcoding Telegram.
- Added runtime control consumption for `cancel_subagent` and `steer_subagent` through the subagent lifecycle/control port, without adding persistent idempotency/replay stores.
- Added `brainctl runtime smoke` no-network migration smoke check.
- Added `brainctl directives check` no-execute directive validation.
- Added root CLI tests and included them in `pnpm run check`.
- Updated `docs/brainctl.md` and `docs/testing.md` with the new checks.


## Implemented in this pass (supervisor/bootstrap slice)

- Added `BrainSupervisor` to host a long-running entrypoint -> runtime -> outbound dispatch loop with health snapshots, structured JSONL logging hooks, graceful stop, and provider/runtime error fallback messages.
- Added `RuntimeCommandInterceptor` for service-level commands before provider turns: `help`, `health`, `logs`/`introspect`, `agents`, `agent status`, `agent kill`, `agent steer`, `agent backend`, `employees`, and safe `update`/`deploy` acknowledgements.
- Added `brainctl start`, `brainctl run`, `brainctl health`, and `brainctl logs` seams. Defaults are fake/no-network and `start` is dry-run unless `--foreground` is supplied; explicit Telegram polling requires token flags.
- Added Telegram one-time pairing state (`FileTelegramPairingStore`) and adapter handling for `/pair <code>` before allowlist filtering, storing only paired user/chat metadata plus temporary private pairing code state.
- Added supervisor/command/Telegram pairing smoke tests and documented the new safe operations seams.

Remaining blockers after this pass:

- No real Claude Code wiring, persistent turn replay/idempotency store, deployment, systemd installation, rollback automation, or Employee app-server lifecycle was added by design.
- Live Telegram/Codex app-server compatibility and user-visible restart/timeout notifications still require a guarded live validation pass.
- Real Employee app-server lifecycle remains intentionally unwired; current Employee commands persist lifecycle records only.

## Implemented in this pass (operations/results/employee slice)

- Added streaming pre-dispatch for provider-emitted `show_status` and `react` actions so the supervisor can update status/reactions before final text.
- Added supervisor subagent result delivery for `return_to_main`, `send_to_user`, `send_progress_and_return`, `send_to_admins`, `store_only`, and `silent` routes, using origin metadata captured at dispatch time.
- Added safe durable Employee lifecycle records plus `employees` and `employee status/start/stop/steer` command handling. This is stateful parity for operator UX, not a real Employee app-server.
- Added `brainctl operations plan` and `brainctl operations systemd` to render non-mutating systemd/update/rollback/post-update smoke plans.
- Added `brainctl validate live` guarded Telegram/Codex readiness planning plus `--run-safe` no-network/no-secret smoke execution.
- Added runtime-core and CLI tests for operations planning, guarded live validation, streaming pre-dispatch, subagent result routing, and Employee lifecycle commands.

Self-audit after this pass: **PARTIAL parity, not full parity**. The replacement is materially closer for safe operator workflows and subagent/user result handling, but live Telegram/Codex app-server cutover, real Employee app-server lifecycle, deployment execution, monitor/web hosted smoke, restart/timeout notifications, and durable turn replay/idempotency (intentionally excluded) are still blockers for declaring practical production parity.

