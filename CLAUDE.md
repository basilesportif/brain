# Claude Code guidance for `brain`

Claude Code should follow the same repository instructions as Codex:

- Start with `AGENTS.md`.
- For setup work, stay at the repository root and use the root-level `setup`
  request as the installation/bootstrap entrypoint after reading repo-wide
  `AGENTS.md`. Then read `docs/setup-plan.md` and the setup skill at
  `assistant-packs/core/skills/setup-self-host/SKILL.md`. Do not `cd` into a
  separate setup directory.
- Start setup by asking whether the user wants a local private workspace or a
  remote Ubuntu server over SSH. For remote setup, use the assistant-agent-logic
  setup-server skill to prepare a dedicated service user before Brain-specific
  config.
- Keep setup provider-agnostic where possible, with Codex as the first live
  provider path. Record Claude Code only as a placeholder until real wiring is
  intentionally added. Bootstrap Telegram first with default first-user pairing:
  the first Telegram user/chat to message a newly configured bot becomes the
  paired/admin identity in private state. Do not require Composio or other
  optional integrations for initial setup.
- Keep private workspace data, env files, credentials, generated artifacts,
  logs, chat transcripts, Telegram IDs, hostnames, and repo-registry state out
  of source control.

This file intentionally stays small so `AGENTS.md` remains the shared source of
truth for both Codex and Claude Code agents.
