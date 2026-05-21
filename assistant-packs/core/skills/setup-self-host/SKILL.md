---
name: setup-self-host
description: Placeholder self-host setup skill for future Codex/Claude-readable assistant installs.
---

# setup-self-host

Skeleton only. The future skill should guide a user through self-hosting their own assistant server without requiring the maintainer's private workspace, credentials, data, or deployment hosts.

Expected future coverage:

- Prerequisite checks for Node/pnpm, Git, provider CLIs/SDK auth, and server access.
- Private workspace creation outside the public repo.
- Provider choice: Codex or Claude Code SDK/subagents, with provider-specific server details hidden behind provider setup.
- Primary entrypoint choice, initially Telegram, plus optional web/runtime deployment choices.
- Secret entry through local env files or host secret stores, never committed.
- Smoke tests and rollback notes.

## Intended procedure

When this skill becomes active, follow `docs/setup-plan.md`:

1. Run preflight checks and `pnpm run check`.
2. Choose local or remote setup.
3. Create or verify a private workspace outside the checkout.
4. Select one provider: Codex or Claude Code.
5. Select one primary entrypoint, initially Telegram.
6. Generate runtime config from `examples/config/` with placeholders only.
7. Store real secrets in private workspace files or host secret stores.
8. Run config validation and smoke tests.
9. Summarize only metadata; never print secret values.
