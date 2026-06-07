# packages

Lab shared libraries live here. Brain's production role is currently the
control plane for the separate `codex-chat` servant runtime stack; these
packages remain compatibility/test/future-runtime surfaces until explicitly
promoted.

Planned package placeholders:

- `runtime-core/` — provider-neutral orchestration, config, session, job, and event contracts.
- `entrypoint-protocol/` — generic inbound event and outbound action contracts used by Telegram now and future web/iOS entrypoints later.
- `providers/codex/` — adapter for Codex; Codex app-server integration is an implementation detail here.
- `providers/claude-code/` — adapter for Claude Code SDK/subagent execution.
- `assistant-pack-schema/` — validation for prompts, skills, workflows, and setup packs.
- `assistant-logic/` — lab compatibility JSON workspace scripts and resources
  for todos, projects, CRM, reminders, and file-save. The production
  control-plane stack resolves the separate `assistant-agent-logic` repo from
  repo-registry metadata instead of treating this package as vendored source.

- `config/workspace-schema` validates workspace runtime configuration, active entrypoint policy, and prompt-context safety.
