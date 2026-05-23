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
up a local private workspace or a remote Ubuntu server over SSH. Do not `cd`
into a separate setup directory.

After safe pre-live validation, setup should continue in order: configure or
verify Codex auth, review/install/start the service only after explicit
confirmation, then configure Telegram. For the default Telegram entrypoint,
setup will ask for a BotFather token. If you do not have one yet, open
Telegram, message `@BotFather`, run `/newbot`, choose a bot name and a unique
username ending in `bot`, then save the returned token only in Brain's private
server secret file/env store or configured secret reference. Never commit or
paste the token into chat/logs. After Brain starts, send the bot its first
message to complete first-user pairing; rotate leaked tokens with BotFather
`/revoke`.

Setup is resumable: Brain writes only non-secret progress metadata to the
private workspace at `state/setup-progress.json` and uses it with fresh metadata
checks on rerun to continue from the next incomplete step. Raw secrets, tokens,
provider sessions, Telegram IDs, and logs do not belong in that file.

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
