# Codex-chat -> Brain parity checklist

Date: 2026-05-21  
Status: living migration checklist; priority implementation has started

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
- [~] Live polling/webhook can be assembled through adapter seams, but no `brainctl start telegram` or long-running supervisor exists yet.
- [~] Voice/audio/video attachment download and upload boundaries exist; OpenAI transcription parity from `codex-chat` is not ported.
- [ ] Pairing/admin bootstrap flow equivalent to current one-time `/pair` behavior.
- [ ] Full live Telegram service queueing, user-visible turn timeout/restart messages, and command intercepts (`logs`, `agents`, `employee`, deploy/admin commands).

### 2. Directives and assistant-visible actions

- [x] `brain-actions` directive blocks are parsed, stripped from clean text, and validated.
- [x] Legacy ```codex-chat fences are accepted for migration compatibility.
- [x] Legacy `send_image` and `send_document` normalize to generic `send_artifact`.
- [x] Legacy Telegram `chatId` and `replyToMessageId` fields normalize into Brain outbound targets.
- [x] Legacy `cancel_job`, `steer_subagent`, and `notify_owner` directives normalize to generic Brain actions.
- [x] Runtime consumes `dispatch_subagent`, `cancel_subagent`, and `steer_subagent` through the subagent lifecycle/control port when configured.
- [x] `brainctl directives check` validates directive blocks without executing them.
- [ ] Streaming-safe pre-execution parity for reactions/status while a provider turn is still streaming.
- [ ] User-facing action merge/ack behavior equivalent to `codex-chat` dispatch follow-up summaries.
- [ ] Persistent stored action/idempotency behavior is intentionally **not** ported; replacement prompts must rely on provider output discipline and runtime best effort only.

### 3. Codex provider and app-server live behavior

- [x] Codex provider package hides `exec` and `app-server` mechanics behind runtime-core provider contracts.
- [x] `exec` transport shells out to `codex exec --json`, streams JSONL deltas/finals/status/errors, captures last-message artifacts, supports image attachments, cancellation, and provider-native resume arguments.
- [x] `app-server` transport owns JSON-RPC/WebSocket connection, app-server spawn, initialize, thread start/resume, turn start, deltas/finals, interrupt, steer, health, and resume handle seams.
- [x] `brainctl provider check codex` can instantiate stub, exec, or app-server boundaries without sending real user turns by default.
- [~] Current app-server protocol is best-effort against the observed `codex-chat` seam; it needs a live compatibility pass before cutover.
- [~] Provider-native resume handles are exposed; no Brain turn replay store will be added.
- [ ] Service-level Codex crash detection, restart notification, context reset messaging, and active-user notification parity.
- [ ] Live app-server memory/log introspection parity.

### 4. Subagents

- [x] File and memory job stores, lifecycle queue, concurrency, timeout, cancellation, steering hooks, terminal states, hydration abandonment, active snapshots, and short-ref resolution exist.
- [x] Provider-backed subagent executor runs child work through provider abstraction with artifact dirs and image attachments.
- [x] Runtime dispatches subagents from directives and records job IDs.
- [x] Runtime now consumes normalized cancel/steer directives through the lifecycle control port.
- [~] Static and provider-backed executors are covered by tests; full `codex-chat` child process backend parity is not ported.
- [~] Result routes (`return_to_main`, `send_to_user`, `send_to_admins`, `store_only`, `silent`) are modeled, but user/admin delivery of completed child results needs runtime supervisor work.
- [ ] Telegram/CLI command parity for `agents`, `agent status`, `agent kill`, `agent steer`, backend switching, and rich job formatting.
- [ ] Employee/durable-agent runtime parity; real Employee app-server lifecycle remains out of scope except documented gap.

### 5. Loops and monitors

- [x] Loop and monitor schemas exist.
- [x] Automation runtime validates loop/monitor health and supports safe no-host-scheduler dry runs.
- [x] `brainctl automation validate/run/due` exercises definitions without crontab or watcher side effects.
- [~] Dispatch-subagent loops can be dry-run and unit-tested; no running supervisor dispatch port is installed.
- [ ] Crontab sync parity, monitor tailing/parsing, IPC loop enqueue, and monitor-triggered subagent/user notifications.

### 6. Workspace and assistant packs

- [x] Private workspace boundary is explicit; `workspace/`, `private/`, and `data/` stay placeholder-only in git.
- [x] Workspace config schema enforces single-primary entrypoint, secret-free prompt context, and originating-entrypoint routing.
- [x] Assistant pack schema validates manifests and public-safe skill/prompt/workflow hygiene.
- [x] Core assistant pack contains portable runtime-boundary prompt/workflow/setup guidance.
- [~] Existing `codex-chat/behavior` prompts and subagent profiles are not fully ported; Telegram-specific language needs migration into adapter docs or generic Brain vocabulary.
- [ ] Workspace-local overlays, personal assistant memory, and repo-registry controller state must remain private and be mounted/configured at runtime.

### 7. Generated web pages

- [x] `@brain/web` validates static page packages, rejects path traversal/symlinks/secret-like files/content, publishes to runtime directories, updates a manifest, and prunes by TTL.
- [x] Defaults are portable and local; maintainer-specific `me.galebach.com` paths/domains are not baked in.
- [~] Publisher primitives exist, but `brainctl web` wrappers and live host integration are not implemented.
- [ ] Full `codex-chat-web` publisher deployment path, manifest authority checks, and hosted URL smoke tests.

### 8. Deployment, health, logs, update

- [x] Docs define self-host, deployment, runtime config, testing, provider, web publisher, and private-boundary principles.
- [x] `brainctl doctor`, `config validate`, `secrets check`, `pack validate`, `provider check`, `entrypoint check`, `runtime status`, `runtime smoke`, `directives check`, and automation checks exist.
- [~] `doctor` validates config, pack, private boundaries, toolchain, and a temporary subagent lifecycle self-test.
- [ ] Long-running `brainctl start` / service supervisor equivalent to `codex-chat start`.
- [ ] Health endpoint/CLI parity for live Telegram, provider auth, logs, process state, and strict optional secrets.
- [ ] Log buffer/introspection commands, deploy/update script parity, systemd install/uninstall, rollback, and post-update smoke flow.

### 9. Fresh-server setup

- [x] Docs and assistant-pack skill describe local/remote setup questions, private workspace directories, server prerequisites, provider choice, Telegram bootstrap, secret metadata checks, and no-secrets summaries.
- [~] `brainctl setup` creates local private directory scaffolding only.
- [ ] Fresh Ubuntu bootstrap automation, systemd templates, reverse-proxy/webhook guidance, service env metadata checks, and remote smoke script.

### 10. Migration and smoke tests

- [x] Unit tests cover runtime bridge, directives, subagents, automation, providers, Telegram adapter, assistant packs, and web publisher.
- [x] `brainctl runtime smoke` provides a deterministic no-network fake entrypoint -> runtime -> fake provider -> dispatch test sourced from workspace config.
- [x] `brainctl directives check` provides behavior-pack directive validation without executing actions.
- [~] Migration map exists in prior runtime port plan and this checklist; full cutover smoke matrix is still pending.
- [ ] Live cutover smoke: Telegram send/reply/edit/artifact, Codex exec/app-server turn, subagent dispatch/cancel/steer/result, loop dry-run/dispatch, monitor trigger, web publish, health/log/update rollback.

## Implemented in this pass

- Added this concrete parity checklist.
- Added legacy directive normalization for Telegram target fields, `cancel_job`, `steer_subagent`, and `notify_owner`.
- Added origin-target filling for partial outbound targets so legacy reply/reaction directives can inherit the active entrypoint conversation without hardcoding Telegram.
- Added runtime control consumption for `cancel_subagent` and `steer_subagent` through the subagent lifecycle/control port, without adding persistent idempotency/replay stores.
- Added `brainctl runtime smoke` no-network migration smoke check.
- Added `brainctl directives check` no-execute directive validation.
- Added root CLI tests and included them in `pnpm run check`.
- Updated `docs/brainctl.md` and `docs/testing.md` with the new checks.
