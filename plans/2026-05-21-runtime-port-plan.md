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
- Provider session/turn contracts plus Codex and Claude Code adapters behind provider packages.
- Generic Brain directive parser supporting `brain-actions` blocks and legacy `codex-chat` action block normalization.
- Minimal `BrainRuntime` that sends inbound events to a provider session, parses final text/actions, routes replies to the originating entrypoint, and can consume `dispatch_subagent` actions through a runtime lifecycle port.
- Runtime entrypoint bridge plus fake entrypoint/fake provider smoke path: inbound event -> runtime -> provider -> outbound dispatch result.
- Subagent job, loop, and monitor schemas with in-memory and file-backed job stores. This captures high-value codex-chat runtime concepts without copying process management or private state.
- Provider-neutral subagent lifecycle core: queueing, max concurrency, running/terminal transitions, cancellation, steering hooks, startup hydration that abandons unsafe active persisted jobs, and a static executor for tests/doctor checks.
- Provider-backed subagent executor that dispatches child work through the provider abstraction with image attachments, artifact directories, abort/cancel propagation, steering, result text, and last-message artifact paths.
- Automation runtime skeleton for loop/monitor health and manual/dry-run dispatch of subagent loops, with no crontab/file-watcher side effects.
- Workspace-local `FileRuntimeStateStore` for private JSON/JSONL state under a runtime state directory.

### Entrypoint slice

- Telegram adapter skeleton that maps Telegram-like updates into generic inbound events and maps core outbound actions into Telegram API call intents.
- No-network `TelegramEntrypointAdapter` implementing the generic entrypoint protocol over supplied update iterables and dispatch-intent hooks.
- Injectable Telegram Bot API boundary for outbound calls and file metadata/download resolution, polling/webhook mapping skeletons, and admin user/chat allowlist filtering. Tests do not require or print a real bot token.

### Provider slice

- Codex `exec` transport now shells out to `codex exec --json` (or a configured binary/argv), streams JSONL deltas/status/final events into runtime-core provider events, checks CLI health with `--version`, handles cancellation, captures last-message artifacts in the runtime artifact directory, and extracts provider-native resume handles from JSONL events.
- Codex `exec resume` argv construction is available for provider-native resume by session id or latest-session flag. No persistent turn replay/idempotency store was added.
- Codex `app-server` remains behind the provider boundary with an injectable protocol-client seam; no top-level app-server runtime was added.
- Claude Code has typed SDK/subagent transport seams with injected-client tests, including streaming, cancellation, and steering boundaries; concrete SDK wiring remains pending.

### Web publisher slice

- `@brain/web` static generated-page validation, publish-to-runtime-directory, manifest update, and TTL prune primitives.
- Portable local defaults and `BRAIN_WEB_*` overrides replace maintainer-specific default paths/domains.
- Tests cover publish, prune, symlink rejection, and secret-like filename/content rejection.

### Assistant pack slice

- Core assistant pack manifest validation.
- Portable setup/self-host, setup-server, repo-registry, and generated-web-page skills.
- Runtime boundary prompt fragment using generic entrypoint/provider vocabulary.

### Operator CLI

- `brainctl setup`, `doctor`, `config validate`, `secrets check`, `pack validate`, `provider check`, `entrypoint check`, `runtime status`, and `automation validate` validation-first skeleton.

## Remaining full-port steps

1. **Codex provider transport**: implement the real app-server protocol client and richer structured event/log mapping. Exec cancellation, image/artifact handoff, and resume-handle seams are now present.
2. **Claude Code provider transport**: wire the typed SDK/subagent seams to the real Claude Code SDK/subagent mechanism and add provider parity tests against realistic clients.
3. **Runtime state policy**: keep only minimal job/runtime state needed for operations. Do **not** add persistent turn replay, exact idempotency replay, or a durable turn store. After a crash/restart, rely on Codex/Claude provider resume infrastructure when a provider can resume; otherwise report degraded recovery and ask the user to restart the work from current context.
4. **Telegram live entrypoint**: add durable service startup, token loading from private workspace/host secret store, webhook server wiring, upload streaming, voice transcription handoff, and operational error reporting.
5. **Loops and monitors**: port cron/queue/spool behavior and monitor dispatch using the new schemas and generic outbound routing; the current automation runtime is manual/dry-run only.
6. **Subagents/employees**: add user/admin result routing, child status forwarding, process logs, and richer employee semantics on top of the provider-backed subagent executor.
7. **Web shell**: port durable web shell/static serving only after auth, manifest, generated artifacts, and deployment boundaries are finalized.
8. **Assistant packs**: continue extracting public-safe prompt fragments and workflow docs; scrub channel-specific or maintainer-specific language into adapter docs or private overlays.
9. **Migration tooling**: add inventory commands that classify old files as runtime, entrypoint, provider, assistant pack, private workspace, generated artifact, secret, or obsolete before any further code movement.

## Non-goals still in force

- No deployment.
- No copied private data, secrets, logs, generated artifacts, real workspace files, personal overlays, or chat transcripts.
- No assumption that Telegram or Codex are the only entrypoint/provider.
- No persistent exact turn replay/idempotency persistence; provider resume plus graceful degradation is the restart strategy.
