# Provider abstraction skeleton

`packages/runtime-core` should define provider-neutral contracts for starting work, streaming events, requesting tools/subagents, handling artifacts, and reporting status.

Provider implementations stay separate:

- `packages/providers/codex` implements those contracts through Codex integration, with any Codex app-server surface treated as an internal implementation detail of this provider package.
- `packages/providers/claude-code` implements those contracts through the Claude Code SDK and subagent mechanism.

Runtime apps and entrypoints should depend on `runtime-core` contracts and select providers through configuration. They should not reach directly into provider-specific SDKs or app-server APIs.
