# @brain/provider-codex

Provider adapter shell for Codex. The adapter implements runtime-core provider contracts while hiding Codex-specific app-server or exec details inside this package.

Current state:

- `stub` transport is runtime-compatible and useful for tests/smoke checks.
- `exec` transport can shell out to `codex exec --json` or a configured Codex-compatible binary, stream JSONL deltas/status/final events into runtime-core provider events, pass prompt text over stdin, pass local image attachments, and report CLI health with `--version`.
- `exec` transport now supports cancellation through `AbortSignal`/`cancelTurn`, captures Codex `--output-last-message` into the runtime artifact directory when one is supplied, emits artifact events for that file, and extracts small provider-native resume handles from Codex JSONL status/completion events.
- `exec resume` argument construction is available through `resumeSessionId`, `resumeLast`, or a runtime `ProviderResumeHandle`; Brain still does not persist exact turn replay state.
- `app-server` transport keeps the app-server boundary internal and now includes an experimental JSON-RPC/WebSocket client based on the current `codex-chat` protocol seam. It can connect to `appServerUrl` or spawn `codex app-server --listen`, initialize, start/resume provider-native threads, run turns, stream deltas/finals, expose resume handles, and attempt steer/interrupt requests. An injectable WebSocket seam remains for tests.

Exec transport does not force `--ephemeral` by default. Brain should rely on Codex's own session/resume infrastructure where possible after a restart instead of persisting exact turn replay state in runtime-core.

Do not model the Codex app-server as a top-level `apps/` runtime; it is an implementation detail of the Codex provider path.
