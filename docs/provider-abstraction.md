# Provider abstraction skeleton

`packages/runtime-core` should define provider-neutral contracts for starting work, streaming events, requesting tools/subagents, handling artifacts, and reporting status.

Provider implementations stay separate:

- `packages/providers/codex` implements those contracts through Codex integration, with any Codex app-server surface treated as an internal implementation detail of this provider package.
- `packages/providers/claude-code` implements those contracts through the Claude Code SDK and subagent mechanism.

Runtime apps and entrypoints should depend on `runtime-core` contracts and select providers through configuration. They should not reach directly into provider-specific SDKs or app-server APIs.

## Current runtime-core seams

`@brain/runtime-core` now exposes two provider-neutral execution seams:

- `ProviderAdapter` / `ProviderSession` for main runtime turns.
- `SubagentExecutor` / `SubagentLifecycle` for queued child work, cancellation, steering, and persisted job state.

`@brain/provider-codex` has a working `stub` transport, a real `exec` transport that shells out to `codex exec --json`, and an experimental `app-server` transport. The app-server transport now owns the best available Codex JSON-RPC/WebSocket protocol seam from the current `codex-chat` implementation: it can connect to `appServerUrl` or spawn `codex app-server --listen`, initialize, start or resume a provider-native thread, run `turn/start`, stream deltas/finals, expose a resume handle, and attempt `turn/steer`/`turn/interrupt`. It deliberately does not persist exact user turns for replay. The exec transport supports cancellation, last-message artifact capture, image attachment handoff, JSONL event mapping, and small provider-native resume handles.

`@brain/provider-claude-code` now exposes typed `sdk` and `subagent` seams. The package can delegate to injected clients and maps streaming/cancel/steer boundaries into runtime-core provider events, but it intentionally does not bundle a concrete Claude Code SDK/subagent dependency yet.

Subagent jobs can run through any provider via `ProviderSubagentExecutor`, so process lifecycle concerns such as artifact directories, provider cancellation, steering, timeout-triggered abort, and terminal result capture stay behind the provider abstraction.

## Crash/restart and resume policy

Brain should not persist exact user turns for replay or maintain a durable turn/idempotency replay store. That adds too much cross-provider state and can diverge from the provider's own conversation/session semantics.

The restart strategy is:

1. Keep only minimal runtime/job state needed to operate queues, subagents, loops, monitors, and provider handles.
2. Let Codex, Claude Code, or another provider resume through its own supported session infrastructure where available.
3. If provider resume is unavailable or unsafe after a crash, degrade gracefully: mark active jobs appropriately, surface the limitation, and ask the user to restart or restate the work from current context.

Provider adapters may record small opaque resume handles when needed, but runtime-core should not store full prompt/turn transcripts for deterministic replay.
