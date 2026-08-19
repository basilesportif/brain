# Directory structure

Brain is the control-plane repo first. The tree below includes lab
runtime/provider/entrypoint compatibility packages, but production servant
runtime deployment is planned through separate repo-registry entries for
`codex-chat`, `assistant-agent-logic`, and `assistant-agent-data`/workspace.

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
  workspace/            # Ignored user-owned boundary; production private data lives in assistant-agent-data/workspace.
  private/              # Ignored local-only/private boundary.
  data/                 # Ignored generated/user data boundary.
```

Ownership rules:

- Runtime orchestration can depend on assistant packs, but assistant packs should remain pure content and setup logic that can be inspected without launching private services or accessing private data.
- Entrypoints own channel translation only. Telegram, future web, and future iOS should all map into the same Brain inbound event and outbound action vocabulary.
- Provider adapters own model/runtime execution details. Codex app-server is part of the Codex provider implementation, not a top-level app.


Configuration examples live under `examples/config/` and are public-safe. Real workspace config, adapter secrets, bot tokens, allowlists, and host-specific paths belong in the private workspace or host secret store, not in source control.

The lab Brain workspace state model uses native TypeScript modules and CLI
commands in the in-repo `packages/assistant-logic` package. Control-plane
servant-stack setup must instead resolve the separate `assistant-agent-logic`
repo and `assistant-agent-data` workspace from the repo registry. Lab setup
creates/recognizes:

- `data/todos.json`, `data/projects/` (markdown notes + rebuildable JSON index), `data/crm.json`, and
  `data/reminders.json`;
- `private/documents/metadata.jsonl` plus private document file directories for
  file-save metadata/bytes;
- `instructions/skills/` and `instructions/prompts/` overlays;
- `tasks/` scheduled-task instructions; and
- selected `.claude/repo-registry/` state.

`projects/`, `notes/`, and `documents/metadata/` remain available only as
markdown/resource folders. Do not migrate current markdown notes into JSON or
convert JSON state back to markdown.
