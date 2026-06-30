# Slack Company Brain Runtime Plan

Date: 2026-06-25
Status: canonical Brain-owned architecture plan / implementation roadmap

## Decision

Keep the canonical Slack/company-brain control-plane roadmap in the Brain
repo, while leaving runtime adapter implementation work in `codex-chat`. Stop
treating `codex-chat` as a Telegram-shaped bot. The target architecture is
a capability-aware, multi-surface agent runtime where Telegram, Slack, and later
surfaces are adapters over shared core abstractions. The strategic admin/control-plane track is Brain-owned: Brain is promoted into
the long-running server process/web app and orchestrator/control plane;
`codex-chat` stays focused on runtime adapters, contracts, and execution.

Telegram remains supported. Slack should not be bolted onto Telegram-specific
message, user, command, or permission types. Instead, both Telegram and Slack
should translate inbound events into the same runtime model and render outbound
runtime events through surface-specific adapters.

## Detailed Slack context design

The implementation-ready design for Slack channel/thread context, hydration,
Claude-like UX decisions, data model, telemetry, admin controls, canaries,
rollout, and rollback now lives in:

```text
/home/tim/pkg/tim/brain/plans/2026-06-29-slack-channel-thread-context-design.md
```

Treat that document as the canonical detail layer beneath this roadmap. Tim has
now requested visible implementation rather than a shadow-only start. The active
Claude-like decision is **source-specific context with root-thread delivery**:
existing Slack threads hydrate/reply as threads, and root channel mentions
hydrate bounded recent channel context while replying in a Slack thread attached
to the invoking root message (`thread_ts = message_ts`). Hydration must remain
bounded/redacted and fall back to the source event if Slack history reads are
unavailable.

## Goals

- Preserve the working Telegram service while making it one adapter among many.
- Add Slack as a first-class company surface without leaking Slack tokens or raw
  Slack ACL assumptions into agent/subagent prompts.
- Make capability checks explicit, auditable, and enforced at every tool call.
- Let authorized Telegram users operate the company brain, including searching
  or acting across Slack chats, when their capabilities allow it.
- Support long-running Codex work with visible progress, cancellation, steering,
  and audit/correlation IDs across surfaces.
- Keep the company brain state and retrieval layer ready for a central server
  with many subagents, persisted summaries, indexes, and context compression.
- Keep near-term admin/control-plane functions in Brain. The codex-chat-hosted
  `/admin` and `/api/admin/codex-chat/*` compatibility surfaces have been
  removed; codex-chat keeps runtime APIs such as Slack Events and audio ingest.

## Current Brain deployment context

Brain is an abstract project/source repo. Concrete service paths and host
settings come from named deployments. The current active deployment for this
conversation is `tim-main-brain` on `codex-chat-assistant-1`
(`178.104.208.141`):

- Brain admin service: `brain-admin.service` serving
  `https://brain.decisive-outcomes.com/admin` from `/home/tim/pkg/tim/brain`;
- codex-chat runtime: `/home/tim/pkg/tim/codex-chat`,
  `codex-chat.service`, env `/home/tim/.config/codex-chat/env`, config
  `/home/tim/pkg/tim/codex-chat/config/codex-chat.toml`;
- assistant logic checkout: `/home/tim/pkg/tim/assistant-agent-logic`;
- private workspace/repo registry: `/home/tim/.assistant-claude/workspace`;
- public Slack Events URL:
  `https://brain.decisive-outcomes.com/api/slack/events`, reverse-proxying raw
  signed requests to the local codex-chat API so codex-chat verifies signatures
  and owns runtime behavior.

Historical single-host Brain/Anna deploy records are not authoritative. Select a
named Brain deployment before acting on service paths or host-specific settings.

## Current state to preserve

Based on the current repo/system state:

- [x] Telegram adapter/current `codex-chat` service exists.
- [x] Subagent manager exists with queued/running job state, artifact dirs,
      result routing, and status commands.
- [x] Loop and monitor runtimes exist and can dispatch work back to the main
      loop or to subagents.
- [x] Basic steering/cancel exists for subagents through Telegram/service
      commands, directives, and IPC seams.
- [x] Behavior packs exist under `behavior/`, including subagent profiles and
      main-loop dispatch guidance.
- [x] Fast mode/service tier support is implemented for the main loop,
      subagents, loops, monitors, and directive schemas.
- [x] Existing Brain/company-runtime planning notes exist in the broader local
      system, including Brain monorepo/runtime parity plans that already frame
      Telegram as an adapter over a channel-neutral runtime.
- [x] Slack adapter exists (`src/slack.ts` and related runtime/API tests).
- [x] Installable Slack app runtime contract exists under codex-chat's
      `slack-app/` with manifest, install metadata template, adapter config/env
      examples, and validation scripts. Brain owns the user-facing setup/runbook
      in `docs/slack-setup-runbook.md`.
- [x] Capability-aware runtime abstractions are implemented in `codex-chat`.
- [x] Brain owns the Clerk-protected admin/control-plane surface at
      `https://brain.decisive-outcomes.com/admin`.
- [x] The legacy codex-chat-hosted admin config page and
      `/api/admin/codex-chat/*` routes have been removed.
- [x] Brain Phase 3 control-plane implementation has started outside
      `codex-chat`: the Brain repo now owns an initial Clerk-protected
      `brain-web-admin` service skeleton for health/settings, safe write-only
      codex-chat env/config updates, and approved codex-chat deploy/restart
      operations.
- [ ] Durable company-mode capability state exists outside long-term JSON files.
- [ ] Full admin dashboard exists for users, channel mappings, capabilities,
      audits, and running jobs. The initial Slack config page is not that full
      dashboard.

## Core runtime abstractions

### `ActorContext`

`ActorContext` identifies the actor requesting or authorizing work. It is the
runtime's identity object, not a Telegram or Slack user object.

Suggested fields:

- stable actor ID
- surface kind (`telegram`, `slack`, `dashboard`, `system`, etc.)
- surface-specific user IDs as adapter metadata
- display name and handle snapshots
- organization/workspace/team IDs
- admin/personal-owner markers
- authenticated session metadata
- correlation ID for the inbound request

Telegram should use the same `ActorContext` shape as Slack. Tim's current
personal Telegram use should be represented as a privileged personal/admin actor
with explicit grants, not as a bypass around the capability model.

### `OutputTarget`

`OutputTarget` describes where output should go, independently of where the work
originated.

Examples:

- reply to the source Telegram chat/message
- reply to the source Slack channel or explicit source thread
- post a progress update to a Slack channel
- DM a user on Slack
- send an admin notification to Telegram
- write an artifact only, with no user-visible send

Fields should include surface kind, workspace/team, channel/chat/thread/message
IDs, routing policy, allowed output types, and any required audit labels. Tool
and subagent requests should use explicit output targets instead of inferring
that replies always go back to the inbound channel.

### `RunContext`

`RunContext` is the per-turn/per-job envelope used by the main loop, subagents,
loops, monitors, and Employees.

It should contain:

- run ID and parent run ID
- conversation session ID
- actor context
- origin target and default output target
- capability grants effective for this run
- surface metadata needed by renderers
- progress sink
- cancellation and steering handles
- artifact directory
- audit/correlation IDs
- context budget and compression policy

Subagents should receive a narrowed `RunContext` view: enough metadata to do
their job and report progress, never raw bot tokens or unrestricted channel
access.

### Conversation-scoped main loops / sessions

The runtime should treat a live Codex main loop as scoped to one conversation,
not to the whole Slack workspace, the whole Telegram service, or a global bot
context. A `ConversationKey` is the stable adapter-derived key for that scope.
A `ConversationSession` is the durable runtime record that owns the active or
hibernated main-loop state, mailbox, current checklist/progress state, active
leases, compressed memory, effective grants, and archive metadata for that key.

Default conversation granularity:

- Slack root `app_mention` in a channel creates or resumes a thread-scoped
  conversation session keyed by workspace/team ID, channel ID, and the invoking
  message timestamp, and posts the default response in the Slack thread attached
  to that root message. It hydrates bounded recent channel context for the
  initial answer.
- Slack messages that are already inside a reply thread create or resume an
  explicit thread session keyed by workspace/team ID, channel ID, and
  `thread_ts`; outputs for that session stay in the source thread unless an
  authorized reroute posts a summary to the channel.
- Slack DM creates or resumes the DM conversation ID.
- Slack MPIM/private group creates or resumes the Slack conversation ID, with
  member and capability context captured as part of the session metadata; if a
  reply thread is used inside that conversation, it can become a distinct
  thread session.
- Telegram creates or resumes by chat ID, plus `message_thread_id`/forum topic
  where available.

Channel-level state is ambient memory, retrieval index, summary state, and
capability scope. It is not a live main loop by default. A channel gets a live
session only for explicit watch, triage, digest, monitor, or similar modes with
bounded leases and clear output policy.

Session lifecycle:

1. Start: derive the `ConversationKey`, create the `ConversationSession`, attach
   initial grants/output targets, and create the first `RunContext`.
2. Run: process mailbox items, dispatch tools/subagents, emit progress events,
   and persist compressed session state.
3. Wait/hibernate: when blocked on user input, approvals, timers, queues, or
   idle time, release expensive model/worker resources while preserving durable
   session state.
4. Resume: reacquire an active lease when a new event, scheduler wakeup,
   approval, or subagent result arrives for the same `ConversationKey`.
5. Expire/archive: after retention/TTL policy, close active leases, retain audit
   records and summaries, and archive or prune heavyweight state.

Hibernation and scheduling are runtime requirements, not optimizations. The
session registry should enforce max active leases, per-workspace and per-surface
rate limits, backoff, wakeup scheduling, and cost controls so many quiet Slack
threads or Telegram chats do not become immortal model contexts.

Subagents are owned by `{conversationSessionId, runId, checklistItemId}`. They
return output, artifacts, and progress to the owning session mailbox/progress
sink, where the session runtime performs capability checks, output routing, and
final composition.

### Slack root-thread and explicit-thread coherence requirement

Slack must behave like a shared company-brain participant with Claude-like
thread UX. Tim's current implementation decision is root-thread delivery: when
someone mentions Brain in the main channel, Brain hydrates bounded recent
channel context but answers in the Slack thread attached to that invoking root
message. If a user is already in a Slack reply chain, that existing thread is a
distinct conversation/session with its own history and output target.

#### Channel-scoped and thread-scoped identity

- Define two related but distinct runtime keys for Slack:
  - `SlackChannelConversationKey = {enterpriseId?, teamId, channelId}` for
    ambient channel memory, summaries, capability scope, membership/visibility
    snapshots, and rollout/canary state.
  - `SlackThreadConversationKey = {enterpriseId?, teamId, channelId, threadTs}`
    for root-attached and existing reply-thread assistant sessions.
- A root channel `app_mention` with no source `thread_ts` uses
  `threadTs = event.ts` as the output/session thread and hydrates bounded recent
  channel context for that turn.
- A Slack event that already has `thread_ts` different from its own `ts` uses
  the thread key and a thread `OutputTarget`. All subsequent messages in that
  reply chain resume the same `ConversationSession`.
- For DMs, use a Slack conversation key based on `{enterpriseId?, teamId,
  channelId}` because the DM channel itself is the conversational container.
  MPIMs and private channels use conversation-level continuity by default and
  thread-level continuity only when Slack supplies a source `thread_ts`.
- Persist channel session records separately from thread records. A channel may
  have many active or archived thread sessions, but a thread session belongs to
  exactly one channel context and does not replace the shared channel session.

#### Avoiding context fragmentation

- Keep root-attached thread sessions isolated from each other. They may hydrate
  bounded channel context, but they must not inherit unrelated root-thread
  state unless future channel summaries explicitly provide it with source labels.
- Do not append every ambient channel message to the live model context. Store a
  bounded, source-labelled event journal and/or summaries, then hydrate only the
  relevant recent window or summary for the turn.
- When a thread produces a decision that should become shared channel context,
  the assistant may post or propose a concise channel summary only with an
  explicit output policy such as "summarize this thread back to the channel".
  Otherwise, the thread stays a side-session and the channel session sees it
  only as an attributed summary when grants allow retrieval.
- Channel summaries must be source-attributed by channel and time window. A
  later channel turn can use that summary; a different channel, DM, or public
  output cannot use it without an explicit export/read grant.

#### When to continue a thread versus the channel

- **Continue the attached root thread session** when the inbound Slack event is a
  root channel `app_mention` with no source `thread_ts`. Progress/final/error
  output goes to the attached root thread by default.
- **Continue the thread session** when the inbound event is in an existing reply
  thread (`thread_ts` present and not equal to the message `ts`), when the user
  explicitly asks to move the current channel discussion into a thread, or when
  an existing thread-owned subagent/loop callback returns.
- **Do not silently switch surfaces.** A thread answer stays in the thread; a
  root-channel answer stays in its attached root thread. Cross-posting from a
  thread to the channel, from a private channel to a public channel, or from Slack to Telegram
  requires explicit read/export/write grants and an explicit `OutputTarget`.
- **DMs stay DMs.** DM context must not silently read public/private channel
  history without explicit channel selection and grants, even if the DM author
  is a member of those channels.

#### Channel message context: API reads and recorded event history

Slack channel-first answers need channel context. There are two viable sources,
and the runtime should support both behind one capability-checked hydrator:

1. **On-demand Slack Web API reads.** Use `conversations.history` for a bounded
   channel window and `conversations.replies` for a bounded thread window when a
   turn needs context. The current manifest already has private-channel/DM/MPIM
   history and read scopes (`groups:history`, `groups:read`, `im:history`,
   `im:read`, `mpim:history`, `mpim:read`). Public channel reads need additional
   bot scopes such as `channels:history` and `channels:read`; Slack documents
   `channels:history` as viewing messages in public channels the app has been
   added to, and `conversations.history` as returning a portion of message
   events for a conversation. [Slack scopes](https://docs.slack.dev/reference/scopes/channels.history/),
   [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/).
2. **Recorded event history.** Subscribe only in allowlisted channels to message
   events the runtime is permitted to retain, then write an append-only,
   source-labelled event journal with retention/compaction. For public channel
   ambient history this likely means adding the `message.channels` bot event and
   the matching public-channel history/read scopes; app mentions alone are not
   enough to reconstruct full channel context. Slack's Events API sends selected
   subscribed events to the app's HTTP endpoint, and Slack documents the
   `message.channels` event for public channel messages. [Events API](https://docs.slack.dev/apis/events-api/),
   [message.channels](https://docs.slack.dev/reference/events/message.channels/).

Recommended plan: start with on-demand bounded API hydration for allowlisted
channels because it gives correct context without storing every channel message;
then add recorded event history for selected high-value channels when operators
want lower-latency summaries, auditability, and fewer repeated history reads.
Both sources must emit the same `HydratedSlackContext` shape: source labels,
time range, message count, truncation flag, retrieval reason, capability check
IDs, and redaction/retention policy.

#### Safe context hydration

- Hydrate context only after deriving the conversation key, actor, effective
  grants, output target, and retrieval reason for the turn.
- Use small defaults: e.g. thread root plus recent replies for a thread; root
  channel mention plus the last N channel messages or last M minutes for a
  channel turn; indexed summaries only when the request asks about older
  channel state.
- Preserve Slack source labels on every snippet before it reaches prompts:
  `{surface: slack, enterpriseId?, teamId, channelId, channelType, threadTs?,
  messageTs?, source: api|event_journal|summary}`.
- Store raw hydrated windows only under short retention unless an operator has
  enabled durable event journaling for that channel. Prefer compact,
  source-attributed summaries for long-term memory.
- Treat cached display names, channel names, topics, and membership as advisory
  context. They help explain results but never authorize access.
- If context cannot be safely hydrated because scopes, channel membership, or
  grants are missing, answer with a transparent limitation instead of guessing
  or falling back to another channel's memory.

#### Privacy and cross-channel isolation

- Every persisted message, summary, embedding, artifact, subagent result, and
  audit row derived from Slack must carry source labels at least
  `{surface: slack, enterpriseId?, teamId, channelId, channelType, threadTs?,
  messageTs?}` plus capability labels inherited from the source.
- Retrieval must filter by both source labels and effective grants before any
  text reaches the main loop, subagents, or callback composer. Private-channel
  summaries are never eligible for public-channel, different-private-channel,
  DM, or Telegram output unless an explicit output-target grant permits export.
- The runtime must reject ambiguous output routing. A request that reads one
  channel but asks to post elsewhere needs separate read and write/export grants
  and an explicit `OutputTarget`.
- Summary compaction must preserve source boundaries. A workspace-wide digest is
  a collection of per-channel/per-thread attributed summaries, not a single
  unlabelled memory blob.

#### Subagents, callbacks, and output targeting

- Subagent dispatch from Slack must include the owning
  `conversationSessionId`, the originating `SlackChannelConversationKey` or
  `SlackThreadConversationKey`, default `OutputTarget`, and a narrowed
  capability set. Do not pass raw Slack bot tokens or broad workspace history
  access to child agents.
- For channel-originated work, `return_to_main`, `send_to_user`, progress,
  failure, and direct-fallback callbacks default to the source channel with no
  `thread_ts` so the channel keeps the shared context.
- For thread-originated work, callbacks default to the source `channelId` and
  `threadTs`. Late callbacks after hibernation/restart must still land in that
  originating thread, not the main channel or a global ops channel.
- `return_to_main` callbacks return to the owning session mailbox first; the
  main loop composes the visible reply in the stored output target unless an
  explicit authorized reroute exists.
- Loop, monitor, and system callbacks that were triggered by Slack context must
  carry their source labels and output target explicitly; do not fall back to a
  global Slack ops channel unless the policy says to notify ops.

#### Telemetry and audit needed per channel/thread

Record redacted, metadata-first telemetry that can answer whether continuity is
working without storing secrets or raw message bodies:

- normalized event counters by team/channel/channel type/thread/DM and event
  type, including duplicate/retry/idempotency outcomes;
- session create/resume/hibernate/archive counts keyed by channel/thread/DM;
- inbound-to-ack latency, enqueue latency, turn start latency, first progress
  latency, final reply latency, and Slack Web API send result class;
- selected context source: channel-only, channel-plus-history-window,
  channel-summary, thread-only, thread-plus-channel-summary, explicit channel
  search, recorded event journal, or denied/no-context;
- capability check outcomes for read channel, read thread, post source channel,
  post source thread, post explicit channel, DM, export/cross-surface, and
  subagent dispatch;
- output target actually used for each progress/final/error send, including
  whether `thread_ts` was absent (channel default) or present (thread context);
- subagent job ownership and callback routing by `conversationSessionId`,
  channel ID, and thread timestamp;
- leakage guard denials, ambiguous target denials, and private-to-public export
  denials;
- canary run IDs and redacted target references for public channels, private
  channels, DMs, MPIMs, and thread replies.

Brain should display rollups and redacted drilldowns, but `codex-chat` remains
the source of truth for runtime event normalization, session routing, context
selection, Slack sends, and callback routing.

#### Migration and testing canaries

Before Slack is considered Telegram-parity for conversation feel, run canaries
that prove root-thread delivery, channel-context hydration, and thread isolation:

1. **Public channel default reply**: mention Brain in a public channel and
   verify the response is posted in the Slack thread attached to the invoking
   root message (`thread_ts = message_ts`).
2. **Public root-thread continuity**: ask a follow-up in the attached root
   thread and verify the same root-thread session/output target is used.
3. **Existing thread continuity**: mention or reply to Brain inside a Slack
   reply thread and verify the response stays in that thread and resumes the
   thread session on follow-up.
4. **Channel context hydration**: reference recent allowed channel discussion
   from a root mention and verify Brain uses only the bounded API/event-journal
   window or channel summary selected by policy.
5. **Second public channel isolation**: ask a similar question in another public
   channel and verify no first-channel details appear unless explicitly
   retrieved with grants.
6. **Private channel**: invite the bot, use both a root channel mention and an
   in-thread follow-up, and confirm root replies stay in the attached private
   root thread while thread replies stay in-thread.
7. **Private-to-public denial**: ask in a public channel for a summary of the
   private canary thread without an export grant and verify a clean denial.
8. **DM continuity**: DM the bot, follow up later, and verify the DM session
   resumes without reading public/private channel context by default.
9. **MPIM/group DM**: run the same continuity test in an MPIM and verify member
   context is metadata only, not an authorization bypass.
10. **Subagent callback routing**: dispatch one channel-originated and one
    thread-originated subagent, allow completion after the main turn hibernates,
    and verify callbacks/final summaries land in the stored channel or thread
    target respectively.
11. **Restart/hibernation resume**: restart or simulate worker hibernation in a
    safe canary environment and verify the same channel/thread sessions and
    output targets are recovered from durable state.
12. **Telemetry audit**: for each canary, verify redacted telemetry links inbound
    event, session key, selected context source, capability checks, subagent
    callbacks, and outbound Slack result without exposing raw text or secrets.

### `CapabilityGrant` and capability checks

Capabilities are the authorization boundary. A `CapabilityGrant` should have:

- unique stable ID
- human-readable name and description
- scope (`user`, `chat`, `channel`, `workspace`, `temporary`, `system`)
- allowed operations and resource selectors
- grant source and grantor
- expiry for temporary capabilities
- audit policy

Every tool call checks capabilities at execution time. Prompt instructions are
not enforcement. Slack ACLs can inform default grants, but the runtime must not
trust Slack ACLs alone because the agent can combine data, route output across
surfaces, and take actions that Slack itself does not understand.

Important capability families:

- read Slack channel/thread history
- search Slack across selected channels
- summarize Slack channel or thread
- post to source Slack thread
- post to an explicitly selected Slack channel
- DM a Slack user
- read/write Telegram chats
- dispatch subagents
- access company brain indexed summaries
- operate admin/dashboard functions
- approve temporary chat capabilities

Future capability planning should likely split these families into individual
abilities for each repo the company brain can access or mutate. For example,
`repo:codex-chat:read`, `repo:codex-chat:write`, `repo:assistant-agent-logic:read`,
and `repo:assistant-agent-logic:write` should be distinct enough that a user can
read plans, inspect diffs, open PRs, or run deploy actions for only the repos
they are trusted to operate.

### `ProgressEvent` and progress sink

Long-running work should emit structured `ProgressEvent`s rather than ad hoc
text. The progress sink can then render appropriately for each surface.

Suggested event types:

- checklist created/updated
- item started/completed/failed/skipped
- subagent dispatched/steered/cancelled/completed
- tool call started/completed/failed
- partial summary
- waiting for approval/input
- final result

Slack can render these as an updating message with checked-off items and thread
updates. Telegram can use a simpler status stream or periodic concise updates.
The same progress events should also feed the audit viewer and running-jobs UI.

### Audit and correlation IDs

Every inbound event, run, subagent, tool call, output send, capability check,
and external API call should carry correlation IDs. Audit records should capture
who asked, what capability was checked, what resource was accessed, where output
was sent, and which run/subagent did it.

IDs to standardize:

- inbound event ID
- run ID
- subagent/job ID
- tool call ID
- output event ID
- capability check ID
- Slack event/channel/thread/message IDs as adapter metadata
- Telegram chat/message IDs as adapter metadata

## Telegram in the capability model

Current Telegram control should migrate into the shared actor/capability model:

- Tim's Telegram actor gets a privileged personal/admin grant set.
- Existing allowed Telegram users become actors with explicit grants.
- Telegram admin commands become capability-checked operations.
- Telegram users can operate the company brain, including reading/searching or
  acting across Slack chats, only when their grants allow the requested resource
  and output routing.
- Telegram-originated work can target Slack output only with explicit target
  routing and matching write capability.

This keeps Telegram powerful while avoiding hidden special cases that Slack and
future surfaces cannot reuse.

## Slack adapter design

### Input

Start with Slack Events API support for:

- app mentions in channels
- DMs to the app
- message actions or shortcuts later
- selected interactive button clicks from progress/admin messages

The Slack HTTP handler must fast-ack within Slack's deadline and enqueue work.
It should not run long Codex turns inline. The queued event becomes a normalized
runtime inbound event with `ActorContext`, `OutputTarget`, Slack metadata, and
correlation IDs.

Required metadata:

- team/workspace ID
- enterprise ID if present
- channel ID and channel type
- thread timestamp and message timestamp
- Slack user ID
- app/bot user ID
- event ID/retry metadata for idempotency
- channel/user names as cached display snapshots, not authorization truth

### Output

Slack renderer responsibilities:

- post channel-originated answers back to the source channel by default
- reply inside the source thread when the inbound event is already threaded
- post to an explicitly selected target channel when authorized
- DM a user when authorized
- update a progress/checklist message as `ProgressEvent`s arrive
- render final answers with artifacts/links
- show approval buttons for temporary capabilities or admin operations
- avoid leaking private run metadata unless the target grants allow it

`OutputTarget` must drive posting. The main loop and subagents should not call
Slack APIs directly or decide target channels from raw strings without runtime
validation.

### Slack read tools

Expose Slack reads only as capability-checked tools owned by the runtime:

- fetch source channel/context and source thread/context
- read recent channel history
- search selected channels
- fetch permalink/message metadata
- resolve channel/user metadata
- read channel membership/visibility metadata as advisory input

Tools should return bounded, redacted, source-attributed data with correlation
IDs. They should support summarization/index handoff so subagents do not need
unbounded raw history.

### Slack write tools

Expose Slack writes only as capability-checked runtime tools:

- post reply to source channel or source thread
- post/update progress message
- post to explicit target channel
- DM explicit target user
- add reaction/status marker
- upload/link artifact when allowed

No raw Slack bot/user tokens should be available to the main Codex process or
subagents. Subagents request an operation; the runtime checks capability, logs
audit, and executes through the adapter.

## Capability assignment model

Real capability enforcement, capability bundles, dashboard/admin grant flows,
and temporary approval UX should not be implemented from this plan text alone.
Before that work starts, schedule a dedicated requirements brainstorming and
planning session to decide the exact capability vocabulary, resource selectors,
bundle semantics, grant lifecycle, admin affordances, audit queries, migration
path, and fail-closed behavior across Telegram, Slack, dashboard, and future
surfaces. Slack foundation work can introduce narrow source-conversation grants
as adapter metadata, but those compatibility grants are not a substitute for
the full enforcement/bundles/admin design.

Capability state should support:

- actor grants: stable actor-level permissions
- conversation grants: permissions tied to a specific Slack channel session,
  Slack thread, DM, MPIM, private group, Telegram chat, or Telegram forum topic
- workspace grants: permissions tied to a Slack workspace/team, Telegram
  administrative scope, or other organization-level resource
- temporary run grants: short-lived grants approved in-context for one run or
  session and automatically expired
- output-target grants: separate routing permissions for where results,
  progress, artifacts, or notifications may be sent
- explicit target routing: separate capability to read a source versus post to a
  target
- unique IDs and descriptions for every grant
- audit records for grant creation, use, denial, expiry, and revocation
- AI-assisted suggestions, but human-confirmed grants for sensitive operations

Temporary capabilities are useful for one-off questions like "summarize this
private Slack thread and send it to this Telegram chat". The runtime should show
exactly what access and output routing is being granted, for how long, and by
whom.

Capability selectors must distinguish narrow and broad resources. Examples:

- reading a source Slack thread is different from reading the shared channel
  session or whole channel history
- reading a Slack channel is different from exporting its summary to Telegram
- posting back to the source channel/thread is different from posting to an arbitrary
  Slack channel
- DMing the requesting actor is different from DMing any workspace member
- source-attributed summaries, embeddings, and compressed memories inherit the
  source capabilities and must be filtered before retrieval or export

Long-term company-mode capability state should not live in JSON files. JSON is
fine for early prototypes, local tests, or import/export, but durable operation
should use a real store with migrations, indexes, revocation history, and audit
query support.

## Admin and dashboard

Current implementation note: Brain now owns the Clerk-protected admin/control
plane at `https://brain.decisive-outcomes.com/admin`. The codex-chat API
process no longer serves `/admin`, `/admin/codex-chat`, or
`/api/admin/codex-chat/*` compatibility surfaces. This is a deliberate breaking
transition: if an operator still needs old setup affordances, add them to Brain
or use the no-secret `slack-app/` manifest scripts from a selected codex-chat
checkout.

`codex-chat` should keep runtime adapter contracts and behavior, while Brain
owns web/admin policy, install metadata, env/deploy/restart orchestration,
health views, capability and audit administration, and `assistant-agent-logic`
checkout/version orchestration. Brain's web/admin UI should be treated as a
heavily used settings-management surface for recurring operations, not just
occasional setup. It may eventually host a guided, sequential Brain
setup/install workflow from the web UI, while still allowing setup from Codex
sessions when that is easier for an operator.

Build Brain's admin/dashboard surface to manage and inspect:

- users/actors and identity mappings across Telegram and Slack
- allowed dashboard users and their admin status
- Slack workspace/channel mappings
- Telegram chat mappings
- capability grants, temporary grants, and revocations
- bundled capability assignments for common user roles or trust levels
- audit viewer filtered by actor, channel, run, capability, and correlation ID
- running jobs/subagents/Employees with steering and cancellation
- queue health, loops, monitors, and stuck jobs
- AI-assisted capability assignment proposals
- button-click operations for approvals, grants, reroutes, cancels, and retries

The dashboard must be Clerk-authenticated and fail closed. The allowed-user list
is required authorization state: if no allowed dashboard users are configured, no
one gets access to the dashboard, including signed-in Clerk users. Store only
environment variable names and non-secret metadata in repo/registry
documentation; never record Clerk secret values.

Dashboard admins should be able to assign capabilities to users in bundles,
then inspect and adjust the individual grants created by each bundle. Bundles
should be convenience templates, not opaque roles that bypass runtime
capability checks or audit records.

Telegram can also remain an admin control surface. The same admin operations
should be runtime actions with capability checks whether invoked from Telegram,
Slack buttons, or the dashboard.

## Incremental progress and checklist orchestration

For multi-step work, the main loop should create an initial checklist and emit a
`ProgressEvent` for it. Each checklist item can dispatch a subagent or run a
bounded tool sequence. Subagents emit structured progress updates against their
assigned item.

Recommended flow:

1. Main loop receives normalized event, creates/resumes a `ConversationSession`,
   and creates `RunContext`.
2. Main loop plans checklist items with required capabilities and output target.
3. Runtime posts or updates an initial progress message.
4. Main loop dispatches subagents per item where useful.
5. Subagents emit progress events, artifacts, and final item summaries.
6. Runtime renderer checks off items in Slack and sends simpler Telegram status
   updates where appropriate.
7. Main loop composes final answer from item results and persisted summaries.
8. Audit records link conversation sessions, checklist items, subagents, tool
   calls, outputs, and capability checks by correlation ID.

Slack should get the richest renderer first: an updating checklist message in
the channel or explicit thread selected by `OutputTarget`, optional threaded
details when requested, approval buttons, and final answer. Telegram can initially use
concise messages such as "3/6 done" and final summaries, while still receiving
all underlying progress events in the audit log.

## Remote brain/server architecture

The company brain should run as a central server, not as state scattered across
client adapters.

Core server responsibilities:

- event ingestion from Telegram, Slack, dashboard, loops, and monitors
- shared runtime abstractions and capability checks
- queueing and cancellation/steering
- many subagent workers with bounded context
- progress event fanout to renderers
- persisted run summaries and artifacts
- retrieval/index service over Slack, Telegram, docs, and durable summaries
- context compression for long channels, long runs, and repeated company topics
- audit/correlation log and admin queries

Compression/context management should be explicit:

- source messages remain source-attributed
- long threads/channels get persisted summaries and embeddings/index entries
- subagents receive task-specific compressed context instead of raw company-wide
  history by default
- final answers cite the source surface/channel/thread where policy permits
- indexes and summaries inherit capability labels so retrieval results are
  filtered before being shown to the model

## Phased plan

### Phase 0 — document and protect current behavior

- [x] Current Telegram service exists.
- [x] Subagent manager exists.
- [x] Loops/monitors exist.
- [x] Basic steering/cancel exists.
- [x] Behavior packs exist.
- [x] Fast mode support is present.
- [x] Existing Brain/runtime planning notes exist in the local system.
- [x] Add this architecture plan to `plans/`.
- [x] Inventory Telegram-shaped types that must become adapter-neutral. See `docs/telegram-runtime-baseline.md`.
- [x] Add tests around current Telegram behavior before refactoring. See `src/__tests__/telegram-baseline.test.ts` plus existing Telegram/service/introspection coverage.

### Phase 1 — introduce shared runtime types behind Telegram

- [x] Add `ActorContext`, `OutputTarget`, `RunContext`, `ConversationKey`,
      `ConversationSession`, `CapabilityGrant`, and `ProgressEvent` TypeScript
      types.
- [x] Wrap current Telegram inbound handling into `ActorContext` and
      `OutputTarget` without changing user behavior.
- [x] Create/resume Telegram conversation sessions by chat ID and
      `message_thread_id`/forum topic where available.
- [x] Route current Telegram sends through `OutputTarget`.
- [x] Add correlation IDs to inbound events, runs, subagents, directives, and
      outputs.
- [x] Represent Tim/current allowed Telegram users as explicit capability grants.
- [x] Add capability-check helper APIs with permissive personal/admin grants for
      existing Telegram flows.

### Phase 2 — Slack adapter foundation

This phase is the Slack foundation/adapter slice only. It intentionally stops
short of broad Slack history/search tools, full capability enforcement,
capability bundles, or admin/dashboard flows. The installable app surface lives
in `slack-app/`; it owns the Slack manifest, scopes/events, non-secret install
metadata template, and deployment/env notes that feed the `src/slack.ts`
adapter. Phase 2 is still operationally open until the real Slack app is
installed and live app-mention/DM/private-channel canaries pass.

- [x] Add Slack app config and secret metadata checks without exposing token
      values.
- [x] Remove the legacy codex-chat-hosted admin config page and keep Slack env/admin workflows in Brain or private operator scripts.
- [x] Add installable Slack app surface (`slack-app/`) with manifest, required
      scopes/events, config/env examples, install metadata template, and local
      validation.
- [x] Implement Events API verification, idempotency, fast ack, and queueing.
- [x] Normalize app mentions and DMs into shared runtime events.
- [x] Create/resume the initial Slack compatibility sessions. Current code still
      creates thread-scoped sessions for root channel app mentions; update this
      to the channel-first model above so root mentions use channel sessions and
      only existing reply chains use thread sessions.
- [x] Resolve Slack user/channel metadata as adapter metadata when available
      from Events API payloads; do not treat cached display snapshots as
      authorization truth.
- [x] Implement Slack renderer support for source-thread/source-conversation
      text replies and final answers through `OutputTarget`; update canaries and
      tests so channel-originated targets omit `thread_ts` by default.
- [x] Add tests with fixture events and no live network calls by default.
- [~] Install the real Slack app in a workspace, point Events API at the Brain
      public URL that reverse-proxies to codex-chat, and run live
      app-mention/DM/private-channel canaries before declaring Phase 2
      operationally complete. Basic inbound Slack Events delivery through
      `https://brain.decisive-outcomes.com/api/slack/events` is confirmed as of
      2026-06-29, and an outbound reply directive was attempted; final outbound
      Slack reply success still needs a live operator canary proving the reply lands in the
      expected source channel/thread/DM with the installed app scopes and bot
      membership. As of 2026-06-30 Brain admin has a manual Slack Canary panel to
      record those outcomes and correlate them with redacted codex-chat telemetry.

### Phase 3 — promote Brain as the long-running web/admin control plane

This is the strategic next implementation phase, even while Phase 2 live
canaries remain open. Brain should become the always-on server process/web app
and orchestrator/control-plane for company-brain administration. `codex-chat`
continues to own Telegram, Slack Events API/replies, the Slack manifest
contract, `ActorContext`/`OutputTarget` runtime semantics, and subagent/runtime
execution.

- [ ] Stand up Brain as a persistent web/admin process on the server behind
      Clerk with fail-closed admin allowlist policy.
- [ ] Treat Brain's UI as a heavily used settings-management surface for
      recurring operations, not just an occasional setup page.
- [ ] Design the tradeoff between guided/sequential Brain setup/install flows in
      the web UI and setup from Codex sessions; keep both paths available when
      each is the easier operator workflow.
- [ ] Move non-secret Slack install metadata, workspace/channel mappings, and
      install health/status into Brain's private control-plane store.
- [ ] Move env/config metadata, secret-reference management, deploy/update,
      restart/rollback, and health-check orchestration into Brain-controlled
      admin flows.
- [ ] Move Clerk/admin policy, dashboard allowlists, capability bundle planning,
      temporary approvals, revocations, and audit browsing into Brain.
- [ ] Let Brain select and validate the `assistant-agent-logic` checkout/ref for
      each deployed servant stack while assistant workflows remain in that repo.
- [ ] Expose the `codex-chat`-owned Slack manifest contract in a stable
      no-secrets way so Brain can render, validate, copy/download, and use it
      without forking adapter semantics.
- [x] Do not restore the removed codex-chat-hosted `/admin` bootstrap. Brain
      owns `/admin` and `/api/admin/brain/*`; runtime-local diagnostics should
      use explicit codex-chat runtime APIs or Brain-mediated operations.

### Phase 4 — capability requirements, enforcement, and audit spine

Status as of 2026-06-30: Brain control-plane Phase 5 has a non-enforcing
foundation slice: the separate Brain UI **Capabilities** tab, store schema v2
for people/users, Telegram/Slack identities, proofs, channels, subjects/grants,
a visible Tim owner/all bundle expansion, grouped catalog semantics, and audit
event shape. It remains non-enforcing and does not grant live permissions. Do
not start full capability enforcement, temporary approval flows, or live admin
grant management
directly from the rough capability lists in this document. Continue dedicated
planning/validation to capture all requirements and produce the canonical
enforcement vocabulary, resource selector model, grant lifecycle, migration
plan, audit schema, denial behavior, and admin UX. Brain should own the
admin/planning/control-plane surface for capabilities and audit, while
`codex-chat` enforces runtime checks at tools, adapters, output sends, and
subagent execution only after review.

Tim's capability-system decisions to carry into that planning session:

1. Capabilities are positive grants only. Do not introduce an explicit deny or
   block model in the first version; absence of a matching grant means the
   runtime fails closed.
2. Granting is inherent to possession for now: an actor, chat, channel, system
   process, or bundle holder that has a capability may grant that same
   capability to others, with audit records. Revisit narrower delegation rules
   only after the first model is operational.
3. Project/resource-level granularity is sufficient initially. Every resource
   or data action in the assistant workspace, and in future durable databases,
   should map to required capabilities at that resource/action level.
4. Chat- or channel-granted capabilities may be permanent. Expiration should be
   supported for temporary or time-boxed grants, but it is not mandatory for all
   chat/channel grants.
5. Admin actors receive capability CRUD capabilities automatically.
6. Start with a Tim admin super-bundle, but implement it as an ordinary bundle
   made up of explicit per-resource capabilities, not as a magical bypass.
7. Capability bundles should support bulk grants for normal users while still
   expanding into individual auditable capabilities.
8. Keep Phase 2 incomplete until the real Slack app is installed and live
   app-mention/DM/private-channel canaries pass.

Preliminary model sketch for planning only, not enforcement implementation:

```ts
type CapabilityGrant = {
  id: string;
  capabilityId: string; // e.g. "workspace.resource.read", "capability.grant"
  subject: { kind: "actor" | "chat" | "channel" | "bundle" | "system"; id: string };
  resource: { kind: "project" | "repo" | "slackChannel" | "telegramChat" | "database" | "artifact"; id: string };
  actions: Array<"read" | "search" | "write" | "post" | "dispatch" | "grant" | "revoke" | "audit">;
  source: { kind: "admin" | "bundle" | "chatApproval" | "migration" | "system"; id: string };
  grantedBy: string;
  expiresAt?: string;
  createdAt: string;
};

type CapabilityBundle = {
  id: string;
  name: string;
  description: string;
  grants: Array<Omit<CapabilityGrant, "id" | "subject" | "createdAt">>;
};
```

The runtime should evaluate requested data/tool/output operations by deriving a
required `{resource, action}` pair and matching it against positive grants from
the actor, current chat/channel, applicable bundles, and system/admin bootstrap
state. Future deny semantics, if ever needed, should be a deliberate later
extension rather than a hidden behavior in the first implementation.

- [x] Add a separate Brain admin **Capabilities** tab/section placeholder for
      read-only catalog, grant vocabulary, audit event shape, and explicit
      no-enforcement constraints.
- [x] Add the Brain-owned non-enforcing capability catalog/store/admin surface
      with Projects, CRM, Calendar, Slack, Todos, Finance, Health, and
      capability-admin groups; Projects group grants visibly imply child project
      capabilities. This is validation vocabulary, not live enforcement.
- [x] Add unified identity foundation rows for Tim, Telegram `253768951`,
      Slack addable/observed/signed-event identity support, proof metadata,
      communication channels, and a Tim owner/all bundle represented in the
      effective grant view.
- [ ] Define canonical capability IDs/descriptions for enforced runtime checks.
- [ ] Add admin write APIs for person/identity links, bundle/group/capability
      grants, revocations, and append-only mutation audit.
- [ ] Define bundle semantics for common trust levels while preserving
      individual auditable grants.
- [ ] Enforce checks at every runtime-owned tool call and output send.
- [ ] Add audit records for grants, checks, tool calls, outputs, and denials.
- [ ] Add temporary capability flow for chat/channel-scoped approvals.
- [ ] Replace long-term JSON capability state with a real durable store plan and
      migration path.
- [ ] Ensure subagents receive narrowed run context, not tokens or broad grants.

### Phase 4.5 — Slack channel/thread context hydration design gate

The detailed implementation plan for this slice is
`plans/2026-06-29-slack-channel-thread-context-design.md`. Tim has authorized
visible implementation now, with working Slack delivery preserved.

- [x] Record the Claude-like UX decision: existing threads are thread-first
      contexts; root channel mentions use bounded channel context and answer in
      the Slack thread attached to the invoking root message.
- [x] Specify channel mention context windows, thread mention context windows,
      explicit context controls, channel memory versus thread sessions, Slack
      API scopes/history reads, stored event history, fallback behavior,
      hydration algorithm, schema, privacy/isolation, subagent callback routing,
      telemetry, Brain admin controls, migration phases, canaries, and
      rollout/rollback.
- [x] Decide implementation order: do not start shadow-only; implement
      root-thread delivery plus source-scoped assist-mode hydration from the
      start, with source-event-only fallback.
- [x] Add tests/telemetry for source classification, root thread output targets,
      thread continuation, bounded channel/thread hydration, and isolation.
- [x] Add prompt-visible `HydratedSlackContext` plumbing with redaction,
      source labels, and no Slack token exposure.
- [x] Add Slack Web API history/replies reads through the runtime-owned adapter
      with mocked tests and bounded limits.
- [x] Add Brain admin manual/read-only Slack visibility canary rollup that records
      operator outcomes for root-thread replies, thread continuity, channel/thread
      hydration, second-channel isolation, DM/MPIM/private behavior, subagent
      callback routing, immediate reaction checks, and telemetry redaction while
      keeping Brain out of Slack message sending.
- [ ] Add optional public-channel history scopes/events after canaries confirm
      fallback behavior and Brain can show installed scopes/events.
- [ ] Add durable event journal, summaries, explicit cross-channel controls, and
      Brain admin policy UI.

### Phase 5 — Slack adapter depth and runtime-owned Slack tools

- [ ] Implement progress message updates from `ProgressEvent`s.
- [ ] Add selected interactive button clicks from progress/admin messages.
- [ ] Resolve Slack user/channel metadata through bounded adapter calls with
      cached display snapshots.
- [ ] Add Slack read tools for source context and selected channel reads.
- [ ] Add Slack write tools for source replies and explicit target posts.
- [ ] Add artifact upload/link support where output grants allow it.
- [ ] Keep Slack read/write tools runtime-owned and capability-checked; never
      pass raw Slack tokens to the main Codex process or subagents.

### Phase 6 — cross-surface company brain operations

- [ ] Allow Telegram-originated company-brain reads/searches over Slack when
      capability grants allow it.
- [ ] Allow Telegram-originated Slack posts only with explicit target routing and
      write grants.
- [ ] Add Slack-originated Telegram/admin notifications where appropriate and
      authorized.
- [ ] Add retrieval/index filtering by capability labels before model exposure.
- [ ] Add persisted summaries for Slack threads/channels and repeated topics.
- [ ] Add context compression policies for long company runs.

### Phase 7 — central server and scale-out subagents

- [ ] Centralize event ingestion, queueing, progress fanout, audits, and indexes.
- [ ] Add durable session registry with hibernation, scheduler wakeups, max
      active leases, and per-workspace/per-surface rate and cost limits.
- [ ] Support many subagent workers with per-run narrowed contexts.
- [ ] Persist run summaries, source summaries, and artifacts.
- [ ] Add retrieval/index maintenance jobs for Slack and Telegram history.
- [ ] Add operational dashboards for worker health, queue depth, stuck runs, and
      capability-denial rates through Brain, while preserving `codex-chat` as
      the runtime executor.
- [ ] Run live canaries with Slack-only, Telegram-only, and cross-surface tasks.

## Avoid

- Do not bolt Slack onto Telegram-shaped types.
- Do not run one global main context for unrelated conversations.
- Do not create immortal per-channel model contexts when hibernated
  conversation sessions and channel summaries suffice.
- Do not trust Slack ACLs alone; use runtime capabilities and audit checks.
- Do not expose Slack bot/user tokens to the main Codex prompt or subagents.
- Do not run long Codex turns inline in Slack event handlers; fast-ack and queue.
- Do not infer output routing implicitly when crossing surfaces; require explicit
  `OutputTarget`s and write capabilities.
- Do not give subagents broad company-wide access by default.
- Do not keep company-mode capability state in JSON long-term.
- Do not let prompt instructions be the only enforcement layer for capabilities.
- Do not make Telegram a privileged bypass; represent privilege as explicit
  admin/personal grants.
- Do not index or summarize private channels without capability labels that are
  enforced before retrieval results reach the model.

## Open questions

- Which durable store should back capability grants, audit records, and channel
  mappings for the first production version?
- Which Slack installation model is needed first: single workspace, Enterprise
  Grid, or multiple independent workspaces?
- Should Slack channel grants be bootstrapped from Slack membership/admin data or
  only from explicit dashboard approvals?
- What approval threshold is required before Telegram-originated requests can
  post into Slack channels?
- How should company-brain summaries age, expire, and get revalidated against
  changed channel membership or revoked grants?
