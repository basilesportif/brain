---
name: setup-self-host
description: Guided Brain control-plane setup skill for local or remote codex-chat self-host bootstrap with Codex provider setup and Telegram first entrypoint.
---

# setup-self-host

Use this skill when a user opens the Brain repo root with Codex or Claude Code
and asks to install, set up, self-host, or "make this work". The current repo has
control-plane, stack planning, and lab compatibility seams, so this skill
guides private workspace creation, local/remote preparation, config/secrets
placeholders, validations, and a stop-before-live `codex-chat.service`
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
- Production service setup must target `codex-chat.service`, not
  `brain-personal.service`, `brainctl run`, or the Brain lab Telegram runtime.
  Stop/disable any legacy Brain polling service before enabling codex-chat to
  avoid double polling.
- Resolve repo authority from repo-registry metadata and refresh the real
  `codex-chat` and `assistant-agent-logic` checkouts during deployment/update.
  Verify and record the resolved SHAs; do not reuse stale embedded copies.
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
  `pnpm run brainctl setup codex-auth-script --config <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root> --ssh-host <host> --ssh-user <ssh-login-user> --service-user <codex-chat-service-user>`.
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
- The initial private workspace scaffold is generic codex-chat/assistant-data
  state only. Brain setup must not create or treat Brain-owned
  todos/projects/CRM/reminders stores as production authority. Before the first
  live provider turn, make sure codex-chat config points at the real
  `codex-chat` checkout, the separate `assistant-agent-logic` checkout, and the
  assistant-agent-data/private workspace. Domain questions are handled by the
  running codex-chat service using assistant-agent-logic/data, not by Brain
  setup code.
- Treat the in-repo `packages/assistant-logic` package as lab compatibility
  only. Production setup requires the separate `assistant-agent-logic` checkout
  resolved from the repo registry; validate Brain's lab workspace commands with
  `pnpm run brainctl workspace status --path <workspace>` only as a smoke check.

## Canonical user flow

The user clones/opens the Brain repo root in Codex or Claude Code and says
`setup` (or "get it up and running"). The agent then reads the referenced root
docs/skill files, checks for saved setup context/progress, and only asks the
first local-vs-remote question after progress has been checked or ruled out.

## Canonical provisioning sequence (get it up and running)

This is the ordered, resumable, prompt-driven path from a bare box to a working
Telegram instance for a NEW owner. The commands referenced here all exist. Run
the steps in order — the ordering is load-bearing: the control plane must exist
before the owner can be granted capabilities, and secrets must be in place
before the services first start. Persist every non-secret answer to
setup-context so an interrupted session resumes; enter every secret through a
one-use hidden-input helper (never echo, never commit). Setup is DONE only when
the acceptance gate (step 12) is green.

1. **Resume inspection.** `pnpm run brainctl setup status --repo <repo-root>
   --workspace <name>`; read `private/setup-context.json`; resume from
   `setupWizard.nextIncompleteStep` rather than restarting.
2. **Mode + guided answers.** Ask local vs remote, then collect and persist:
   service user (default `brain`); **owner admin email** (`ownerAdminEmail`,
   required — becomes the Clerk first admin and `CLERK_ALLOWED_EMAILS`); **owner
   Telegram user id** (`ownerTelegramUserId`, required — from @userinfobot); the
   four repo remotes (brain, codex-chat, assistant-agent-logic,
   assistant-agent-data); and remote SSH host/user/path if remote.
3. **Bare-server prerequisites (remote).** Prepare the service user with
   `pnpm run brainctl setup remote-bootstrap`, then install the base runtime per
   the fresh-remote prerequisites (Node >= 24, pnpm >= 10, git, cron, systemd
   with lingering as needed). Verify the versions before continuing.
4. **Brain checkout + workspace.** Clone/build brain (`pnpm install`,
   `pnpm run check`), then `pnpm run brainctl setup` to create the private
   workspace + setup-context.
5. **Repo registry.** `pnpm run brainctl registry init` with the collected
   remotes/paths and codex-chat deploy metadata. Resolve any
   `REQUIRED: set --…-remote <url>` placeholders it emits before proceeding —
   `brainctl stack` cannot run until the registry is complete.
6. **Secrets (one-use hidden-input helpers).** Telegram bot token; Clerk
   publishable key + secret key + `CLERK_ALLOWED_EMAILS` = the owner admin email
   (this MUST be set before brain-admin first starts, or the first admin is not
   seeded); OpenAI transcription key (optional). Written only into the rendered
   service env files, never into metadata, logs, or chat.
7. **Behavior pack for the new owner.** Point the new instance's codex-chat
   `behavior.dir` at codex-chat's `behavior-templates/generic` and set the
   config `[owner]` block (`name`, `telegramChatId`) so the generic, owner-neutral
   pack renders for this owner. (An existing personal instance keeps its own
   `behavior/` — this applies to NEW instances.)
8. **Deploy the stack.** `pnpm run brainctl stack plan` then `... stack apply`
   through the approval gates (apply → config → service → health). This builds
   and installs BOTH `codex-chat.service` and `brain-admin.service`, writes the
   codex-chat config with `[paths]`/`[brain]`/socket (per
   `docs/provisioning-contract.md`) and the brain-admin env with the SAME store
   path + IPC socket, and seeds the assistant-agent-data workspace from the logic
   template.
9. **Control plane up.** brain-admin starts, creates the capability store, and
   seeds the first Clerk admin from `CLERK_ALLOWED_EMAILS`. Confirm `/healthz`.
10. **Owner bootstrap.** `pnpm run brainctl owner bootstrap --telegram-user-id
    <id> --owner-email <email> --display-name <name>` — creates the owner person,
    links the Telegram identity, and grants the runtime channel baseline
    (`telegram.event.receive`/`assistant.run`/`output.text.send` with
    `surfaceKind:"telegram"` selectors) plus the domain baseline. It prints the
    Telegram user id that codex-chat's `/pair` allowlist must also include.
11. **Pair the channel.** Ensure the owner's Telegram id is in codex-chat's
    allowlist: the owner messages the bot and completes `/pair <code>` (the
    runtime pairing), targeting the SAME id printed in step 10 so pairing and
    capability grants line up.
12. **Acceptance gate.** `pnpm run brainctl canary --config <codex-chat.toml>`
    (add `--live` after the owner sends a test message). Every check must PASS —
    config resolves, store valid, Telegram-linked owner, IPC reachable, owner
    authorizes the runtime baseline, a stranger is denied, behavior pack present.
    If any check FAILs, follow its printed remediation and re-run. Green canary =
    provisioned.

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
2. Private assistant-agent-data/workspace state? Validate the workspace root,
   then pull or initialize the separate private data repo through the stack data
   gate or an explicit user-approved backup flow. Do not create Brain-owned
   domain stores as production authority; `brainctl workspace scaffold/run` is
   legacy/lab compatibility only.
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
     `pnpm run brainctl setup codex-auth-script --config <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root> --ssh-host <host> --ssh-user <ssh-login-user> --service-user <codex-chat-service-user>`,
   - for remote setup, show the exact returned `sshRunCommand` as a copy-paste
     command including user, host, and remote script path; for local setup,
     show the exact returned `runCommand`,
   - verify the Codex session as the service user that will run codex-chat,
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
5. Clone/update the user-confirmed Brain control-plane repository remote into
   the chosen repo path. Collect or confirm the four generic Git remotes, then
   run `pnpm run brainctl registry init --workspace <name> --brain-remote
   <url> --codex-chat-remote <url> --assistant-logic-remote <url>
   --assistant-data-remote <url> --deploy-host <local-or-ssh-target>` (plus
   saved `--repo`/`--setup-context` fields when needed). Use its validated
   repo-registry authority to resolve and clone/update `codex-chat` and
   `assistant-agent-logic`; do not proceed to stack apply while
   `unresolvedRemotes` is non-empty.
6. Run dependency/check commands from the remote repo root, at minimum
   `pnpm run check` after any install step.
7. Create the remote private workspace directories listed in the local flow.
8. Install placeholder runtime config with Telegram as `telegram-main` and the
   chosen provider identifier. Store real secret values only if supplied, and
   only through a private temporary script/secret store flow that keeps values
   out of shell history, chat, logs, and the checkout.
9. Re-run `brainctl registry init` with the same confirmed inputs. It must
   report either an unchanged stack-ready index or an atomic update with a
   backup. Then render servant-stack metadata with `brainctl stack plan`;
   install or enable `codex-chat.service` only after explicit confirmation.
   Record working directory, env/config refs, `ExecStart`, requested refs,
   resolved SHAs, restart policy, log command, health command, and
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

After `codex-chat.service` starts with the token, the intended admin chat(s) should message the
bot to complete first-user pairing. By default up to two distinct user/chat
pairs can pair, and pairing closes after the cap. If the token is ever leaked,
tell the user to rotate it immediately in `@BotFather` with `/revoke`, update
the private service secret, restart `codex-chat`, and verify setup checks still report
only redacted token metadata.

## Fresh remote prerequisites checklist

Before a new server test, confirm:

- Ubuntu LTS, SSH reachability, local SSH config alias, and dedicated service
  user.
- Base packages: `git`, `curl`, `unzip`, `build-essential`, `tmux`, `jq`,
  `ca-certificates`, `cron`, and systemd (with lingering if a user service is
  ever used — the stack deploys SYSTEM services, so lingering is not required).
- Node **>= 24** and pnpm **>= 10** (per `package.json` `engines`). Install them
  system-wide so the systemd unit (which runs `/usr/bin/env node`) can see them —
  do NOT rely on an nvm-only install in the operator's shell, or the service will
  fail to find `node`. Concretely, as root during bootstrap:

  ```bash
  # Node 24 system-wide (NodeSource)
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs cron
  systemctl enable --now cron
  # pnpm >= 10 via corepack (ships with Node 24)
  corepack enable && corepack prepare pnpm@latest --activate
  node -v   # must be >= v24
  pnpm -v   # must be >= 10
  ```

  If a Node manager is used instead, ensure the resolved `node`/`pnpm` are on the
  PATH of the systemd unit (set `Environment=PATH=...` in the unit or symlink into
  `/usr/local/bin`) — the rendered units assume `node` resolves via `/usr/bin/env`.
- `cron` must be installed and running: codex-chat loops are registered into the
  service user's crontab, so a missing `cron` breaks loop scheduling (not first
  chat, but any recurring job).
- Bun/Docker only if explicitly needed.
- Provider selected and auth either present or pending with clear next steps.
- Repo clone path and workspace path known; workspace is outside the checkout.
- systemd service name, env file path, logs, health, restart, update, backup,
  and rollback commands documented.
- Telegram token/admin pairing metadata ready or pending; checks report only
  counts and presence, never raw user/chat IDs or pairing code values.
- Generated web/pages disabled unless explicitly enabled.
- Firewall/ports: outbound HTTPS for polling; inbound HTTPS only for optional
  webhook/web preview.

## Control-plane and provider secrets

Every secret goes in through a one-use hidden-input helper (prompt with hidden
input, write to the private service env, then self-delete). Never echo, log, or
commit a value. The secrets a Telegram-only instance needs:

- **Telegram bot token** → codex-chat service env (`TELEGRAM_BOT_TOKEN`). From
  BotFather. Required.
- **Clerk** (the brain-admin control-plane login) → brain-admin env, required for
  the admin surface and the first-admin seed:
  - `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (from the Clerk dashboard).
  - `CLERK_ALLOWED_EMAILS` = the owner admin email. This is NOT secret but MUST
    be set before brain-admin first starts, or no first admin is seeded (an
    admin-less store is a bootstrap lockout — the owner-bootstrap step also
    repairs this, but set it up front).
- **OpenAI** (optional, voice transcription) → codex-chat service env
  (`OPENAI_API_KEY`). Transcription starts disabled; only needed if enabled.

Enter each with a one-use script, e.g. (Clerk secret key):

```bash
umask 077; f=$(mktemp); cat >"$f" <<'SH'
read -rsp "Clerk secret key: " V; echo
printf 'CLERK_SECRET_KEY=%s\n' "$V" >> "$BRAIN_ADMIN_ENV_FILE"
SH
bash "$f"; rm -f "$f"
```

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
pnpm run brainctl registry init --workspace <name> --deploy-host <local-or-ssh-target> \
  --brain-remote <url> --codex-chat-remote <url> \
  --assistant-logic-remote <url> --assistant-data-remote <url>
pnpm run brainctl stack status --workspace <name>
pnpm run brainctl stack plan --workspace <name>
pnpm run brainctl stack apply --workspace <name> --approve --approve-config --approve-service --approve-health
pnpm run brainctl owner bootstrap --telegram-user-id <owner-tg-id> --owner-email <owner-email> --display-name "<Owner Name>"
# Acceptance gate — provisioning is DONE only when this is PASS:
pnpm run brainctl canary --config <workspace>/config/codex-chat.toml
# After the owner sends a test Telegram message, confirm the full path lit up:
pnpm run brainctl canary --config <workspace>/config/codex-chat.toml --live
```

The `canary` command is the definition of "provisioned": a green run means a
new owner can message the Telegram bot and get an authorized reply with
capabilities enforced. Do not consider setup complete until it passes.
