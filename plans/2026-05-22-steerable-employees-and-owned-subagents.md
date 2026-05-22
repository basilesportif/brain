# Steerable Employees and Employee-owned subagents implementation plan

Date: 2026-05-22
Status: implementation plan only; no runtime changes in this document

## Summary

Brain already has the first safe seams for durable Employees, provider-backed Employee turns, subagent dispatch, subagent steering, cancellation, result routes, and provider-native resume handles. The next step is to turn those seams into a coherent orchestration model where:

1. A user or service can steer a durable **Employee** itself.
2. A user or service can steer a specific **Employee-owned child subagent** when, and only when, the child is explicitly named by id/ref.
3. Employees can dispatch, track, steer, cancel, and aggregate their own direct child subagents without those child results leaking into the main assistant turn unless the route asks for that.
4. Brain can resume provider sessions where the provider supports resume, and can recover persisted queues/results without adding codex-chat-style durable turn replay.

This plan intentionally does not implement the behavior yet. It defines semantics, state, APIs, command/directive shapes, tests, and rollout milestones.

## Goals

- Make Employee runtime orchestration first-class rather than a lifecycle-record-only seam.
- Support steering the Employee itself with clear active-turn versus queued-turn semantics.
- Support steering one Employee-owned child subagent when the operator explicitly names that child/ref.
- Keep child ownership and result routing explicit: `main`, `employee`, `loop`, `monitor`, and `system` owners must not be conflated.
- Add a result inbox and aggregation path so Employees can receive child completions/failures as provider-visible context.
- Enforce per-Employee concurrency limits for child subagents in addition to global subagent limits.
- Define direct-child steering and cancellation rules, including what is deliberately disallowed for nested children.
- Persist enough state for safe restart/resume using provider-native resume handles, without building a persistent transcript replay/idempotency store.
- Preserve codex-chat-compatible user ergonomics where safe (`agent status`, `agent steer`, `employee steer`) while using Brain-native data models internally.

## Non-goals

- Do not add exact provider turn replay or a durable transcript/idempotency store.
- Do not let arbitrary provider output control unrelated Employees, unrelated subagents, or global runtime state.
- Do not support implicit steering of a child when the user only names an Employee. That should steer the Employee itself.
- Do not support cross-Employee child steering unless the command comes from an authorized operator and explicitly names both the Employee and child/ref.
- Do not make provider-specific app-server protocols public runtime contracts; keep them behind provider adapters.
- Do not implement UI-specific Telegram behavior in runtime-core. Entrypoints remain adapters.

## Current gaps

### Employee lifecycle gaps

- `EmployeeLifecycle` can start, stop, and steer durable Employee records, and `ProviderEmployeeRuntime` can run provider turns, but there is no Employee-owned orchestration loop.
- Employee status does not distinguish `idle`, `active_turn`, `queued`, `stopping`, `needs_resume`, or `degraded`; it only has `stopped`, `running`, and `failed`.
- Employee steering is immediate only through the injected runtime seam; it does not persist pending steering messages or define active-turn interrupt behavior.
- Employee resume metadata is stored loosely under `metadata.resumeHandle`, with no typed session/turn state or recovery state.

### Subagent ownership gaps

- `SubagentJob` already has `ownerType: "employee"`, `ownerId`, `ownerRequestId`, `resultTarget: "employee"`, and `route` fields, but dispatch from provider directives currently defaults to `ownerType: "main"` in `BrainRuntime`.
- There is no Employee-scoped dispatch API that applies per-Employee concurrency, owner validation, or child refs.
- There is no dedicated Employee inbox/aggregation model for child terminal results.
- Current `steer_subagent` and `cancel_subagent` target global job refs; they do not encode whether a command is scoped to the main runtime or to a particular Employee owner.

### Provider/runtime gaps

- Provider events support `action`, `final`, `status`, `artifact`, and `error`, but the runtime only consumes actions for the main Brain session.
- There is no common provider capability contract for active-turn steering versus queued next-turn steering.
- There is no Employee turn runner that parses Brain actions emitted by an Employee provider session and executes them in the Employee's ownership scope.
- Provider resume handles are exposed, but hydration currently abandons active subagent jobs and does not resume Employee provider sessions.

### Command and directive gaps

- `employee steer <id> <text>` exists but only targets the Employee itself.
- `agent steer <job> <text>` exists for subagents but is globally scoped and main-owned in user mental model.
- There is no Brain-native `steer_employee`, `dispatch_employee_subagent`, or scoped child-steering directive shape.
- Existing action parsing is directive-block-oriented; service actions emitted as streaming provider events need the same validation/routing envelope.

## Core concepts and invariants

### Ownership

- An **Employee** is a durable provider-backed agent with a stable `employeeId`, provider session state, pending steering queue, and child-result inbox.
- An **Employee-owned child subagent** is a `SubagentJob` with `ownerType: "employee"` and `ownerId: employeeId`.
- A child subagent may have a human-readable `childRef` or `summary` for listing, but its stable identifier remains the job id.
- Ownership is immutable after dispatch. Reparenting is not supported.

### Steering targets

Brain must support both of these explicitly:

1. **Steer the Employee itself**: `employee steer analyst "focus on the API plan"` sends or queues a steering turn to Employee `analyst`.
2. **Steer a specific Employee-owned child**: `employee steer analyst child job_ab12 "narrow the search to provider resume"` or an equivalent directive sends steering to child `job_ab12`, but only after resolving it as a direct child of Employee `analyst`.

If the text names only an Employee, Brain steers the Employee itself. Brain must not guess which child is meant from conversational context unless the command/directive has an explicit child/job/ref field.

### Active-turn versus queued-turn steering

- **Active-turn steering** means sending a steering instruction into an already-running provider turn or child run through a provider/executor method that can accept mid-turn input.
- **Queued-turn steering** means persisting an instruction to be sent as the next provider turn when the Employee or child becomes idle/resumable.
- Brain should prefer active-turn steering only when all of these are true:
  - Target is currently active.
  - Provider/executor advertises active steering support for that target.
  - The command/directive requests default or active behavior, not `queueOnly`.
  - Runtime can associate the steering instruction with the current provider session/turn.
- If active steering is unsupported, unavailable after restart, or races with completion, Brain persists a queued steering item and reports that it was queued.
- If `activeOnly` is requested and active steering is unavailable, Brain returns a failed control result instead of silently queueing.

## Data model and state additions

### EmployeeRecord additions

Extend `EmployeeRecord` or add associated state records so typed state is not hidden in arbitrary metadata:

```ts
type EmployeeRuntimeStatus =
  | "stopped"
  | "starting"
  | "idle"
  | "active_turn"
  | "queued"
  | "stopping"
  | "failed"
  | "needs_resume"
  | "degraded";

interface EmployeeRuntimeState {
  employeeId: string;
  workspaceId?: string;
  status: EmployeeRuntimeStatus;
  provider: string;
  sessionId?: string;
  activeTurnId?: string;
  activeTurnStartedAt?: string;
  resumeHandle?: ProviderResumeHandle;
  lastResumeAttemptAt?: string;
  lastProviderEventAt?: string;
  pendingSteerCount: number;
  activeChildCount: number;
  queuedChildCount: number;
  completedChildCount: number;
  failedChildCount: number;
  maxConcurrentChildren?: number;
  maxPendingSteers?: number;
  error?: string;
  updatedAt: string;
}
```

Keep `EmployeeRecord.status` for backward compatibility during migration, but derive it from `EmployeeRuntimeState` until the older enum can be safely expanded.

### EmployeeTurnRecord

Persist one record per Employee turn to support status, diagnostics, resume metadata, and result aggregation without replaying the turn:

```ts
interface EmployeeTurnRecord {
  id: string;                 // turn_employee_<employeeId>_<timestamp|uuid>
  employeeId: string;
  workspaceId?: string;
  inputKind: "start" | "steer" | "inbox_aggregate" | "resume_notice" | "system";
  inputText?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "abandoned";
  provider: string;
  sessionId?: string;
  resumeHandle?: ProviderResumeHandle;
  dispatchedActionIds: string[];
  childJobIds: string[];
  resultInboxIds: string[];
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}
```

### EmployeeSteerQueueItem

```ts
interface EmployeeSteerQueueItem {
  id: string;
  workspaceId?: string;
  employeeId: string;
  target: { kind: "employee" } | { kind: "child"; childRef: string; jobId?: string };
  text: string;
  requestedBy: "user" | "employee" | "system" | "directive";
  sourceEventId?: string;
  sourceTurnId?: string;
  delivery: "default" | "activeOnly" | "queueOnly";
  status: "queued" | "sent_active" | "sent_turn" | "failed" | "cancelled";
  createdAt: string;
  deliveredAt?: string;
  error?: string;
}
```

### SubagentJob additions

Add or standardize these fields for Employee-owned jobs:

```ts
interface EmployeeOwnedSubagentFields {
  ownerType: "employee";
  ownerId: string;             // employeeId
  ownerTurnId?: string;        // EmployeeTurnRecord.id that dispatched it
  childRef?: string;           // optional user-facing ref/label, unique among active children of owner
  resultTarget: "employee";
  parentJobId?: string;        // only if nested children are later allowed
  resumeHandle?: ProviderResumeHandle;
  lastProviderEventAt?: string;
  terminalDeliveredAt?: string;
  inboxItemId?: string;
}
```

Existing fields `summary`, `ownerRequestId`, `parentTurnId`, and `metadata` can bridge migration, but the implementation should prefer typed fields where possible.

### EmployeeResultInboxItem

Create a durable inbox so child completions/failures can be aggregated into Employee context even if the Employee is idle or the process restarts:

```ts
interface EmployeeResultInboxItem {
  id: string;
  workspaceId?: string;
  employeeId: string;
  source: { kind: "subagent"; jobId: string; childRef?: string } | { kind: "system" };
  status: "pending" | "delivered" | "acknowledged" | "superseded";
  resultKind: "completed" | "failed" | "cancelled" | "timed_out" | "abandoned" | "artifact" | "notice";
  summary: string;
  text?: string;
  artifactPaths?: string[];
  createdAt: string;
  deliveredTurnId?: string;
  deliveredAt?: string;
}
```

### Store interfaces

Add small stores rather than overloading `SubagentJobStore`:

- `EmployeeRuntimeStateStore`
- `EmployeeTurnStore`
- `EmployeeSteerQueueStore`
- `EmployeeResultInboxStore`

File-backed versions should use the existing `FileRuntimeStateStore` path validation and atomic writes under workspace-local private state.

## Provider and runtime APIs

### Provider capabilities

Add capability discovery on `ProviderSession` or `ProviderAdapter`:

```ts
interface ProviderSessionCapabilities {
  activeTurnSteering: boolean;
  activeTurnCancellation: boolean;
  sessionResume: boolean;
  turnResume: boolean;
  streamingActionEvents: boolean;
}
```

Provider adapters should map these to actual transports:

- Codex app-server: active steer/interrupt/resume where supported by protocol.
- Codex exec: no active turn steering; cancel via abort; resume only through native resume args where available.
- Claude Code: support depends on SDK/subagent mechanism; expose truthfully through adapter.
- Fake/static providers: configurable capabilities for tests.

### Employee runtime orchestrator

Introduce an `EmployeeOrchestrator` separate from `EmployeeLifecycle`:

```ts
interface EmployeeOrchestrator {
  start(input: EmployeeStartInput): Promise<EmployeeLifecycleResult>;
  stop(ref: string, options?: EmployeeStopOptions): Promise<EmployeeLifecycleResult>;
  steer(input: EmployeeSteerInput): Promise<EmployeeSteerResult>;
  dispatchChild(input: EmployeeChildDispatchInput): Promise<EmployeeChildDispatchResult>;
  steerChild(input: EmployeeChildSteerInput): Promise<EmployeeChildSteerResult>;
  cancelChild(input: EmployeeChildCancelInput): Promise<EmployeeChildCancelResult>;
  drainInbox(employeeRef: string, options?: DrainInboxOptions): Promise<EmployeeInboxDrainResult>;
  resumeAll(): Promise<EmployeeResumeSummary>;
}
```

`EmployeeLifecycle` remains the backward-compatible facade for CLI/supervisor commands, but delegates to the orchestrator when configured.

### Employee turn runner

The Employee turn runner should:

1. Resolve/start provider session for an Employee.
2. Build an Employee-scoped prompt with:
   - Employee identity/profile.
   - Active child list and refs.
   - Pending inbox summaries.
   - Clear action/directive instructions scoped to this Employee.
3. Stream provider events.
4. Parse provider action events and final-text directive blocks through the same validation pipeline.
5. Execute only actions allowed in Employee scope.
6. Persist resume handles and turn status.
7. Mark consumed inbox items delivered only after the turn is accepted by the provider.

### Employee-scoped action executor

Create an action executor that receives `(employeeId, employeeTurnId, action)` and applies a strict policy:

Allowed by default:

- `dispatch_subagent` -> rewritten to Employee-owned dispatch with `ownerType: "employee"`, `ownerId`, `ownerTurnId`, `resultTarget: "employee"` unless explicitly `silent` or `store_only`.
- `steer_subagent` -> allowed only for direct children of the same Employee.
- `cancel_subagent` -> allowed only for direct children of the same Employee.
- `send_text`/`send_artifact` -> allowed only through configured route policy, usually Employee inbox/admin/user depending on the Employee profile and action target.
- `show_status` -> can be surfaced as status for the Employee or originating conversation.

Rejected by default:

- Starting/stopping other Employees.
- Steering other Employees.
- Steering main-owned or other-Employee-owned subagents.
- Mutating entrypoint routing outside the Employee's authorized result route.

## Command and directive shapes

### User/service commands

Keep existing commands and add scoped variants:

```text
employees
employee status <employee-ref>
employee start <employee-ref> [--profile <profile>] [--model <model>] [--max-children N]
employee stop <employee-ref> [--cancel-children|--keep-children]
employee steer <employee-ref> <text>
employee steer <employee-ref> --queue <text>
employee steer <employee-ref> --active-only <text>

employee children <employee-ref>
employee child status <employee-ref> <child-ref|job-id>
employee child steer <employee-ref> <child-ref|job-id> <text>
employee child cancel <employee-ref> <child-ref|job-id> [reason]
```

Parsing aliases may support natural forms, but the canonical command should keep the child target explicit. In particular:

- `employee steer analyst focus on docs` steers `analyst`.
- `employee child steer analyst job_ab12 focus on docs` steers child `job_ab12` owned by `analyst`.
- `agent steer job_ab12 ...` may still work for globally visible operator commands, but the status message should show owner `employee:analyst` and should not be described as steering the Employee.

### Brain directive actions

Add Brain-native actions while preserving legacy `steer_subagent` and `cancel_subagent`:

```json
{
  "version": 1,
  "actions": [
    {
      "type": "steer_employee",
      "employeeRef": "analyst",
      "text": "Prioritize provider resume semantics.",
      "delivery": "default",
      "idempotencyKey": "turn-123-steer-analyst"
    },
    {
      "type": "steer_employee_child",
      "employeeRef": "analyst",
      "childRef": "job_ab12",
      "text": "Ignore UI commands; inspect runtime-core only.",
      "delivery": "activeOnly",
      "idempotencyKey": "turn-123-steer-child"
    },
    {
      "type": "dispatch_subagent",
      "owner": { "type": "employee", "employeeRef": "analyst" },
      "profile": "explorer",
      "summary": "Inspect provider resume API",
      "prompt": "Find the provider resume seams and report risks.",
      "route": "return_to_owner",
      "idempotencyKey": "analyst-child-resume-1"
    }
  ]
}
```

Preferred normalized internal action names:

- `steer_employee`
- `stop_employee`
- `dispatch_employee_subagent` or `dispatch_subagent` with `owner.type = "employee"`
- `steer_employee_child`
- `cancel_employee_child`
- `ack_employee_inbox`

`return_to_owner` can normalize to existing `resultTarget: "employee"` for Employee-owned jobs. If adding a new route is too broad for first implementation, keep external `route: "return_to_main" | "store_only" | ...` and compute `resultTarget: "employee"` from the owner.

### Service-action envelope and action-event parsing

Provider streaming `action` events and final-text directive blocks should converge through a shared parser/executor:

```ts
interface RuntimeActionEnvelope {
  version: 1;
  source: {
    kind: "main" | "employee" | "subagent" | "system";
    workspaceId?: string;
    employeeId?: string;
    turnId?: string;
    jobId?: string;
    providerEventId?: string;
  };
  action: BrainOutboundAction | EmployeeAction;
  idempotencyKey?: string;
  emittedAt: string;
}
```

Implementation order:

1. Keep accepting current `ProviderTurnEvent.type === "action"` objects.
2. Wrap them in a `RuntimeActionEnvelope` at the runtime boundary.
3. Parse final-text directive blocks into the same envelope shape.
4. Use source scope to choose the executor:
   - main executor for main Brain turns.
   - Employee executor for Employee turns.
   - child executor only for direct child actions that are explicitly supported.
5. Validate idempotency keys for mutating service actions even though Brain is not adding a persistent replay store. The key helps deduplicate within an active process and future short-lived event journals.

## Queue versus active-turn steering semantics

### Employee itself

- If Employee is `idle` and provider session is healthy: create an `EmployeeTurnRecord` immediately and send the steering text as a new provider turn.
- If Employee has an `active_turn`:
  - `delivery: "default"`: attempt active-turn steering if supported; otherwise persist queued steer.
  - `delivery: "activeOnly"`: attempt active-turn steering; fail if unavailable.
  - `delivery: "queueOnly"`: persist queued steer and do not touch active turn.
- If Employee is `needs_resume` or `degraded`: persist queued steer, report degraded status, and trigger/reserve a resume attempt.
- If Employee is `stopped` or `failed`: reject by default. Optional future flag `--start-if-needed` can start first.

### Employee-owned child subagent

- Resolve child ref only within `ownerType: "employee", ownerId: employeeId`.
- If child is `running`: call `SubagentLifecycle.steerJob` or scoped equivalent.
- If child is `queued`: store steering as child-pending input to apply on start if executor supports pre-start steering; otherwise append to prompt before execution through a controlled template.
- If child is terminal: reject, but offer to enqueue a new Employee steering turn containing the late instruction.
- If child is `cancelling`: reject unless executor still reports alive and supports steering; default reject.

### Ordering

- Employee self-steering queue is FIFO per Employee.
- Child steering queue is FIFO per child.
- Inbox aggregation turns should not starve explicit user steers. Priority order:
  1. Stop/cancel controls.
  2. Explicit user/operator active steering.
  3. Explicit queued user/operator steering.
  4. Child result inbox aggregation.
  5. Employee self-scheduled work.

## Employee-owned subagent dispatch and result routing

### Dispatch path

Employee provider action or command -> `EmployeeActionExecutor` -> `EmployeeOrchestrator.dispatchChild` -> `SubagentLifecycle.dispatch` with:

- `ownerType: "employee"`
- `ownerId: employeeId`
- `ownerTurnId: current EmployeeTurnRecord.id`
- `resultTarget: "employee"`
- `route` preserved for user/admin visibility only if explicitly allowed
- `childRef` generated from requested ref, summary slug, or short job id
- `metadata.origin` containing Employee id, turn id, provider session id, and action id

### Result routing

When an Employee-owned child reaches a terminal state:

1. `SubagentLifecycle.onTerminal` calls `EmployeeResultRouter` if `ownerType === "employee"`.
2. The router writes an `EmployeeResultInboxItem` with concise summary, terminal status, result text, and artifact refs.
3. The router updates child `terminalDeliveredAt` and `inboxItemId` after durable inbox write.
4. If Employee is idle and auto-drain is enabled, the orchestrator starts an `inbox_aggregate` Employee turn.
5. If Employee is active, the inbox item remains pending; optional active-turn notice can be sent if provider supports it and policy allows.
6. For routes that also notify a user/admin, send a short status/action through the entrypoint adapter without bypassing the Employee inbox.

### Aggregation prompt

Employee inbox aggregation should be compact and structured:

```text
New child subagent results for Employee <id>:
- <childRef> / <jobId>: completed. Summary: ...
  Result: ...
- <childRef> / <jobId>: failed. Error: ...

Acknowledge these results in your next plan. You may dispatch follow-up direct children if needed.
```

Large result text should be summarized or referenced by artifact path according to existing artifact boundaries.

## Nested steering policy

Initial policy: support direct children only.

Allowed:

- Main/operator can steer Employee itself by Employee ref.
- Main/operator can steer Employee-owned direct child by explicit Employee ref plus child ref/job id.
- Employee can dispatch direct children.
- Employee can steer/cancel its own direct children.
- Main/operator can cancel a child directly if explicitly named and authorized.

Disallowed by default:

- Employee-owned child dispatching sibling or parent controls directly.
- Employee-owned child steering the Employee itself.
- Employee A steering Employee B's child.
- Implicit grandchild steering.
- Ambiguous short refs.

If nested child subagents are later needed, add `parentJobId` and `ancestorOwner` fields and require a separate explicit policy. Do not overload direct-child semantics.

## Concurrency limits

### Limits to add

- `runtime.subagents.maxConcurrent`: existing global limit remains.
- `employees.defaultMaxConcurrentChildren`: default per Employee, e.g. 2.
- `employees.maxConcurrentChildrenHardLimit`: hard cap for any Employee, e.g. 8.
- `employees.maxPendingSteers`: maximum queued Employee steering items.
- `employees.maxInboxItems`: maximum pending inbox items before backpressure.
- `employees.maxActiveTurnsPerEmployee`: always 1 initially.

### Scheduling policy

- Use a global scheduler with owner-aware fairness rather than letting one Employee fill all global subagent slots.
- A child can start only if both global subagent capacity and owner Employee capacity are available.
- Main-owned urgent jobs should not be starved by Employee children; reserve at least one global slot for non-Employee work when configured.
- If Employee child capacity is full, dispatch returns an accepted queued child job and reports the queue position to the Employee/user.
- If queue depth is exceeded, reject the dispatch action with a provider-visible control result.

### Status visibility

`employee status <id>` should show:

- Runtime status and provider session/resume summary.
- Active turn id and age.
- Pending steering count.
- Active/queued/recent child counts.
- Pending inbox item count.
- Concurrency limit and saturation warnings.

`employee children <id>` should list active and recent children with child refs, job ids, statuses, summaries, route/result target, and steerability.

## Cancellation and stop semantics

### Employee stop

`employee stop <id>` should have explicit child policy:

- Default: graceful stop Employee provider session and keep already-running children alive, with future results stored in inbox. This avoids deleting work accidentally.
- `--cancel-children`: request cancellation of active/queued direct children after stopping the Employee turn.
- `--keep-children`: explicit form of default.
- `--force`: abort active provider turn/session if graceful stop exceeds timeout.

State transitions:

1. `idle|active_turn|queued -> stopping`
2. cancel/finish active turn according to provider capability
3. persist resume handle if available
4. apply child policy
5. `stopping -> stopped` or `failed` with error

### Employee active turn cancellation

Add a control distinct from stop if needed:

```text
employee cancel-turn <employee-ref> [reason]
```

This cancels the current turn but leaves the Employee session/running state available for queued steers and inbox aggregation.

### Child cancellation

- `employee child cancel <employee> <child> [reason]` resolves only direct children.
- `cancel_employee_child` directive does the same through action policy.
- Terminal child cancellation returns `already_terminal`.
- Queued child cancellation removes/prevents execution and writes terminal status `cancelled`.
- Running child cancellation calls executor cancel and marks `cancelling` before terminal update.

## Persistence and resume

### Persisted state

Persist:

- Employee records and runtime state.
- Provider session and resume handles.
- Employee turns and their terminal status.
- Pending Employee steer queue.
- Employee child jobs through existing `SubagentJobStore` plus new typed fields.
- Employee result inbox.
- Short-lived action execution journal if needed for same-process/session duplicate suppression.

Do not persist:

- Full provider transcripts beyond provider-managed resume metadata.
- Secrets or raw entrypoint credentials.
- Full unbounded child output in Employee state; use existing result text/artifact boundaries.

### Startup hydration

On supervisor startup:

1. Load Employee records/runtime states.
2. For each Employee that was `active_turn`, `idle`, or `queued`, try provider-native session resume if a resume handle exists.
3. If resume succeeds, mark `idle` or `queued` and continue pending steers/inbox.
4. If resume fails but pending steers/inbox exist, mark `needs_resume` and surface status; do not invent transcript replay.
5. For active Employee-owned child jobs, follow provider/executor-specific resume if available. If not available, use existing subagent abandonment behavior and write an inbox notice to the Employee.
6. Drain pending inbox/steer queues only after the provider session is healthy.

### Resume contracts

Provider adapters should implement:

```ts
interface ResumableProviderAdapter extends ProviderAdapter {
  resumeSession?(handle: ProviderResumeHandle, options: { workspaceId: string }): Promise<ProviderSession>;
}
```

If only turn-level resume is available, the Employee orchestrator should store the handle but still report limitations in `employee status`.

## Migration from codex-chat behavior

- Preserve `agent status`, `agent kill`, and `agent steer` for operator-visible subagents, but display owner information and require explicit refs for Employee-owned children.
- Preserve `employee start/stop/steer` command spelling, but upgrade semantics from lifecycle-record-only to orchestrated provider sessions.
- Existing `steer_subagent` directives remain accepted for main-owned jobs; Employee-scoped provider output should normalize them through the Employee action executor and reject non-owned refs.
- Existing `dispatch_subagent` directives from the main assistant continue to create main-owned jobs unless an explicit owner is provided.
- Provider-native resume replaces codex-chat process/thread assumptions. After restart, Brain should tell the user what resumed, what was abandoned, and what needs manual restart.
- Existing result routes map as follows:
  - `return_to_main` for main-owned jobs remains main aggregation.
  - Employee-owned jobs use `resultTarget: "employee"` even if the external route is `silent` or `store_only`.
  - `send_to_user` and `send_progress_and_return` may notify the originating user and still write the Employee inbox.

## Tests

### Unit tests

- Directive/action schemas parse `steer_employee`, `steer_employee_child`, `cancel_employee_child`, and owner-scoped `dispatch_subagent`.
- Employee ref resolution and child ref resolution reject ambiguous refs and cross-owner refs.
- Queue semantics produce expected results for `default`, `activeOnly`, and `queueOnly`.
- Per-Employee concurrency admits/queues/rejects correctly under global and owner limits.
- Direct-child policy rejects sibling, parent, other-Employee, main-owned, and terminal child steering.
- Result inbox writes are idempotent per child terminal event.
- Status formatting includes owner, child refs, inbox, and resume state without secrets.

### Integration tests with fake providers/executors

- Employee starts, receives a steer, emits `dispatch_subagent`, child completes, inbox aggregates into next Employee turn.
- Employee active steering uses fake provider capability when enabled.
- Employee active steering queues when fake provider capability is disabled.
- Employee child steering routes to child executor when child is running.
- Queued child steering is applied before fake child start.
- Stop with keep-children leaves child running and routes result to inbox.
- Stop with cancel-children cancels active/queued children.
- Restart hydration resumes provider sessions when fake provider resume succeeds.
- Restart hydration marks `needs_resume` and preserves pending steers/inbox when fake resume fails.

### CLI/supervisor tests

- Commands:
  - `employee steer analyst ...` targets Employee.
  - `employee child steer analyst job_ab12 ...` targets child.
  - `agent steer job_ab12 ...` reports owner and respects authorization.
  - `employee children analyst` lists active/recent direct children.
- Supervisor intercepts produce clear acknowledgements: `sent active`, `queued`, `not found`, `ambiguous`, `not steerable`, `needs resume`.

### Provider adapter tests

- Codex app-server adapter exposes capabilities and maps active steer/interrupt/resume to protocol calls.
- Codex exec adapter truthfully reports no active steering and uses queued semantics.
- Claude Code adapter reports SDK-supported capabilities.
- Provider action events and final directive blocks execute through the same envelope validation.

### Persistence tests

- File-backed stores atomically persist Employee runtime state, turns, steer queue, and inbox.
- Hydration does not print or read secret values.
- Malformed historical state files are ignored or quarantined without blocking all Employees.

## Rollout milestones

### Milestone 1: schemas and parser compatibility

- Add Employee action schemas and normalized internal action types.
- Add typed Employee runtime/turn/queue/inbox stores.
- Add tests for parser, stores, and formatting.
- No live provider behavior change yet.

### Milestone 2: Employee orchestrator with fake provider

- Implement `EmployeeOrchestrator` and Employee turn runner against fake provider/session.
- Implement self-steer queue semantics.
- Implement result inbox and aggregation turns.
- Keep CLI guarded behind existing `--employee-runtime` or an equivalent explicit config flag.

### Milestone 3: Employee-owned child dispatch

- Add owner-scoped child dispatch API and per-Employee concurrency.
- Route terminal child results to Employee inbox.
- Add `employee children`, `employee child status`, `employee child steer`, and `employee child cancel` commands.
- Ensure main-owned subagent behavior remains unchanged.

### Milestone 4: provider capabilities and active steering

- Add provider capability reporting.
- Wire active-turn steering/cancellation for capable providers.
- Ensure fallback to queued semantics for non-capable providers.
- Add provider resume hooks without transcript replay.

### Milestone 5: restart/resume behavior

- Hydrate Employee runtime state on supervisor startup.
- Resume provider sessions where possible.
- Preserve pending steers and inbox items across restart.
- Surface degraded/needs-resume state clearly in commands and user-visible summaries.

### Milestone 6: codex-chat migration compatibility pass

- Compare command acknowledgements and result routing against codex-chat behavior.
- Preserve legacy commands/directives where safe.
- Update migration docs with new Brain-native Employee semantics.
- Run guarded live validation with Codex app-server only after fake/integration tests pass.

### Milestone 7: default enablement

- Enable Employee-owned orchestration by default for configured Employee runtimes.
- Keep dangerous/cross-scope actions rejected by policy.
- Add operator-facing docs and examples.
- Leave provider-specific limitations visible in `employee status`.

## Open decisions

- Whether to add `return_to_owner` as a public route or keep it as an internal normalization from Employee ownership to `resultTarget: "employee"`.
- Whether `employee stop` should default to keep children alive or prompt/require an explicit child policy in interactive entrypoints. This plan recommends keep-children by default to avoid accidental work loss.
- Whether an Employee can auto-drain inbox while an active turn is running through provider active steering, or whether inbox aggregation should always wait for idle. This plan recommends waiting for idle unless provider capability and Employee profile explicitly opt in.
- Whether `agent steer <job>` should be allowed for Employee-owned children by operators without also naming the Employee. This plan allows it only as an operator command that clearly reports owner; provider/directive forms should include the Employee scope.
