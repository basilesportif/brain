# brain

`brain` is a new local skeleton monorepo for consolidating a self-hosted assistant runtime, entrypoint adapters, web shell, reusable assistant logic, and self-host setup guidance.

Status: **skeleton only**. No private assistant data, secrets, logs, generated artifacts, or current runtime code has been copied here.

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

The check currently validates that the skeleton structure exists, that runtime config examples are present, and that private boundary directories contain only their README placeholders.

## Design goals

- Clean monorepo first, with an option to make public-safe slices later.
- Treat channel-specific bots as entrypoint adapters, not as the core app.
- Configure one primary active entrypoint per workspace by default through an explicit `enabledEntrypoints` map.
- Route outbound actions back to the originating entrypoint unless deliberate config says otherwise.
- Keep assistant prompts and workflows generic around Brain inbound events, active-entrypoint metadata, and outbound actions, while preserving Telegram behavior through the Telegram entrypoint adapter.
- Make setup skills and docs inspectable by Codex itself so a Codex subscriber can self-host.
- Keep provider support abstracted: Codex and Claude Code live behind provider packages; Codex app-server is an implementation detail of the Codex provider package.
- Assume users self-host their own servers initially; SaaS can be considered later.
