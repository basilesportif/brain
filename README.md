# brain

`brain` is a new local skeleton monorepo for consolidating a self-hosted assistant runtime, entrypoint adapters, web shell, reusable assistant logic, and self-host setup guidance.

Status: **safe parity scaffold**. Runtime, entrypoint, provider, supervisor, operations, and web-publisher seams exist for no-network validation, but no private assistant data, secrets, logs, generated artifacts, or real deployment state has been copied here.

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

## Initial commands

```bash
pnpm run check
```

The check currently validates that the skeleton structure exists, that runtime config examples are present, that private boundary directories contain only their README placeholders, and that provider/entrypoint/automation seams pass unit tests.


## brainctl

`brainctl` is the operator CLI for Brain. It validates runtime config, assistant-pack manifests, private-boundary hygiene, provider/entrypoint health seams, automation definitions, secret reference metadata, foreground fake supervisor smoke, non-mutating operations plans, and guarded live-readiness plans without deploying services or printing secret values. See `docs/brainctl.md`.

```bash
pnpm run build
pnpm run brainctl -- doctor --config examples/config/runtime.yaml --pack assistant-packs/core
pnpm run brainctl -- runtime smoke --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- operations plan --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl -- validate live --config examples/config/runtime.yaml --workspace personal --run-safe
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
