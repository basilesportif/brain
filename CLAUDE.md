# Claude Code guidance for `brain`

Claude Code should follow the same repository instructions as Codex:

- Start with `AGENTS.md`.
- For setup work, read `docs/setup-plan.md` and then the setup skill at
  `assistant-packs/core/skills/setup-self-host/SKILL.md`; this is the shared
  setup entrypoint for both Codex and Claude Code when started from the repo
  root.
- Start setup by asking whether the user wants a local private workspace or a
  remote Ubuntu server over SSH. For remote setup, use the assistant-agent-logic
  setup-server skill to prepare a dedicated service user before Brain-specific
  config.
- Keep setup provider-agnostic: Codex provider/app-server or Claude Code
  SDK/subagents. Bootstrap Telegram first, and do not require Composio or other
  optional integrations for initial setup.
- Keep private workspace data, env files, credentials, generated artifacts,
  logs, chat transcripts, Telegram IDs, hostnames, and repo-registry state out
  of source control.

This file intentionally stays small so `AGENTS.md` remains the shared source of
truth for both Codex and Claude Code agents.
