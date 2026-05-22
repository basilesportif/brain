# Self-hosting

Initial target: users run their own assistant server, one primary entrypoint, and a private workspace. SaaS can be considered later.

The setup docs and skills should be readable by Codex or Claude Code itself so a user can clone/open this repo root, say `setup`, and let the agent ask local vs remote before continuing. Agents should not ask users to `cd` into a separate setup directory.

## Supported first setup paths

1. **Local private workspace**
   - Clone/open this repo locally.
   - Create a private workspace outside the checkout.
   - Choose one provider: Codex or Claude Code SDK/subagents.
   - Configure Telegram as the single primary entrypoint, or use fake config for
     smoke testing only.
2. **Remote Ubuntu server over SSH**
   - Add or reuse a local SSH config host alias.
   - Prepare the server with its own non-root Brain service user using
     `/home/tim/pkg/tim/assistant-agent-logic/config/skills/setup-server.md`.
   - Clone Brain, create a private workspace outside the checkout, install
     prerequisites, and prepare service metadata.
   - Assume a server-side SSH key for Git/provider access already exists; if it
     does not, pause for the user to add one.

## Provider and entrypoint policy

- Provider setup remains provider-agnostic at the runtime layer:
  - Codex provider hides Codex app-server details behind its adapter boundary.
  - Claude Code provider hides SDK/subagent mechanics behind its adapter boundary.
- Initial entrypoint should be Telegram as `telegram-main` in single-primary
  mode unless the user explicitly chooses a fake smoke-test entrypoint.
- Telegram bootstrap requires only bot token plus first-user admin pairing state
  in a private boundary by default. Explicit admin allowlists and optional
  `/pair` code bootstrap remain advanced paths. This should be enough to
  continue future integration setup through Telegram after pairing.
- Composio and other third-party integrations are optional follow-ups, never
  required for first bootstrap.
- Running setup again should always offer missing optional components without
  overwriting existing private config: private Git/local-snapshot backup, web
  publishing, Google Calendar/chat via Composio, provider/entrypoint refs, and
  other integrations.

Self-host config should start from `examples/config/runtime.yaml` or `examples/config/runtime.toml`. Operators may predefine disabled future entrypoints, but enabling multiple entrypoints must wait for deliberate `multi-explicit` routing and conflict configuration.

## Agent-driven setup path

Agents should use root-level `AGENTS.md`, `CLAUDE.md` when running under Claude Code, `docs/setup-plan.md`, and `assistant-packs/core/skills/setup-self-host/SKILL.md` as the current source of truth for the safe setup contract. The canonical user command is `setup` from the repository root:

- `brainctl setup` for local private workspace scaffolding.
- `brainctl setup inspect/status` for idempotent configured/missing/unsafe
  setup plans.
- `brainctl backup plan/init/check/status` for private workspace backup setup.
- `brainctl web setup/status` for domain vs direct-IP generated-page publishing
  checks; DNS and Caddy changes stay manual/operator-confirmed.
- `brainctl composio setup/status` for optional Google Calendar/chat metadata
  refs via Composio without real credentials.
- `brainctl doctor` for environment and credential-readiness checks.
- `brainctl config validate` for runtime config validation.
- `brainctl secrets check` for metadata-only secret presence checks.
- `brainctl operations validate/systemd` for non-mutating deployment readiness.

Setup work should prepare and validate private config, then stop before live
service installation/start unless the user explicitly confirms. Use
`brainctl run --fake --once --fake-text help` for fake smoke tests. Real
credentials, hostnames, Telegram IDs, env files, logs, generated artifacts, and
workspace state belong in the user's private workspace or host secret store,
never in source control.
