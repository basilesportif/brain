# Guided setup plan

Goal: Brain acts as the control-plane/setup orchestrator. A user can
clone/open this repo root with Codex or Claude Code, say `setup`, and the agent
can guide a first local or remote bootstrap for the servant runtime stack
without access to the maintainer's private workspace, integrations,
credentials, or hosts.

Status: guided setup documentation. `brainctl stack status` and
`brainctl stack plan` now establish Brain's control-plane source of truth:
`codex-chat` is the servant Telegram/Codex runtime, `assistant-agent-logic` is a
separate logic repository, and `assistant-agent-data` / workspace is separate
private state. Brain runtime packages, provider adapters, and Telegram
entrypoint seams are lab/compatibility surfaces until explicitly promoted.
Setup should prepare and validate repo-registry metadata, servant runtime
service paths, and private workspace/data choices, then stop before
credentials, privileged service changes, or live deployment unless the user
explicitly confirms.

Setup is intentionally re-runnable. At any time, `brainctl setup inspect` or
`brainctl setup status` should show configured, missing required, missing
optional, and unsafe-to-overwrite items without printing secrets. A later setup
pass should offer missing optional components: private Git/local-snapshot
backup, generated web publishing, Gmail/Google Calendar via Composio,
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
session, but progress state is only a resume aid, not authority. Agents must
reconcile it with current config, file metadata, secret-ref checks, actual
remote/server state, provider health, and service health rather than trusting
stale progress blindly.

If saved setup progress does not match the real workspace/remote/server state,
or if setup cannot determine what is safe to do next, reset the progress state
before guessing, forcing commands, or applying destructive flags. After reset,
rerun `setup inspect`, `setup status`, and any guarded live/status checks needed
to rebuild the picture from current state.

Setup guidance must be direct-action first. The user should not have to know
SSH syntax, which host/user/path to use, which env file matters, which systemd
unit is implied, or which `brainctl` flags are safe. For every user-facing setup
step, output either one exact copy-paste command, one exact Telegram/BotFather
message to send, or one short question for a missing value needed to construct
that command. Avoid bare conceptual instructions such as "SSH into the server",
"run this on the server", "configure auth", "verify Codex", "check the logs",
or "start the service" unless the complete command is included immediately.
Ask confirmation questions in plain English and accept ordinary yes/no answers;
do not require exact reply text unless the user must run a command verbatim.

Initial setup must create or validate an inspectable assistant workspace before
live traffic. The control-plane source of truth is the separate
`assistant-agent-data` workspace and separate `assistant-agent-logic` repo
resolved from repo-registry metadata. The legacy/lab in-repo
`packages/assistant-logic` stores and CLI commands remain compatibility helpers:
`data/todos.json`, `data/projects.json`, `data/crm.json`,
`data/reminders.json`, `private/documents/metadata.jsonl`,
`instructions/skills/`, `instructions/prompts/`, `tasks/`, and selected
`.claude/repo-registry/` state. `projects/`, `notes/`, `documents/`, and
`documents/metadata/` are still created, but only as markdown/resource folders;
do not migrate existing markdown notes or convert JSON state to markdown.
Codex should run with explicit `runtimeContext` roots for Brain,
`codex-chat`, `assistant-agent-logic`, and assistant-data/repo-registry; it
must not infer those roots from the private workspace cwd. The default provider
cwd is the configured Brain control-plane root when present, while `TMPDIR`
still points at `<workspace>/tmp`, approval behavior is non-interactive, and the
self-host service sandbox mode is `danger-full-access`. Telegram has no
interactive approval channel, and common Ubuntu server sandboxes can fail before
shell commands start; the safety boundary is the dedicated service user plus
explicit private workspace paths, not a per-turn approval prompt. This lets
questions like "do I have projects?" inspect the JSON stores through native
assistant-logic CLI commands instead of answering from active entrypoint
metadata or markdown folders alone.
Ask whether the user wants to initialize, pull, or validate the
`assistant-agent-data` private workspace/repo; never commit secrets, logs,
Telegram IDs, transcripts, or provider session material. Do not auto-migrate
legacy private data in the first control-plane implementation; render a
placeholder/prompt and require an explicit migration plan.

If the wizard needs a clean resume state, run:

```bash
pnpm run brainctl setup reset --workspace <workspace-name> --path <private-workspace> --dry-run
pnpm run brainctl setup reset --workspace <workspace-name> --path <private-workspace> --yes
```

Reset is intentionally narrow: it reports only the target path, previous
presence/mode/size, and action taken or skipped, and it can remove only
`<private-workspace>/state/setup-progress.json`. It must not touch private
secrets, config, backups, logs, documents, provider sessions, Telegram state, or
other private data.

## Agent entrypoints

When started from the repository root, Codex and Claude Code agents should treat
the root-level `setup` request as the setup entrypoint. Do not ask the user to
change directories into `setup/`.

1. Read `AGENTS.md`; Claude Code also reads `CLAUDE.md`.
2. Read this setup plan.
3. Read `assistant-packs/core/skills/setup-self-host/SKILL.md`.
4. Inspect saved setup context/progress before asking first-run questions. Run
   `pnpm run brainctl setup status --repo <repo-root> --workspace <name>` and
   check the reported `state/setup-progress.json` plus any ignored
   `private/setup-context.json` pointer. If it points to a remote host, ask only
   for permission or missing SSH details needed to run the reported remote
   metadata check, then resume from the next incomplete step.
5. For remote Ubuntu preparation, use the Brain-owned deployment/self-hosting
   docs in this repo, then use repo-registry metadata to resolve the separate
   `assistant-agent-logic` checkout required by the servant stack.
6. Run `pnpm run check` before and after setup or documentation changes.
7. Ask before touching any real remote host, local SSH config, systemd unit,
   secret file, or credential.
8. Any user copy-paste CLI command that inputs or stores a secret must be a
   one-use private temporary script, not an inline shell command. The script
   lives outside version control, prompts/reads the secret with hidden input,
   writes only to the private env file or secret store, and deletes itself after
   success.
9. Keep real workspace config, env files, tokens, Telegram IDs, logs, generated
   artifacts, repo-registry state, hostnames, and deployment notes outside git.

## First action: resume inspection

A setup agent must start by checking whether this is an interrupted setup. From
the repo root, run:

```bash
pnpm run brainctl setup status --repo <repo-root> --workspace <workspace-name>
```

If the output reports `resumeProbe.target: "remote"`, do not restart the
wizard. Ask only for permission to contact the known host, or for the missing
SSH host if the local context is incomplete, then run the reported
`resumeProbe.command` to inspect the remote
`<workspace>/state/setup-progress.json`. Reconcile that metadata with current
config, secret metadata, provider health, and service status before continuing.

When a remote target is selected or discovered, save an ignored local pointer at
`private/setup-context.json` with non-secret metadata such as target, workspace,
SSH host/user, remote repo path, remote workspace path, and remote config path.
`brainctl setup defaults --target remote` and `brainctl setup --target remote`
write this pointer for the agent and refuse to write it unless the path is
untracked and git-ignored. The file may contain private host/path metadata, is
outside version control, and must never be committed. It exists so a later
Codex/Claude session can find remote progress before asking first-run
questions.

## First question after resume inspection: local directory or remote SSH server?

Only after saved progress/context has been checked or ruled out, ask the user to
choose one path:

- **Local setup**: install from this checkout into a private workspace directory
  on the current machine.
- **Remote SSH setup**: prepare a user-owned Ubuntu server over SSH, clone this
  repo there, and create the private workspace on the server.

The agent should then collect only the information needed for that path and
confirm before making changes.

## Guided questions

Ask these questions explicitly. Defaults are suggestions, not assumptions.
For the first setup confirmation, keep the summary short: show only setup mode,
remote SSH host, initial SSH user, future SSH user, source checkout path,
private workspace path, initial workspace name, and the core setup flow. If
remote mode is selected, ask for the SSH IP/DNS host and initial SSH login
username; default the initial username to `root` when omitted, but keep root
only for one-time bootstrap and persist future commands as the non-root service
user. Hide implementation plumbing such as systemd service name, derived
config/secrets/log paths, and command lists unless the user asks for details or
`brainctl setup defaults --verbose` is used.

### Common questions

1. Connect Telegram:
   - use `telegram-main` as the initial primary entrypoint unless the user asks
     for fake/smoke only;
   - if no bot exists, show the BotFather steps;
   - store only a private token ref, not the token value;
   - do not start polling/webhooks yet.
2. Create personal workspace memory:
   - run or rely on `brainctl setup` / `brainctl workspace scaffold` to create
     `data/*.json`, `instructions/**`, `tasks/**`,
     `private/documents/metadata.jsonl`, selected `.claude/repo-registry/`
     state paths, and markdown resource folders;
   - tell the user todos/projects/CRM/reminders are JSON-backed and accessed by
     native assistant-logic CLI commands via `brainctl workspace run`;
   - ask whether to initialize or connect a private Git backup so non-secret
     workspace state can be committed privately.
3. Pull or initialize the private data/backup repo:
   - prefer an existing private-git remote when supplied;
   - otherwise initialize a private local repo/path and add a remote later;
   - keep secrets, logs, tmp, and caches excluded by default.
4. Connect Composio accounts if needed:
   - collect only env/file refs for the Composio API key and connected-account
     metadata;
   - skip for a minimal Telegram + Codex setup.
5. What workspace name should Brain use? Default: `personal`.
6. Which provider should execute assistant work?
   - `codex` — Codex provider; Codex app-server details stay behind the
     provider adapter boundary.
   - `claude-code` — Claude Code provider placeholder/seam; no real Claude
     Code wiring is installed in this setup flow.
7. How will the chosen provider be authenticated?
   - Existing CLI/session on this machine or server.
   - API key or token stored in a private workspace secret file or host secret
     store.
   - Not ready yet; create placeholders and report unauthenticated state.
8. After the core choices are captured, configure or verify Codex auth before
   service start or live Telegram traffic:
   first generate a target-host helper with
   `pnpm run brainctl setup codex-auth-script --config <workspace>/config/runtime.yaml --workspace <workspace-name> --repo <repo-root> --ssh-host <host> --ssh-user <ssh-login-user> --service-user <brain-service-user>`.
   For remote setup, show the exact returned `sshRunCommand` as a copy-paste
   command, for example `ssh -t root@host 'sudo -iu brain bash
   /tmp/verify-brain-codex-auth.sh'`, so device-auth can happen in the user's
   terminal. Verify auth as the same service user that systemd will run; root's
   Codex login is not enough for `User=brain`. Record the verified OS user in
   setup progress and resume from Codex auth if the recorded user differs from
   the service user. Do not say only "SSH into the server" or "run this on the
   server."
   The helper checks `codex login status`. If auth is missing during remote
   setup, the helper itself must print the exact copy-paste SSH login command,
   such as `ssh -t root@host 'sudo -iu brain codex login --device-auth'`; do
   not leave the user with only local-on-target `codex login` instructions. The
   JSON output should also include `sshLoginCommand` for automation, and setup
   progress is updated only via guarded
   `brainctl validate live --allow-live --run-safe` after login is present;
   use the selected Codex transport, store any credential only in the private
   workspace/server env file or host secret store, and run only redacted
   metadata/health checks unless the user explicitly allows live provider
   checks.
9. Review and install/start the Brain service only after Telegram token storage,
   private data setup, and Codex auth are ready:
   render the systemd plan, confirm service user, working directory, private env
   file, and unit path, and require explicit confirmation before any `sudo
   systemctl` install/enable/start.
10. Optional follow-up: which Telegram admin bootstrap should be used? Default:
   first-user pairing,
   where up to two distinct Telegram user/chat pairs that message the newly
   configured bot are persisted as paired/admin identities in private state.
   Pairing closes after the configured maximum is reached; set the maximum to
   one when deliberately preserving a single-admin deployment. Use a
   user-supplied explicit allowlist or optional `/pair` code only if requested.
11. Optional follow-up: should voice/audio transcription be enabled for Telegram attachments?
   Default: no. If yes, use `transcription.provider: openai`, store the OpenAI
   key only as a private ref such as `env:OPENAI_API_KEY` or `file:/...`, choose
   the model, and scope it to `telegram-main` with `voice`/`audio` attachment
   kinds. Never paste or commit the key.
12. Optional follow-up: is generated web/page publishing needed now? Default: no; keep web preview
   disabled unless the user explicitly enables it. If yes, choose domain vs
   direct IP, public base URL, publish root, and Caddy/reverse-proxy plan. DNS
   is needed for a domain and not needed for direct-IP publishing; setup never
   changes DNS.
13. Optional follow-up: tune backup strategy details after the initial private
    data repo exists. Safe defaults exclude secrets, logs, tmp, and caches.

### Local-only questions

1. Which private workspace directory should be used? Suggested default:
   `~/.brain/workspace`.
2. Should setup create local config, secrets, logs, artifacts, backups, state,
   projects, notes, and document metadata directories there with restrictive
   permissions?

### Remote-only questions

1. What SSH host label should be added or reused in local `~/.ssh/config`?
2. What server address should that host label point to?
3. Which SSH login username has initial access? Default to `root` when omitted.
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
  `state/`, `backups/`, `tmp/`, `data/`, `instructions/`, `tasks/`,
  `.claude/repo-registry/`, `private/documents/`, `projects/`, `notes/`,
  `documents/`, and `documents/metadata/` with restrictive
  ownership/permissions.
- JSON stores exist and validate for Brain assistant-logic parity:
  `data/todos.json`, `data/projects.json`, `data/crm.json`, and
  `data/reminders.json`.
- The in-repo `packages/assistant-logic` package is present; validate with
  `pnpm run brainctl workspace status --path <workspace>`. No sibling
  assistant-agent-logic checkout is required.
- File-save metadata is `private/documents/metadata.jsonl`; private file bytes
  stay under `private/documents/files/` and are excluded from default backups.
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
- Private workspace env files are authoritative setup metadata sources for
  `env:` refs. `setup status` and `secrets check` should inspect
  `<workspace>/config/brain-<workspace>.env` and
  `<workspace>/secrets/secrets.env` by metadata/key presence. Do not mark a
  secret missing merely because a one-off shell or SSH command has not sourced
  those files into its process environment.
- Secret-entry commands shown to users must be temporary script commands.
  Prefer generating the Telegram token helper with
  `pnpm run brainctl setup telegram-token-script --path <workspace>`, then tell
  the user to run the returned `bash .../store-brain-telegram-token.sh`
  command. The generated script is syntax-checked, prompts with hidden input,
  updates the private token/config/env files, unsets the in-memory token, and
  deletes itself on success. Do not hand-roll shell quoting for this flow. The
  script content must never embed the token/key value.
- Use the same one-use helper pattern for Composio. Generate it on the target
  host with
  `pnpm run brainctl setup composio-api-key-script --path <workspace>`, then
  have Tim run the returned `bash .../store-brain-composio-api-key.sh` command
  in a TTY. The helper prompts with hidden input, updates only the private
  workspace `.env` key `COMPOSIO_API_KEY`, sets owner-readable mode where
  practical, unsets the in-memory key, deletes itself on success, and never
  prints or embeds the key.
- Practical pattern for a Telegram token: generate the helper on the target
  host, run it with a TTY, then validate metadata with
  `pnpm run brainctl entrypoint check telegram --token-file
  <workspace>/secrets/telegram-bot-token`. Do not put the actual token in the
  command, the script body, chat, logs, or repo files.
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
  display name, choose a unique username ending in `bot`, and store the returned
  token through the one-use helper generated by
  `pnpm run brainctl setup telegram-token-script --path <workspace>`.
- Bot token is stored privately, for example in the workspace secrets file,
  `secrets.env`, an adapter-owned env file with mode `0600`, or a host secret
  store. Never commit it, print it, echo it, leave it in shell history, or
  include it in setup summaries/logs.
- Admin pairing defaults to first-user pairing: after the bot token is configured
  and the service starts, up to two distinct Telegram user/chat pairs that
  message the bot are persisted under private `state/telegram-pairing` as exact
  paired/admin identities. Pairing closes after the max is reached; raw IDs stay
  private.
- Advanced paths remain supported when deliberately chosen: a user-provided
  explicit admin allowlist or an optional one-time `/pair <code>` flow.
- Once paired, the Telegram entrypoint should be able to receive setup commands
  so future integrations can be configured through Telegram.
- If the token is leaked, rotate it in `@BotFather` with `/revoke`, replace the
  private Brain secret reference, restart Brain, and re-run metadata-only secret
  checks. Setup output still reports only redacted token metadata.
- No Composio or third-party integration token is required for this bootstrap.
- After the base workspace, private backup, Codex auth, Telegram token, and
  service health are ready, the next data-source setup blocker is Gmail and
  Google Calendar through Composio. Prompt Tim only for:
  1. a Composio API key from `https://app.composio.dev/settings`, entered via
     the one-use helper;
  2. a Google Calendar OAuth connection generated by
     `pnpm run brainctl workspace run --path <workspace> composio-connect.js -- --generate --app google_calendar --user-id <label>`;
  3. one Gmail OAuth connection per inbox generated by
     `pnpm run brainctl workspace run --path <workspace> composio-connect.js -- --generate --app gmail --user-id <label>`;
  4. the returned connected-account IDs and non-secret email labels to place in
     private `workspace/composio.yaml`.
  Use `pnpm run brainctl composio status --config <workspace>/config/runtime.yaml
  --workspace <name>` for metadata-only verification. Do not print API keys,
  OAuth tokens, connected-account contents, or email/message data.
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
- Backup: config metadata, assistant JSON workspace state, instruction overlays,
  task metadata, file-save metadata, selected repo-registry state, and secrets
  backup path are documented without checking data into public git.
  `private-git` backups use a private repo path/remote/branch and the
  `examples/private-workspace.gitignore` template; `backup init` is dry-run
  unless `--apply` is explicit.
- Update: pull/fetch target ref, reinstall dependencies, run checks, restart,
  and rollback command are documented.

## Local setup flow

1. First run the resume inspection command from the repo root. If progress
   exists, reconcile it with current state and resume from the reported next
   step instead of asking first-run questions. If no progress exists, confirm
   the user chose local mode and a private workspace path outside this checkout.
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
5. Write secrets only through private temporary secret-entry scripts into
   private files, or tell the user what secret store keys are missing.
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
   - confirm essential runtime choices;
   - when the provider is Codex, print the generated Codex auth helper command
     and, for remote setup, the full `ssh -t user@host 'bash /path/script.sh'`
     command before service start or live Telegram traffic;
   - connect Telegram with BotFather steps and private-secret-only token
     storage guidance, but do not start polling/webhooks yet;
   - then pull or initialize the private data/backup repo;
   - then connect Composio accounts if needed;
   - then show the exact operations/systemd command(s) needed to review,
     install, or start the service, and require explicit confirmation before
     privileged changes;
   - finally optional follow-ups such as first-user pairing, OpenAI
     transcription, web publishing, or backup tuning.
10. On rerun, read `<workspace>/state/setup-progress.json`, inspect the current
    workspace/config/secret metadata and actual remote/server/service state
    again, report completed steps, identify the next incomplete step, and
    continue there only when they agree. If progress and reality disagree, or if
    the safe next step is unclear, run `brainctl setup reset` first and then
    rerun `setup inspect/status` and guarded live/status checks instead of
    guessing or forcing inconsistent state.

## Remote SSH setup flow

Remote setup should be user-confirmed and should not deploy live services unless
explicitly requested.

Current Brain remote metadata: use `brain@178.104.221.223` as the future normal
SSH target / SSH-in identity. Keep `root@178.104.221.223` only as
bootstrap/root access if a privileged bootstrap context is needed. The expected
remote checkout is `/home/brain/brain`, the workspace parent is
`/home/brain/.brain`, and the private workspace is
`/home/brain/.brain/workspace`.

1. Confirm remote mode and show concise defaults, either from the remote-only
   questions above or with:

   ```bash
   pnpm run brainctl setup defaults --target remote --workspace personal
   ```

   The defaults ask for the remote SSH host/IP and distinguish the initial SSH
   user from the future SSH user. When the initial user is `root`, root is only
   a one-time bootstrap identity; the persisted future user is the non-root
   service user (default `brain`). They keep `/home/brain/brain` as the source
   checkout and `/home/brain/.brain/workspace` as the private workspace. They
   also create/update ignored local `private/setup-context.json` with non-secret
   resume metadata so an interrupted setup can survive a later `git pull`.
2. Add or reuse a local SSH config entry:

   ```sshconfig
   Host <server-label>
       HostName <server-address>
       User <service-user>
       IdentityFile <optional-local-key>
   ```

   If the first connection must use `root`, use root only for
   `pnpm run brainctl setup remote-bootstrap --ssh-host <host> --ssh-user root
   --service-user brain`. That bootstrap creates/validates the service user,
   sudo access, authorized keys, `/home/brain/brain`, and
   `/home/brain/.brain/workspace`, then rewrites the local resume context and
   any generated SSH alias to the service user.

3. Prepare the Ubuntu server using the Brain-owned deployment/self-hosting docs
   in this repository.
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
6. Ensure the ignored local resume context exists in
   `private/setup-context.json` with only non-secret metadata: target `remote`,
   workspace name, SSH host/future service user, optional one-time bootstrap
   user, remote repo path, remote workspace path, and remote config path. `brainctl setup defaults --target remote` or
   `brainctl setup --target remote` should have created it before this point;
   rerun one of those commands if it is missing. This lets a later interrupted
   setup inspect remote progress before asking "local or remote?" again.
7. Create the remote private workspace and config/secrets/log/state directories.
8. Install placeholder runtime config with Telegram as the single primary
   entrypoint and selected provider recorded generically.
9. Write private Telegram/provider secret files only if the user supplies the
   values through a private temporary script/secret store flow; otherwise mark
   them pending.
10. Render and review, but do not install or enable, a systemd unit with
   `brainctl operations systemd`. The rendered command uses the runtime config's
   provider and primary entrypoint by default.
   Record its `ExecStart`, env file, working directory, restart policy, log
   command, and health command.
11. Run metadata-only checks and report exactly what remains before a live start:
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
