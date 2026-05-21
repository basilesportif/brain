# @brain/runtime-core

Provider-neutral and entrypoint-neutral orchestration contracts live here: provider sessions, runtime turns, directive parsing, subagent jobs, persistent runtime state, and lifecycle controls.

This package must not import Codex-, Claude-, Telegram-, web-, or iOS-specific SDKs directly.

## Implemented slices

- Generic provider contracts plus an echo provider for tests/smoke checks.
- Generic entrypoint bridge that connects entrypoint inbound event streams to runtime turns and dispatches resulting outbound actions.
- `BrainSupervisor` for a long-running foreground entrypoint/runtime loop with health snapshots, structured log hooks, graceful stop, and error fallback sends.
- `RuntimeCommandInterceptor` for service-level `help`, `health`, `logs`, `agents`, `agent status/kill/steer`, deploy/update safe seams, and Employee/backend placeholder commands before provider turns.
- Fake entrypoint and fake provider helpers for no-network end-to-end smoke tests.
- Brain directive parsing for `brain-actions` blocks.
- `BrainRuntime` turn handling that routes generic outbound actions back to the originating entrypoint and consumes `dispatch_subagent` actions when a subagent lifecycle port is configured.
- Subagent job schemas, active/terminal status helpers, in-memory and file-backed job stores.
- `FileRuntimeStateStore` for workspace-local JSON/JSONL runtime state under a private workspace state directory.
- `SubagentLifecycle` for provider-neutral queueing, dispatch, running/terminal transitions, cancellation, steering, hydration/abandonment of active persisted jobs, and test/static executor hooks.
- `ProviderSubagentExecutor` for running subagent jobs through any `ProviderAdapter` with artifact directories, image attachments, cancellation, steering, and terminal result capture.
- `AutomationRuntime` for loop/monitor health, cron-expression validation, due-loop evaluation, and dry-run/manual dispatch of subagent loops without installing crontabs, file watchers, or host services.

## Boundary rules

Runtime-core deals in generic workspaces, entrypoints, providers, jobs, artifacts, and outbound actions. Provider packages own model transport details; entrypoint packages own channel delivery details; workspace data stays outside the repo.

Runtime-core intentionally does not add a durable exact-turn replay/idempotency store. Crash/restart recovery should prefer provider-native resume handles where available and otherwise degrade gracefully while preserving only minimal job/runtime state needed for operations.
