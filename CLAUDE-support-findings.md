# Claude support architecture findings

**Assessment date:** 2026-07-31

**Scope:** the authoritative Brain control-plane repository and the active `codex-chat` runtime repository resolved through the Repo Registry.

## Status vocabulary

This report deliberately separates evidence from design judgment:

- **Verified fact** means the behavior or boundary is directly represented in the checked-out source, tests, manifests, or repository instructions named here.
- **Inference / proposal** means an engineering conclusion or recommended design derived from those facts. It is not a claim that the behavior already exists.

No secret values or credential contents were inspected. Model names such as **Sonnet 5**, **Fable**, and **Opus 5** below describe requested product/model families. This report does not assert an Opus 5 API/SDK model identifier; none is safely established by the inspected implementation.

## Executive conclusion

**Inference / estimate:** Adding a Sonnet 5 main loop and rolling the already-built Claude Agent SDK path out to ordinary subagents is feasible without replacing channel, directive, queue, capability, artifact, loop, monitor, or result-routing infrastructure. The correct approach is to introduce a provider-neutral main-agent boundary, retain the current Codex implementation behind a Codex adapter, and add a Claude Agent SDK adapter that implements the same lifecycle and event contract.

The ordinary-subagent case is materially further along: `codex-chat` already contains a real, opt-in `claude_agent_sdk` backend with OAuth-only readiness checks, streaming, steering, cancellation, images, tool restrictions, artifacts, error mapping, and tests. By contrast, the main loop, crash recovery, heartbeat, session state, health messages, logs, and durable Employees are still coupled to Codex app-server concepts.

**Estimate:**

- **12–18 engineering days** for a production-candidate Sonnet 5 main loop plus ordinary Anthropic subagent rollout, including configuration/admin work, authentication, prompt/event mapping, tests, canarying, observability, and rollback.
- **25–40 engineering days total** to also add service-owned nested coding dispatch and provider-neutral durable Employees, including ownership/capability enforcement, cancellation propagation, durable state, artifact/result routing, additional security review, and failure/restart tests.

These are implementation estimates, not calendar commitments. They assume the service account can obtain supported Claude subscription OAuth, the installed Claude Agent SDK exposes the required model and session controls, and no external product limitation blocks the intended account/model combination.

## 1. Repository and runtime boundary

### Verified facts

1. The Repo Registry identifies Brain at `/home/tim/pkg/tim/brain` as a local, source-only control-plane repository and `codex-chat` at `/home/tim/pkg/tim/codex-chat` as the active runtime/adapter/engine.
2. Brain's `AGENTS.md` explicitly says that Brain is **not** the deployed assistant runtime; its in-repo runtime/provider code is experimental/lab unless explicitly promoted. Provider and runtime changes for the live assistant therefore belong primarily in `codex-chat`, with Brain changed where it manages configuration, deployment, status, and UI.
3. Brain already documents the intended provider boundary in `docs/provider-abstraction.md`: `ProviderAdapter` / `ProviderSession` for main turns and `SubagentExecutor` / `SubagentLifecycle` for children. Brain's `packages/providers/claude-code/src/index.ts` is only a typed seam: its SDK transport requires an injected client and intentionally bundles no concrete client.
4. The active implementation is in `codex-chat`, whose `package.json` directly depends on `@anthropic-ai/claude-agent-sdk` and whose `src/subagent-backends.ts` contains the concrete Claude backend.

### Inference

Brain's lab interfaces are useful reference material but should not be promoted by copying them wholesale into the live runtime. The safer migration is a small live-runtime abstraction shaped around the behavior `ServiceSupervisor` already needs, followed by Brain admin support for that runtime contract.

## 2. Feasibility

### Verified facts supporting feasibility

- Main-loop execution already flows through one TypeScript interface, `CodexClient` in `codex-chat/src/types.ts`, with `start`, `stop`, `health`, `sendTurn`, optional `resetSession`, and optional recent-log access.
- `ServiceSupervisor.consumeCodexStream` in `codex-chat/src/service.ts` consumes a small event union (`delta`, `final`, `error`, `status`) rather than raw app-server messages. The final assistant text then enters the existing provider-independent directive parser in `src/directives.ts` and the existing action/capability paths.
- The concrete Claude child backend in `codex-chat/src/subagent-backends.ts` already demonstrates Agent SDK streaming-input usage, message accumulation, result/error handling, OAuth validation, steering, interrupt/close behavior, image encoding, sanitized child environment construction, and artifact/event logging.
- The installed SDK type surface supports session identifiers/resume, streaming input, interruption, initialization/account metadata, model selection, system prompts, permissions, tools, and programmatic agents. Those are the essential primitives needed by a main-loop adapter.

### Inference

The change is an adapter and lifecycle refactor, not a rewrite of the assistant. Most channel ingress, context hydration, prompt formatting, directive parsing/execution, capability checks, output routing, queues, subagent management, loops, monitors, and audit state can remain unchanged. The main risks are semantic parity—session recovery, prompt authority, tools/permissions, streaming completion, and provider-specific failure classification—not basic SDK feasibility.

## 3. Ordinary Anthropic subagent support already present

### Verified facts

The live `codex-chat` runtime already implements ordinary Claude children:

- `SubagentManager` constructs three backends: `codex_exec`, `codex_app_server`, and `claude_agent_sdk` (`src/subagents.ts`).
- `ClaudeAgentSdkChildAgentBackend` and `ClaudeAgentSdkSession` (`src/subagent-backends.ts`) launch the Agent SDK, stream messages, save `events.jsonl` and the last message, expose active steering, interrupt/close the query, and update job session/turn metadata.
- `SubagentManager.resolveDispatchBackend` auto-routes recognized Claude model names/aliases to the Claude backend when no backend is specified, and rejects an explicit Codex backend combined with a Claude model.
- Claude-routed jobs reject Codex-only selectors `codexProfile` and `modelProvider` (`SubagentManager.resolveSubagentModelSpec`).
- `effort` maps to the SDK effort levels for `low`, `medium`, `high`, and `xhigh`; `none`/`minimal` maps to disabled thinking (`ClaudeAgentSdkSession.claudeEffortAndThinking`).
- Claude has no direct Codex service-tier contract. The current backend optionally maps a requested fast tier to SDK fast-mode settings when enabled and supported (`shouldApplyFastMode`), while retaining the requested tier in job metadata.
- The backend strips non-OAuth Anthropic/provider environment variables, rejects non-first-party/non-OAuth initialization, and permits only Claude OAuth env names through its specialized sanitizer (`src/env.ts`, `checkReadiness`, and `verifyOAuthInitialization`).
- Programmatic native agents exist only inside the Claude SDK session. The built-in `reviewer` definition in `src/subagent-backends.ts` is read-only and is not a top-level `SubagentManager` job.
- Tests in `src/__tests__/subagent-backends.test.ts`, `src/__tests__/subagents.test.ts`, `src/__tests__/env.test.ts`, and related service/config suites cover backend routing, config, authentication safeguards, steering/cancellation, terminal errors, and result flow.
- The backend is disabled by default under `[subagents.claude]` (`src/config.ts`) and has an operator runbook in `docs/claude-agent-sdk-subagents.md`.

### Inference / rollout consequence

Ordinary subagents need hardening, configuration exposure, and live canaries—not a new execution engine. Initial rollout should remain explicit per dispatch or behind a runtime override, with the existing safe Codex default retained until Claude canaries prove auth, permissions, model selection, artifacts, cancellation, and rate-limit behavior.

## 4. Why the main loop remains Codex-specific

### Verified facts

The nominal `CodexClient` interface is small, but the surrounding service is provider-specific:

- `ServiceSupervisor` has a public `codex: CodexClient`, imports and directly constructs `AppServerCodexClient`, rejects any main transport other than `app-server`, and casts the client back to `AppServerCodexClient` for Employees (`src/service.ts`).
- Startup, heartbeat, health text, log commands, error messages, restart flags, crash callbacks, watchdog recovery, session clearing, and many log component/event names are explicitly Codex-oriented (`ServiceSupervisor`, `CodexHeartbeat`, and `StateStore` Codex-session methods).
- Main sessions are created/resumed through Codex JSON-RPC `thread/start`, `thread/resume`, `turn/start`, and app-server WebSocket notifications (`src/codex.ts`, `AppServerCodexClient`).
- Main prompt bootstrap is installed through Codex `baseInstructions` and `developerInstructions`; the service then formats every inbound event through `formatEventForCodex`.
- Main-loop configuration is exclusively `[codex]` plus `CODEX_CHAT_CODEX_*` keys (`src/config.ts`).
- Brain's admin UI and API describe and write only Codex main-loop selectors. `MAIN_LOOP_MODEL_ENV_KEYS` and `MAIN_LOOP_PRESETS` in `brain/apps/web/src/admin-service.ts` have no provider discriminator or Claude settings.
- Durable Employees implement `EmployeeRuntimeClient` by reusing `AppServerCodexClient`. Their state stores a Codex app-server thread identifier, and their prompts explicitly describe a Codex app-server Employee (`src/employee-runtime.ts`, `src/employees.ts`, `src/codex.ts`).

### Inference

Changing only the `model` string cannot turn the main loop into Claude. A clean provider boundary must cover lifecycle, health, session persistence/resume, errors, reset/recovery, diagnostics, prompt installation, event normalization, and Employee integration—not just `sendTurn`.

## 5. Proposed provider-neutral `MainAgentClient`

### Proposed contract

Replace the service-facing `CodexClient` name with a provider-neutral contract while preserving the current minimal event shape:

```ts
interface MainAgentClient {
  readonly provider: "codex" | "claude_agent_sdk";
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<MainAgentHealth>;
  sendTurn(input: MainAgentTurnInput): AsyncIterable<MainAgentEvent>;
  resetSession?(reason?: string): Promise<MainAgentHealth>;
  getRecentLogs?(n?: number, includeRaw?: boolean): string[];
}

type MainAgentEvent =
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string; raw?: unknown; kind?: string }
  | { type: "status"; message: string; raw?: unknown };
```

`MainAgentHealth` should include provider, transport, session id, readiness, selected model, and redacted authentication source metadata. Provider-specific native data should remain opaque or diagnostic-only.

### Proposed adapters

1. **`CodexMainAgentClient`**: rename/wrap the existing `AppServerCodexClient` with no protocol or behavior change. Preserve current thread persistence, crash callback, watchdog, logs, fast tier, sandbox, and approval behavior during the first refactor.
2. **`ClaudeAgentSdkMainAgentClient`**: use one streaming-input Agent SDK query per persistent main session, install the same behavior bootstrap as the authoritative system/developer instruction equivalent, convert SDK text/result/error/status messages to `MainAgentEvent`, persist only the provider session identifier and behavior hash, resume via the supported SDK resume option, and expose interrupt/close for watchdog/restart handling.
3. **Factory/config selection**: construct the client from a new main provider discriminator. The service should never branch on a model-name prefix to select the main provider.

### Required service refactor

- Rename `codex`, `consumeCodexStream`, `restartCodex`, `formatEventForCodex`, `restartingCodex`, and user-facing provider messages to main-agent equivalents.
- Move provider-specific failure classification and session clearing into the adapter or a provider error classifier.
- Make heartbeat and diagnostics consume `MainAgentHealth` and generic logs.
- Store session records by provider and reject cross-provider resume rather than attempting to feed a Codex thread id to Claude or vice versa.
- Keep current directive parsing and execution after the normalized final text. This minimizes behavior drift.
- Split Employee runtime construction from the main client; do not cast the generic main client to a Codex implementation.

## 6. Sonnet 5 main-loop work

### Implementation work

1. Add `mainAgent.provider` (or an equivalent backward-compatible key) and provider-specific main config. Treat existing `[codex]` as the Codex adapter's settings during migration.
2. Implement `ClaudeAgentSdkMainAgentClient` using the already-pinned SDK dependency and the proven child-backend utilities, but do not share a child session object with the main loop.
3. Reuse/refactor OAuth readiness and redaction helpers so both main and child Claude paths enforce the same first-party OAuth-only policy without logging token values.
4. Map the behavior pack into an authoritative SDK system prompt and preserve event/context formatting, active-subagent snapshots, Employee snapshots, and directive instructions.
5. Decide and test the main tool posture. The existing Claude child default allows powerful filesystem/shell tools under bypass permissions. A main-loop launch must have an explicit reviewed allowlist, cwd/additional-directory rules, permission policy, and MCP/capability story rather than inheriting defaults accidentally.
6. Persist the Claude session id plus provider/model/behavior hash. On behavior changes, inject a refresh turn or intentionally start a new session; do not assume Codex `thread/resume` semantics.
7. Normalize partial/final/result semantics so directives run once, text is not duplicated, and a result arriving after deltas closes the turn correctly.
8. Generalize crash/restart/watchdog/health/user messages and rate-limit/auth classifications.
9. Add Brain admin selectors, readiness metadata, confirmations, and rollback controls for Claude main-loop configuration.
10. Run fake-SDK contract tests, process/session integration tests, and guarded live Sonnet 5 canaries before making it selectable as the normal main loop.

### Verified configuration gap

Brain's current main-model controls do not include `CODEX_CHAT_CODEX_EFFORT`, even though `codex-chat` accepts it and sends effort on main turns. Brain's main presets also carry older hard-coded Codex defaults than the current `codex-chat/src/config.ts` defaults. This drift must be resolved before adding Sonnet controls; otherwise the UI can silently report/write a partial model selection.

### Inference / estimate

A production-candidate Sonnet 5 main loop plus ordinary Claude subagent rollout is **12–18 engineering days**:

- 3–5 days: contract extraction, Codex adapter preservation, generic supervisor/health/recovery naming and state migration.
- 3–4 days: Claude main adapter, auth, prompt, streaming/session/resume, and failure mapping.
- 2–3 days: configuration and Brain admin UI/API, including effort/model/provider validation and rollback.
- 2–3 days: unit/integration/security tests and observability.
- 2–3 days: staged live canaries, fixes, operational documentation, and rollback rehearsal.

Some work can overlap, but provider session/recovery behavior should not be compressed out of the critical path.

## 7. Ordinary subagent rollout

### Proposed phases

1. **Readiness only:** expose redacted SDK/version/OAuth/model readiness in health/admin without changing dispatch defaults.
2. **Explicit canary jobs:** allow only explicit `backend: "claude_agent_sdk"` dispatches for a small profile/model/effort allowlist and a conservative concurrency cap.
3. **Per-workload routing:** enable selected research/review/implementation profiles; compare completion, artifacts, cancellation, latency, and error rate with Codex jobs.
4. **Optional default:** only after canaries, allow the runtime backend override or configured default to select Claude. Preserve `agent backend exec` as the immediate recovery path.

### Required hardening

- Validate the selected model against SDK initialization metadata/readiness rather than accepting any arbitrary string until launch failure.
- Make effort/thinking validation model-aware; a model that requires adaptive thinking must not receive disabled-thinking settings.
- Keep per-dispatch provider selection explicit in persisted job metadata.
- Add backend/model/concurrency allowlists and cost/rate-limit protection.
- Verify artifact retention/cleanup, image limits, prompt byte limits, steering grace behavior, cancellation, service shutdown, and abandoned-job recovery under real SDK timing.

## 8. Why Fable cannot currently safely dispatch managed Opus 5 coding children

### Verified facts

- A Claude-backed ordinary child receives the SDK-native `Agent` tool and programmatic agent definitions (`ClaudeAgentSdkSession.claudeSdkTools` and `claudeSdkAgents`).
- The only built-in programmatic agent currently defined by `codex-chat` is a narrow, read-only reviewer using an older configured model. There is no service-owned Opus 5 implementer definition or verified Opus 5 identifier in this code.
- SDK-native nested agents execute inside the parent's Claude query. They do **not** create a `SubagentManager` job, `SubagentJob` record, service artifact directory, ownership/result target, capability decision, central concurrency slot, or independently addressable service control handle.
- `SubagentManager` only manages jobs dispatched through its own `dispatch` path. Employee children similarly must be requested through the service-owned envelope and central manager (`src/employees.ts`); direct spawning is explicitly prohibited.
- The current Claude query's interrupt/close controls the parent session. `codex-chat` has no mapping from a native nested-agent task to a durable child id that it can list, steer, cancel, time out, audit, or recover independently.

### Inference

Fable may be technically able to invoke an SDK-native agent, but that is not equivalent to safely dispatching a **managed Opus 5 coding child**. Advertising it as managed would overstate service guarantees and bypass the ownership, capability, queue, artifact, cancellation, result-routing, and audit boundaries used elsewhere. The model availability/identifier question is an additional blocker and must be verified through the installed SDK/account rather than guessed.

## 9. Required service-owned nested-dispatch design

### Proposed design

Expose a narrow service-owned MCP/SDK tool to Claude sessions, for example `request_managed_subagent`, rather than allowing a raw shell escape or treating the SDK-native `Agent` tool as a managed job.

Minimum request schema:

```json
{
  "profile": "implementer",
  "prompt": "bounded task",
  "modelClass": "approved-capability-class",
  "effort": "high",
  "route": "return_to_parent",
  "timeoutSec": 1800,
  "files": ["optional scoped paths"],
  "summary": "short display summary"
}
```

`modelClass` should resolve through a service-owned allowlist/configuration record. Do not place an unverified Opus 5 identifier in prompts, source defaults, or schemas.

The tool handler must:

1. Derive parent run/session/job/Employee identity from trusted server context, never from model-supplied owner fields.
2. Authorize `subagents.dispatch` and the requested profile/resource scope using the existing capability system.
3. Create a normal `SubagentManager` job with immutable `parentJobId`/owner/result-target metadata and a child-specific artifact directory.
4. Enforce global, per-parent, per-provider, and per-model concurrency; prompt/file byte limits; timeout; nesting depth; and cost/rate budgets.
5. Return a stable job reference and either await a bounded result through a service tool response or provide explicit poll/cancel tools. Results must be size-bounded and artifact paths validated.
6. Cascade parent cancellation/service shutdown to descendants and prevent orphaned process trees.
7. Persist parent-child lineage, selected provider/model/effort, capability decision ids, terminal status, artifact metadata, and delivery state.
8. Route terminal results back only to the authorized parent turn/Employee inbox, with a safe fallback if the parent is gone.
9. Redact credentials and isolate provider auth exactly as the direct child backends do.
10. Emit structured lifecycle logs/metrics without raw secrets or uncontrolled prompt/result bodies.

### Employees

To support Anthropic Employees, introduce a provider-neutral `EmployeeAgentClient` parallel to `MainAgentClient`, or a shared session factory with truthful capability flags. Employee service-action parsing, owner checks, result inboxes, and central child dispatch should remain service-owned. A Claude Employee must not gain broader child/control rights merely because its SDK exposes the native `Agent` tool.

### Inference / estimate

Adding nested managed coding children and provider-neutral Employees brings the total to **25–40 engineering days**. The increment is dominated by durable parent/child state, central tool transport, authorization, concurrency, cancellation/recovery, Employee session abstractions, result inbox semantics, security review, and destructive/failure testing—not by the model call itself.

## 10. Model, effort, and service-tier flow

### Verified current flow

| Path | Model | Effort/thinking | Service tier | Provider selectors |
|---|---|---|---|---|
| Main Codex | `[codex].model` / `CODEX_CHAT_CODEX_MODEL` | `[codex].effort` sent as app-server effort and `model_reasoning_effort` | `fast`/`standard`, conditionally emitted by `serviceTierMode`; fast also enables Codex fast mode | Codex profile at process launch; model provider on thread start |
| Codex exec child | job/default model | job/default effort becomes `model_reasoning_effort` | fast adds Codex fast-mode and tier config; standard adds neither | optional allowlisted Codex profile/provider flow, although exec arguments use the profile and do not directly consume `modelProvider` |
| Codex app-server child | job/default model | job/default effort on turn/thread config | emitted unless mode is `omit` | model provider on thread start; profile selects child app-server process configuration |
| Claude Agent SDK child | explicit model or SDK default | mapped to SDK effort, or disabled thinking for `none`/`minimal` | no direct parity; requested fast may turn on SDK fast mode | Codex profile/provider rejected |
| Durable Employee | Employee model/effort | passed to Codex Employee thread/turn | configured fields exist on descriptors but are not part of `EmployeeRuntimeClient`'s thread spec | remains tied to the shared Codex app-server implementation |

### Verified inconsistencies to fix

1. The provider choice is represented by a subagent backend but not by a main-loop provider key.
2. Directive schema requires every `dispatch_subagent` to carry `model`, `effort`, `serviceTier`, and `summary`, while lower-level dispatch APIs and config have defaults. This makes prompt/schema compatibility brittle and encourages irrelevant Codex tier fields on Claude jobs.
3. Claude jobs persist a Codex-shaped `serviceTier`/`serviceTierMode`; launch telemetry currently can state `serviceTierIgnored: true` while also reporting that fast-mode settings were applied.
4. Main app-server `standard` can be explicitly sent, whereas Codex exec `standard` is represented by omission of fast settings. These are not the same observable contract.
5. `modelProvider` is resolved and stored for Codex exec jobs but is not passed as a distinct exec argument; its effective behavior depends on profile/config.
6. Brain's main-loop admin key set omits effort and its preset defaults have drifted from `codex-chat` defaults.
7. Brain's OpenRouter UI/backend enum exposes only Codex backends and has no Claude readiness/configuration controls.
8. Employee configuration contains provider/tier-shaped fields that the current `EmployeeRuntimeClient` contract does not carry through.

### Proposed normalized selection

Persist a provider-neutral selection on every main session, Employee, and child:

```ts
interface AgentModelSelection {
  provider: "codex" | "claude_agent_sdk";
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  latencyClass?: "standard" | "fast";
  providerOptions?: Record<string, unknown>; // validated, non-secret, adapter-owned
}
```

Resolve defaults once, validate against provider/model capabilities, persist the resolved selection, and let each adapter translate it. `latencyClass` is a requested policy, not a promise that every provider has a native service-tier field. Adapter telemetry should record `requested`, `applied`, and `reasonNotApplied` separately.

## 11. Configuration, authentication, prompts, schemas, security, testing, and observability

### Configuration

- Add a provider discriminator and separate Codex/Claude settings; preserve current Codex keys as backward-compatible inputs during migration.
- Add Claude main and subagent readiness/configuration to Brain's admin schema/UI using confirmation-bound, non-secret writes. Secret values remain write-only/presence-only.
- Expose model, effort, permission mode, allowed/disallowed tools, setting sources, fast policy, concurrency, and rollback. Validate combinations server-side.
- Record which changes require service restart and make the active runtime report the effective resolved selection after restart.

### Authentication

- Run Claude authentication as the same OS user that runs `codex-chat.service`.
- Reuse the OAuth-only sanitizer/readiness policy; never fall back silently to API keys, cloud-provider credentials, gateway variables, or user/project settings containing auth helpers.
- Inspect credential files only by presence/permissions metadata in operator diagnostics. Log redacted SDK account-source metadata, not identity/token contents.
- Fail closed when the SDK reports an unexpected provider or credential source.

### Prompts and schemas

- Preserve one authoritative behavior bootstrap and provider-neutral inbound-event formatting; rename Codex-specific labels without changing their semantics.
- Test system/developer instruction precedence and behavior-refresh behavior on both providers.
- Version the directive schema. Make provider-specific dispatch fields conditional rather than universally required, and return actionable validation errors to the parent loop.
- Treat model output as untrusted: all directives and nested tool calls must pass schema validation, capability authorization, path validation, idempotency, and output-target checks.

### Security

- Define an explicit Claude main tool allowlist and filesystem/network boundary. Do not assume Codex sandbox/approval settings translate to Claude permission modes.
- Avoid `bypassPermissions` as an unreviewed default for a main loop. If it is retained for a trusted owner deployment, require an explicit opt-in and narrow service/OS isolation.
- Keep provider credentials isolated per child/provider, maintain current Slack/ingest/transcription secret stripping, and add regression tests for every new adapter process/tool path.
- Service-owned nested dispatch must enforce lineage, depth, ownership, model/profile allowlists, concurrency, prompt/result sizes, timeouts, artifact roots, and cancellation cascades.
- Do not expose arbitrary command fields in nested-dispatch MCP tools.

### Testing

Minimum gates:

1. Contract tests run unchanged against fake Codex and fake Claude `MainAgentClient` implementations.
2. Claude adapter tests cover init/auth rejection, delta/final ordering, duplicate result suppression, errors, interruption, close, resume, behavior refresh, images, and stuck-query watchdog behavior.
3. Supervisor tests prove provider-neutral queueing, restart, health, user messaging, directive execution, idempotency, and session-store migration.
4. Subagent tests cover explicit/automatic routing, provider/model validation, effort/thinking, fast-policy telemetry, steering races, cancellation trees, timeout, service shutdown, and restart abandonment/recovery.
5. Security tests assert environment stripping/redaction and deny unauthorized nested dispatch, cross-owner control, path escape, excess depth/concurrency, and oversized payloads.
6. Brain admin tests cover effective values, effort, Claude readiness, confirmations, no secret echo, restart requirement, and one-click rollback.
7. Guarded live canaries record provider, resolved model, SDK/CLI version, auth source class, latency, terminal kind, artifact paths, and cancellation outcome without recording tokens.

### Observability

- Use generic components (`main_agent`, `provider_session`, `subagents`) plus structured `provider` and `transport` fields.
- Emit session start/resume/reset, behavior hash, resolved selection, auth readiness class, first/last event timestamps, time to first token, total duration, terminal/error classification, retry/restart count, and directive validation/execution counts.
- For nested jobs, emit parent/child ids, owner, depth, queue delay, backend/model/effort, requested/applied latency class, cancellation lineage, result route, and artifact lifecycle.
- Keep prompts, full responses, credential paths, account identifiers, and secret-bearing raw SDK events out of normal logs. Raw debug artifacts require explicit opt-in, restrictive permissions, retention limits, and redaction.

## 12. Phased rollout and rollback

### Phase 0 — contract extraction

- Introduce `MainAgentClient` and wrap Codex without behavior changes.
- Generalize health/restart/session state and add provider fields.
- Keep Codex as the only selectable main provider.

**Rollback:** revert to the prior Codex wrapper/commit; no provider or model change occurs.

### Phase 1 — Claude ordinary-subagent canary

- Expose readiness and explicit per-job Claude routing.
- Limit profiles/models/concurrency; keep default backend `codex_exec`.

**Rollback:** clear per-dispatch routing or use the existing backend recovery override to Codex exec; cancel active Claude jobs.

### Phase 2 — Sonnet 5 shadow and canary main loop

- Run offline/fake contract tests, then bounded operator canaries on non-critical conversations.
- Preserve separate provider session state and a confirmed Codex main-loop rollback preset.

**Rollback:** stop new Claude turns, close/interrupt the SDK query, switch provider to Codex, restart, and resume/start the last valid Codex session. Do not attempt cross-provider session conversion.

### Phase 3 — selectable production main loop

- Enable Sonnet 5 as an explicit admin selection after auth, model, prompt, directive, tool, and recovery gates pass.
- Monitor auth/rate errors, latency, duplicate/missing outputs, directive failures, and restart loops.

**Rollback:** provider-select Codex and restart. Keep Claude session metadata isolated for later diagnosis/resume.

### Phase 4 — service-owned nested dispatch

- Add narrow service tools, lineage, authorization, central queues, cancellation propagation, result delivery, and security/load tests.
- Do not market SDK-native agents as managed children.

**Rollback:** disable nested-dispatch tools/capability grants; ordinary top-level subagents remain available.

### Phase 5 — provider-neutral Employees

- Extract `EmployeeAgentClient`, add Claude Employee sessions and durable inbox/recovery, and route all child requests through the central service.

**Rollback:** disable Claude Employees or `employees.enabled`; preserve stored metadata without attempting unsafe provider conversion.

## 13. Blockers and rollback risks

### Blocking before a Sonnet 5 main canary

- Confirm service-user Claude OAuth readiness and allowed account usage without exposing credentials.
- Confirm the installed SDK/Claude Code combination reports and accepts the intended Sonnet 5 selection.
- Define Claude main-loop tool/permission/filesystem/network policy.
- Implement provider-specific session persistence and tested resume/reset behavior.
- Prove bootstrap prompt and directive-schema parity.
- Add Brain admin provider/effort/config controls and a tested Codex rollback.

### Blocking before managed Opus 5 coding children

- Verify supported model availability and identifier through the runtime/account; do not guess or hard-code one prematurely.
- Implement service-owned nested-dispatch tools and normal `SubagentManager` jobs.
- Add capability/owner/depth/concurrency/cost controls, artifact isolation, cancellation cascade, and durable result delivery.
- Complete security review and hostile-model-output tests.

### Principal rollback risks

- **Session incompatibility:** provider sessions cannot be converted. Switching providers can lose conversational continuity unless the user restates context or the service supplies a bounded, reviewed handoff summary.
- **Duplicate side effects:** retrying after ambiguous stream termination could repeat directives. Existing idempotency must cover normalized provider completion/retry paths.
- **Permission mismatch:** Codex sandbox/approval and Claude permission/tool controls are not equivalent; an overly broad Claude launch can widen filesystem or shell access.
- **Credential leakage:** sharing generic child env/process helpers can accidentally pass provider or channel secrets. Keep specialized sanitizers and regression tests.
- **Orphaned descendants:** native or service-owned nested work can outlive a parent unless process/query cancellation is propagated and verified.
- **Configuration drift:** Brain admin, environment keys, runtime defaults, docs, and effective runtime state currently differ in places; a partial migration can show one selection while running another.
- **Rate/usage limits:** a new main provider or nested fan-out can create restart loops, queues, or unexpected spend without classified backoff and concurrency/budget controls.
- **Behavior drift:** different prompt authority and streaming semantics can produce malformed directives or missing user replies even when basic text generation works.

## Final recommendation

Proceed, but split the work at the safety boundaries already present:

1. Extract and verify a provider-neutral main client while preserving Codex behavior.
2. Canary ordinary Claude subagents using the existing backend.
3. Add and canary a Sonnet 5 main adapter with provider-specific session/auth/tool controls.
4. Build nested coding dispatch only as a service-owned, authorized `SubagentManager` path.
5. Generalize durable Employees last, after nested ownership/result/recovery semantics are proven.

This sequencing delivers useful Anthropic support within the **12–18 day** first tranche while avoiding the unsafe inference that SDK-native nested agents are already managed Opus 5 coding children. The fully managed nested/Employee design remains a larger **25–40 day total** program with distinct security and recovery obligations.
