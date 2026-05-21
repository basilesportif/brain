# Directory structure

```text
brain/
  entrypoints/
    telegram/           # Telegram adapter: external updates <-> Brain events/actions.
  apps/
    web/                # Web shell/static publisher; future codex-chat-web extraction.
  packages/
    runtime-core/       # Provider-neutral and entrypoint-neutral orchestration contracts.
    entrypoint-protocol/ # Generic inbound event and outbound action contracts.
    providers/
      codex/            # Codex adapter; Codex app-server details stay behind this package.
      claude-code/      # Claude Code adapter via SDK/subagents.
    assistant-pack-schema/ # Validation for skills/prompts/workflows/setup packs.
  assistant-packs/
    core/               # Pure assistant prompts, skills, workflows, setup docs.
  docs/                 # Architecture, runtime config, migration, and self-host documentation.
  examples/config/      # Public-safe runtime config examples.
  plans/                # Migration plans and decision logs.
  workspace/            # Ignored user-owned workspace boundary.
  private/              # Ignored local-only/private boundary.
  data/                 # Ignored generated/user data boundary.
```

Ownership rules:

- Runtime orchestration can depend on assistant packs, but assistant packs should remain pure content and setup logic that can be inspected without launching private services or accessing private data.
- Entrypoints own channel translation only. Telegram, future web, and future iOS should all map into the same Brain inbound event and outbound action vocabulary.
- Provider adapters own model/runtime execution details. Codex app-server is part of the Codex provider implementation, not a top-level app.


Configuration examples live under `examples/config/` and are public-safe. Real workspace config, adapter secrets, bot tokens, allowlists, and host-specific paths belong in the private workspace or host secret store, not in source control.
