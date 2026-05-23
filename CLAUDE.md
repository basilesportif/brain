# Claude Code guidance for `brain`

Claude Code should follow the same repository instructions as Codex:

- Start with `AGENTS.md`.
- For setup work, stay at the repository root and use the root-level `setup`
  request as the installation/bootstrap entrypoint after reading repo-wide
  `AGENTS.md`. Then read `docs/setup-plan.md` and the setup skill at
  `assistant-packs/core/skills/setup-self-host/SKILL.md`. Do not `cd` into a
  separate setup directory.
- Start setup by inspecting existing non-secret setup context/progress before
  asking first-run questions. Run `pnpm run brainctl setup status --repo
  <repo-root> --workspace <name>` and follow any `private/setup-context.json`
  remote resume probe before asking whether this is local or remote. If no
  progress/context exists, then ask whether the user wants a local private
  workspace or a remote Ubuntu server over SSH. For remote setup, use the
  assistant-agent-logic setup-server skill to prepare a dedicated service user
  before Brain-specific config, and save a non-secret ignored resume pointer in
  `private/setup-context.json` as soon as the remote target is known.
- Keep setup provider-agnostic where possible, with Codex as the first live
  provider path. Record Claude Code only as a placeholder until real wiring is
  intentionally added. Bootstrap Telegram first with default first-user pairing:
  the first Telegram user/chat to message a newly configured bot becomes the
  paired/admin identity in private state. Do not require Composio or other
  optional integrations for initial setup.
- Keep private workspace data, env files, credentials, generated artifacts,
  logs, chat transcripts, Telegram IDs, hostnames, and repo-registry state out
  of source control.
- Provide secret-entry copy/paste commands only as one-use private temporary
  scripts that prompt with hidden input, write to the private server
  env/secret store, and delete themselves. Never echo tokens in shell history,
  chat, logs, command output, or repo files.
- Treat setup progress state as a resume aid, not authority. If saved setup
  progress conflicts with real workspace/remote/server state, or setup cannot
  identify the safe next step, use `brainctl setup reset` to clear only
  `state/setup-progress.json`, then rerun setup inspect/status and guarded
  live/status checks. Reset before guessing or forcing inconsistent state; it
  must not delete secrets, config, backups, logs, documents, provider sessions,
  Telegram state, or other private data.

This file intentionally stays small so `AGENTS.md` remains the shared source of
truth for both Codex and Claude Code agents.
