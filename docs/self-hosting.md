# Self-hosting skeleton

Initial target: users run their own assistant server, one primary entrypoint, and a private workspace. SaaS can be considered later.

The setup docs and skills should be readable by Codex or Claude Code itself so a user can start either assistant from this repo root and ask it to guide setup.

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
- Telegram bootstrap requires only bot token and admin pairing metadata in a
  private secret boundary. It should be enough to continue future integration
  setup through Telegram after pairing.
- Composio and other third-party integrations are optional follow-ups, never
  required for first bootstrap.

Self-host config should start from `examples/config/runtime.yaml` or `examples/config/runtime.toml`. Operators may predefine disabled future entrypoints, but enabling multiple entrypoints must wait for deliberate `multi-explicit` routing and conflict configuration.

## Agent-driven setup path

Agents should use `docs/setup-plan.md` as the current source of truth for the
future installer contract:

- `brainctl setup` for guided local or remote bootstrap.
- `brainctl doctor` for environment and credential-readiness checks.
- `brainctl config validate` for runtime config validation.
- `brainctl secrets check` for metadata-only secret presence checks.

Until these commands exist, setup work should remain documentation/skeleton-only
or use fake providers and fake entrypoints. Real credentials, hostnames,
Telegram IDs, env files, logs, generated artifacts, and workspace state belong
in the user's private workspace or host secret store, never in source control.
