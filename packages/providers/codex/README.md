# @brain/provider-codex

Provider adapter shell for Codex. The adapter implements runtime-core provider contracts while hiding Codex-specific app-server or exec details inside this package.

Current state:

- `stub` transport is runtime-compatible and useful for tests/smoke checks.
- `app-server` and `exec` transports expose typed configuration/session seams and health/error events, but the real transport wiring is still a TODO.

Do not model the Codex app-server as a top-level `apps/` runtime; it is an implementation detail of the Codex provider path.
