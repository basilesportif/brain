# brainctl

`brainctl` is the operator CLI for Brain. Its control-plane commands are the
current source of truth for stack setup/deploy planning: resolve
`codex-chat`, `assistant-agent-logic`, and `assistant-agent-data` from the repo
registry, preserve repo boundaries, and render no-network plans without
installing services, contacting hosts, or printing secrets. The older Brain
runtime/provider commands remain validation/lab surfaces.

Setup output should be direct-action first. When a setup step requires the user
to do something, print the exact copy-paste command or the exact UI message to
send, not a conceptual instruction. For remote work, this means a full command
such as `ssh -t root@host 'sudo -iu brain bash /tmp/verify-brain-codex-auth.sh'`,
not "SSH into the server."
For confirmations, ask in plain English and accept normal yes/no replies; do
not require the user to type a magic phrase unless they must run a command
verbatim.

For interrupted setup reruns, start with `setup status` before asking first-run
questions. It reports the current private `state/setup-progress.json` and, when
present, the ignored local `private/setup-context.json` pointer for a prior
remote setup. If a remote pointer exists, follow `resumeProbe.command` to inspect
remote metadata before restarting any wizard prompts.
For remote installs, `setup defaults --target remote` and
`setup --target remote` create/update that ignored local pointer immediately
with non-secret host/path metadata, refusing to write if the path is not safely
git-ignored.

## Commands

```bash
pnpm run brainctl setup defaults --target remote --workspace personal
pnpm run brainctl setup --workspace personal --path ~/.brain/workspace
pnpm run brainctl setup inspect --config ~/.brain/workspace/config/runtime.yaml --workspace personal
pnpm run brainctl setup status --config ~/.brain/workspace/config/runtime.yaml --workspace personal
pnpm run brainctl setup reset --workspace personal --path ~/.brain/workspace --dry-run
pnpm run brainctl setup reset --workspace personal --path ~/.brain/workspace --yes
pnpm run brainctl doctor --config examples/config/runtime.yaml --pack assistant-packs/core
pnpm run brainctl config validate examples/config/runtime.yaml
pnpm run brainctl secrets check --config examples/config/runtime.yaml
pnpm run brainctl stack status --workspace personal
pnpm run brainctl stack plan --workspace personal
pnpm run brainctl stack apply --workspace personal
pnpm run brainctl stack apply --workspace personal --executor mock --approve --approve-data --approve-config --approve-service --approve-health --metadata-file /tmp/brain-deployments.json
pnpm run brainctl backup plan --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl backup init --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl backup init --config examples/config/runtime.yaml --workspace personal --apply
pnpm run brainctl backup check --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl backup status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl workspace scaffold --path ~/.brain/workspace
pnpm run brainctl workspace status --path ~/.brain/workspace
pnpm run brainctl workspace commands --path ~/.brain/workspace
pnpm run brainctl workspace run --path ~/.brain/workspace todo-list.js
pnpm run brainctl workspace run --path ~/.brain/workspace project-list.js
pnpm run brainctl workspace run --path ~/.brain/workspace crm-list-people.js
pnpm run brainctl workspace run --path ~/.brain/workspace reminder-list.js
pnpm run brainctl workspace run --path ~/.brain/workspace file-list.js
pnpm run brainctl pack validate assistant-packs/core
pnpm run brainctl provider check codex --transport stub
pnpm run brainctl provider smoke codex --transport stub --prompt ping
pnpm run brainctl provider check codex --transport app-server --app-server-url ws://127.0.0.1:9000 --timeout-ms 3000
pnpm run brainctl provider check claude-code --transport stub
pnpm run brainctl entrypoint check telegram --token-env TELEGRAM_BOT_TOKEN \
  --polling-state ~/.brain/workspace/state/telegram-offset.json \
  --pairing-state ~/.brain/workspace/state/telegram-pairing
pnpm run brainctl start --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl run --config examples/config/runtime.yaml --workspace personal --fake --once --fake-text help
pnpm run brainctl health --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl logs --file ~/.brain/workspace/logs/runtime.jsonl --lines 100
pnpm run brainctl operations plan --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl operations systemd --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl operations validate --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl validate live --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl validate live --config examples/config/runtime.yaml --workspace personal --run-safe
pnpm run brainctl runtime status --state ~/.brain/workspace/state
pnpm run brainctl runtime smoke --config examples/config/runtime.yaml --workspace personal --text ping
pnpm run brainctl directives check docs/brainctl.md
pnpm run brainctl automation validate examples/config/automation.yaml
pnpm run brainctl automation run daily-summary --file examples/config/automation.yaml
pnpm run brainctl automation due --file examples/config/automation.yaml --now 2026-05-21T09:00:00.000Z
pnpm run brainctl automation monitor inbox-placeholder --file examples/config/automation.yaml
pnpm run brainctl composio setup --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl composio status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl web setup --config examples/config/runtime.yaml --workspace personal --base-url http://203.0.113.10/pages --publish-root ~/.brain/pages
pnpm run brainctl web status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl web validate --dir /path/to/static-page
pnpm run brainctl web publish --dir /path/to/static-page --id demo-page --dry-run
pnpm run brainctl web prune --dry-run
```

## Setup, inspect, and re-runnable plans

`setup` is idempotent by default. It creates only missing workspace directories
and never overwrites an existing config, secret, backup repo, or generated-page
root. Run it any time to reconcile the directory scaffold, or run `setup inspect`
/ `setup status` to get a metadata-only plan:

```bash
pnpm run brainctl setup defaults --target remote --workspace personal
pnpm run brainctl setup --workspace personal --path ~/.brain/workspace
pnpm run brainctl setup inspect --config ~/.brain/workspace/config/runtime.yaml --workspace personal
```

`setup defaults` is intentionally concise: by default it shows only the setup
mode, remote SSH host, initial SSH user, future SSH user, source checkout,
private workspace, initial workspace name, and the core setup flow. For remote
setup, ask for an SSH IP/DNS host and SSH login username; if no username is
given, default the initial login to `root` for one-time bootstrap, but persist
future setup/auth/deploy commands as the non-root service user (default
`brain`). Pass `--verbose` only when you need derived config/secrets/log paths,
service-user details, or copyable commands. In remote mode it also writes the
ignored local `private/setup-context.json` resume pointer unless `--dry-run` is
used. Use `pnpm run brainctl setup remote-bootstrap --ssh-host <host>
--ssh-user root --service-user brain` to idempotently create/validate the
service user, sudo access, authorized keys, `/home/brain/brain`, and
`/home/brain/.brain/workspace`, then rewrite the local resume context and any
explicit `--ssh-config/--ssh-alias` entry to `brain@host`.

The normal core setup flow is:

1. Confirm essential runtime choices by printing the resolved workspace path,
   provider, primary entrypoint, and service target.
2. If the provider is Codex, print the generated Codex auth helper command and,
   for remote setup, the full `ssh -t user@host 'bash /path/script.sh'` command
   before service start or live Telegram traffic.
3. Connect Telegram with exact BotFather messages or the generated token helper
   command; do not start polling/webhooks yet.
4. Pull or initialize the private data/backup repo.
5. Connect Composio accounts only if this workspace needs calendar/chat data
   sources.
6. Show exact operations/systemd command(s) for review/install/start, then wait
   for explicit confirmation before privileged changes.

OpenAI transcription, web publishing, backup policy tuning, and first-user
pairing are follow-up steps unless explicitly requested during initial setup.

The setup status response groups findings into:

- `configured`
- `missing_required`
- `missing_optional`
- `unsafe_to_overwrite`

Destructive replacement is never implicit; commands that support replacement
require explicit `--force` or `--replace` and still print the planned target.
Secret refs are checked only by env/file existence, mode, and byte size.

## Control-plane servant stack

`stack status`, `stack plan`, and `stack apply` are the control-plane commands
for the production architecture where Brain manages the `codex-chat` servant
runtime stack instead of replacing it:

```bash
pnpm run brainctl stack status --workspace personal
pnpm run brainctl stack plan --workspace personal
pnpm run brainctl stack apply --workspace personal
pnpm run brainctl stack status --registry /path/to/index.yaml --setup-context /path/to/setup-context.json
```

The status command resolves repo-registry entries for `codex-chat`,
`assistant-agent-logic` (or the legacy `assistant-claude` alias), and
`assistant-agent-data`; it also resolves deploy host, SSH identity, service
name, env/config paths, env-var names, health-check commands, and the canonical
deployment metadata ledger from `codex-chat` app metadata and local setup
context. Secret checks are represented only as metadata plans such as `stat` or
quiet env-key checks; values are always redacted.

Deployment metadata is canonical on the Brain/control-plane host, under:

```text
<brain-workspace-root>/state/control-plane/deployments.json
```

For the current remote Brain workspace that is:

```text
/home/brain/.brain/workspace/state/control-plane/deployments.json
```

The schema is `kind: brain.control-plane.deployments`, `version: 1`, with a
`deployments[]` list keyed by IDs such as `personal:production:codex-chat`.
Records include servant stack status, repo paths/remotes, approved executor
metadata, config/env placeholders, health status, and `secretValuesStored:
false`. Repo-registry and local notes are secondary pointers, not deployment
status authority.

The plan command renders, but does not run, the first servant-stack flow:
clone/update `codex-chat`, clone/update `assistant-agent-logic`, prompt/validate
`assistant-agent-data`/workspace, render `codex-chat` config/env, install/start
the `codex-chat` service, record deployment metadata, and run health checks. It
blocks boundary violations such as nesting `assistant-agent-logic` under
`codex-chat`.

`stack apply` is dry-run unless explicitly approved. Approval gates are:

- `--approve`: git/build/metadata execution gate.
- `--approve-data`: assistant-agent-data clone/init/validation gate.
- `--approve-config`: config/env template write gate; secret values remain
  placeholders only.
- `--approve-service`: systemd install/enable/start gate.
- `--approve-health`: live/read-only health check gate.

Executors are `dry-run`, `mock`, `local`, and `ssh`. Use `mock` with
`--metadata-file` for tests/rehearsals. Use `ssh` only after reviewing the
rendered action list; it runs approved commands via the resolved SSH identity and
redacts stdout/stderr before output.

Setup is resumable across Codex sessions. `brainctl setup` writes a
metadata-only private progress file at
`<private-workspace>/state/setup-progress.json` with mode `0600` where
practical. It records non-secret setup progress such as workspace name/path,
completed step ids, Codex auth status metadata, service install/start status,
Telegram token configured metadata, and the next recommended step. It never
stores raw tokens, API keys, session material, Telegram IDs, or logs. The file
is excluded from the private workspace Git template and source checkout ignores
workspace state. `setup inspect/status` reads this progress file as a resume aid,
not authority: current config, directory, secret-ref metadata, actual
remote/server state, and explicit live/provider/health checks still decide
whether setup can safely continue.

To restart only the wizard resume metadata, use `setup reset` with an explicit
workspace path. Use it when saved progress disagrees with real workspace,
remote, service, or provider state, or when setup cannot determine the safe next
step. Reset before guessing, using force/replace flags, or continuing from
inconsistent state; then rerun `setup inspect/status` and guarded live/status
checks. It targets exactly `<private-workspace>/state/setup-progress.json`; it
does not remove secrets, config, backups, logs, documents, provider sessions,
Telegram state, or other private data. `--dry-run` reports the target path,
previous presence/mode/size, and planned action. Without `--yes`, reset skips
removal. With `--yes`, it removes only that progress file and prints metadata
only.

## Backup and private Git model

`backup plan/init/check/status` manages private-workspace backup metadata. The
default behavior is dry-run/safe: `backup init` prints actions unless `--apply`
is supplied. `private-git` uses a private repo path/remote/branch and safe
include/exclude rules; the template excludes `secrets/**`, `logs/**`, `tmp/**`,
caches, `node_modules`, and `*.log` by default. `backup status` summarizes Git
presence, remotes, branch, and status counts without printing private filenames.

The default include policy now covers the Brain assistant-logic JSON workspace
state:

- `data/**` for todos, projects, CRM, reminders, and related JSON stores;
- `instructions/**` for skill/prompt overlays;
- `tasks/**` for scheduled task metadata;
- `private/documents/metadata.jsonl` for file-save metadata (not file bytes);
- selected `.claude/repo-registry/` state files; and
- legacy markdown resource folders (`projects/**`, `notes/**`,
  `documents/metadata/**`) as supporting resources only.

Bulky/private document bytes under `private/documents/files/**`, secrets, logs,
tmp/cache paths, setup progress metadata, and repo-registry runtime caches are
excluded by default.

## Lab assistant workspace parity

Brain still carries lab todo/project/CRM/reminder/file-save JSON stores and
compatibility scripts in the in-repo `packages/assistant-logic` package. These
commands are useful for tests and future experiments, but the control-plane
servant stack treats the separate `assistant-agent-logic` repo and
`assistant-agent-data` workspace as production sources of truth. Setup must not
vendor or merge those repos into Brain. `brainctl workspace run` executes the
lab integrated commands with:

```bash
ASSISTANT_WORKSPACE=<workspace>
ASSISTANT_PRIVATE_DIR=<workspace>/private
BRAIN_PRIVATE_DIR=<workspace>/private
```

Use:

```bash
pnpm run brainctl workspace scaffold --path ~/.brain/workspace
pnpm run brainctl workspace status --path ~/.brain/workspace
pnpm run brainctl workspace run --path ~/.brain/workspace todo-add.js -- --title "Buy coffee"
pnpm run brainctl workspace run --path ~/.brain/workspace project-list.js
pnpm run brainctl workspace run --path ~/.brain/workspace crm-list-people.js
pnpm run brainctl workspace run --path ~/.brain/workspace reminder-list.js
pnpm run brainctl workspace run --path ~/.brain/workspace file-save.js -- --source /path/to/file.pdf
pnpm run brainctl workspace run --path ~/.brain/workspace bet-list.js
pnpm run brainctl workspace run --path ~/.brain/workspace gmail-recent.js -- --limit 10
pnpm run brainctl workspace run --path ~/.brain/workspace calendar-events.js -- --days 7
pnpm run brainctl workspace run --path ~/.brain/workspace composio-connect.js -- --list
pnpm run brainctl workspace run --path ~/.brain/workspace protonmail-send.js -- --list-drafts
pnpm run brainctl workspace run --path ~/.brain/workspace finance-balances.js
pnpm run brainctl workspace run --path ~/.brain/workspace whoop-profile.js
pnpm run brainctl workspace run --path ~/.brain/workspace telegram-unread.js
```

The legacy `--assistant-repo` flag is accepted only as a deprecated no-op for
the lab command wrapper. For stack setup/deploy, use `brainctl stack status` and
`brainctl stack plan` to resolve the external `assistant-agent-logic` checkout
from the repo registry instead.

`workspace scaffold` writes empty stores and example templates only. Copy/fill `.env.example`, `composio.yaml.example`, `messaging.yaml.example`, `telegram.yaml.example`, and `protonmail.yaml.example` inside the private workspace; never commit filled credentials, OAuth tokens, Telegram sessions, ProtonMail Bridge passwords, finance tokens, WHOOP tokens, live API output, or private logs.

Run `brainctl workspace commands --path <workspace>` to list the full command catalog and whether each command resolves to a native or vendored implementation.

## Optional web publishing and Composio setup

`web setup/status` checks the optional generated-page publishing config without
changing DNS, Caddy, or reverse-proxy state. If the base URL is a direct IP,
DNS is reported as not needed; if it is a domain, DNS records are listed as
operator work only.

`composio setup/status` is optional and generic. It checks refs for Composio API
key metadata, connected-account metadata, Google Calendar, and chat data-source
config without using real credentials or printing values.

## Supervisor commands added for parity smoke

`brainctl start` and `brainctl run` now expose the long-running supervisor shape without making live side effects the default:

```bash
# Prints the resolved start plan only; no providers, Telegram, deployment, or services start.
pnpm run brainctl start --config examples/config/runtime.yaml --workspace personal

# Foreground fake-entrypoint/fake-provider smoke through the supervisor and command intercepts.
pnpm run brainctl run --config examples/config/runtime.yaml --workspace personal --fake --once --fake-text "help"

# Optional provider-backed Employee sessions (uses selected provider from config unless overridden).
pnpm run brainctl run --config examples/config/runtime.yaml --workspace personal --employee-runtime

# Inspect state/log readiness without live processes.
pnpm run brainctl health --config examples/config/runtime.yaml --workspace personal

# Tail supervisor JSONL logs with conservative token/key redaction.
pnpm run brainctl logs --file ~/.brain/workspace/logs/runtime.jsonl --lines 100
```

`start` defaults to a dry-run plan. Use `start --foreground` or `run` to enter the foreground supervisor. Provider and entrypoint default to the selected workspace's runtime config; pass `--fake` or explicit `--provider fake --entrypoint fake` for CI/fresh-checkout smoke. Explicit live Telegram polling requires `--entrypoint telegram --telegram-polling` plus `--telegram-token-env` or `--telegram-token-file`; polling offsets remain Telegram-native state only. Telegram bootstrap uses first-user pairing by default and stores paired identity state under the private state root; pass `--telegram-pairing` only for the optional advanced `/pair` code flow. Attachment download is opt-in with `--telegram-downloads`/`--telegram-download-dir`; voice/audio transcription can come from workspace `transcription.provider: openai` with an `apiKeyRef` such as `env:OPENAI_API_KEY`, or from the private `--telegram-transcription-command` seam. Brainctl wires the Telegram adapter in codex-chat parity mode: disabled/unavailable voice transcription replies `Voice transcription is not enabled.` and is not sent to the provider, disabled audio stays an attachment event, and configured voice/audio transcription errors are dropped before provider dispatch. No transcription provider keys belong in the repo.

The supervisor intercepts service commands before provider turns when configured: `help`, `health`, `logs`/`introspect`, `agents`, `agent status`, `agent kill`, `agent steer`, `agent backend`, `employees`, `employee status/start/stop/steer`, and `update`/`deploy`. Backend mutation and deploy/update remain safe seams only. Employee commands update durable lifecycle records; pass `--employee-runtime` when running the supervisor to back Employee start/steer/stop with the selected provider session.


## Operations and guarded live-readiness

Deployment/update/rollback automation is represented as non-mutating plans:

```bash
# Render preflight/update/restart/rollback/post-update smoke commands as JSON.
pnpm run brainctl operations plan --config examples/config/runtime.yaml --workspace personal

# Render a systemd service unit without installing it or restarting anything.
pnpm run brainctl operations systemd --config examples/config/runtime.yaml --workspace personal

# Render a guarded pre-live setup plan. Defaults to no network.
pnpm run brainctl validate live --config examples/config/runtime.yaml --workspace personal --codex-transport app-server

# Execute only safe local checks from that plan: config, secret metadata, runtime smoke,
# Codex stub provider check, and no-network Telegram adapter check.
pnpm run brainctl validate live --config examples/config/runtime.yaml --workspace personal --run-safe
```

`operations` never runs git, pnpm, systemctl, or deployment commands; it returns the exact operator commands to run externally. `validate live` is a guarded smoke harness: without `--allow-live`, live Codex app-server checks are only planned, Telegram token refs are checked by metadata, and no polling/webhook or user task starts. When the pre-live checks pass, the output is organized like a setup wizard instead of a raw dump:

- completed checks;
- not live yet;
- next step / guided sequence.

The guided sequence is intentionally: confirm essential runtime choices,
configure/verify Codex auth when the provider is Codex, connect Telegram token
storage without starting polling/webhooks, connect or initialize the private
data/backup repo, connect Composio accounts if needed, review/install/start the
service after explicit confirmation, then handle optional follow-ups such as
first-user pairing, OpenAI transcription, web publishing, and backup tuning.
The Telegram step shows the BotFather flow: message `@BotFather`, send
`/newbot`, choose a display name, choose a unique username ending in `bot`, and
store the token only via the generated one-use helper:
`pnpm run brainctl setup telegram-token-script --path <workspace>`. Run the
returned `bash .../store-brain-telegram-token.sh` command with a TTY; the script
is syntax-checked, prompts with hidden input, writes private token/config/env
files, and deletes itself after success. Never paste tokens into the repo, setup
chat, shell history, command output, or logs.

When the wizard reaches Codex auth, generate a target-host verification helper:

```bash
pnpm run brainctl setup codex-auth-script --config <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root> --ssh-host <host> --ssh-user <ssh-login-user> --service-user <brain-service-user>
```

For remote setup, give the user the returned
`ssh -t ... 'sudo -iu brain bash .../verify-brain-codex-auth.sh'` command when
the SSH login user differs from the service user. For local setup, run the
returned `bash .../verify-brain-codex-auth.sh` command as the same user that
will run Brain. A root Codex login is not enough for a `User=brain` systemd
service. The helper checks `codex login status`. If auth is missing during
remote setup, the helper itself prints the exact SSH command to run from the
operator's terminal, such as
`ssh -t root@host 'sudo -iu brain codex login --device-auth'`; it must not
leave the user with only local-on-target `codex login` instructions. The JSON
output also includes `sshLoginCommand` for automation. It records the verified
OS user in setup progress, so `setup status --service-user brain` will not
accept a Codex session that was verified as `root`. It records verified setup
state only through guarded
`validate live --codex-transport exec --allow-live --run-safe`.

When `validate live --run-safe` runs against an existing private workspace, it
may update `state/setup-progress.json` with metadata-only results such as Codex
auth verified by a guarded provider check or Telegram token ref presence. That
update still stores no secret values and remains a resume aid, not proof that
future provider/service health checks can be skipped.

`provider smoke` sends one provider turn through the provider abstraction. Stub transport is safe by default; `exec` and `app-server` require `--allow-live`.

`web validate/publish/prune/manifest` wrap `@brain/web` generated-page primitives. They validate static packages, reject secret-like files/content, publish through configured runtime roots/manifests, and keep scratch pages TTL-governed unless `--promoted` is supplied.

## Safety model

- `setup` creates only private directory scaffolding (`config/`, `secrets/`, `logs/`, `artifacts/`, `state/`, `backups/`, `tmp/`, `projects/`, `notes/`, `documents/`, `documents/metadata/`).
- `setup inspect/status` reports configured, missing required, missing optional,
  and unsafe-to-overwrite items for workspace dirs, config, provider/entrypoint,
  secret refs, source/backup Git state, backup policy, web publishing, and
  optional Composio data sources.
- `backup plan/init/check/status` is dry-run/safe by default, writes only backup
  metadata with `--apply`, and uses a private-workspace `.gitignore` template.
- `config validate` enforces the initial single-primary entrypoint policy and secret-free prompt context.
- `secrets check` reports only metadata such as env/file ref presence, mode, and byte size; values are redacted.
- `pack validate` checks assistant-pack manifests, skill frontmatter, and portable public-safety hygiene.
- `provider check` instantiates provider adapters and reports health without sending a real user task. Codex `app-server` checks can point at an existing WebSocket URL or, when a binary is supplied, exercise the provider-owned app-server protocol startup path.
- `provider smoke` runs a single provider turn; non-stub transports require `--allow-live`.
- `entrypoint check` instantiates entrypoint adapters without requiring live credentials. Optional Telegram token, polling-state, and pairing-state flags report only redacted token metadata, durable offset metadata, and paired identity counts/presence.
- `start` prints a dry-run supervisor start plan by default. `start --foreground` and `run` enter the foreground supervisor; provider/entrypoint default to runtime config, and `--fake` keeps explicit test/dev smoke side effects local.
- `health` inspects config, state, and log readiness without starting live processes.
- `status` combines health, runtime state/log metadata, and operations preflight readiness without starting live processes.
- `logs` tails supervisor JSONL logs with conservative redaction of token/key-like fields.
- `operations plan`, `operations systemd`, and `operations validate` render deployment/update/rollback/systemd artifacts and path metadata without installing, restarting, or mutating a checkout.
- `validate live` renders a guarded Telegram/Codex validation plan; `--run-safe` executes only no-network/no-secret checks unless `--allow-live` is supplied.
- `runtime status` initializes/reads job state and summarizes active jobs without starting providers or entrypoints.
- `runtime smoke` runs a deterministic no-network path through a fake entrypoint, `BrainRuntime`, a fake provider, and outbound dispatch routing using workspace metadata from the runtime config.
- `directives check` parses `brain-actions` and legacy `codex-chat` directive fences without executing anything. It reports normalized action counts, parse errors, and clean-text byte size.
- `automation validate` validates loop/monitor definitions, cron expression shape, and no-host-scheduler status.
- `automation run`, `automation due`, and `automation monitor` evaluate loops/monitor events without installing crontabs/watchers. They dry-run by default; `--dispatch` uses a local static subagent lifecycle plus file spool/locks for fake execution smoke.
- `web` commands validate/publish/prune generated static page packages through the publisher boundary; publish/prune support `--dry-run`.
- `web setup/status` checks domain vs direct-IP publishing fields and Caddy/reverse-proxy notes without changing DNS.
- `composio setup/status` checks optional Google Calendar/chat refs through Composio without real credentials.
- `doctor` combines the checks above with toolchain and private-boundary placeholder checks.

The CLI is the place setup, health, runtime, migration, and publisher commands should attach instead of making entrypoint or provider packages own operator workflows.
