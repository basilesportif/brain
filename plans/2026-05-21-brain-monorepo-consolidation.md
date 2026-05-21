# Brain monorepo consolidation plan

Date: 2026-05-21
Status: draft skeleton plan; no runtime code ported yet

## Goal

Create a clean `brain` monorepo that can eventually consolidate:

- `codex-chat` runtime behavior, with Telegram treated as an entrypoint adapter rather than the core app.
- `codex-chat-web` durable web shell and generated static page publisher patterns.
- `assistant-agent-logic` reusable prompts, skills, workflows, setup docs, and repo-registry conventions.
- Reusable assistant data patterns without copying private maintainer data.

The first step is intentionally limited to skeleton, documentation, and repo-registry registration.

## Non-goals for this first step

- Do not copy private data, secrets, logs, generated artifacts, transcripts, or local databases.
- Do not deeply port runtime code from existing repos.
- Do not port Codex app-server runtime code yet; keep it documented as a Codex provider implementation detail.
- Do not configure deployment or push to any remote.
- Do not make the repo public until public-readiness criteria pass.

## Architecture principles

1. **Clean monorepo first, public later** — use private/package boundaries that make future public extraction possible.
2. **Entrypoints are adapters** — Telegram, future web, and future iOS should translate external channels into generic Brain inbound events and Brain outbound actions.
3. **Runtime separated from assistant packs** — orchestration/web code belongs in runtime packages/apps; reusable prompts, skills, workflows, and setup docs belong in `assistant-packs/`.
4. **Provider-agnostic orchestration** — core runtime code depends on provider contracts; Codex and Claude Code integrations are adapters.
5. **Provider implementation details stay behind providers** — Codex app-server is part of `packages/providers/codex`, not a top-level app.
6. **Self-host first** — users initially run their own server and private workspace. SaaS is optional later.
7. **Explicit active entrypoints** — each workspace starts with one primary active entrypoint; multiple active entrypoints require deliberate config and validation.
8. **Private data stays private** — workspace/data paths are ignored, documented, and audited before any migration.

## Proposed directory structure

```text
brain/
  entrypoints/
    telegram/              # Telegram adapter: updates <-> Brain events/actions.
  apps/
    web/                   # Future codex-chat-web web shell/publisher extraction.
  packages/
    runtime-core/          # Provider-neutral and entrypoint-neutral orchestration contracts.
    entrypoint-protocol/   # Generic inbound event and outbound action protocol.
    providers/
      codex/               # Codex adapter; app-server details stay behind this package.
      claude-code/         # Claude Code adapter via SDK/subagent mechanism.
    assistant-pack-schema/ # Skill/prompt/workflow/setup schema and hygiene checks.
  assistant-packs/
    core/
      prompts/             # Public-safe prompt fragments using generic Brain vocabulary.
      skills/              # Public-safe setup/workflow skills.
      workflows/           # Provider-neutral and entrypoint-neutral workflow definitions.
  docs/                    # Architecture, setup, deployment, testing, public readiness.
  plans/                   # Migration plans and decision logs.
  workspace/               # Ignored user-owned workspace mount/symlink placeholder.
  private/                 # Ignored local-only private scratch boundary.
  data/                    # Ignored generated/user data boundary.
```

## Entrypoint protocol

`packages/entrypoint-protocol` should define channel-neutral contracts for:

- Inbound events: user messages, commands, callbacks/actions, attachments, lifecycle events, and delivery metadata.
- Outbound actions: replies, edits, artifact uploads, status updates, clarification requests, completion/failure notices, and channel-specific fallback metadata.
- Routing metadata: stable entrypoint ID, channel kind, external conversation ID, actor identity, workspace ID, and correlation IDs.

`entrypoints/telegram` should preserve current Telegram behavior by mapping Telegram chats, messages, threads, files, webhook/polling events, and API calls into and out of those generic contracts. Future web and iOS entrypoints should follow the same protocol rather than introducing prompt-specific channel concepts.

### Single vs multiple active entrypoints

Initial policy: **one primary active entrypoint per workspace**. This keeps identity, notifications, permissions, and conflict handling simple during the first runtime port.

Runtime configuration should make this policy explicit:

- Each workspace declares `primaryEntrypointId`.
- Each workspace declares an `enabledEntrypoints` map keyed by stable entrypoint ID.
- In `single-primary` mode, exactly one entrypoint may have `enabled: true`, and it must be the primary entrypoint.
- Outbound actions default to the entrypoint that originated the inbound event.
- Prompt context receives generic active-entrypoint metadata and capability flags, not Telegram-only vocabulary or secrets.

The protocol should still be shaped for multiple later: every inbound event and outbound action should carry entrypoint/routing metadata, and runtime-core should avoid assuming that Telegram is the only channel. A future workspace can then opt into Telegram plus web plus iOS without changing assistant-pack prompt semantics, but only through a deliberate `multi-explicit` config mode with routing, identity, permission, notification, and conflict policies.

## Prompt and workflow reframing

Assistant prompts, skills, and workflows should stop describing the user interface as Telegram-specific. Preferred language:

- Use **entrypoint**, **inbound message**, **user-visible reply**, **outbound action**, **artifact**, and **workspace**.
- Avoid **Telegram chat**, **bot message**, **bot token**, and similar terms outside Telegram adapter docs, tests, and setup instructions.
- Keep behavior equivalent for Telegram by letting `entrypoints/telegram` translate Brain outbound replies/status/artifacts into Telegram sends/edits/uploads.

During assistant-pack extraction, any prompt copied from `codex-chat` should be scrubbed so channel-specific assumptions move to entrypoint adapter documentation or channel-specific tests.

## Runtime vs assistant-pack separation

Runtime code should own:

- Generic event ingestion from entrypoints, server processes, health checks, job dispatch, queues, monitors, and artifact routing.
- Web shell/static publisher mechanics.
- Provider adapter invocation and event streaming.
- Deployment entrypoints and operational health.

Entrypoints should own:

- Channel-specific auth, delivery mechanisms, and API details.
- Translation between external channel payloads and Brain inbound/outbound contracts.
- Channel capability differences, such as message edits, upload limits, or threading models.

Assistant packs should own:

- Prompts, skills, setup guides, workflows, and policy/instruction fragments.
- Provider-neutral and entrypoint-neutral instructions that Codex and Claude Code can read directly.
- Schemas describing expected workspace data, without including real user data.

Rule: assistant packs may describe how to run a runtime capability, but they should not import runtime code, depend on Telegram, or require the maintainer's workspace.

## Private workspace boundary

The future private workspace should be outside public code paths and mounted, symlinked, or configured explicitly. It may contain user instructions, secrets, local state, task data, repo-registry controller state, generated page manifests, and logs.

Initial boundary rules:

- `workspace/`, `private/`, and `data/` are ignored except README placeholders.
- `.env*` files are ignored except `.env.example`.
- Public-safe source should include only examples, schemas, and docs.
- Any migration from `assistant-agent-data` or existing workspaces must go through an explicit inventory and cleanup phase.

## Provider abstraction

`packages/runtime-core` should define contracts for:

- Creating a task/session.
- Sending generic inbound events and receiving streamed runtime/provider events.
- Requesting tools, subagents, or image/page artifact handling.
- Reading/writing artifacts through controlled paths.
- Reporting health, cancellation, and final status.

Provider implementations:

- **Codex**: `packages/providers/codex` talks to Codex through its required integration path. Any Codex app-server surface should stay inside this provider package or a documented dependency boundary, avoiding a separate top-level runtime app.
- **Claude Code**: `packages/providers/claude-code` uses the Claude Code SDK/subagent mechanism and maps SDK/subagent events into runtime-core events.

Provider parity checks should verify that common workflows can run through either adapter where capabilities overlap.

## Self-host setup

Self-host should be the primary initial distribution model:

1. Clone `brain`.
2. Install Node/pnpm and provider prerequisites.
3. Create a private workspace outside git.
4. Choose provider mode: Codex, Claude Code SDK/subagents, or both.
5. Configure the primary entrypoint, initially Telegram, plus web env if enabled.
6. Run a local smoke test.
7. Deploy to a user-owned server.

Setup skills and docs should live in `assistant-packs/core/skills/` and `docs/` so Codex can inspect and follow them directly.

## Server deployment shape

No deployment should happen during the skeleton phase. Future deployment docs should define:

- Supported host baseline: Ubuntu, Git, Node/pnpm, optional Docker, process manager, reverse proxy/TLS.
- Runtime process layout: core runtime, primary entrypoint adapter, provider adapter dependencies, and web/static publisher if enabled.
- Secret storage: env files or host secret manager outside git.
- Health checks: CLI health command, HTTP endpoint where applicable, entrypoint reachability, and provider auth checks.
- Backups: private workspace/data backup policy, excluding cache/logs unless explicitly requested.
- Rollback: git ref rollback plus service restart instructions.

## Migration phases

### Phase 0 — skeleton and registration

- Create repo, package/workspace metadata, docs skeleton, empty entrypoint/app/package folders, and this plan.
- Register the repo in the local repo registry as local.
- Do not copy runtime code or private data.

### Phase 1 — inventory and classification

- Inventory `codex-chat`, `codex-chat-web`, `assistant-agent-logic`, and reusable assistant data patterns.
- Classify each item as runtime core, entrypoint adapter, provider adapter, assistant pack, private workspace, generated artifact, secret, or obsolete.
- Produce a migration map before moving code.

### Phase 2 — schemas and contracts

- Define runtime-core contracts, entrypoint protocol contracts, active-entrypoint config schemas, and assistant-pack schemas.
- Add validation for private boundary hygiene, package layout, one-primary-entrypoint defaults, `enabledEntrypoints` maps, originating-entrypoint outbound routing, and prompt context metadata safety.
- Add fake-entrypoint and fake-provider tests before real adapter ports.

### Phase 3 — assistant-pack extraction

- Port public-safe skills, prompts, setup docs, and workflows into `assistant-packs/core`.
- Replace Telegram-specific prompt language with generic entrypoint/inbound/outbound terminology unless the content is explicitly Telegram adapter setup.
- Replace owner-specific paths/account IDs with documented variables/placeholders.
- Keep workspace-local overlays and personal state out of git.

### Phase 4 — runtime and entrypoint extraction

- Port minimal runtime skeleton from `codex-chat` behind runtime-core interfaces.
- Port Telegram ingress/egress into `entrypoints/telegram` behind `entrypoint-protocol`, preserving current behavior as the sole enabled primary entrypoint for the migrated workspace.
- Port web shell/publisher primitives from `codex-chat-web` into `apps/web` only after generated/private page state boundaries are clear.
- Add health checks and smoke tests.

### Phase 5 — provider adapters

- Implement `packages/providers/codex`, keeping Codex app-server mechanics behind that package.
- Implement `packages/providers/claude-code` through SDK/subagents.
- Run provider contract tests and document capability differences.

### Phase 6 — self-host hardening

- Write end-to-end self-host setup docs and Codex-readable setup skills.
- Add deployment templates and rollback instructions.
- Test from a clean checkout, one primary entrypoint configured in `enabledEntrypoints`, and empty private workspace.

### Phase 7 — public readiness / optional publication

- Run secret/personal-data cleanup checks against working tree and git history.
- Add license, security policy, examples, and contribution docs if publication is desired.
- Decide whether to publish the whole monorepo, selected packages, or a public template.

## Secret and personal-data cleanup

Before any real migration or publication:

- Search for `.env`, tokens, API keys, SSH keys, bot tokens, OAuth files, cookies, and host-specific credentials.
- Exclude logs, generated artifacts, generated images/pages, local databases, transcripts, and queue state.
- Replace owner-specific paths, IPs, domains, account IDs, and repository aliases with examples unless the doc is explicitly private.
- Audit git history before public release, not just the working tree.
- Add automated checks for suspicious file names and secret-like patterns.

## Test strategy

- **Skeleton checks**: required directories/files exist and private boundary directories contain only placeholders.
- **Entrypoint protocol tests**: fake inbound events and outbound actions round-trip through generic contracts and Telegram mappings.
- **Package unit tests**: config parsing, workspace resolution, artifact path controls, and assistant-pack schemas.
- **Provider contract tests**: shared scenarios run against fake, Codex, and Claude Code providers where possible.
- **Integration tests**: temporary private workspace, fake entrypoint events, fake web artifacts, and fake provider events.
- **Deployment smoke tests**: service starts, health endpoint/CLI passes, entrypoint/provider auth is detected but secrets are not printed.
- **Migration regression tests**: compare selected behavior from old repos to new modules without copying private state.

## Public-readiness criteria

A public release is not ready until:

- Secret scans and personal-data audits pass for working tree and git history.
- All owner-specific private paths, hosts, accounts, and data examples are removed or converted to placeholders.
- Self-host docs work from a clean machine with an empty private workspace.
- Entrypoint protocol is documented and does not force users into Telegram.
- Provider abstraction is documented and does not force all users into one provider.
- Public-safe sample data replaces private data.
- License, support boundaries, security policy, and contribution expectations are explicit.

## Initial assumptions

- The safe local repo path is the current checkout path; publishable docs should use placeholders.
- No remote exists yet, so no remote is configured and nothing is pushed.
- `pnpm` is the preferred workspace manager because `codex-chat` already uses it.
- The repo remains private/local until the maintainer explicitly requests publication.


## Runtime configuration artifacts added in skeleton

- `docs/runtime-configuration.md` captures draft defaults, YAML/TOML examples, validation rules, generic prompt context metadata, and current Telegram migration notes.
- `examples/config/runtime.yaml` and `examples/config/runtime.toml` provide public-safe examples for one primary Telegram entrypoint plus a disabled future web entrypoint.
- These are documentation/skeleton artifacts only; no runtime code is ported in this phase.
