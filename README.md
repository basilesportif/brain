# brain

`brain` is the control-plane and setup-orchestrator repository for Tim's
assistant stack. Its first responsibility is to resolve, plan, deploy, and
operate the servant runtime stack made of separate repositories:

- `codex-chat` — the servant Telegram/Codex runtime service.
- `assistant-agent-logic` — reusable assistant logic, scripts, prompts, and
  setup resources.
- `assistant-agent-data` / workspace — private durable workspace data and
  repo-registry state.

Status: **control-plane first**. `brainctl stack status` and
`brainctl stack plan` resolve the servant runtime stack from repo-registry
metadata and local setup context without contacting remote hosts, mutating
servers, or printing secrets. Brain's own in-repo runtime packages remain
experimental/lab compatibility surfaces; they are not the production servant
runtime source of truth.

## Intended layout

```text
src/brainctl.ts           Control-plane CLI, including stack registry resolution and no-network plans.
entrypoints/              Lab channel adapter experiments, not the production servant runtime.
apps/                     Lab app/static publisher placeholders.
packages/                 Lab provider/runtime compatibility packages and schemas.
assistant-packs/          Setup/operator guidance inspectable by Codex/Claude.
docs/                     Control-plane, setup, deployment, testing, and public-readiness docs.
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

Control-plane setup preserves repository boundaries. Brain resolves
`assistant-agent-logic` and `assistant-agent-data` from the repo registry and
plans clone/update/validation steps against those separate repositories. The
older in-repo `packages/assistant-logic` workspace commands are lab
compatibility helpers only; do not vendor, merge, or make them the production
source of truth for servant runtime deployment.

Brain must not become the home for Tim-assistant domain behavior. Assistant
workflows, prompts, skills, and intent rules belong in `assistant-agent-logic`;
runtime/channel behavior belongs in `codex-chat` or in generic Brain
transport/entrypoint code only when the behavior is domain-neutral.

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
pnpm run brainctl stack status --workspace personal
pnpm run brainctl stack plan --workspace personal
pnpm run brainctl operations plan --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl validate live --config examples/config/runtime.yaml --workspace personal --run-safe
pnpm run brainctl workspace status --path ~/.brain/workspace
pnpm run brainctl workspace run --path ~/.brain/workspace todo-list.js
```

## Design goals

- Brain is the control plane first; servant runtime execution belongs to
  `codex-chat` unless and until a future Brain runtime graduates from the lab.
- Keep Brain free of Tim-assistant domain logic; it is a deployment/control-plane
  wrapper around `codex-chat` and `assistant-agent-logic`, not a replacement for
  their runtime or workflow responsibilities.
- Preserve repo boundaries using repo-registry links/metadata; never vendor or
  merge `codex-chat`, `assistant-agent-logic`, or `assistant-agent-data` into
  Brain.
- Treat channel-specific bots as servant runtime/entrypoint concerns, not as
  the control-plane core.
- Configure one primary active entrypoint per workspace by default through an explicit `enabledEntrypoints` map.
- Route outbound actions back to the originating entrypoint unless deliberate config says otherwise.
- Keep assistant prompts and workflows generic around Brain inbound events, active-entrypoint metadata, and outbound actions, while preserving Telegram behavior through the Telegram entrypoint adapter.
- Make setup skills and docs inspectable by Codex itself so a Codex subscriber can self-host.
- Keep provider support abstracted: Codex and Claude Code live behind provider packages; Codex app-server is an implementation detail of the Codex provider package.
- Assume users self-host their own servers initially; SaaS can be considered later.
