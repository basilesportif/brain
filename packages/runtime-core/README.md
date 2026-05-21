# @brain/runtime-core

Provider-neutral and entrypoint-neutral orchestration contracts live here: provider sessions, runtime turns, directive parsing, subagent jobs, persistent runtime state, and lifecycle controls.

This package must not import Codex-, Claude-, Telegram-, web-, or iOS-specific SDKs directly.

## Implemented slices

- Generic provider contracts plus an echo provider for tests/smoke checks.
- Brain directive parsing for `brain-actions` blocks.
- `BrainRuntime` turn handling that routes generic outbound actions back to the originating entrypoint and consumes `dispatch_subagent` actions when a subagent lifecycle port is configured.
- Subagent job schemas, active/terminal status helpers, in-memory and file-backed job stores.
- `FileRuntimeStateStore` for workspace-local JSON/JSONL runtime state under a private workspace state directory.
- `SubagentLifecycle` for provider-neutral queueing, dispatch, running/terminal transitions, cancellation, steering, hydration/abandonment of active persisted jobs, and test/static executor hooks.

## Boundary rules

Runtime-core deals in generic workspaces, entrypoints, providers, jobs, artifacts, and outbound actions. Provider packages own model transport details; entrypoint packages own channel delivery details; workspace data stays outside the repo.
