# brainctl

`brainctl` is the operator CLI for Brain. It remains validation-first and safe by default: it prepares private workspace directories, checks config/assistant-pack hygiene, resolves supervisor provider/entrypoint defaults from runtime config, keeps explicit fake/no-network smoke flags for tests, and renders deployment plans without installing services, contacting Telegram, deploying, or writing secrets unless explicit live flags are supplied.

## Commands

```bash
pnpm run brainctl -- setup --workspace personal --path ~/.brain/workspaces/personal
pnpm run brainctl -- setup inspect --config ~/.brain/workspaces/personal/config/runtime.yaml --workspace personal
pnpm run brainctl -- setup status --config ~/.brain/workspaces/personal/config/runtime.yaml --workspace personal
pnpm run brainctl -- doctor --config examples/config/runtime.yaml --pack assistant-packs/core
pnpm run brainctl -- config validate examples/config/runtime.yaml
pnpm run brainctl -- secrets check --config examples/config/runtime.yaml
pnpm run brainctl -- backup plan --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- backup init --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- backup init --config examples/config/runtime.yaml --workspace personal --apply
pnpm run brainctl -- backup check --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- backup status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- pack validate assistant-packs/core
pnpm run brainctl -- provider check codex --transport stub
pnpm run brainctl -- provider smoke codex --transport stub --prompt ping
pnpm run brainctl -- provider check codex --transport app-server --app-server-url ws://127.0.0.1:9000 --timeout-ms 3000
pnpm run brainctl -- provider check claude-code --transport stub
pnpm run brainctl -- entrypoint check telegram --token-env TELEGRAM_BOT_TOKEN \
  --polling-state ~/.brain/workspaces/personal/state/telegram-offset.json \
  --pairing-state ~/.brain/workspaces/personal/state/telegram-pairing
pnpm run brainctl -- start --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- run --config examples/config/runtime.yaml --workspace personal --fake --once --fake-text help
pnpm run brainctl -- health --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- logs --file ~/.brain/workspaces/personal/logs/runtime.jsonl --lines 100
pnpm run brainctl -- operations plan --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- operations systemd --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- operations validate --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- validate live --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- validate live --config examples/config/runtime.yaml --workspace personal --run-safe
pnpm run brainctl -- runtime status --state ~/.brain/workspaces/personal/state
pnpm run brainctl -- runtime smoke --config examples/config/runtime.yaml --workspace personal --text ping
pnpm run brainctl -- directives check docs/brainctl.md
pnpm run brainctl -- automation validate examples/config/automation.yaml
pnpm run brainctl -- automation run daily-summary --file examples/config/automation.yaml
pnpm run brainctl -- automation due --file examples/config/automation.yaml --now 2026-05-21T09:00:00.000Z
pnpm run brainctl -- automation monitor inbox-placeholder --file examples/config/automation.yaml
pnpm run brainctl -- composio setup --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- composio status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- web setup --config examples/config/runtime.yaml --workspace personal --base-url http://203.0.113.10/pages --publish-root /srv/brain/pages
pnpm run brainctl -- web status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- web validate --dir /path/to/static-page
pnpm run brainctl -- web publish --dir /path/to/static-page --id demo-page --dry-run
pnpm run brainctl -- web prune --dry-run
```

## Setup, inspect, and re-runnable plans

`setup` is idempotent by default. It creates only missing workspace directories
and never overwrites an existing config, secret, backup repo, or generated-page
root. Run it any time to reconcile the directory scaffold, or run `setup inspect`
/ `setup status` to get a metadata-only plan:

```bash
pnpm run brainctl -- setup --workspace personal --path ~/.brain/workspaces/personal
pnpm run brainctl -- setup inspect --config ~/.brain/workspaces/personal/config/runtime.yaml --workspace personal
```

The setup status response groups findings into:

- `configured`
- `missing_required`
- `missing_optional`
- `unsafe_to_overwrite`

Destructive replacement is never implicit; commands that support replacement
require explicit `--force` or `--replace` and still print the planned target.
Secret refs are checked only by env/file existence, mode, and byte size.

## Backup and private Git model

`backup plan/init/check/status` manages private-workspace backup metadata. The
default behavior is dry-run/safe: `backup init` prints actions unless `--apply`
is supplied. `private-git` uses a private repo path/remote/branch and safe
include/exclude rules; the template excludes `secrets/**`, `logs/**`, `tmp/**`,
caches, `node_modules`, and `*.log` by default. `backup status` summarizes Git
presence, remotes, branch, and status counts without printing private filenames.

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
pnpm run brainctl -- start --config examples/config/runtime.yaml --workspace personal

# Foreground fake-entrypoint/fake-provider smoke through the supervisor and command intercepts.
pnpm run brainctl -- run --config examples/config/runtime.yaml --workspace personal --fake --once --fake-text "help"

# Optional provider-backed Employee sessions (uses selected provider from config unless overridden).
pnpm run brainctl -- run --config examples/config/runtime.yaml --workspace personal --employee-runtime

# Inspect state/log readiness without live processes.
pnpm run brainctl -- health --config examples/config/runtime.yaml --workspace personal

# Tail supervisor JSONL logs with conservative token/key redaction.
pnpm run brainctl -- logs --file ~/.brain/workspaces/personal/logs/runtime.jsonl --lines 100
```

`start` defaults to a dry-run plan. Use `start --foreground` or `run` to enter the foreground supervisor. Provider and entrypoint default to the selected workspace's runtime config; pass `--fake` or explicit `--provider fake --entrypoint fake` for CI/fresh-checkout smoke. Explicit live Telegram polling requires `--entrypoint telegram --telegram-polling` plus `--telegram-token-env` or `--telegram-token-file`; polling offsets remain Telegram-native state only. Telegram bootstrap uses first-user pairing by default and stores paired identity state under the private state root; pass `--telegram-pairing` only for the optional advanced `/pair` code flow. Attachment download is opt-in with `--telegram-downloads`/`--telegram-download-dir`; voice/audio transcription can come from workspace `transcription.provider: openai` with an `apiKeyRef` such as `env:OPENAI_API_KEY`, or from the private `--telegram-transcription-command` seam. No transcription provider keys belong in the repo.

The supervisor intercepts service commands before provider turns when configured: `help`, `health`, `logs`/`introspect`, `agents`, `agent status`, `agent kill`, `agent steer`, `agent backend`, `employees`, `employee status/start/stop/steer`, and `update`/`deploy`. Backend mutation and deploy/update remain safe seams only. Employee commands update durable lifecycle records; pass `--employee-runtime` when running the supervisor to back Employee start/steer/stop with the selected provider session.


## Operations and guarded live-readiness

Deployment/update/rollback automation is represented as non-mutating plans:

```bash
# Render preflight/update/restart/rollback/post-update smoke commands as JSON.
pnpm run brainctl -- operations plan --config examples/config/runtime.yaml --workspace personal

# Render a systemd service unit without installing it or restarting anything.
pnpm run brainctl -- operations systemd --config examples/config/runtime.yaml --workspace personal

# Render a guarded Telegram/Codex live-readiness plan. Defaults to no network.
pnpm run brainctl -- validate live --config examples/config/runtime.yaml --workspace personal --codex-transport app-server

# Execute only safe local checks from that plan: config, secret metadata, runtime smoke,
# Codex stub provider check, and no-network Telegram adapter check.
pnpm run brainctl -- validate live --config examples/config/runtime.yaml --workspace personal --run-safe
```

`operations` never runs git, pnpm, systemctl, or deployment commands; it returns the exact operator commands to run externally. `validate live` is a guarded smoke harness: without `--allow-live`, live Codex app-server checks are only planned, Telegram token refs are checked by metadata, and no polling/webhook or user task starts.

`provider smoke` sends one provider turn through the provider abstraction. Stub transport is safe by default; `exec` and `app-server` require `--allow-live`.

`web validate/publish/prune/manifest` wrap `@brain/web` generated-page primitives. They validate static packages, reject secret-like files/content, publish through configured runtime roots/manifests, and keep scratch pages TTL-governed unless `--promoted` is supplied.

## Safety model

- `setup` creates only private directory scaffolding (`config/`, `secrets/`, `logs/`, `artifacts/`, `state/`, `backups/`, `tmp/`).
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
