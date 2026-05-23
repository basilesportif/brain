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
- First inspect for existing setup progress/context before asking first-run
  questions. Run `pnpm run brainctl setup status --repo <repo-root> --workspace
  <workspace-name>` from the repo root and check the reported
  `state/setup-progress.json` plus any ignored `private/setup-context.json`.
  If a prior remote context is found, ask only for permission or a missing SSH
  host needed to run the reported remote metadata check, then resume from the
  next incomplete step. Do not ask **local directory** vs **remote server over
  SSH** until saved progress has been checked or ruled out.
- Ask the user to choose **local directory** or **remote server over SSH** only
  when no existing progress/context was found.
- Ask before editing local `~/.ssh/config`, contacting a real host, writing a
  secret, creating a systemd unit, or starting/enabling a service.
- Keep real workspace contents, credentials, Telegram IDs, hostnames, logs,
  generated artifacts, and repo-registry data outside git.
- Do not require Composio or any optional integration for initial bootstrap.
- Print only secret metadata: existence, owner, mode, byte size, and required-key
  presence. Never print token values or raw chat/user IDs.
- Treat setup as re-runnable. Existing config, backup metadata, generated-page
  roots, and secret refs are inspected and reported, not overwritten. Destructive
  replacement requires an explicit `--force` or `--replace` on a command that
  documents the target.
- Use the private workspace resume file
  `<workspace>/state/setup-progress.json` as metadata-only setup state. It must
  be outside the source checkout, mode `0600` where practical, and excluded from
  private Git backups. It may record completed step ids, chosen workspace
  name/path, Codex auth status metadata, service install/start status, Telegram
  token configured metadata, and next recommended step. Never store raw
  secrets, tokens, provider session material, Telegram user/chat IDs, or logs.
  Reconcile it with current config, file metadata, secret-ref checks, actual
  remote/server state, provider health, and service health; do not trust stale
  progress blindly.
- If saved setup progress conflicts with real workspace/remote/server state, or
  if setup cannot determine the safe next step, run `brainctl setup reset` to
  clear only `state/setup-progress.json`, then rerun setup inspect/status and
  guarded live/status checks. Reset before guessing, using force/replace, or
  continuing from inconsistent state. It must not delete secrets, config,
  backups, logs, documents, provider sessions, Telegram state, or other private
  data.
- Run `pnpm run check` after setup/documentation edits and before declaring
  setup ready.
- Any copy-paste CLI command that inputs or stores a provider key, Telegram bot
  token, webhook secret, pairing code, or other secret must be provided as a
  one-use private temporary script rather than an inline command. The script
  lives outside version control, prompts/reads the secret with hidden input,
  writes only to the private workspace/server env file or configured secret
  store, and deletes itself after successful use. Never echo tokens in shell
  history, chat, logs, command output, or repo files.

## Canonical user flow

The user clones/opens the Brain repo root in Codex or Claude Code and says
`setup`. The agent then reads the referenced root docs/skill files, checks for
saved setup context/progress, and only asks the first local-vs-remote question
after progress has been checked or ruled out.

## Required first action

Before any "local or remote?" prompt, run a metadata-only resume inspection:

```bash
pnpm run brainctl setup status --repo <repo-root> --workspace <workspace-name>
```

If output reports a `resumeProbe.target` of `remote`, do not restart the wizard.
Ask only for permission to contact that known host, or for the missing SSH host
if the local pointer is incomplete, then run the reported `resumeProbe.command`
to inspect `/home/brain/.brain/workspace/state/setup-progress.json` (or the
configured remote path) on the server. Reconcile that metadata with actual
config/secret/service checks and continue from `setupWizard.nextIncompleteStep`.

If no local context/progress exists, or the user says this is a different setup,
then ask the first setup prompt below.

When the user confirms a remote target, immediately run
`pnpm run brainctl setup defaults --target remote --workspace <name>` (add
`--ssh-host`, `--ssh-user`, `--path`, and `--repo <repo-root>` when known) or
`pnpm run brainctl setup --target remote ...` so Brain creates/updates the
ignored `private/setup-context.json` pointer with non-secret resume metadata.
The CLI refuses to write the pointer if that path is tracked or not ignored by
git. The file shape is:

```json
{
  "version": 1,
  "target": "remote",
  "workspace": "personal",
  "workspaceRoot": "/home/brain/.brain/workspace",
  "sshHost": "<ssh-host>",
  "sshUser": "brain",
  "repoPath": "/home/brain/brain",
  "configPath": "/home/brain/.brain/workspace/config/runtime.yaml",
  "secretValuesStored": false
}
```

This file is a local/private pointer only. It may contain private host/path
metadata, is under ignored `private/`, and must never be committed. It exists so
a later interrupted Codex/Claude session can find remote progress before asking
first-run questions again.

## Required first prompt, only after resume inspection

Ask:

> Do you want to set Brain up locally in a private directory on this machine, or
> on a remote Ubuntu server over SSH?

Then collect the path-specific fields below.

## Common guided questions

For the first default confirmation, optimize for confidence over completeness:
show only the setup mode, remote SSH host/user when remote mode is selected,
source checkout path, private workspace path, initial workspace name, and the
core setup flow. For a remote server, ask for the SSH IP/DNS host and SSH login
username; default that SSH login username to `root` if omitted. Hide service
user, systemd service name, derived config/secrets/log paths, and command lists
unless the user asks for details or `brainctl setup defaults --verbose` is used.

1. Telegram connection? Default entrypoint is Telegram as `telegram-main`.
   Create/choose the BotFather bot, store only a private token ref, and do not
   start polling/webhooks yet.
2. Private data/backup repo? Pull an existing private repo or initialize one in
   the private workspace. Safe defaults exclude secrets, logs, tmp, and caches.
3. Composio accounts? Connect Google Calendar/chat refs only if this workspace
   needs them; otherwise skip for minimal Telegram + Codex setup.
4. Workspace name? Default: `personal`.
5. Provider? Choose exactly one:
   - `codex` for the Codex provider; app-server mechanics stay inside the
     provider adapter/private config boundary.
   - `claude-code` only as a placeholder/seam for now; do not install real
     Claude Code wiring in this setup flow.
6. Provider auth status?
   - Existing CLI/session already authenticated.
   - Private API key/token to store outside git.
   - Not ready; create placeholders and report pending auth.
7. Codex auth ready? Configure or verify this before service start and before
   accepting Telegram traffic:
   - confirm the selected Codex transport/auth path,
   - store any credential only in the private workspace/server env file or host
     secret store,
   - run redacted metadata/health checks only, unless the user explicitly
     confirms a live provider check with `--allow-live`,
   - never print provider tokens, keys, session material, or raw env values.
8. Service install/start ready? Guide this after Telegram token storage,
   private data setup, and Codex auth are ready:
   - render and review the systemd plan,
   - confirm service user, working directory, private env file, and unit path,
   - require explicit user confirmation before privileged install, enable, or
     start commands,
   - keep the service stopped/pending if Codex auth or private secrets are not
     ready.
9. Optional follow-up: first-user pairing/admin bootstrap?
   - default: first-user pairing after service start, where the first Telegram
     user/chat to message the newly configured bot becomes paired/admin state,
   - user supplies an explicit admin allowlist privately,
   - optional advanced one-time `/pair <code>` flow,
   - not ready; leave pairing pending.
10. Optional follow-up: Telegram voice/audio transcription? Default: disabled.
    If enabled, configure `transcription.provider: openai`, `apiKeyRef` such as
    `env:OPENAI_API_KEY`, a model such as `gpt-4o-mini-transcribe`, and scope
    it to `telegram-main` with `voice`/`audio` attachment kinds. Store the
    OpenAI key only in the private workspace or host secret store.
11. Optional follow-up: generated pages/web preview? Default: disabled.
12. Optional follow-up: backup strategy tuning after the initial private repo
    exists.

BotFather token creation guidance:
   - open Telegram and message `@BotFather`,
   - send `/newbot`,
   - choose a display name,
   - choose a unique username ending in `bot` such as `my_brain_bot`,
   - store the returned token with a one-use private temporary script such as
     `bash /private/tmp/store-brain-telegram-token.sh` on macOS or a script in
     a `0700` `mktemp -d` directory on Linux; the script prompts with hidden
     input, writes the token into the private Brain server `secrets.env`,
     private env store, or configured secret-store reference, then deletes
     itself after success,
   - never commit, paste, echo, or log the token in repo files, chat
     transcripts, shell history, command output, or setup summaries.
11. Optional private workspace backup? Default: none. Offer `local-snapshot` or
   `private-git` with private repo path, optional remote, branch, and safe
   include/exclude defaults that exclude secrets/logs/tmp/caches.
12. Optional generated web publishing? If yes, ask domain vs direct IP, public
   base URL, publish root, Caddy/reverse-proxy note, and explain DNS is needed
   for domains but not direct IP. Do not change DNS.
13. Optional Google Calendar/chat through Composio? If yes, collect only env/file
   refs for API key and connected-account metadata; do not request or print real
   credentials.

## Local setup flow

1. Confirm a private workspace path outside the checkout, for example
   `~/.brain/workspace`.
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
6. Store provider auth and Telegram token/admin-pairing data only through
   private temporary secret-entry scripts into workspace secret files, private
   `state/telegram-pairing`, or the user's chosen secret store.
7. Run metadata-only validation:
   - workspace exists outside git,
   - expected directories exist,
   - secret files are not tracked,
   - runtime config has one primary enabled entrypoint,
   - provider auth and Telegram bootstrap are either present or clearly pending,
   - backup, web publishing, Composio, providers, entrypoints, and integrations
     are listed as configured/missing optional/missing required.
8. Run safe `brainctl` validations and summarize the setup-wizard sequence
   before live Telegram traffic:
   - completed checks,
   - not live yet,
   - next step: connect Telegram and show BotFather/private-token guidance,
   - then pull or initialize the private data/backup repo,
   - then connect Composio accounts if needed,
   - then confirm essential runtime choices,
   - then configure/verify Codex auth before service start,
   - then review/install/start the service after explicit confirmation,
   - finally optional follow-ups such as first-user pairing, OpenAI
     transcription, web publishing, or backup tuning.
9. If the user reruns setup after closing a Codex/Claude session, inspect
   `<workspace>/state/setup-progress.json` plus current config, secret metadata,
   remote/server state, and guarded live/status metadata. Continue from the next
   incomplete step only when those sources agree. If they conflict, or if the
   safe next step is unclear, run `brainctl setup reset` before rerunning
   inspect/status checks; do not guess or force inconsistent state.

Recommended safe commands:

```bash
pnpm run brainctl setup status --config <private-config> --workspace <workspace-name>
pnpm run brainctl backup plan --config <private-config> --workspace <workspace-name>
pnpm run brainctl web status --config <private-config> --workspace <workspace-name>
pnpm run brainctl composio status --config <private-config> --workspace <workspace-name>
```

## Remote SSH setup flow

Use this flow only after the user chooses remote mode and confirms the host.

1. Collect:
   - local SSH config host label,
   - server address/IP,
   - initial SSH login username, default `root` when omitted,
   - repo clone path, default `/home/brain/brain` for the `brain` service user,
   - remote workspace path, default `/home/brain/.brain/workspace`,
   - provider and Telegram readiness.
   To display the concise grouped defaults without extra caveats, run:
   `pnpm run brainctl setup defaults --target remote --workspace <workspace-name>`.
   Use `--verbose` only when the user asks for derived paths, service-user, or
   service-name details.
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
   chosen provider identifier. Store real secret values only if supplied, and
   only through a private temporary script/secret store flow that keeps values
   out of shell history, chat, logs, and the checkout.
9. Render systemd metadata with `brainctl operations systemd`; install or enable
   a unit only after explicit confirmation. Record working directory, env file
   path, `ExecStart`, restart policy, log command, health command, and
   rollback/update notes.
10. Report remaining blockers before any live start in this order: Codex auth,
    reviewed service install/start, Telegram bot token, first-user pairing or
    selected admin bootstrap, webhook/firewall, and optional web preview.

## Telegram bootstrap minimum

The initial Telegram setup is successful when:

- `telegram-main` is configured as the single primary entrypoint.
- Codex auth has been configured or explicitly left pending with private-only
  credential storage instructions.
- Service installation/start has been reviewed and either completed with
  explicit confirmation or left pending before Telegram live traffic.
- A private bot token secret is present or clearly marked pending. If missing,
  setup tells the user to open Telegram, message `@BotFather`, run `/newbot`,
  choose a bot display name and a unique username ending in `bot`, then use a
  one-use private temporary script to prompt for the token and write it only
  into private Brain server `secrets.env`, private env store, or the configured
  secret reference. The token must never be committed, chatted, logged, printed,
  echoed, or left in shell history.
- Admin pairing defaults to first-user pairing with private
  `state/telegram-pairing` persistence; an explicit private admin allowlist or
  optional `/pair` code is used only when requested.
- The setup summary explains that future integrations can be configured through
  Telegram after admin pairing.
- No Composio or third-party integration token is required.
- Voice/audio transcription is optional. If requested, use the runtime
  `transcription` config with an OpenAI secret ref such as
  `env:OPENAI_API_KEY`; setup may check only key presence metadata and must not
  print or store the value in git.

Prefer polling for the first bootstrap because it needs only outbound HTTPS.
Webhook mode, reverse proxy, TLS, firewall rules, generated pages, and web
preview are optional follow-up setup.

After Brain starts with the token, the user should send the bot its first
Telegram message to complete first-user pairing. If the token is ever leaked,
tell the user to rotate it immediately in `@BotFather` with `/revoke`, update
the private Brain secret, restart Brain, and verify setup checks still report
only redacted token metadata.

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
pnpm run brainctl setup --workspace <name> --path <workspace>
pnpm run brainctl config validate <workspace>/config/runtime.yaml
pnpm run brainctl secrets check --config <workspace>/config/runtime.yaml
pnpm run brainctl entrypoint check telegram --token-env TELEGRAM_BOT_TOKEN \
  --polling-state <workspace>/state/telegram-offset.json \
  --pairing-state <workspace>/state/telegram-pairing
pnpm run brainctl doctor --config <workspace>/config/runtime.yaml --pack assistant-packs/core
pnpm run brainctl operations validate --config <workspace>/config/runtime.yaml --workspace <name> --repo <checkout>
pnpm run brainctl operations systemd --config <workspace>/config/runtime.yaml --workspace <name> --repo <checkout>
```
