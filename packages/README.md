# packages

Shared libraries live here. Keep reusable orchestration contracts provider-neutral and channel-neutral, then implement entrypoint and provider adapters separately.

Planned package placeholders:

- `runtime-core/` — provider-neutral orchestration, config, session, job, and event contracts.
- `entrypoint-protocol/` — generic inbound event and outbound action contracts used by Telegram now and future web/iOS entrypoints later.
- `providers/codex/` — adapter for Codex; Codex app-server integration is an implementation detail here.
- `providers/claude-code/` — adapter for Claude Code SDK/subagent execution.
- `assistant-pack-schema/` — validation for prompts, skills, workflows, and setup packs.
- `assistant-logic/` — vendored/in-repo JSON workspace scripts and resources for todos, projects, CRM, reminders, and file-save.

- `config/workspace-schema` validates workspace runtime configuration, active entrypoint policy, and prompt-context safety.
