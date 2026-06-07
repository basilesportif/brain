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
- Treat setup as a guided operator flow. The user should not need to know SSH
  syntax, server paths, env-file names, systemd unit names, validation flags, or
  Brain CLI sequencing. Whenever user action is needed, give one exact
  copy-paste command or one concrete UI action; if a value is missing, ask for
  only that value so you can produce the command. Do not say only "SSH into the
  server", "run this remotely", "configure auth", "verify it", "check logs", or
  "start the service" without the exact command immediately attached.
- Ask confirmation questions in plain English and accept natural yes/no replies.
  Do not require magic phrases like "reply exactly..." unless the user must run
  a shell command verbatim.
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
- For Telegram bot tokens, generate the helper with
  `pnpm run brainctl setup telegram-token-script --path <workspace>` and run the
  returned command. Do not hand-write that shell script in chat.
- For Codex auth verification, generate the helper with
  `pnpm run brainctl setup codex-auth-script --config <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root> --ssh-host <host> --ssh-user <ssh-login-user> --service-user <brain-service-user>`.
  Show the exact returned `sshRunCommand` as a copy-paste command, for example
  `ssh -t root@host 'sudo -iu brain bash /tmp/verify-brain-codex-auth.sh'`, so
  the user can enter any device-auth flow in their terminal. Verify auth as the
  same non-root service user that systemd will use; a root Codex login does not
  make `User=brain` ready. Setup progress records the verified OS user and must
  not treat auth verified as one user as sufficient for a different service
  user. Do not say only "SSH into the server" or "run this on the server." The
  helper checks `codex login status`. If auth is missing during remote setup,
  the helper itself must print the exact copy-paste SSH login command, such as
  `ssh -t root@host 'sudo -iu brain codex login --device-auth'`; do not leave
  the user with only local-on-target `codex login` instructions. The JSON output
  should also include `sshLoginCommand` for automation, and setup progress is
  updated only through guarded `brainctl validate live --allow-live --run-safe`
  after login is present.
- Setup/secret metadata should inspect private workspace env files such as
  `<workspace>/config/brain-<workspace>.env` and
  `<workspace>/secrets/secrets.env`. Do not mark a step incomplete just because
  the current ad hoc shell or SSH command has not sourced those env vars.
- The initial private workspace scaffold must include the Brain assistant-logic
  JSON state model: `data/todos.json`, `data/projects.json`, `data/crm.json`,
  `data/reminders.json`, `private/documents/metadata.jsonl`,
  `instructions/**`, `tasks/**`, and selected `.claude/repo-registry/` state.
  `projects/`, `notes/`, `documents/`, and `documents/metadata/` remain
  supporting markdown/resource paths only; do not migrate current markdown notes
  or convert JSON state to markdown. Before the first live provider turn, make
  sure Codex is launched from the private
  workspace path with `TMPDIR=<workspace>/tmp`, `approval_policy=never`, and
  self-host service sandbox mode `danger-full-access`. Telegram cannot service
  interactive approval prompts, and server sandboxes can fail before shell
  commands start; isolate Brain with the dedicated service user and private
  workspace path instead. Todos/projects/CRM/reminders and file-save questions
  should be answered by using Brain's native assistant-logic CLI commands through
  `brainctl workspace run` with `ASSISTANT_WORKSPACE=<path>` and private roots set,
  not from active entrypoint metadata or markdown folders alone.
- Ensure the in-repo `packages/assistant-logic` package is present in the Brain
  checkout. No sibling assistant-agent-logic checkout is required; validate with
  `pnpm run brainctl workspace status --path <workspace>`.

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
show only the setup mode, remote SSH host, initial SSH user, future SSH user,
source checkout path, private workspace path, initial workspace name, and the
core setup flow. For a remote server, ask for the SSH IP/DNS host and initial
SSH login username; default that initial username to `root` if omitted, but
root must be kept only for one-time bootstrap and future commands should use
the non-root service user. Hide service user, systemd service name, derived
config/secrets/log paths, and command lists unless the user asks for details or
`brainctl setup defaults --verbose` is used.

1. Telegram connection? Default entrypoint is Telegram as `telegram-main`.
   Create/choose the BotFather bot, store only a private token ref, and do not
   start polling/webhooks yet.
2. Personal workspace memory? Create the Brain assistant-logic-compatible
   JSON workspace (`data/*.json` for todos/projects/CRM/reminders),
   instruction overlays, task metadata, file-save metadata, selected
   repo-registry state paths, and markdown resource folders. Ask whether the
   user wants to initialize or connect a private Git backup so non-secret
   workspace state can be committed privately; do not commit secrets, logs,
   Telegram IDs, transcripts, private document bytes, or raw provider state.
3. Private data/backup repo? Pull an existing private repo or initialize one in
   the private workspace. Safe defaults exclude secrets, logs, tmp, and caches.
4. Composio accounts? Connect Google Calendar/chat refs only if this workspace
   needs them; otherwise skip for minimal Telegram + Codex setup.
5. Workspace name? Default: `personal`.
6. Provider? Choose exactly one:
   - `codex` for the Codex provider; app-server mechanics stay inside the
     provider adapter/private config boundary.
   - `claude-code` only as a placeholder/seam for now; do not install real
     Claude Code wiring in this setup flow.
7. Provider auth status?
   - Existing CLI/session already authenticated.
   - Private API key/token to store outside git.
   - Not ready; create placeholders and report pending auth.
8. Codex auth ready? Configure or verify this before service start and before
   accepting Telegram traffic:
   - generate a target-host helper with
     `pnpm run brainctl setup codex-auth-script --config <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root> --ssh-host <host> --ssh-user <ssh-login-user> --service-user <brain-service-user>`,
   - for remote setup, show the exact returned `sshRunCommand` as a copy-paste
     command including user, host, and remote script path; for local setup,
     show the exact returned `runCommand`,
   - verify the Codex session as the service user that will run Brain,
   - if it reports missing auth during remote setup, run the exact SSH login
     command printed by the helper, then rerun it,
   - confirm the selected Codex transport/auth path,
   - store any credential only in the private workspace/server env file or host
     secret store,
   - run redacted metadata/health checks only, unless the user explicitly
     confirms a live provider check with `--allow-live`,
   - never print provider tokens, keys, session material, or raw env values.
9. Service install/start ready? Guide this after Telegram token storage,
   private data setup, and Codex auth are ready:
   - render and review the systemd plan,
   - confirm service user, working directory, private env file, and unit path,
   - require explicit user confirmation before privileged install, enable, or
     start commands,
   - keep the service stopped/pending if Codex auth or private secrets are not
     ready.
10. Optional follow-up: first-user pairing/admin bootstrap?
   - default: first-user pairing after service start, where up to two distinct
     Telegram user/chat pairs that message the newly configured bot become
     paired/admin state and pairing closes after the configured max,
   - cap first-user pairing at one admin pair when deliberately preserving a
     single-admin deployment,
   - user supplies an explicit admin allowlist privately,
   - optional advanced one-time `/pair <code>` flow,
   - not ready; leave pairing pending.
11. Optional follow-up: Telegram voice/audio transcription? Default: disabled.
    If enabled, configure `transcription.provider: openai`, `apiKeyRef` such as
    `env:OPENAI_API_KEY`, a model such as `gpt-4o-mini-transcribe`, and scope
    it to `telegram-main` with `voice`/`audio` attachment kinds. Store the
    OpenAI key only in the private workspace or host secret store.
12. Optional follow-up: generated pages/web preview? Default: disabled.
13. Optional follow-up: backup strategy tuning after the initial private repo
    exists.

BotFather token creation guidance:
   - open Telegram and message `@BotFather`,
   - send `/newbot`,
   - choose a display name,
   - choose a unique username ending in `bot` such as `my_brain_bot`,
   - store the returned token with the generated one-use helper from
     `pnpm run brainctl setup telegram-token-script --path <workspace>`; run the
     returned `bash .../store-brain-telegram-token.sh` command with a TTY so it
     prompts with hidden input, writes private token/config/env files, then
     deletes itself after success,
   - do not hand-roll shell quoting for the Telegram token helper; use the
     generated, syntax-checked script,
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
   - `data/`
   - `instructions/`
   - `instructions/skills/`
   - `instructions/prompts/`
   - `tasks/`
   - `.claude/repo-registry/`
   - `private/documents/`
   - `private/documents/files/`
   - `projects/`
   - `notes/`
   - `documents/`
   - `documents/metadata/`
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
   - then print the generated Codex auth helper command and, for remote setup,
     the full `ssh -t user@host 'bash /path/script.sh'` command before service
     start,
   - then show the exact operations/systemd command(s) needed to review,
     install, or start the service, and require explicit confirmation before
     privileged changes,
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
   - initial SSH login username, default `root` when omitted, and future service-user SSH identity,
   - repo clone path, default `/home/brain/brain` for the `brain` service user,
   - remote workspace path, default `/home/brain/.brain/workspace`,
   - provider and Telegram readiness.
   To display the concise grouped defaults without extra caveats, run:
   `pnpm run brainctl setup defaults --target remote --workspace <workspace-name>`.
   Use `--verbose` only when the user asks for derived paths, service-user, or
   service-name details. If the initial login is `root`, treat it only as the
   one-time bootstrap identity; future resume/status/auth/deploy commands must
   use the non-root service user.
2. Add or reuse a local `~/.ssh/config` entry so `ssh <host-label>` works. If
   root is needed only for bootstrap, run `pnpm run brainctl setup
   remote-bootstrap --ssh-host <host> --ssh-user root --service-user brain`
   (plus `--ssh-config/--ssh-alias` when generating an alias) so setup
   creates/validates the service user, sudo access, authorized keys, checkout
   and workspace ownership, then switches the alias/context to the service
   user.
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
  one-use private temporary script generated by
  `pnpm run brainctl setup telegram-token-script --path <workspace>` to prompt
  for the token and write it only into private token/config/env files. The token
  must never be committed, chatted, logged, printed, echoed, or left in shell
  history.
- Admin pairing defaults to first-user pairing with private
  `state/telegram-pairing` persistence for up to two exact admin user/chat
  pairs; cap it at one when deliberately preserving a single-admin deployment.
  An explicit private admin allowlist or optional `/pair` code is used only when
  requested.
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

After Brain starts with the token, the intended admin chat(s) should message the
bot to complete first-user pairing. By default up to two distinct user/chat
pairs can pair, and pairing closes after the cap. If the token is ever leaked,
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
