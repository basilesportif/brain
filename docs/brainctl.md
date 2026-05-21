# brainctl

`brainctl` is the future operator CLI for Brain. In this initial runtime foundation it is intentionally a validation-first skeleton: it prepares private workspace directories and checks config/assistant-pack hygiene, but it does not start a live runtime, contact Telegram, deploy services, or write secrets.

## Commands

```bash
pnpm run brainctl -- setup --workspace personal --path ~/.brain/workspaces/personal
pnpm run brainctl -- doctor --config examples/config/runtime.yaml --pack assistant-packs/core
pnpm run brainctl -- config validate examples/config/runtime.yaml
pnpm run brainctl -- secrets check --config examples/config/runtime.yaml
pnpm run brainctl -- pack validate assistant-packs/core
pnpm run brainctl -- provider check codex --transport stub
pnpm run brainctl -- provider check codex --transport app-server --app-server-url ws://127.0.0.1:9000 --timeout-ms 3000
pnpm run brainctl -- provider check claude-code --transport stub
pnpm run brainctl -- entrypoint check telegram --token-env TELEGRAM_BOT_TOKEN --polling-state ~/.brain/workspaces/personal/state/telegram-offset.json
pnpm run brainctl -- start --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- run --config examples/config/runtime.yaml --workspace personal --once --fake-text help
pnpm run brainctl -- health --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- logs --file ~/.brain/workspaces/personal/logs/runtime.jsonl --lines 100
pnpm run brainctl -- runtime status --state ~/.brain/workspaces/personal/state
pnpm run brainctl -- runtime smoke --config examples/config/runtime.yaml --workspace personal --text ping
pnpm run brainctl -- directives check docs/brainctl.md
pnpm run brainctl -- automation validate examples/config/automation.yaml
pnpm run brainctl -- automation run daily-summary --file examples/config/automation.yaml
pnpm run brainctl -- automation due --file examples/config/automation.yaml --now 2026-05-21T09:00:00.000Z
```

## Supervisor commands added for parity smoke

`brainctl start` and `brainctl run` now expose the long-running supervisor shape without making live side effects the default:

```bash
# Prints the resolved start plan only; no providers, Telegram, deployment, or services start.
pnpm run brainctl -- start --config examples/config/runtime.yaml --workspace personal

# Foreground fake-entrypoint/fake-provider smoke through the supervisor and command intercepts.
pnpm run brainctl -- run --config examples/config/runtime.yaml --workspace personal --once --fake-text "help"

# Inspect state/log readiness without live processes.
pnpm run brainctl -- health --config examples/config/runtime.yaml --workspace personal

# Tail supervisor JSONL logs with conservative token/key redaction.
pnpm run brainctl -- logs --file ~/.brain/workspaces/personal/logs/runtime.jsonl --lines 100
```

`start` defaults to a dry-run plan. Use `start --foreground` or `run` to enter the foreground supervisor. The default provider and entrypoint are `fake`, so the command is safe in CI and fresh checkouts. Explicit live Telegram polling requires `--entrypoint telegram --telegram-polling` plus `--telegram-token-env` or `--telegram-token-file`; polling offsets remain Telegram-native state only.

The supervisor intercepts service commands before provider turns when configured: `help`, `health`, `logs`/`introspect`, `agents`, `agent status`, `agent kill`, `agent steer`, `agent backend`, `employees`, and `update`/`deploy`. Backend mutation, Employee lifecycle, and deploy/update are safe seams only: they acknowledge the command but do not mutate services or run deployments.

## Safety model

- `setup` creates only private directory scaffolding (`config/`, `secrets/`, `logs/`, `artifacts/`, `state/`, `backups/`, `tmp/`).
- `config validate` enforces the initial single-primary entrypoint policy and secret-free prompt context.
- `secrets check` reports only metadata such as env/file ref presence, mode, and byte size; values are redacted.
- `pack validate` checks assistant-pack manifests, skill frontmatter, and portable public-safety hygiene.
- `provider check` instantiates provider adapters and reports health without sending a real user task. Codex `app-server` checks can point at an existing WebSocket URL or, when a binary is supplied, exercise the provider-owned app-server protocol startup path.
- `entrypoint check` instantiates entrypoint adapters without requiring live credentials. Optional Telegram token and polling-state flags report only redacted token metadata and durable offset metadata.
- `start` prints a dry-run supervisor start plan by default. `start --foreground` and `run` enter the foreground supervisor; fake provider/entrypoint defaults avoid live side effects.
- `health` inspects config, state, and log readiness without starting live processes.
- `logs` tails supervisor JSONL logs with conservative redaction of token/key-like fields.
- `runtime status` initializes/reads job state and summarizes active jobs without starting providers or entrypoints.
- `runtime smoke` runs a deterministic no-network path through a fake entrypoint, `BrainRuntime`, a fake provider, and outbound dispatch routing using workspace metadata from the runtime config.
- `directives check` parses `brain-actions` and legacy `codex-chat` directive fences without executing anything. It reports normalized action counts, parse errors, and clean-text byte size.
- `automation validate` validates loop/monitor definitions, cron expression shape, and no-host-scheduler status.
- `automation run` and `automation due` evaluate loops without installing crontabs/watchers. They dry-run by default; `--dispatch` currently reports not-runnable unless a real runtime dispatch port is wired in a future command.
- `doctor` combines the checks above with toolchain and private-boundary placeholder checks.

The CLI is the place future setup, health, runtime, migration, and publisher commands should attach instead of making entrypoint or provider packages own operator workflows.
