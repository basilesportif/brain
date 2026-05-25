# brain

`brain` is a local monorepo for consolidating a self-hosted assistant runtime, entrypoint adapters, web shell, reusable assistant logic, and self-host setup guidance.

Status: **safe parity surface**. Runtime, entrypoint, provider, supervisor, operations, and web-publisher seams exist for no-network validation and reviewed setup/deployment planning, but no private assistant data, secrets, logs, generated artifacts, or real deployment state has been copied here.

## Intended layout

```text
entrypoints/              Channel adapters such as Telegram; they translate external traffic into Brain events.
apps/                     Durable runtime applications, currently the web shell/static publisher placeholder.
packages/                 Provider-neutral libraries, entrypoint protocol contracts, and provider adapters.
assistant-packs/          Pure prompts, skills, workflows, and setup guidance inspectable by Codex/Claude.
docs/                     Architecture, runtime configuration, entrypoint, self-host, deployment, testing, and public-readiness docs.
plans/                    Migration and consolidation plans.
workspace/, private/, data/  User-owned/private boundaries; ignored except README placeholders.
```


## Setup

Clone or open this repository root in Codex or Claude Code, then say `setup`.
The agent should stay in the repo root, read `AGENTS.md`, `CLAUDE.md` when
running under Claude Code, `docs/setup-plan.md`, and
`assistant-packs/core/skills/setup-self-host/SKILL.md`, then ask whether to set
up a local private workspace or a remote Ubuntu server over SSH. Before asking
that first-run question, setup should run `brainctl setup status` to inspect
existing private setup progress and any ignored `private/setup-context.json`
remote pointer, then resume from saved state when present. Do not `cd` into a
separate setup directory.
For remote installs, `brainctl setup defaults --target remote` or
`brainctl setup --target remote` writes that ignored non-secret pointer early so
an interrupted setup can be resumed after a later pull.

After safe pre-live validation, setup should confirm essential runtime choices
and, when the provider is Codex, configure or verify Codex auth before service
start or live Telegram traffic. For the default Telegram entrypoint, setup will
ask for a BotFather token but must not start polling/webhooks until service
start is explicitly confirmed. If you do not have a bot yet, open Telegram,
message `@BotFather`, run `/newbot`, choose a bot name and a unique username
ending in `bot`, then store the returned token only through a one-use private
temporary script that prompts with hidden input and writes to Brain's private
server secret file/env store or configured secret reference. Never commit,
paste, echo, log, or leave the token in shell history. After Brain starts, send
the bot its first message to complete first-user pairing; rotate leaked tokens
with BotFather `/revoke`.

Setup is resumable: Brain writes only non-secret progress metadata to the
private workspace at `state/setup-progress.json` and uses it with fresh metadata
checks on rerun to continue from the next incomplete step. Raw secrets, tokens,
provider sessions, Telegram IDs, and logs do not belong in that file.
Use `brainctl setup reset --workspace <name> --path <workspace-path> --dry-run`
to inspect a reset, and add `--yes` to remove only that progress file.

Short-term personal workspace parity is JSON-backed and reuses
assistant-agent-logic rather than a Brain-native store port. Setup scaffolds
`data/todos.json`, `data/projects.json`, `data/crm.json`,
`data/reminders.json`, `private/documents/metadata.jsonl`,
`instructions/`, `tasks/`, and selected repo-registry state. Use
`brainctl workspace run --path <workspace> <assistant-script>.js -- <args>` to
run the existing assistant-agent-logic scripts against that workspace. Markdown
`projects/`, `notes/`, and `documents/metadata/` folders remain supporting
resources only.

## Initial commands

```bash
pnpm run check
```

The check validates that the repo structure exists, runtime config examples are present, private boundary directories contain only their README placeholders, and provider/entrypoint/automation seams pass unit tests.


## brainctl

`brainctl` is the operator CLI for Brain. It validates runtime config, assistant-pack manifests, private-boundary hygiene, provider/entrypoint health seams, automation definitions, secret reference metadata, config-driven supervisor plans, explicit fake smoke paths, non-mutating operations plans, and guarded live-readiness plans without deploying services or printing secret values. See `docs/brainctl.md`.

```bash
pnpm run build
pnpm run brainctl doctor --config examples/config/runtime.yaml --pack assistant-packs/core
pnpm run brainctl runtime smoke --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl operations plan --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl validate live --config examples/config/runtime.yaml --workspace personal --run-safe
pnpm run brainctl workspace status --path ~/.brain/workspace
pnpm run brainctl workspace run --path ~/.brain/workspace todo-list.js
```

## Design goals

- Clean monorepo first, with an option to make public-safe slices later.
- Treat channel-specific bots as entrypoint adapters, not as the core app.
- Configure one primary active entrypoint per workspace by default through an explicit `enabledEntrypoints` map.
- Route outbound actions back to the originating entrypoint unless deliberate config says otherwise.
- Keep assistant prompts and workflows generic around Brain inbound events, active-entrypoint metadata, and outbound actions, while preserving Telegram behavior through the Telegram entrypoint adapter.
- Make setup skills and docs inspectable by Codex itself so a Codex subscriber can self-host.
- Keep provider support abstracted: Codex and Claude Code live behind provider packages; Codex app-server is an implementation detail of the Codex provider package.
- Assume users self-host their own servers initially; SaaS can be considered later.
