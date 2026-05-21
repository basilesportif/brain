# Setup plan skeleton

Goal: a user can open this repo with Codex or Claude Code, say "make this work",
and the agent can find enough public-safe instructions to complete a first local
or self-hosted install without access to the maintainer's private workspace.

Status: design documentation only. `brainctl` and runtime packages are not
implemented yet.

## Agent entrypoints

1. Read `AGENTS.md`. Claude Code should also see `CLAUDE.md`, which delegates to
   the shared guidance.
2. Read this setup plan.
3. Read `assistant-packs/core/skills/setup-self-host/SKILL.md`.
4. Run `pnpm run check` before and after any setup-documentation changes.
5. Refuse to copy private data into git. Use placeholders in source and put real
   config in the user's private workspace or host secret store.

## Future `brainctl setup` flow

`brainctl setup` should be the primary guided installer. It should be safe to run
interactively by a human or by Codex/Claude Code acting on the user's machine.

Proposed phases:

1. **Preflight**
   - Check Node, pnpm, Git, supported OS, and write permissions.
   - Detect whether the repo is clean enough to modify.
   - Verify no private boundary files are tracked.
2. **Workspace creation**
   - Default to a workspace outside the source checkout, for example a user
     supplied path or `/srv/brain/workspaces/<name>` on a server.
   - Create subdirectories for config, secrets, logs, artifacts, and runtime
     state with restrictive permissions.
   - Never place real workspace contents under checked-in `workspace/`,
     `private/`, or `data/`.
3. **Provider selection**
   - Ask for one provider: `codex` or `claude-code`.
   - Store only a provider identifier in runtime config.
   - Keep provider auth setup inside provider-specific adapters and local secret
     storage; never serialize API tokens into repo files.
4. **Entrypoint selection**
   - Ask for one primary entrypoint. Initial supported target is Telegram.
   - Generate runtime config from `examples/config/runtime.yaml` or
     `examples/config/runtime.toml`.
   - Require `primaryEntrypointId` and exactly one enabled entrypoint in
     `single-primary` mode.
5. **Secrets**
   - Prompt the user for secrets or point to an existing host secret store.
   - Write local env/config files only inside the private workspace with `0600`
     permissions, or install secrets into a host-managed secret store.
   - Redact secrets from logs and setup summaries.
6. **Local smoke test**
   - Validate config.
   - Start the runtime with a fake provider/entrypoint if real credentials are
     absent.
   - If credentials are present, run a minimal provider and entrypoint health
     check without sending unsolicited user-visible messages.
7. **Optional remote bootstrap**
   - Ask for a host and target directory, then create the remote workspace and
     deployment checkout.
   - Install prerequisites, copy public source or pull from git, install
     dependencies, and install secrets through the selected host mechanism.
   - Configure a process manager (`systemd` or Docker), health checks, logs, and
     rollback notes.

## CLI shape

Initial commands should be explicit and scriptable:

```bash
brainctl setup --mode local --workspace <path> --provider codex --entrypoint telegram
brainctl setup --mode local --workspace <path> --provider claude-code --entrypoint telegram
brainctl setup --mode remote --host <user@host> --workspace <remote-path> --provider codex --entrypoint telegram
brainctl doctor --workspace <path>
brainctl config validate --config <path>
brainctl secrets check --workspace <path>
```

The CLI should print paths and actions, but not secret values.

## Local vs remote deployment

- **Local development** uses the checkout plus a private workspace outside git.
  It should support fake providers/entrypoints for contract tests and smoke
  tests without credentials.
- **Remote self-hosting** uses a deployment checkout plus private workspace/data
  volumes on the server. Hostnames, IPs, SSH config, TLS certs, and service
  account names must stay in the user's deployment notes or secret store unless
  expressed as placeholders in docs.

## Definition of done for first setup

- `pnpm run check` passes.
- Runtime config validates with one primary enabled entrypoint.
- Provider adapter can authenticate or report a clear unauthenticated state.
- Telegram adapter can validate its config without exposing token or chat ID
  values.
- Private workspace exists outside git and contains all real env/config/state.
- No private data, generated artifacts, logs, tokens, hostnames, or
  repo-registry state are tracked.
