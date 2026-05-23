# Guided setup plan

Goal: a user can clone/open this repo root with Codex or Claude Code, say
`setup`, and the agent can guide a first local or remote bootstrap without
access to the maintainer's private workspace, integrations, credentials, or
hosts.

Status: guided setup documentation. `brainctl`, runtime packages, provider
adapters, Telegram entrypoint seams, and non-mutating operations planning exist.
Setup should prepare and validate a local or remote workspace, then guide the
user through Codex auth, reviewed service installation/start, Telegram token
configuration, and first-user pairing. It still stops before credentials,
privileged service changes, or live deployment unless the user explicitly
confirms.

Setup is intentionally re-runnable. At any time, `brainctl setup inspect` or
`brainctl setup status` should show configured, missing required, missing
optional, and unsafe-to-overwrite items without printing secrets. A later setup
pass should offer missing optional components: private Git/local-snapshot
backup, generated web publishing, Google Calendar/chat via Composio,
entrypoints, providers, and integrations.
Existing config or backup metadata is never overwritten by default; destructive
replacement requires an explicit `--force` or `--replace` flag on a command that
documents what it will replace.

Setup also keeps a private, metadata-only resume file in the private workspace:
`state/setup-progress.json`. This file is created with restrictive permissions
where practical, is excluded from the private workspace Git template, and must
never be checked into GitHub. It may record completed setup step ids, workspace
name/path, Codex auth status metadata, reviewed service install/start status,
Telegram token configured metadata, and the next recommended step. It must never
store raw tokens, provider credentials, session material, Telegram user/chat IDs,
or logs. `setup inspect/status` may use the file to resume after a closed Codex
session, but must reconcile it with current config, file metadata, secret-ref
checks, provider health, and service health rather than trusting stale progress
blindly.

## Agent entrypoints

When started from the repository root, Codex and Claude Code agents should treat
the root-level `setup` request as the setup entrypoint. Do not ask the user to
change directories into `setup/`.

1. Read `AGENTS.md`; Claude Code also reads `CLAUDE.md`.
2. Read this setup plan.
3. Read `assistant-packs/core/skills/setup-self-host/SKILL.md`.
4. For remote Ubuntu preparation, read the upstream helper skill at
   `/home/tim/pkg/tim/assistant-agent-logic/config/skills/setup-server.md` and
   adapt only its public-safe, user-owned steps.
5. Run `pnpm run check` before and after setup or documentation changes.
6. Ask before touching any real remote host, local SSH config, systemd unit,
   secret file, or credential.
7. Keep real workspace config, env files, tokens, Telegram IDs, logs, generated
   artifacts, repo-registry state, hostnames, and deployment notes outside git.

## First question: local directory or remote SSH server?

A setup agent must start by asking the user to choose one path:

- **Local setup**: install from this checkout into a private workspace directory
  on the current machine.
- **Remote SSH setup**: prepare a user-owned Ubuntu server over SSH, clone this
  repo there, and create the private workspace on the server.

The agent should then collect only the information needed for that path and
confirm before making changes.

## Guided questions

Ask these questions explicitly. Defaults are suggestions, not assumptions.
For the first setup confirmation, keep the summary short: show only setup mode,
source checkout path, private workspace path, and initial workspace name. Hide
implementation plumbing such as service user, systemd service name, derived
config/secrets/log paths, and command lists unless the user asks for details or
`brainctl setup defaults --verbose` is used.

### Common questions

1. What workspace name should Brain use? Default: `personal`.
2. Which provider should execute assistant work?
   - `codex` — Codex provider; Codex app-server details stay behind the
     provider adapter boundary.
   - `claude-code` — Claude Code provider placeholder/seam; no real Claude
     Code wiring is installed in this setup flow.
3. How will the chosen provider be authenticated?
   - Existing CLI/session on this machine or server.
   - API key or token stored in a private workspace secret file or host secret
     store.
   - Not ready yet; create placeholders and report unauthenticated state.
4. Should the initial primary entrypoint be Telegram? Initial bootstrap assumes
   `telegram-main` unless the user asks for a fake/smoke-test entrypoint only.
5. After validation passes, configure or verify Codex auth before Telegram:
   use the selected Codex transport, store any credential only in the private
   workspace/server env file or host secret store, and run only redacted
   metadata/health checks unless the user explicitly allows live provider
   checks.
6. Review and install/start the Brain service before Telegram live traffic:
   render the systemd plan, confirm service user, working directory, private env
   file, and unit path, and require explicit confirmation before any `sudo
   systemctl` install/enable/start.
7. Do you already have a Telegram bot token from BotFather? If not, tell the
   user how to create one before live start: open Telegram, message
   `@BotFather`, send `/newbot`, choose a display name, choose a unique
   username ending in `bot`, copy the returned token into Brain's private
   server `secrets.env`/env store or the configured secret reference, and never
   commit, chat, log, or print the token.
8. Which Telegram admin bootstrap should be used? Default: first-user pairing,
   where the first Telegram user/chat to message the newly configured bot is
   persisted as the paired/admin identity in private state. Use a user-supplied
   explicit allowlist or optional `/pair` code only if requested.
9. Should voice/audio transcription be enabled for Telegram attachments?
   Default: no. If yes, use `transcription.provider: openai`, store the OpenAI
   key only as a private ref such as `env:OPENAI_API_KEY` or `file:/...`, choose
   the model, and scope it to `telegram-main` with `voice`/`audio` attachment
   kinds. Never paste or commit the key.
10. Is generated web/page publishing needed now? Default: no; keep web preview
   disabled unless the user explicitly enables it. If yes, choose domain vs
   direct IP, public base URL, publish root, and Caddy/reverse-proxy plan. DNS
   is needed for a domain and not needed for direct-IP publishing; setup never
   changes DNS.
11. Should private workspace backup be configured now?
   - `none` — default/no backup.
   - `local-snapshot` — local snapshot root and retention notes.
   - `private-git` — private repo path, optional remote, branch, include/exclude
     policy. Safe defaults exclude secrets, logs, tmp, and caches.
12. Should optional Google Calendar or chat data-source access be configured via
   Composio? Default: no. If yes, collect only env/file refs for the Composio
   API key and connected-account metadata; never collect or print credential
   values.

### Local-only questions

1. Which private workspace directory should be used? Suggested default:
   `~/.brain/workspace`.
2. Should setup create local config, secrets, logs, artifacts, backups, and
   state directories there with restrictive permissions?

### Remote-only questions

1. What SSH host label should be added or reused in local `~/.ssh/config`?
2. What server address should that host label point to?
3. Which bootstrap SSH user has initial access? Usually `root` on a fresh VPS.
4. What remote repo clone path should be used? Suggested default:
   `/home/brain/brain` for the default `brain` service user.
5. What remote private workspace path should be used? Suggested default:
   `/home/brain/.brain/workspace`.
6. Which Git remote should the server clone? Default: this repository's origin.
7. Does the service user already have an SSH key on the server for Git/provider
   access? If not, stop and ask the user to install one; do not require setup to
   create a new server key for first bootstrap.
8. Are provider auth and Telegram token ready now, or should setup install
    placeholders and leave the service stopped/pending auth?

## Fresh remote server checklist

Use this checklist before a real remote test. It is intentionally explicit so a
Codex or Claude Code setup session can discover missing config without relying
on private workspace knowledge.

### OS, user, and SSH

- Ubuntu LTS server reachable by SSH.
- Initial SSH access available, commonly `root@<ip>`.
- Local `~/.ssh/config` contains or will contain a `Host <label>` entry with
  `HostName`, `User`, and optional `IdentityFile`.
- A dedicated non-root Brain user exists or will be created by the remote
  bootstrap; it owns the checkout and workspace and can use passwordless sudo
  for package/service setup.
- The service user's existing server-side SSH key is available for Git clone and
  provider-specific SSH flows, or setup pauses for the user to add one.

### Base packages and runtimes

- Required packages: `git`, `curl`, `unzip`, `build-essential`, `tmux`, `jq`,
  `ca-certificates`, and systemd tools.
- Node.js and package manager: install Node compatible with `package.json`
  (`>=24`) and pnpm compatible with `packageManager`.
- Optional runtimes: Bun only if a selected provider/entrypoint package requires
  it; Docker only if the chosen deployment mode uses containers.
- Do not require Composio or any optional integration for initial bootstrap.

### Provider selection and auth

- Exactly one initial provider is selected: `codex` or `claude-code`.
- Codex path records only `provider: codex`; Codex app-server mechanics and auth
  stay in the provider adapter/private secret boundary.
- Claude path records only `provider: claude-code` as a placeholder/seam for now;
  real Claude Code wiring is out of scope for this setup flow.
- Setup can proceed with unauthenticated placeholders, but `doctor` must report
  provider auth as pending before a live runtime starts.

### Repository and workspace

- Repo clone path, branch/ref, and remote URL are known.
- Private workspace path is outside the source checkout and outside git.
- Workspace directories exist for `config/`, `secrets/`, `logs/`, `artifacts/`,
  `state/`, `backups/`, and `tmp/` with restrictive ownership/permissions.
- Runtime config starts from `examples/config/runtime.yaml` or TOML and contains
  one `primaryEntrypointId` in `single-primary` mode.

### Service and process manager

- systemd service name, working directory, runtime command, environment file
  path, restart policy, and log target are documented before service creation.
- Initial systemd unit may be installed disabled or stopped until provider and
  Telegram auth are complete.
- Health/doctor command, log command, restart command, and rollback/update
  command are recorded in private deployment notes.

### Env and secrets

- Secret files live only in the private workspace or host secret store, never in
  this repo.
- Expected secret/config refs include provider auth, Telegram bot token,
  Telegram admin pairing data, optional webhook secret, optional web preview
  config, optional OpenAI transcription API key ref, optional Composio API key
  and connected-account metadata refs, and host-specific service env.
- Setup summaries print only metadata: file existence, ownership, permissions,
  size, and key counts; never secret values.

### Telegram bootstrap

- Telegram is the initial primary entrypoint (`telegram-main`) unless the user
  explicitly chooses a fake entrypoint for smoke testing.
- If the user does not already have a bot token, setup must give the concrete
  BotFather flow: open Telegram, message `@BotFather`, send `/newbot`, choose a
  display name, choose a unique username ending in `bot`, and copy the returned
  token into Brain's private `secrets.env` or configured secret-store reference.
- Bot token is stored privately, for example in the workspace secrets file,
  `secrets.env`, an adapter-owned env file with mode `0600`, or a host secret
  store. Never commit it, print it, or include it in setup summaries/logs.
- Admin pairing defaults to first-user pairing: after the bot token is configured
  and the service starts, the first Telegram user/chat to message the bot is
  persisted under private `state/telegram-pairing` as the paired/admin identity.
  Raw IDs stay private.
- Advanced paths remain supported when deliberately chosen: a user-provided
  explicit admin allowlist or an optional one-time `/pair <code>` flow.
- Once paired, the Telegram entrypoint should be able to receive setup commands
  so future integrations can be configured through Telegram.
- If the token is leaked, rotate it in `@BotFather` with `/revoke`, replace the
  private Brain secret reference, restart Brain, and re-run metadata-only secret
  checks. Setup output still reports only redacted token metadata.
- No Composio or third-party integration token is required for this bootstrap.
- Voice/audio transcription is optional. If enabled, the OpenAI key lives only
  behind `transcription.apiKeyRef` (for example `env:OPENAI_API_KEY`) in the
  private workspace or host secret store; setup/status/secrets checks must never
  print the key value.

### Networking, firewall, and web optionality

- Polling mode needs outbound HTTPS only and is the simplest Telegram bootstrap.
- Webhook mode needs a public HTTPS endpoint and firewall/reverse-proxy config;
  it is optional for first bootstrap.
- Generated pages/web preview are optional and disabled by default. If enabled,
  document domain or direct-IP publishing, public base URL, publish root, Caddy
  or reverse-proxy notes, ports, TLS, and retention in private deployment notes.
  Setup reports DNS as needed for domains and not needed for direct IP; it does
  not perform DNS changes.

### Operations

- Logs: `journalctl -u <service>`, provider logs, and entrypoint logs have known
  paths/commands.
- Health: `brainctl doctor --config <path> --pack assistant-packs/core`,
  `brainctl config validate <path>`, and `brainctl operations validate` are the
  current safe checks.
- Backup: config metadata, private workspace state, and secrets backup path are
  documented without checking data into git. `private-git` backups use a private
  repo path/remote/branch and the `examples/private-workspace.gitignore`
  template; `backup init` is dry-run unless `--apply` is explicit.
- Update: pull/fetch target ref, reinstall dependencies, run checks, restart,
  and rollback command are documented.

## Local setup flow

1. Confirm the user chose local mode and a private workspace path outside this
   checkout.
2. From the repo root, run `pnpm run check`.
3. Create private workspace directories with restrictive permissions, either
   directly or with:

   ```bash
   pnpm run brainctl setup --workspace <workspace-name> --path <private-workspace-path>
   pnpm run brainctl setup inspect --config <private-config> --workspace <workspace-name>
   ```

4. Copy `examples/config/runtime.yaml` or TOML into the private workspace config
   area and adjust placeholders for:
   - workspace ID/name,
   - `workspacePath`,
   - selected provider,
   - `primaryEntrypointId: telegram-main`,
   - `enabledEntrypoints.telegram-main.enabled: true`,
   - optional `web-preview.enabled: false`.
5. Write secrets only to private files or tell the user what secret store keys
   are missing.
6. Validate metadata only: file exists, permissions are restrictive, required
   keys are present, and no source-controlled private files were created.
7. Run current safe checks:

   ```bash
   pnpm run brainctl setup status --config <private-config> --workspace <workspace-name>
   pnpm run brainctl config validate <private-config>
   pnpm run brainctl secrets check --config <private-config>
   pnpm run brainctl backup plan --config <private-config> --workspace <workspace-name>
   pnpm run brainctl web status --config <private-config> --workspace <workspace-name>
   pnpm run brainctl composio status --config <private-config> --workspace <workspace-name>
   pnpm run brainctl entrypoint check telegram --token-env TELEGRAM_BOT_TOKEN \
     --polling-state <workspace>/state/telegram-offset.json \
     --pairing-state <workspace>/state/telegram-pairing
   pnpm run brainctl doctor --config <private-config> --pack assistant-packs/core
   pnpm run brainctl operations validate --config <private-config> --workspace <workspace-name> --repo <repo-root>
   pnpm run brainctl operations systemd --config <private-config> --workspace <workspace-name> --repo <repo-root>
   ```

8. Use `brainctl run --fake --once --fake-text help` only for fake/dev smoke.
   Config-driven `brainctl start`/`run` resolves the provider and entrypoint
   from runtime config by default.
9. Summarize successful pre-live validation as a wizard:
   - completed checks;
   - not live yet;
   - next step: configure/verify Codex auth;
   - then review/install/start the service with explicit confirmation;
   - then "Next up, let's configure your Telegram token" with the BotFather
     steps and private-secret-only storage guidance;
   - finally first-user pairing (or the explicitly selected allowlist/`/pair`
     advanced path).
10. On rerun, read `<workspace>/state/setup-progress.json`, inspect the current
    workspace/config/secret metadata again, report completed steps, identify the
    next incomplete step, and continue there instead of restarting from defaults
    or dumping every setup option.

## Remote SSH setup flow

Remote setup should be user-confirmed and should not deploy live services unless
explicitly requested.

1. Confirm remote mode and show concise defaults, either from the remote-only
   questions above or with:

   ```bash
   pnpm run brainctl setup defaults --target remote --workspace personal
   ```

   The defaults keep `/home/brain/brain` as the source checkout and
   `/home/brain/.brain/workspace` as the private workspace for the non-root
   service user.
2. Add or reuse a local SSH config entry:

   ```sshconfig
   Host <server-label>
       HostName <server-address>
       User <service-user>
       IdentityFile <optional-local-key>
   ```

   If the first connection must use `root`, use the root address only for the
   bootstrap phase, then switch the alias to the service user.

3. Prepare the Ubuntu server using the setup-server skill from
   `assistant-agent-logic`:
   `/home/tim/pkg/tim/assistant-agent-logic/config/skills/setup-server.md`.
   Required adaptations for Brain:
   - create/use the dedicated Brain service user,
   - install only needed base packages and runtimes,
   - ensure Node/pnpm satisfy this repo,
   - do not require Composio or optional integrations,
   - prefer an existing server-side SSH key for Git/provider access and pause if
     it is absent,
   - keep Telegram/provider secrets out of source.
4. Verify SSH as the service user through the local SSH config alias.
5. Clone or update the Brain repo at the chosen path and run `pnpm install` if
   dependencies are needed, then `pnpm run check`.
6. Create the remote private workspace and config/secrets/log/state directories.
7. Install placeholder runtime config with Telegram as the single primary
   entrypoint and selected provider recorded generically.
8. Write private Telegram/provider secret files only if the user supplies the
   values; otherwise mark them pending.
9. Render and review, but do not install or enable, a systemd unit with
   `brainctl operations systemd`. The rendered command uses the runtime config's
   provider and primary entrypoint by default.
   Record its `ExecStart`, env file, working directory, restart policy, log
   command, and health command.
10. Run metadata-only checks and report exactly what remains before a live start:
    provider auth, Telegram bot token, first-user pairing or selected admin bootstrap, service enable/start, and optional webhook/web configuration.

## Current `brainctl` CLI shape

Current commands are explicit and scriptable:

```bash
pnpm run brainctl setup --workspace <name> --path <private-workspace-path>
pnpm run brainctl doctor --config <runtime-config> --pack assistant-packs/core
pnpm run brainctl config validate <runtime-config>
pnpm run brainctl secrets check --config <runtime-config>
pnpm run brainctl entrypoint check telegram --token-env TELEGRAM_BOT_TOKEN \
  --polling-state <workspace>/state/telegram-offset.json \
  --pairing-state <workspace>/state/telegram-pairing
pnpm run brainctl start --config <runtime-config> --workspace <name>
pnpm run brainctl run --config <runtime-config> --workspace <name> --fake --once --fake-text help
pnpm run brainctl operations validate --config <runtime-config> --workspace <name> --repo <checkout>
pnpm run brainctl operations systemd --config <runtime-config> --workspace <name> --repo <checkout>
```

The CLI should print paths and actions, but not secret values.

## Definition of done for first setup

- `pnpm run check` passes from the repo root.
- Private workspace exists outside git and contains all real env/config/state.
- Runtime config validates with one primary enabled entrypoint.
- Provider adapter can authenticate or report a clear unauthenticated state.
- Telegram adapter can validate token/admin-pairing metadata without exposing
  token, chat ID, user ID, or pairing code values.
- Telegram is ready enough that future integration setup can continue through
  Telegram after admin pairing.
- No private data, generated artifacts, logs, tokens, hostnames, Composio config,
  or repo-registry state are tracked.
