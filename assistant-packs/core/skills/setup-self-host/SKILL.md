---
name: setup-self-host
description: Guided Brain setup skill for local or remote self-host bootstrap with Codex-first provider setup, Claude Code placeholder support, and Telegram first entrypoint.
---

# setup-self-host

Use this skill when a user opens the Brain repo root with Codex or Claude Code
and asks to install, set up, self-host, or "make this work". The current repo has
runtime, provider, Telegram entrypoint, `brainctl`, and operations planning
seams, so this skill guides private workspace creation, local/remote
preparation, config/secrets placeholders, validations, and a stop-before-live
deployment handoff.

## Safety rules

- Start from the repo root after the user says `setup`; do not `cd` into a
  separate setup directory.
- Read `AGENTS.md`, `CLAUDE.md` if running under Claude Code, and
  `docs/setup-plan.md` before changing anything.
- Ask the user to choose **local directory** or **remote server over SSH** before
  setup actions.
- Ask before editing local `~/.ssh/config`, contacting a real host, writing a
  secret, creating a systemd unit, or starting/enabling a service.
- Keep real workspace contents, credentials, Telegram IDs, hostnames, logs,
  generated artifacts, and repo-registry data outside git.
- Do not require Composio or any optional integration for initial bootstrap.
- Print only secret metadata: existence, owner, mode, byte size, and required-key
  presence. Never print token values or raw chat/user IDs.
- Run `pnpm run check` after setup/documentation edits and before declaring
  setup ready.

## Canonical user flow

The user clones/opens the Brain repo root in Codex or Claude Code and says
`setup`. The agent then reads the referenced root docs/skill files and asks the
first local-vs-remote question below.

## Required first prompt

Ask:

> Do you want to set Brain up locally in a private directory on this machine, or
> on a remote Ubuntu server over SSH?

Then collect the path-specific fields below.

## Common guided questions

1. Workspace name? Default: `personal`.
2. Provider? Choose exactly one:
   - `codex` for the Codex provider; app-server mechanics stay inside the
     provider adapter/private config boundary.
   - `claude-code` only as a placeholder/seam for now; do not install real
     Claude Code wiring in this setup flow.
3. Provider auth status?
   - Existing CLI/session already authenticated.
   - Private API key/token to store outside git.
   - Not ready; create placeholders and report pending auth.
4. Initial entrypoint? Default: Telegram as `telegram-main` in single-primary
   mode. Use fake entrypoint only if the user explicitly declines Telegram for
   smoke testing.
5. Telegram bot token from BotFather ready? If yes, store privately; if no,
   leave token pending.
6. Initial Telegram admin bootstrap method?
   - default: first-user pairing, where the first Telegram user/chat to message
     the newly configured bot becomes paired/admin state,
   - user supplies an explicit admin allowlist privately,
   - optional advanced one-time `/pair <code>` flow,
   - not ready; leave pairing pending.
7. Optional generated pages/web preview? Default: disabled.

## Local setup flow

1. Confirm a private workspace path outside the checkout, for example
   `~/.brain/workspaces/<workspace-name>`.
2. Run `pnpm run check` from the repo root.
3. Create workspace directories:
   - `config/`
   - `secrets/`
   - `logs/`
   - `artifacts/`
   - `state/`
   - `backups/`
   - `tmp/`
4. Set private permissions: workspace and secret-bearing files should be owner
   readable/writable only where practical.
5. Copy `examples/config/runtime.yaml` or `.toml` into the workspace config area
   and fill placeholders for:
   - workspace name/path,
   - selected provider identifier,
   - `primaryEntrypointId: telegram-main`,
   - exactly one enabled entrypoint in `single-primary` mode,
   - optional `web-preview` disabled.
6. Store provider auth and Telegram token/admin-pairing data only in workspace
   secret files, private `state/telegram-pairing`, or the user's chosen secret
   store.
7. Run metadata-only validation:
   - workspace exists outside git,
   - expected directories exist,
   - secret files are not tracked,
   - runtime config has one primary enabled entrypoint,
   - provider auth and Telegram bootstrap are either present or clearly pending.
8. Run safe `brainctl` validations and summarize what remains before live
   deployment.

## Remote SSH setup flow

Use this flow only after the user chooses remote mode and confirms the host.

1. Collect:
   - local SSH config host label,
   - server address/IP,
   - initial bootstrap user, often `root`,
   - desired dedicated Brain service user,
   - repo clone path, default `~/pkg/brain`,
   - remote workspace path, default `/srv/brain/workspaces/<workspace-name>`,
   - systemd service name, default `brain-<workspace-name>`,
   - provider and Telegram readiness.
2. Add or reuse a local `~/.ssh/config` entry so `ssh <host-label>` works. If
   root is needed only for bootstrap, switch the alias to the service user after
   user creation.
3. Prepare the server with the configured setup-server runbook. For Brain, adapt it as follows:
   - create/use a dedicated non-root Brain user with sudo for setup,
   - install Ubuntu base packages and Node/pnpm that satisfy this repo,
   - install Codex CLI only if the selected Codex transport needs that local
     auth path; do not install real Claude Code wiring in this setup flow,
   - do not require Composio or optional integrations,
   - assume a server-side SSH key for Git/provider access should already exist;
     if missing, pause and ask the user to add/register one instead of silently
     creating a new key for initial bootstrap,
   - keep all provider and Telegram secrets out of the checkout.
4. Verify service-user access through the local SSH config alias.
5. Clone/update the user-confirmed Brain repository remote into the chosen repo path.
6. Run dependency/check commands from the remote repo root, at minimum
   `pnpm run check` after any install step.
7. Create the remote private workspace directories listed in the local flow.
8. Install placeholder runtime config with Telegram as `telegram-main` and the
   chosen provider identifier. Store real secret values only if supplied.
9. Render systemd metadata with `brainctl operations systemd`; install or enable
   a unit only after explicit confirmation. Record working directory, env file
   path, `ExecStart`, restart policy, log command, health command, and
   rollback/update notes.
10. Report remaining blockers before any live start: provider auth, Telegram bot
    token, first-user pairing or selected admin bootstrap, service enable/start,
    webhook/firewall, and optional web preview.

## Telegram bootstrap minimum

The initial Telegram setup is successful when:

- `telegram-main` is configured as the single primary entrypoint.
- A private bot token secret is present or clearly marked pending.
- Admin pairing defaults to first-user pairing with private
  `state/telegram-pairing` persistence; an explicit private admin allowlist or
  optional `/pair` code is used only when requested.
- The setup summary explains that future integrations can be configured through
  Telegram after admin pairing.
- No Composio or third-party integration token is required.

Prefer polling for the first bootstrap because it needs only outbound HTTPS.
Webhook mode, reverse proxy, TLS, firewall rules, generated pages, and web
preview are optional follow-up setup.

## Fresh remote prerequisites checklist

Before a new server test, confirm:

- Ubuntu LTS, SSH reachability, local SSH config alias, and dedicated service
  user.
- Base packages: `git`, `curl`, `unzip`, `build-essential`, `tmux`, `jq`,
  `ca-certificates`, and systemd.
- Node and pnpm satisfy `package.json`; Bun/Docker only if explicitly needed.
- Provider selected and auth either present or pending with clear next steps.
- Repo clone path and workspace path known; workspace is outside the checkout.
- systemd service name, env file path, logs, health, restart, update, backup,
  and rollback commands documented.
- Telegram token/admin pairing metadata ready or pending; checks report only
  counts and presence, never raw user/chat IDs or pairing code values.
- Generated web/pages disabled unless explicitly enabled.
- Firewall/ports: outbound HTTPS for polling; inbound HTTPS only for optional
  webhook/web preview.

## Verification commands

```bash
pnpm run check
pnpm run brainctl -- setup --workspace <name> --path <workspace>
pnpm run brainctl -- config validate <workspace>/config/runtime.yaml
pnpm run brainctl -- secrets check --config <workspace>/config/runtime.yaml
pnpm run brainctl -- entrypoint check telegram --token-env TELEGRAM_BOT_TOKEN \
  --polling-state <workspace>/state/telegram-offset.json \
  --pairing-state <workspace>/state/telegram-pairing
pnpm run brainctl -- doctor --config <workspace>/config/runtime.yaml --pack assistant-packs/core
pnpm run brainctl -- operations validate --config <workspace>/config/runtime.yaml --workspace <name> --repo <checkout>
pnpm run brainctl -- operations systemd --config <workspace>/config/runtime.yaml --workspace <name> --repo <checkout>
```
