# Brain runtime port plan and initial implementation checkpoint

Date: 2026-05-21
Status: initial implementation slices landed; full runtime port remains incomplete

## Source boundaries inspected

- `codex-chat`: runtime concepts inspected from the authoritative checkout; no private config, secrets, logs, data, or generated artifacts were copied.
- `codex-chat-web`: generated static page publisher concepts inspected from the authoritative checkout; maintainer-specific paths/domains were not ported as defaults.
- `assistant-agent-logic`: reusable setup, repo-authority, and generated-page workflow concepts inspected from source-controlled guidance; private workspace symlink/data was not copied.

## Implemented slices

### Runtime foundations

- Provider-neutral `EntryPointInboundEvent` and `BrainOutboundAction` contracts.
- Workspace config validation with `single-primary` active entrypoint policy.
- Provider session/turn contracts plus Codex and Claude Code stub adapters behind provider packages.
- Generic Brain directive parser supporting `brain-actions` blocks and legacy `codex-chat` action block normalization.
- Minimal `BrainRuntime` that sends inbound events to a provider session, parses final text/actions, routes replies to the originating entrypoint, and can consume `dispatch_subagent` actions through a runtime lifecycle port.
- Runtime entrypoint bridge plus fake entrypoint/fake provider smoke path: inbound event -> runtime -> provider -> outbound dispatch result.
- Subagent job, loop, and monitor schemas with in-memory and file-backed job stores. This captures high-value codex-chat runtime concepts without copying process management or private state.
- Provider-neutral subagent lifecycle core: queueing, max concurrency, running/terminal transitions, cancellation, steering hooks, startup hydration that abandons unsafe active persisted jobs, and a static executor for tests/doctor checks.
- Workspace-local `FileRuntimeStateStore` for private JSON/JSONL state under a runtime state directory.

### Entrypoint slice

- Telegram adapter skeleton that maps Telegram-like updates into generic inbound events and maps core outbound actions into Telegram API call intents.
- No-network `TelegramEntrypointAdapter` implementing the generic entrypoint protocol over supplied update iterables and dispatch-intent hooks.
- The adapter has no bot token handling, network client, webhook, polling loop, or private allowlist data.

### Provider slice

- Codex `exec` transport now shells out to `codex exec --json` (or a configured binary/argv), streams JSONL deltas/status/final events into runtime-core provider events, and checks CLI health with `--version`.
- Codex `app-server` remains behind the provider boundary with an injectable protocol-client seam; no top-level app-server runtime was added.

### Web publisher slice

- `@brain/web` static generated-page validation, publish-to-runtime-directory, manifest update, and TTL prune primitives.
- Portable local defaults and `BRAIN_WEB_*` overrides replace maintainer-specific default paths/domains.
- Tests cover publish, prune, symlink rejection, and secret-like filename/content rejection.

### Assistant pack slice

- Core assistant pack manifest validation.
- Portable setup/self-host, setup-server, repo-registry, and generated-web-page skills.
- Runtime boundary prompt fragment using generic entrypoint/provider vocabulary.

### Operator CLI

- `brainctl setup`, `doctor`, `config validate`, `secrets check`, and `pack validate` validation-first skeleton.

## Remaining full-port steps

1. **Codex provider transport**: harden `@brain/provider-codex` beyond the initial exec transport: cancellation/interrupt, structured logs, image/artifact handoff, provider session IDs/resume handles, and real app-server protocol client wiring.
2. **Claude Code provider transport**: implement SDK/subagent execution behind `@brain/provider-claude-code`, plus contract parity tests.
3. **Runtime state policy**: keep only minimal job/runtime state needed for operations. Do **not** add persistent turn replay, exact idempotency replay, or a durable turn store. After a crash/restart, rely on Codex/Claude provider resume infrastructure when a provider can resume; otherwise report degraded recovery and ask the user to restart the work from current context.
4. **Telegram live entrypoint**: port polling/webhook startup, bot API client, file download/upload, reply/thread mapping, admin allowlists, voice transcription handoff, status updates, reactions, and error reporting into `entrypoints/telegram`.
5. **Loops and monitors**: port cron/queue/spool behavior and monitor dispatch using the new schemas and generic outbound routing.
6. **Subagents/employees**: port process/session lifecycle, steering/cancellation, child status forwarding, artifact directories, and result routing into provider-neutral runtime modules.
7. **Web shell**: port durable web shell/static serving only after auth, manifest, generated artifacts, and deployment boundaries are finalized.
8. **Assistant packs**: continue extracting public-safe prompt fragments and workflow docs; scrub channel-specific or maintainer-specific language into adapter docs or private overlays.
9. **Migration tooling**: add inventory commands that classify old files as runtime, entrypoint, provider, assistant pack, private workspace, generated artifact, secret, or obsolete before any further code movement.

## Non-goals still in force

- No deployment.
- No copied private data, secrets, logs, generated artifacts, real workspace files, personal overlays, or chat transcripts.
- No assumption that Telegram or Codex are the only entrypoint/provider.
- No persistent exact turn replay/idempotency persistence; provider resume plus graceful degradation is the restart strategy.
