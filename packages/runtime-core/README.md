# @brain/runtime-core

Provider-neutral and entrypoint-neutral orchestration contracts will live here: jobs, sessions, messages, tool routing, workspace resolution, config schemas, artifact controls, and Brain event models.

This package must not import Codex-, Claude-, Telegram-, web-, or iOS-specific SDKs directly.


## Runtime config contracts to define later

Runtime-core should eventually own schemas for workspace-scoped active entrypoint configuration:

- `primaryEntrypointId` is required for each workspace.
- `enabledEntrypoints` is a map of stable entrypoint IDs to kind, enabled state, display metadata, capability flags, and adapter config references.
- Default outbound routing is `originating-entrypoint`.
- Prompt context exposes generic active-entrypoint metadata and capabilities, never channel secrets.
- `single-primary` mode rejects multiple enabled entrypoints; future `multi-explicit` mode must require deliberate routing/conflict config.

No runtime implementation has been ported yet; see `docs/runtime-configuration.md` for the design skeleton.
