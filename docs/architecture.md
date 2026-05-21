# Architecture skeleton

`brain` should separate the assistant system into four layers:

1. **Entrypoints** in `entrypoints/` — channel adapters that translate external traffic into Brain inbound events and Brain outbound actions back to the channel.
2. **Runtime apps** in `apps/` — durable app surfaces such as the web shell/static publisher; channel ingress does not live here.
3. **Reusable packages** in `packages/` — provider-neutral and entrypoint-neutral contracts plus provider adapters.
4. **Assistant packs** in `assistant-packs/` — prompts, skills, workflows, and setup docs.

The runtime must load user-owned workspace state from a private boundary and load public-safe assistant pack content from source-controlled packs. Entrypoint-specific concerns, such as Telegram chat IDs or future web/iOS session IDs, should be normalized at the edge. Provider-specific execution belongs behind adapters so Codex and Claude Code can share orchestration logic.

Initial routing policy should be simple: one primary active entrypoint per workspace. The entrypoint protocol should still include entrypoint IDs and channel metadata so multiple simultaneous entrypoints can be added later without rewriting assistant packs.


## Runtime configuration boundary

Runtime configuration should be explicit and workspace-scoped. Each workspace defaults to a single primary active entrypoint, declared by `primaryEntrypointId` and an `enabledEntrypoints` map. Generic runtime code should load active-entrypoint metadata for prompts and routing, while adapter secrets and channel-specific details stay behind each entrypoint package.

Outbound actions produced while processing an inbound event should route to the originating entrypoint by default. Cross-entrypoint sends, notifications, or handoffs require deliberate configuration and validation. Multiple active entrypoints are a future capability, not an implicit side effect of configuring more than one adapter.

See `docs/runtime-configuration.md` and `examples/config/` for the draft YAML/TOML shape, validation rules, and Telegram migration notes.
