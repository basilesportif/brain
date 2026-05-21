# Self-hosting skeleton

Initial target: users run their own assistant server, one primary entrypoint, and private workspace. SaaS can be considered later.

Future self-host docs should cover:

1. Clone/install `brain`.
2. Create a private workspace outside source control.
3. Choose and authenticate a provider: Codex or Claude Code SDK/subagents.
4. Configure runtime entrypoints explicitly: choose one `primaryEntrypointId`, populate `enabledEntrypoints`, and keep only that entrypoint enabled by default, initially Telegram. Store optional web/runtime env files locally or through host secret stores.
5. Run local smoke tests.
6. Deploy to a user-owned server with documented rollback.

The setup docs and skills should be readable by Codex itself so a Codex subscriber can follow or automate the install.


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
