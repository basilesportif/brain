# @brain/provider-claude-code

Provider adapter boundary for Claude Code. The package keeps Claude-specific SDK/subagent mechanics behind runtime-core provider contracts.

Current state:

- `stub` transport is runtime-compatible and useful for tests/smoke checks.
- `sdk` transport exposes a typed `ClaudeCodeSdkClient` injection seam. Without an injected client it reports degraded health and emits a clear provider error; the runtime does not bundle a Claude SDK dependency yet.
- `subagent` transport exposes a typed `ClaudeCodeSubagentClient` seam with turn streaming plus cancellation/steering hooks. This is ready for the future Claude Code subagent mechanism without leaking it into runtime-core.

The real SDK/subagent implementation remains a provider-package TODO. Runtime and entrypoint packages should depend only on the generic provider interfaces.
