# Slack Channel and Thread Context Hydration Design

Date: 2026-06-29
Status: implementation approved / active runtime behavior
Owners: Brain control plane, codex-chat Slack runtime adapter
Parent plan: [`plans/slack-company-brain-runtime.md`](./slack-company-brain-runtime.md)

## Implementation decision and safety notice

Tim has decided not to start with a shadow-only rollout. Implement the visible
Slack behavior from the start while preserving the already-working Slack
inbound/outbound path and Telegram behavior. The active product decision is
Claude-like Slack UX:

1. Root Slack channel `app_mention` events reply in a Slack thread attached to
   the invoking root message (`thread_ts = event.ts`).
2. Mentions already inside an existing Slack thread continue in that source
   thread (`thread_ts = event.thread_ts`).
3. Root channel mentions hydrate a safely bounded, redacted recent source-channel
   window. Existing thread mentions hydrate safely bounded, redacted source-thread
   replies.
4. Hydration is prompt-visible in the main loop, not shadow-only, but it must
   fail closed to source-event-only context when Slack scopes, membership, rate
   limits, or other API errors prevent history reads.
5. Subagents and late callbacks must persist and reuse the originating Slack
   output target so root-channel work returns to the attached root thread and
   thread-originated work returns to the same thread.
6. Telemetry must record metadata-only routing/context decisions without storing
   raw Slack text in telemetry.

Guardrails remain: fast-ack Slack Events, keep Slack tokens out of prompts and
subagents, bound all history reads, redact prompt context, keep source channel
and thread labels attached, do not read/post across Slack boundaries without an
explicit future control, and do not break Telegram.

## Research inputs and UX takeaways

The design borrows UX lessons from Anthropic/Claude Slack surfaces while keeping
Brain/codex-chat's policy and Tim's root-thread delivery behavior.

Primary inputs checked on 2026-06-29:

- Claude Code in Slack docs: <https://code.claude.com/docs/en/slack>
- Claude Tag announcement: <https://www.anthropic.com/news/introducing-claude-tag>
- Claude and Slack product note: <https://claude.com/blog/claude-and-slack>
- Slack Events API: <https://docs.slack.dev/apis/events-api/>
- Slack message retrieval guide: <https://docs.slack.dev/messaging/retrieving-messages/>
- Slack `conversations.history`: <https://docs.slack.dev/reference/methods/conversations.history/>
- Slack `conversations.replies`: <https://docs.slack.dev/reference/methods/conversations.replies>
- Slack 2025 history/replies rate-limit changelog:
  <https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/>

Observed Claude-like UX principles to adapt:

1. **Thread mentions use thread context first.** Claude Code in Slack describes
   a thread mention as gathering the thread conversation. Brain should treat an
   existing Slack thread as the most specific context boundary.
2. **Root channel mentions use recent channel context.** Claude Code in Slack
   describes direct channel mentions as looking at recent channel messages.
   Brain should hydrate a bounded, source-labelled channel window for root
   channel mentions when scopes/grants allow it.
3. **The assistant is a channel participant, not a private singleton.** Claude
   Tag emphasizes a shared channel-facing assistant identity. Brain should make
   channel memory visible, shared, and auditable within the channel's capability
   boundary.
4. **Memory is scoped.** Claude Tag describes access, memories, tools, and logs
   as scoped by administrator-defined channel identities. Brain should maintain
   separate channel memory, thread sessions, DM sessions, and private-channel
   summaries with hard source labels.
5. **DMs stay private.** Claude's Slack surfaces support DMs separately from
   shared channel work. Brain must not silently read or export channel memory in
   DMs without explicit controls.
6. **Admins control access, spend, and logs.** Brain admin must expose channel
   allowlists, history-read policy, stored-history retention, token/context
   budgets, canary state, and redacted audit trails.
7. **Slack permissions are necessary but insufficient.** Slack app membership,
   scopes, and user/channel ACLs shape what the app can see, but Brain still
   needs its own capability checks and output/export grants because an AI agent
   can combine data and post across surfaces.
8. **Asynchronous work needs stable routing.** Claude Code in Slack posts status
   and completion in Slack. Brain/codex-chat must persist output targets so
   subagents, loops, and late callbacks return to the originating channel,
   thread, DM, or explicit target after hibernation/restart.

Brain/codex-chat deviations from Claude where Tim has made a product decision:

- Brain's root-channel default is now **root-thread delivery**: a root channel
  mention hydrates recent channel context and posts the answer in a Slack thread
  attached to the invoking message.
- Brain adopts a **source-specific context selection** default: if the source
  event is already in a Slack thread, hydrate/reply within that thread; if the
  source event is a root channel mention, hydrate the channel window and reply in
  the attached root thread.
- Brain must preserve Telegram/codex-chat semantics and subagent routing; Slack
  context is another adapter/context source, not a replacement for the shared
  runtime model.

## Goals

### Product goals

- Make Brain feel like a Slack-native company-brain participant that understands
  the immediate channel or thread without requiring users to restate recent
  context.
- Preserve Tim's root-thread default for root Slack mentions: answers to root
  channel mentions should post in a Slack thread attached to the invoking
  message.
- Make existing Slack threads first-class side sessions: if a user mentions or
  replies to Brain inside a thread, Brain should use that thread and keep output
  there.
- Make context boundaries understandable to humans: every answer should be able
  to explain whether it used only the user request, the current thread, recent
  channel messages, a channel summary, a stored event journal, an explicit
  cross-channel read, or no extra context.
- Let Brain admin manage channel opt-in, scopes, retention, context budgets,
  memory/session behavior, and canary rollout without editing code.
- Enable future ambient/channel memory and proactive follow-up in a controlled,
  auditable way without turning every Slack channel into an immortal live model
  context.

### Engineering goals

- Introduce a single context hydrator boundary that can draw from Slack Web API
  reads, recorded event history, cached summaries, and explicit search tools.
- Keep Slack API tokens out of prompts, subagents, and arbitrary tools; only the
  runtime-owned Slack adapter/hydrator can call Slack.
- Label every Slack-derived snippet, summary, embedding, artifact, and callback
  with source and capability metadata before prompt exposure.
- Make all retrieval fail closed through explicit capability checks and source
  filters.
- Persist enough Slack event/session/output metadata to route subagent callbacks
  correctly after hibernation, restart, or delayed completion.
- Add metadata-first telemetry that proves continuity and isolation without
  storing raw Slack text in telemetry.
- Support a staged migration from the current adapter to channel/thread
  hydration without breaking current Slack delivery.

### Operations goals

- Let Brain admin show which channels have history hydration enabled, which
  scopes are installed, which channels are canaried, and what the current
  fallback mode is.
- Provide clear rollback levers: disable hydration, disable event journaling,
  disable summaries, disable explicit cross-channel reads, or revert visible
  routing independently.
- Provide canary scripts/checklists that cover public channels, private
  channels, DMs, MPIMs, channel root mentions, existing threads, subagents, and
  telemetry.

## Non-goals

- Do not add broad workspace-wide Slack search by default.
- Do not store all Slack messages for all channels.
- Do not use Slack display names, channel names, or membership snapshots as the
  sole authorization source.
- Do not create one global Brain memory that mixes public channels, private
  channels, DMs, MPIMs, Telegram, and dashboard state.
- Do not pass Slack bot/user tokens to Codex prompts, subagents, or external
  tools.
- Do not use prompt instructions as the enforcement layer for privacy or
  capability controls.
- Do not backfill historical Slack data except through a separately approved,
  rate-limit-aware, retention-aware, per-channel plan.
- Do not make Brain proactive/ambient in channels until passive hydration,
  session routing, capability enforcement, and admin controls are operational.
- Do not depend on Slack's current non-Marketplace history/replies rate limits
  remaining generous; design for tight limits and graceful degradation.

## Decision record

### DR-001: Source-specific context selection, root-thread delivery

**Decision:** Use the source-specific Slack boundary for context and delivery.
Existing thread mentions hydrate/reply in the source thread. Root channel
mentions hydrate recent channel context and reply in a Slack thread attached to
the invoking root message (`thread_ts = event.ts`).

**Rationale:** Claude-like Slack UX teaches that thread mentions use thread
context and direct channel mentions can use recent channel messages. Tim's
implementation decision is to keep root channel asks visible as roots while
placing Brain's answer and follow-ups in the attached Slack thread.

**Implementation impact:**

- Existing thread mention: `conversationKey = slack:team:{T}:channel:{C}:thread:{thread_ts}`;
  default `OutputTarget.threadId = thread_ts`; hydrate `conversations.replies`.
- Root channel mention: `conversationKey = slack:team:{T}:channel:{C}:thread:{message_ts}`;
  default `OutputTarget.threadId = message_ts`; hydrate bounded
  `conversations.history` for the source channel.
- Hydration is assist-mode from the first implementation, with source-event-only
  fallback when history is unavailable.

**Rollback:** Disable context hydration to source-event-only if needed. Reverting
root-thread delivery would be a visible product rollback and must preserve
existing thread callbacks and Telegram behavior.

### DR-002: Channel memory is not a live model session

**Decision:** A Slack channel has ambient memory, a source-labelled event journal,
retrieval summaries, and channel-level policy. It is not a permanently running
main-loop model context. A channel gets a live `ConversationSession` only when a
root mention, command, monitor, digest, or explicitly leased ambient behavior
requires one.

**Rationale:** Claude Tag-style channel memory is useful, but a channel can be
high volume and long lived. Brain must avoid immortal contexts, uncontrolled
cost, and cross-topic drift.

**Implementation impact:**

- Channel memory records are durable and compacted.
- Channel sessions are resumable/hibernatable runtime records keyed by channel.
- Thread sessions are distinct runtime records keyed by channel + `thread_ts`.
- Hydration chooses bounded windows and summaries, not unbounded live context.

### DR-003: Thread sessions inherit only safe channel summaries by default

**Decision:** Thread prompts include thread context first. They may include a
small channel summary or recent channel window only when the policy says the
thread needs channel context and the source channel grants allow it. Thread
memory is not automatically promoted back into channel memory unless explicitly
summarized or policy-compacted with source attribution.

**Rationale:** Threads are side conversations. They need enough channel context
to understand references, but private or detailed thread work should not leak
back into the channel.

### DR-004: Explicit controls beat inference for cross-boundary context

**Decision:** Reading outside the source thread/channel, exporting summaries,
posting outside the source output target, or including old stored memory requires
explicit user/admin controls and capability checks.

**Rationale:** Slack channels often have different audiences. A model can combine
information in ways Slack itself does not police. Controls must be visible and
audited.

### DR-005: One hydrator shape, multiple backing sources

**Decision:** Slack context hydration returns one `HydratedSlackContext` shape
regardless of whether text came from Events API payloads, `conversations.history`,
`conversations.replies`, stored event journal, summaries, or explicit search.

**Rationale:** The main loop, subagents, telemetry, and tests should not depend
on the source-specific retrieval mechanics. Source labels and policy metadata
must travel with the text either way.

### DR-006: Brain admin owns policy; codex-chat owns enforcement/execution

**Decision:** Brain admin stores and displays rollout policy, allowlists,
retention knobs, canary results, and human controls. codex-chat enforces runtime
normalization, Slack API calls, source labels, prompt hydration, output target
routing, and subagent callback routing.

**Rationale:** Brain is the control plane. codex-chat is the runtime adapter and
execution engine. Splitting these roles avoids recreating admin surfaces in the
runtime while keeping security enforcement near tool execution.

### DR-007: History reads must degrade gracefully under Slack limits

**Decision:** The default hydrator must assume history/replies calls can be
missing scopes, denied by membership, rate-limited, or too small to satisfy the
request. The user-facing answer should transparently state what context was
available and should never guess from another channel.

**Rationale:** Slack documents meaningful access and rate-limit variation for
history/replies methods. Brain's Slack app may be internal, marketplace, or
non-marketplace over time, and limits/scopes can differ by installation.

## Terminology

- **Source event:** The Slack event that triggered the current turn.
- **Root channel mention:** An `app_mention` whose Slack event has no source
  `thread_ts` distinct from its own `ts`.
- **Existing thread mention:** A Slack message where `thread_ts` is present and
  points to the parent/root thread message; for replies, `thread_ts !== ts`.
- **Root-attached thread:** Target behavior where a root channel message's own `ts`
  is used as `thread_ts` so Brain replies in the Slack thread attached to the
  invoking message.
- **Channel context window:** Bounded set of recent channel messages around or
  before the source event, excluding unrelated threads unless policy requests
  thread summaries.
- **Thread context window:** Bounded set of messages in the source thread,
  usually fetched via event journal or `conversations.replies`.
- **Channel memory:** Durable, source-labelled summaries/indexes/event metadata
  for a channel, governed by retention and grants.
- **Thread session:** Runtime session keyed by channel + thread timestamp;
  handles side conversations, subagents, and callbacks for that thread.
- **Hydration:** Selecting, fetching, filtering, redacting, budgeting, and
  packaging Slack context for a specific run.
- **Stored event history:** Allowlisted append-only record of Slack events the
  app was permitted to receive and retain, with retention and compaction.
- **Explicit context control:** A user/admin action or prompt directive that
  changes context policy, such as "use only this thread" or "include #eng last
  two hours".

## Current state and boundary to preserve

### Brain-owned surfaces

- Brain owns the Clerk-protected admin/control-plane surface at
  `https://brain.decisive-outcomes.com/admin`.
- Brain renders the codex-chat-owned no-secret Slack manifest contract.
- Brain writes Slack runtime secrets through write-only env controls.
- Brain is expected to own future channel allowlists, context policy knobs,
  memory retention controls, canary dashboards, and audit views.

### codex-chat-owned runtime

- codex-chat owns Slack Events API verification, fast ack, idempotency,
  normalization, queueing, `ActorContext`, `OutputTarget`, runtime events,
  renderer/sends, subagent dispatch, and telemetry.
- Current code still has a planned correction: root public-channel `app_mention`
  events synthesize a thread (`threadTs = event.ts`) instead of using the root
  channel as the default output target. This design documents the target
  behavior, but does not change it.
- Current manifest covers app mentions, write, and private/DM/MPIM message
  scopes/events. Public-channel history reads and ambient public-channel message
  journaling require additional scopes/events and a reinstall.

### Must-not-break guardrails

- The public Slack Events URL remains
  `https://brain.decisive-outcomes.com/api/slack/events`.
- Slack signature verification remains in codex-chat, using raw request body and
  Slack signature headers forwarded unchanged by Brain/Caddy.
- Slack event handling remains fast-ack + enqueue; no long model or history work
  should run inside the HTTP handler.
- Existing reply sending through `SlackGateway.sendText` remains the renderer; it
  must use the normalized/stored `OutputTarget` and never invent a fallback
  channel.
- Telemetry must remain metadata-first and must not persist raw Slack message
  bodies by default.

## Target user experience

### Root public/private channel mention

User posts in `#project`:

```text
@Brain what did we decide about the release blocker?
```

Target behavior:

1. Brain recognizes this as a root channel mention.
2. Brain creates/resumes the root-attached thread session for the invoking message in `#project`.
3. Brain hydrates a bounded recent channel window and/or channel summary,
   subject to policy/scopes/grants.
4. Brain answers in the Slack thread attached to the invoking root message
   (`thread_ts = source message ts`) by default.
5. The answer can include a small context note, for example: "I used recent
   messages in #project from the last 45 minutes." The exact wording is a UX
   detail, but telemetry must record the selected context source.
6. If history is unavailable, Brain says so and answers from the mention only or
   asks for the needed context.

### Existing thread mention

User replies in an existing Slack thread:

```text
@Brain can you turn this thread into a checklist?
```

Target behavior:

1. Brain recognizes `thread_ts` as an existing source thread.
2. Brain creates/resumes the thread session.
3. Brain hydrates thread root + recent/all bounded replies first.
4. Brain optionally includes a small channel summary only if policy permits and
   the thread question requires channel-level background.
5. Brain replies in the same thread.
6. Subagents and late callbacks return to the same thread.

### Explicit thread request from channel

User posts in the channel:

```text
@Brain take this to a thread and investigate the deploy failure.
```

Target behavior:

1. Initial event is still a root channel mention.
2. Brain may post a short channel acknowledgement or create a thread only after
   the renderer has a valid Slack timestamp for a parent message.
3. Runtime records an explicit routing decision and creates a thread session.
4. Subsequent progress/final replies go to that thread.
5. A channel summary is posted only if requested/authorized.

### DM

User DMs Brain:

```text
Can you summarize what happened in #project today?
```

Target behavior:

1. Brain resumes the DM session.
2. Brain does not read `#project` by default just because the user named it.
3. If the actor has an explicit read grant and the channel is selected, Brain
   can ask for confirmation or use an approved context control.
4. If no grant/control exists, Brain explains that it can only use the DM
   context unless the user/admin grants access.
5. The response stays in DM unless an explicit output target is authorized.

### Private channel

Root mentions in private channels behave like public channel mentions, but all
source labels, retention, summaries, and export controls must reflect private
visibility. Private-channel content is never eligible for public-channel output
or Telegram output without an explicit export grant.

### MPIM/group DM

MPIMs use conversation-level continuity by default. Thread-level continuity only
applies when Slack supplies a `thread_ts`. Membership snapshots help explain the
conversation but do not grant cross-channel permissions.

## Channel mention context windows

A channel mention context window is the bounded context Brain may use when the
source event is a root channel mention. It is a retrieval policy; delivery remains the normalized stored `OutputTarget`
(the attached root thread for root channel mentions).

Default planning shape:

- **Anchor:** the source event timestamp (`messageTs`) and source channel ID.
- **Direction:** look backward from the source event by default; include the
  source event itself; optionally include a tiny forward window only for delayed
  queued processing if messages arrived before the run actually started and the
  policy explicitly allows it.
- **Count cap:** start with a small cap such as 15 recent channel messages, then
  make this Brain-admin configurable.
- **Time cap:** start with a short cap such as 30-60 minutes, then make this
  Brain-admin configurable per channel.
- **Token cap:** reserve a fixed prompt budget for channel context, separate
  from the user request, thread context, and durable summaries.
- **Thread exclusion:** do not pull every reply from unrelated Slack threads in
  the channel window. Channel windows may include root messages and explicit
  thread summary stubs, but full thread replies require an explicit thread
  source or explicit include control.
- **Source priority:** use event journal first when enabled and fresh; otherwise
  use `conversations.history` when scopes, membership, capability grants, and
  rate budgets allow; otherwise fall back to a channel summary or source event
  only.
- **Visibility:** source labels must mark the channel, time range, message count,
  and whether the context came from API history, event journal, or summary.

Channel context is appropriate for questions like "what did we decide above?"
or "summarize the recent discussion" in the same channel. It is not appropriate
for DMs, other channels, private-channel export, or old history unless the user
and Brain admin controls explicitly request and authorize that broader context.

## Thread mention context windows

A thread mention context window is the bounded context Brain may use when the
source event is already inside a Slack reply thread. This is the primary meaning
of the thread-first default for context selection.

Default planning shape:

- **Anchor:** source channel ID plus `thread_ts`.
- **Thread root:** include the root message when available because it often names
  the problem, incident, PR, customer, or decision.
- **Replies:** include replies in chronological order up to the configured
  message/time/token caps.
- **Source event:** always include the user's mention/reply even if truncation
  drops other messages.
- **Large threads:** keep root + recent replies + existing thread summary; mark
  the context truncated with a reason.
- **Parent channel context:** do not include recent channel messages by default
  unless policy says a small channel summary is useful and allowed, or the user
  explicitly asks for channel context.
- **Source priority:** use event journal if enabled and complete enough;
  otherwise use `conversations.replies`; otherwise use source event plus any
  existing thread summary.
- **Delivery:** thread context windows imply thread output for thread-originated
  work; they do not authorize posting thread details back to the channel.

Thread context is appropriate for bug triage, implementation discussions,
customer escalations, or side investigations that already have a Slack thread.
When a thread produces a channel-wide decision, Brain should post or propose an
attributed channel summary only through an explicit output/export control.

## Context controls

The implementation should support controls in three layers: prompt language,
Slack UI/actions later, and Brain admin policy. The first implementation can
support only prompt-language controls and admin defaults, but the data model
should anticipate UI controls.

### User-facing prompt controls

These phrases should map to explicit context policies after normalization and
capability checks:

| Control | Source surfaces | Effect | Requires |
| --- | --- | --- | --- |
| "use only this thread" | thread | Hydrate source thread only; suppress channel summary/window | source thread read grant |
| "use only this message" | any | No history; use event text and attachments only | source message read grant |
| "use recent channel context" | channel/thread | Hydrate default channel window | source channel read grant |
| "use the last N messages" | channel/thread | Set message-count window up to admin max | source channel/thread read grant |
| "use the last N minutes/hours" | channel/thread | Set time-bounded window up to admin max | source channel/thread read grant |
| "include #channel" | any | Add explicit additional channel context | read grant for named channel + export/use grant |
| "include this thread" | channel/DM | Add explicit thread context by permalink/ts | thread read grant + export/use grant |
| "don't use channel history" | channel/thread | Disable channel window and summary for this turn | none beyond source event |
| "summarize this thread back to the channel" | thread | Post an attributed summary to channel | thread read + channel write/export grant |
| "send the result to #channel" | any | Explicit output target | source read + target write/export grant |
| "forget this thread" | thread/admin | Queue retention deletion/compaction action | retention/admin capability |
| "refresh context" | any | Bypass cached summary if rate limits allow | source read grant + rate budget |

### Brain admin controls

Brain admin should expose:

- workspace-level Slack context mode:
  - `off`: no hydration beyond event text;
  - `assist`: hydrate source channel/thread into prompts;
  - `ambient`: future proactive/summary modes, disabled initially.
- per-channel hydration allowlist.
- per-channel stored-event-history allowlist.
- per-channel memory retention class.
- default channel window count/time/token budget.
- default thread window count/time/token budget.
- max additional channels per turn.
- max Slack history calls per turn and per channel/minute.
- fallback text policy for missing scopes/rate limits.
- whether root channel delivery is root-attached-thread behavior (current
  decision) or a future explicitly approved alternative.
- canary channel list and canary status.
- channel summary promotion controls.
- export controls between private/public/DM/Telegram/dashboard.
- redacted telemetry retention.

### Slack UI controls later

After interactivity is added, Brain can render buttons/dropdowns such as:

- Use thread only
- Include recent channel context
- Retry with more context
- Move to thread
- Summarize thread to channel
- Do not store this turn
- Open in Brain admin
- Approve one-time channel read
- Approve one-time target post

These controls must create auditable temporary grants or context policies, not
hidden prompt-only behavior.

## Channel memory versus thread session model

### Runtime keys

```ts
type SlackChannelConversationKey = {
  surfaceKind: "slack";
  enterpriseId?: string;
  teamId: string;
  channelId: string;
};

type SlackThreadConversationKey = SlackChannelConversationKey & {
  threadTs: string;
};

type SlackDmConversationKey = {
  surfaceKind: "slack";
  enterpriseId?: string;
  teamId: string;
  channelId: string; // D... Slack DM conversation ID
};

type SlackMpimConversationKey = {
  surfaceKind: "slack";
  enterpriseId?: string;
  teamId: string;
  channelId: string; // G... or Slack-reported mpim conversation ID
};
```

### Channel memory record

A channel memory record stores durable context policy and compacted knowledge for
one Slack conversation container.

Responsibilities:

- source-labelled channel summaries;
- high-level topic/state summaries;
- event-journal checkpoints;
- last hydration/canary status;
- channel-level capability/resource labels;
- retention class;
- context budget defaults;
- ambient/proactive leases if ever enabled;
- references to child thread sessions and thread summaries.

Non-responsibilities:

- not a raw, unbounded transcript;
- not an always-running model context;
- not authorization truth;
- not globally retrievable without source filters.

### Thread session record

A thread session stores a side conversation and active/hibernated runtime state
for one Slack thread.

Responsibilities:

- thread `conversationSessionId`;
- source channel labels;
- output target with `thread_ts`;
- parent channel memory pointer;
- run/subagent/callback ownership;
- thread summary and artifacts;
- explicit promotion/export status;
- expiration/archival state.

Non-responsibilities:

- not a replacement for the channel session;
- not automatically visible to other channels;
- not automatically posted back to the channel;
- not a broad channel-history grant.

### Session/memory interaction rules

1. Root channel mention creates/resumes channel session and may read channel
   memory.
2. Existing thread mention creates/resumes thread session and may read thread
   memory first.
3. Thread session may read channel summary/window only when the channel policy
   and grants allow it.
4. Thread decisions become channel memory only through:
   - explicit "summarize back to channel" output;
   - admin-approved compaction policy that writes an attributed thread summary;
   - an explicit future ambient policy.
5. Channel memory can reference thread summaries, but those references retain
   thread/source labels and export restrictions.
6. DM sessions cannot use channel memory without explicit channel selection and
   grants.
7. MPIM/private-channel sessions cannot share memory with public channels unless
   export is explicitly authorized.

## Slack API scopes and history reads

### Current adapter scopes/events

Current required bot scopes:

- `app_mentions:read`
- `chat:write`
- `im:history`
- `im:read`
- `mpim:history`
- `mpim:read`
- `groups:history`
- `groups:read`

Current subscribed bot events:

- `app_mention`
- `message.im`
- `message.mpim`
- `message.groups`

These support current app mentions, DMs, MPIMs, private-channel messages where
invited, and outbound writes.

### Additional scopes/events for public channel hydration

For bounded public channel history reads and public ambient event journaling,
plan for:

- `channels:history` — read public channel messages the bot/app can access.
- `channels:read` — resolve public channel metadata/listing when needed.
- `message.channels` bot event — receive public channel message events where the
  bot is a member and event subscription/scopes permit.

These additions require Slack manifest update and workspace reinstall. They
should be introduced only after admin controls and canary plan exist.

### Optional/future scopes/events

Only request when a concrete feature needs them:

- `users:read` for user display metadata cache.
- `reactions:write` for status markers.
- file scopes for upload/link previews if artifacts require native file upload.
- interactive components request URL and actions for context buttons.
- Slack Enterprise/Grid/admin APIs only after a separate Enterprise plan.

### Slack Web API methods

Hydrator-owned methods:

- `conversations.history`
  - Source channel recent window.
  - Single-message fetch by `ts` when reconstructing a root event.
  - Bounded pagination only within admin max.
- `conversations.replies`
  - Source thread root + replies.
  - Bounded pagination only within admin max.
- `conversations.info`
  - Advisory channel metadata when needed.
- `conversations.members`
  - Advisory membership snapshot only when explicitly useful and permitted.
- `users.info` / `users.profile.get`
  - Advisory display metadata only if scope exists.
- `chat.postMessage` / `chat.update`
  - Output renderer only, not hydrator.

### Rate-limit posture

Slack has changed limits for `conversations.history` and `conversations.replies`
for some non-Marketplace apps. The implementation must:

- treat rate limits as a normal fallback path;
- inspect and honor `Retry-After`;
- maintain per-method/team/channel rate budgets;
- avoid naive pagination/backfill;
- default to small windows;
- prefer event journal/summaries when enabled;
- cache safe, source-labelled summaries;
- show Brain admin when history reads are unavailable or throttled;
- never retry history reads aggressively inside Slack event handling.

### API call placement

Do not call Slack history APIs in the HTTP request handler. Flow:

1. HTTP handler verifies signature.
2. HTTP handler fast-acks and enqueues normalized event metadata.
3. Worker/session runtime derives key, actor, grants, output target.
4. Hydrator runs in worker context with timeout/rate budget.
5. Prompt hydration happens only after source filtering and redaction.
6. Renderer sends output through stored `OutputTarget`.

## Stored event history

### Why store event history

Stored event history can provide:

- lower-latency context for high-value channels;
- fewer repeated `conversations.history` calls;
- source-attributed summaries;
- canary/audit evidence;
- continuity across restarts;
- compacted channel memory for long-running projects.

### Why not store everything

Slack conversations can include sensitive data. Storing every message in every
channel would increase privacy risk, compliance burden, and cost. Event history
must be opt-in, minimal, source-labelled, and retention-bound.

### Event history modes

| Mode | Meaning | Default? |
| --- | --- | --- |
| `none` | Do not store ambient messages beyond current event metadata | yes |
| `triggered_only` | Store messages where Brain is mentioned or DMed, plus replies it sends | safe early default |
| `allowlisted_events` | Store ambient subscribed events in allowlisted channels | later canary |
| `summary_only` | Discard raw text after compaction; retain source-labelled summaries | preferred durable mode |
| `audit_metadata_only` | Store metadata/counters without raw text | telemetry default |

### Append-only event journal shape

```ts
type SlackEventJournalEntry = {
  id: string;
  source: "slack";
  enterpriseId?: string;
  teamId: string;
  channelId: string;
  channelType: "channel" | "group" | "im" | "mpim" | string;
  threadTs?: string;
  messageTs: string;
  eventTs?: string;
  eventId?: string;
  eventType: string;
  subtype?: string;
  actorSlackUserId?: string;
  botId?: string;
  textRef?: {
    storage: "none" | "encrypted_blob" | "redacted_inline" | "summary_only";
    blobId?: string;
    redactedText?: string;
    tokenCount?: number;
    hash?: string;
  };
  sourceLabels: SlackSourceLabels;
  capabilityLabels: string[];
  retentionClass: "none" | "ephemeral" | "short" | "standard" | "long";
  receivedAt: string;
  expiresAt?: string;
  redactionVersion: string;
};
```

### Retention defaults

Suggested initial defaults, subject to Tim/admin confirmation:

- Triggered event raw text: retain as part of normal run/session state according
  to existing run retention policy.
- Shadow hydration raw windows: do not persist; log metadata only.
- Event-journal raw text for allowlisted channel: 7-30 days maximum for early
  canaries, encrypted at rest if a durable store supports it.
- Durable memory: compact to source-labelled summaries; discard raw windows.
- Telemetry: metadata-only; no raw Slack text.

### Compaction rules

- Compact by source channel/thread and time window.
- Preserve source labels and capability labels on every summary chunk.
- Store summary provenance: input message IDs/range, compactor version,
  retention class, model/provider if applicable, and redaction version.
- Never merge private-channel and public-channel content into one unlabelled
  summary.
- Never merge multiple private channels into one unlabelled summary.
- Workspace-wide digests must be collections of attributed summaries, not a
  single prompt blob.

## Hydrated context contract

### Type sketch

```ts
type SlackSourceLabels = {
  surface: "slack";
  enterpriseId?: string;
  teamId: string;
  channelId: string;
  channelType: "channel" | "group" | "im" | "mpim" | string;
  threadTs?: string;
  messageTs?: string;
  eventId?: string;
};

type SlackHydrationSource =
  | "source_event"
  | "events_api_payload"
  | "web_api_history"
  | "web_api_replies"
  | "event_journal"
  | "channel_summary"
  | "thread_summary"
  | "explicit_search"
  | "admin_seed"
  | "none";

type HydratedSlackMessage = {
  id: string;
  sourceLabels: SlackSourceLabels;
  source: SlackHydrationSource;
  roleHint: "requester" | "participant" | "brain" | "bot" | "system" | "unknown";
  slackUserId?: string;
  displayNameSnapshot?: string;
  text: string;
  redacted: boolean;
  messageTs?: string;
  threadTs?: string;
  permalink?: string;
  tokenEstimate: number;
  includedBecause: string;
};

type HydratedSlackSummary = {
  id: string;
  sourceLabels: SlackSourceLabels;
  source: "channel_summary" | "thread_summary";
  summaryText: string;
  timeRange?: { oldest?: string; latest?: string };
  messageCount?: number;
  tokenEstimate: number;
  provenanceIds: string[];
  capabilityLabels: string[];
};

type HydratedSlackContext = {
  request: {
    correlationId: string;
    runId?: string;
    conversationSessionId: string;
    retrievalReason: string;
    policyId: string;
  };
  sourceLabels: SlackSourceLabels;
  conversation: {
    kind: "channel" | "thread" | "dm" | "mpim" | "private_channel";
    conversationKey: string;
    parentChannelKey?: string;
  };
  selectedSources: SlackHydrationSource[];
  messages: HydratedSlackMessage[];
  summaries: HydratedSlackSummary[];
  denied: HydrationDenial[];
  fallbacks: HydrationFallback[];
  budget: {
    maxMessages: number;
    maxTokens: number;
    usedTokens: number;
    truncated: boolean;
    truncationReason?: string;
  };
  apiUsage: {
    conversationsHistoryCalls: number;
    conversationsRepliesCalls: number;
    rateLimited: boolean;
    retryAfterSec?: number;
  };
  checks: {
    capabilityCheckIds: string[];
    privacyCheckIds: string[];
    redactionVersion: string;
  };
};

type HydrationDenial = {
  code:
    | "missing_scope"
    | "missing_membership"
    | "capability_denied"
    | "export_denied"
    | "private_to_public_denied"
    | "ambiguous_target"
    | "rate_limited"
    | "history_disabled"
    | "retention_expired";
  resource: SlackSourceLabels | Record<string, unknown>;
  userVisible: boolean;
  message?: string;
};

type HydrationFallback = {
  code:
    | "source_event_only"
    | "event_journal_only"
    | "summary_only"
    | "no_thread_history"
    | "no_channel_history"
    | "rate_limit_degraded"
    | "dm_requires_explicit_channel";
  detail: string;
};
```

### Prompt packaging rules

Before context reaches a prompt:

1. Filter by source labels and capability labels.
2. Redact secrets and Slack tokens using existing/no-secret patterns plus a
   redaction version.
3. Sort messages chronologically within each context section.
4. Group by source boundary: request, thread messages, channel window, summaries,
   explicit additional sources.
5. Include context provenance header with channel/thread IDs redacted or
   human-readable according to target policy.
6. Include a short system/developer instruction that context snippets are
   untrusted user content and may contain instructions from other Slack users.
7. Do not include denied context text; include only safe denial metadata if it
   helps the assistant explain limitations.

Suggested prompt section order:

1. Source event/request.
2. Current thread context, if source is thread.
3. Recent channel context, if source is root channel or explicitly enabled for
   thread.
4. Source channel summary.
5. Explicit additional contexts, each separately labelled.
6. Relevant durable memory summaries, each separately labelled.
7. Denials/fallbacks, if user-visible.

## Context hydration algorithm

### High-level flow

```text
normalize Slack event
  -> derive actor/context/output target
  -> derive conversation key (channel/thread/DM/MPIM)
  -> derive retrieval reason and explicit controls
  -> load Brain/codex-chat context policy
  -> compute required capabilities
  -> run capability checks
  -> choose source plan
  -> fetch from source event/event journal/API/summaries within budgets
  -> redact + label + filter
  -> assemble HydratedSlackContext
  -> emit telemetry
  -> inject prompt context when source-scoped hydration succeeds
  -> fall back to source-event-only context when hydration fails
  -> renderer sends output only to stored OutputTarget
```

### Detailed algorithm

#### Step 0: Inputs

Inputs to the hydrator:

- normalized `UserEvent` from codex-chat;
- `ActorContext`;
- `OutputTarget`;
- `ConversationKey`;
- `conversationSessionId`;
- source Slack metadata;
- explicit context controls parsed from text/UI/admin;
- Brain policy snapshot;
- capability grant snapshot;
- rate budget snapshot;
- token/context budget.

#### Step 1: Classify source conversation

```ts
function classifySlackSource(meta): SlackSourceKind {
  if (meta.channelType === "im") return "dm";
  if (meta.channelType === "mpim") return "mpim";
  if (meta.threadTs && meta.threadTs !== meta.messageTs) return "thread";
  if (meta.channelType === "group") return "private_channel_root";
  if (meta.channelType === "channel") return "public_channel_root";
  return "unknown_conversation";
}
```

Target classification rules:

- A source reply inside a thread is always `thread`.
- A root message with `thread_ts === ts` is treated as root unless Slack/event
  semantics prove it is a parent thread event; do not force thread just because
  `thread_ts` equals `ts`.
- `app_mention` in a channel with no source thread is `public_channel_root` or
  `private_channel_root` by channel type.
- DMs and MPIMs are conversation containers.

#### Step 2: Parse explicit context controls

Controls can come from:

- normalized prompt text;
- future Slack button/action payload;
- Brain admin default;
- channel policy override;
- temporary approval.

Control parser must return structured directives, not direct access:

```ts
type SlackContextDirective =
  | { kind: "source_only" }
  | { kind: "thread_only" }
  | { kind: "recent_channel"; count?: number; durationMinutes?: number }
  | { kind: "include_channel"; channelRef: string; count?: number; durationMinutes?: number }
  | { kind: "include_thread"; channelRef?: string; threadTsOrPermalink: string }
  | { kind: "no_history" }
  | { kind: "summarize_to_channel" }
  | { kind: "explicit_output"; targetRef: string }
  | { kind: "refresh_context" };
```

The parser must not grant access. The policy engine converts directives to
required checks.

#### Step 3: Build source plan

Default source plans:

| Source kind | Default plan |
| --- | --- |
| public/private root channel mention | source event + recent channel window + channel summary if available |
| existing thread | source event + thread replies/root + optional channel summary |
| DM | source event + DM recent/session summary only |
| MPIM | source event + MPIM recent/session summary only |
| private channel | source event + recent private-channel window/summary if allowlisted |

Admin policy can set `hydrationMode = off|assist` for this implementation. If
`off`, the plan returns source event only and telemetry explains
`history_disabled`.

#### Step 4: Compute capability checks

Examples:

- Source event read: `slack.message.read.source` for the source event.
- Source channel recent window: `slack.channel.history.read` with
  `{teamId, channelId}`.
- Source thread replies: `slack.thread.history.read` with
  `{teamId, channelId, threadTs}`.
- Channel summary: `brain.memory.read` with source labels for the channel.
- Additional channel: `slack.channel.history.read` + `slack.context.include` or
  export/use grant from that channel into current run.
- Posting summary to channel: source read + target channel write + export grant.
- DM with named channel: actor/user grant plus channel policy grant.

Checks must produce auditable IDs and denial records. Prompt hydration is
blocked for denied sources.

#### Step 5: Choose backing sources

Backing source priority:

1. Source event payload (always available after normalization).
2. Stored event journal if enabled and fresh enough.
3. Slack Web API if scopes, membership, rate budget, and policy allow.
4. Source-labelled summaries if raw windows are unavailable or too expensive.
5. No-history fallback.

For root channel mentions:

```text
if policy.hydrationMode == off:
  source event only
else if explicit no_history/source_only:
  source event only
else:
  include source event
  include channel summary if available and allowed
  include recent channel window from event journal or conversations.history
  never include unrelated thread replies unless explicit or summarized
```

For thread mentions:

```text
include source event
if explicit source_only:
  stop
if event journal has source thread and fresh enough:
  include journal thread window
else if Web API replies available:
  include conversations.replies(channel, thread_ts)
else:
  include source event + existing thread summary if available
if policy.threadMayUseChannelSummary and not explicit thread_only:
  include small parent channel summary/window if allowed and useful
```

For DMs:

```text
include source event + DM session summary/recent DM messages
if user names a channel:
  require explicit include_channel directive or ask for confirmation
  require channel read + export/use grant
```

#### Step 6: Fetch with budgets

Budget dimensions:

- max Slack API calls per turn;
- max messages per source;
- max oldest/latest window;
- max tokens per prompt section;
- per-channel rate budget;
- total run context budget;
- privacy/export grants.

Suggested initial defaults for planning:

```text
root channel mention:
  max history calls: 1
  max channel messages: min(admin default, 15 if rate-limited install unknown)
  max time window: 60 minutes
  max channel tokens: 3,000

thread mention:
  max replies calls: 1-2 depending rate budget
  max thread messages: 50 or admin default
  max time window: full thread if within token/message budget, otherwise recent + root + summary
  max thread tokens: 5,000

DM/MPIM:
  max messages: 20 recent/session summary
  max tokens: 3,000
```

Do not hard-code these as permanent product decisions. Make them Brain policy
settings with safe defaults.

#### Step 7: Redact and label

For every message/summary:

- attach `SlackSourceLabels`;
- attach capability labels;
- set `includedBecause`;
- redact Slack tokens, known env secrets, API keys, and private file paths where
  policy requires;
- normalize Slack mentions to safe display snapshots plus raw IDs in metadata;
- mark bot/assistant messages separately;
- remove unsupported blocks/attachments or summarize them as unavailable.

#### Step 8: Budget and truncate

Truncation order:

1. Drop low-relevance non-source messages first.
2. Keep source event/request.
3. Keep thread root and most recent thread replies for thread turns.
4. Keep nearest recent channel messages for channel turns.
5. Replace older ranges with summaries.
6. Emit `truncated=true` and reason.

Never silently replace private context with public context or another channel's
summary.

#### Step 9: Assemble prompt context

In assist mode:

- pass prompt-safe `HydratedSlackContext` to the main loop context builder;
- include denial/fallback explanation metadata;
- keep output routing from stored `OutputTarget` unchanged.

If hydration is disabled or unavailable, package source-event-only context and
telemetry so the model does not claim to have read broader history.

#### Step 10: Emit telemetry

Emit metadata-only telemetry for:

- source classification;
- selected context source(s);
- capabilities checked/denied;
- API calls attempted/succeeded/rate-limited;
- message counts/token estimates/truncation;
- fallback reason;
- whether prompt exposure happened;
- output target type and `thread_ts` presence/absence;
- subagent ownership labels if subagents are dispatched.

## Data model and schema

The first implementation can use existing state mechanisms for telemetry and
source-scoped prompt hydration, but production policy/history should use a
durable store with migrations. The shapes
below are implementation-ready contracts, not a mandate for a specific database.

### Tables / collections

#### `slack_workspace_installations`

Tracks non-secret installation metadata.

```sql
CREATE TABLE slack_workspace_installations (
  id TEXT PRIMARY KEY,
  enterprise_id TEXT NULL,
  team_id TEXT NOT NULL,
  team_name_snapshot TEXT NULL,
  app_id TEXT NULL,
  bot_user_id TEXT NULL,
  installed_by_actor_id TEXT NULL,
  installed_scopes_json TEXT NOT NULL,
  subscribed_events_json TEXT NOT NULL,
  manifest_version TEXT NOT NULL,
  events_url TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  hydration_mode TEXT NOT NULL DEFAULT 'off',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (enterprise_id, team_id)
);
```

#### `slack_channel_policies`

Per-channel policy, allowlist, retention, budgets.

```sql
CREATE TABLE slack_channel_policies (
  id TEXT PRIMARY KEY,
  enterprise_id TEXT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_name_snapshot TEXT NULL,
  hydration_mode TEXT NOT NULL DEFAULT 'off',
  event_history_mode TEXT NOT NULL DEFAULT 'none',
  default_channel_window_messages INTEGER NOT NULL DEFAULT 15,
  default_channel_window_minutes INTEGER NOT NULL DEFAULT 60,
  default_thread_window_messages INTEGER NOT NULL DEFAULT 50,
  default_thread_window_minutes INTEGER NULL,
  max_context_tokens INTEGER NOT NULL DEFAULT 6000,
  retention_class TEXT NOT NULL DEFAULT 'metadata_only',
  allow_channel_summary BOOLEAN NOT NULL DEFAULT TRUE,
  allow_thread_summary BOOLEAN NOT NULL DEFAULT TRUE,
  allow_cross_channel_include BOOLEAN NOT NULL DEFAULT FALSE,
  allow_private_export BOOLEAN NOT NULL DEFAULT FALSE,
  canary_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (enterprise_id, team_id, channel_id)
);
```

#### `conversation_sessions`

Adapter-neutral session registry, with Slack-specific metadata.

```sql
CREATE TABLE conversation_sessions (
  id TEXT PRIMARY KEY,
  surface_kind TEXT NOT NULL,
  conversation_key TEXT NOT NULL UNIQUE,
  parent_conversation_key TEXT NULL,
  enterprise_id TEXT NULL,
  workspace_id TEXT NULL,
  channel_id TEXT NULL,
  thread_id TEXT NULL,
  actor_id_last TEXT NULL,
  default_output_target_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  hibernated_at TEXT NULL,
  archived_at TEXT NULL,
  retention_class TEXT NOT NULL,
  summary_ref TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### `slack_event_journal`

Append-only event journal, optionally raw-text-backed.

```sql
CREATE TABLE slack_event_journal (
  id TEXT PRIMARY KEY,
  enterprise_id TEXT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  thread_ts TEXT NULL,
  message_ts TEXT NOT NULL,
  event_ts TEXT NULL,
  event_id TEXT NULL,
  event_type TEXT NOT NULL,
  subtype TEXT NULL,
  actor_slack_user_id TEXT NULL,
  bot_id TEXT NULL,
  text_storage TEXT NOT NULL DEFAULT 'none',
  text_blob_id TEXT NULL,
  redacted_text TEXT NULL,
  text_hash TEXT NULL,
  token_count INTEGER NULL,
  source_labels_json TEXT NOT NULL,
  capability_labels_json TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NULL,
  redaction_version TEXT NOT NULL,
  UNIQUE (team_id, channel_id, message_ts, event_id)
);
```

Indexes:

```sql
CREATE INDEX slack_event_journal_channel_time
  ON slack_event_journal (team_id, channel_id, message_ts);

CREATE INDEX slack_event_journal_thread_time
  ON slack_event_journal (team_id, channel_id, thread_ts, message_ts);

CREATE INDEX slack_event_journal_expiry
  ON slack_event_journal (expires_at);
```

#### `source_attributed_summaries`

```sql
CREATE TABLE source_attributed_summaries (
  id TEXT PRIMARY KEY,
  source_surface TEXT NOT NULL,
  enterprise_id TEXT NULL,
  team_id TEXT NULL,
  channel_id TEXT NULL,
  channel_type TEXT NULL,
  thread_ts TEXT NULL,
  time_range_oldest TEXT NULL,
  time_range_latest TEXT NULL,
  summary_kind TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  summary_token_count INTEGER NOT NULL,
  provenance_json TEXT NOT NULL,
  source_labels_json TEXT NOT NULL,
  capability_labels_json TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  compactor_version TEXT NOT NULL,
  created_by_run_id TEXT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NULL
);
```

#### `slack_hydration_runs`

Metadata-only audit/telemetry join table.

```sql
CREATE TABLE slack_hydration_runs (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  run_id TEXT NULL,
  conversation_session_id TEXT NOT NULL,
  enterprise_id TEXT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  thread_ts TEXT NULL,
  source_kind TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  hydration_mode TEXT NOT NULL,
  selected_sources_json TEXT NOT NULL,
  capability_check_ids_json TEXT NOT NULL,
  denied_json TEXT NOT NULL,
  fallbacks_json TEXT NOT NULL,
  messages_included INTEGER NOT NULL,
  summaries_included INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  truncated BOOLEAN NOT NULL,
  api_calls_json TEXT NOT NULL,
  prompt_exposed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL
);
```

#### `subagent_routing_bindings`

Ensures callbacks return to the correct origin.

```sql
CREATE TABLE subagent_routing_bindings (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_session_id TEXT NOT NULL,
  source_surface TEXT NOT NULL,
  source_labels_json TEXT NOT NULL,
  default_output_target_json TEXT NOT NULL,
  callback_policy TEXT NOT NULL DEFAULT 'return_to_main',
  created_at TEXT NOT NULL,
  completed_at TEXT NULL,
  archived_at TEXT NULL
);
```

### TypeScript interface additions

Implementation can start with types before persistence:

```ts
interface SlackContextPolicySnapshot {
  policyId: string;
  hydrationMode: "off" | "assist" | "ambient";
  eventHistoryMode: "none" | "triggered_only" | "allowlisted_events" | "summary_only" | "audit_metadata_only";
  channelWindow: { maxMessages: number; maxMinutes?: number; maxTokens: number };
  threadWindow: { maxMessages: number; maxMinutes?: number; maxTokens: number };
  allowChannelSummary: boolean;
  allowThreadSummary: boolean;
  allowCrossChannelInclude: boolean;
  allowPrivateExport: boolean;
  maxHistoryCallsPerTurn: number;
  maxAdditionalSources: number;
  redactionVersion: string;
}

interface SlackHydrator {
  hydrate(input: SlackHydrationInput): Promise<HydratedSlackContext>;
}

interface SlackHistoryClient {
  fetchConversationWindow(input: SlackConversationWindowRequest): Promise<SlackHistoryWindowResult>;
  fetchThreadWindow(input: SlackThreadWindowRequest): Promise<SlackHistoryWindowResult>;
}
```

## Privacy and isolation

### Hard rules

- Every Slack-derived object must carry source labels before storage or prompt
  exposure.
- Retrieval must filter by both source labels and effective grants.
- Private-channel content must not be posted to public channels without an
  explicit export grant.
- DM content must not be used as channel memory without explicit user/admin
  approval.
- Channel summaries must not hide their source. A summary from `#sales-private`
  cannot become an unlabelled "company memory" snippet.
- Slack Connect/external shared channels require an explicit policy review
  before event journaling or summaries are enabled.
- Display names, channel names, and topics are advisory only.
- Slack app membership/scopes decide possible access; Brain capabilities decide
  allowed use.
- If the hydrator cannot prove a source is allowed, it must omit that source.

### Prompt-injection posture

Slack context is untrusted user content. Other channel participants may write
instructions that conflict with system/developer policy. Prompt packaging must:

- identify context as untrusted Slack messages;
- preserve author/source labels;
- not elevate Slack text to system/developer instruction;
- prioritize current actor request and runtime policy;
- avoid following instructions from context that attempt to change tools,
  output targets, privacy controls, or capabilities.

### Cross-surface isolation

- Telegram-originated Slack reads require explicit Slack resource grants and
  explicit output/export policy.
- Slack-originated Telegram posts require explicit Telegram target grants.
- Dashboard views require Clerk/admin authorization plus source-label filters.
- Subagents inherit a narrowed context view; they cannot request broad Slack
  history outside the run's grants.

### Retention and deletion

Brain admin should eventually provide:

- per-channel retention class;
- per-thread forget/archive action;
- per-run raw hydration purge;
- summary expiration;
- telemetry retention independent of raw text;
- audit records for deletion/compaction.

Deletion must preserve enough audit metadata to explain that data was deleted
without retaining raw text.

## Fallback behavior

### User-visible fallback matrix

| Failure | Prompt exposure | User response style | Telemetry |
| --- | --- | --- | --- |
| Missing `channels:history` | Source event only or summary if allowed | "I don't have channel-history access for recent messages." | `missing_scope` |
| Bot not in channel/private channel | No channel read | "Brain is not a member of that channel." | `missing_membership` |
| Capability denied | Omit denied source | "I can't use that channel/thread from here without an explicit grant." | `capability_denied` |
| Rate limited | Use cache/summary/source only | "I couldn't refresh Slack history right now; using available context." | `rate_limited`, retry-after |
| Event journal disabled | API or source only | Usually no user text unless requested context missing | `history_disabled` |
| Summary stale | Recent window or source only | "I only have recent context; older summary is stale." | `summary_stale` |
| Ambiguous channel name | Ask clarification | "Which #project did you mean?" | `ambiguous_target` |
| Private-to-public export | Deny/ask admin | "I can't summarize private-channel content into this public channel." | `private_to_public_denied` |
| Too large thread | Truncate + summary | "This thread was long, so I used the root, newest replies, and summary." | `truncated` |
| Slack API outage | Source only | "Slack history is unavailable; answer may be incomplete." | `api_unavailable` |

### Fallback principles

- Be transparent when the user asked for context that was unavailable.
- Do not over-apologize for normal bounded-context behavior.
- Never substitute a different channel's memory as a fallback.
- Never leak the existence/content of private-channel data in a public denial
  beyond what the user already named and is allowed to know.
- Emit machine-readable fallback telemetry even when no user-visible caveat is
  needed.

## Subagent callback routing

### Required invariant

Every Slack-originated subagent job must persist:

- `conversationSessionId`;
- parent `runId`;
- source `SlackSourceLabels`;
- default `OutputTarget`;
- callback policy;
- narrowed capability grant IDs;
- artifact directory;
- correlation IDs.

Callbacks must return to the owning session mailbox first. The session runtime
then composes visible output to the stored target.

### Channel-originated work

- Source: root channel mention.
- Default output target: channel + `thread_ts` equal to the invoking root
  message timestamp.
- Subagent progress/final/failure: return to main/session mailbox; renderer posts
  in the attached root thread unless explicit reroute exists.
- Late callback after hibernation: reload session + output target from durable
  binding; do not fall back to DM, global ops channel, or another thread.

### Thread-originated work

- Source: existing Slack thread.
- Default output target: channel + `thread_ts`.
- Subagent progress/final/failure: return to thread session; renderer posts in
  same thread.
- If thread summary should be posted to channel, that is a separate explicit
  output event with export/write checks.

### DM/MPIM work

- Source: DM/MPIM conversation.
- Default output target: same DM/MPIM conversation, no cross-channel reads or
  writes by default.
- Late callbacks stay in DM/MPIM.

### Callback data contract

```ts
type SlackSubagentCallbackEnvelope = {
  jobId: string;
  runId: string;
  conversationSessionId: string;
  callbackKind: "progress" | "result" | "failure" | "artifact" | "question";
  sourceLabels: SlackSourceLabels;
  defaultOutputTarget: OutputTarget;
  capabilityGrantIds: string[];
  telemetry: {
    correlationId: string;
    parentSlackEventId?: string;
    sourceKind: "channel" | "thread" | "dm" | "mpim" | "private_channel";
  };
};
```

## Telemetry integration

### Existing telemetry direction

codex-chat already has read-only Slack telemetry for inbound/outbound event
metadata. Extend it without raw message bodies.

### New event names

Suggested event classes:

- `slack.context.classified`
- `slack.context.policy_loaded`
- `slack.context.capability_checked`
- `slack.context.hydration_started`
- `slack.context.hydration_completed`
- `slack.context.hydration_denied`
- `slack.context.hydration_fallback`
- `slack.context.prompt_exposed`
- `slack.context.api_rate_limited`
- `slack.context.truncated`
- `slack.session.created`
- `slack.session.resumed`
- `slack.session.hibernated`
- `slack.session.archived`
- `slack.subagent.routing_bound`
- `slack.subagent.callback_routed`
- `slack.output.target_resolved`
- `slack.output.private_export_denied`

### Required fields

Every telemetry event should include where applicable:

- `correlationId`
- `runId`
- `conversationSessionId`
- `enterpriseId` (redacted/hash if needed)
- `teamId` (redacted/hash if needed)
- `channelId` (redacted/hash if needed)
- `channelType`
- `threadPresent: boolean`
- `sourceKind`
- `slackEventId`
- `contextPolicyId`
- `hydrationMode`
- `selectedSources`
- `messagesIncluded`
- `summariesIncluded`
- `tokenEstimate`
- `truncated`
- `fallbackCodes`
- `denialCodes`
- `capabilityCheckIds`
- `historyCalls`
- `replyCalls`
- `rateLimited`
- `outputTargetKind`
- `outputThreadTsPresent`
- `sendResultClass`
- `jobId` for subagent events

### Brain admin rollups

Brain should show:

- hydration mode by workspace/channel;
- canary status by channel/thread/DM/MPIM;
- count of source-only vs channel-window vs thread-window vs summary contexts;
- denial rates by reason;
- Slack API rate-limit rates;
- session create/resume rates;
- callback routing success/failure;
- output target distribution: channel vs thread vs DM;
- private export denials;
- context window sizes and truncation frequency;
- installed scopes/events vs required scopes/events.

### Privacy of telemetry

- No raw message text.
- No Slack tokens.
- IDs can be raw in local private ops if Tim accepts; otherwise hash or display
  with admin-only reveal. The data model should support redaction.
- Fallback messages can be enum codes, not user text.
- Store prompt-exposure boolean, not prompt content.

## Brain admin controls

### Settings page additions

Brain admin Slack page should add sections:

1. **Installation status**
   - app ID, bot user ID, installed scopes/events, manifest version;
   - request URL status;
   - env secret presence metadata only.
2. **Context mode**
   - workspace default: off/assist;
   - per-channel overrides;
   - root channel delivery mode: root-attached-thread (current decision) and
     any explicitly approved future alternative.
3. **Channel allowlist**
   - public/private/MPIM/DM policy rows;
   - hydration enabled;
   - event history mode;
   - retention class;
   - canary enabled.
4. **Budgets**
   - max messages/minutes/tokens;
   - max history/replies calls;
   - rate-limit backoff settings.
5. **Memory and retention**
   - summary status;
   - raw text retention;
   - purge/forget controls;
   - compaction schedule.
6. **Explicit controls / approvals**
   - pending one-time grants;
   - channel read/export requests;
   - target post requests.
7. **Telemetry and canaries**
   - latest canary results;
   - context source distribution;
   - denial/fallback charts;
   - callback routing results.
8. **Rollout/rollback**
   - disable hydration globally;
   - disable event journal;
   - disable summaries;
   - return to source-event-only;
   - restore previous manifest scope set guidance.

### Admin API responsibilities

Brain APIs should store/update policy; codex-chat APIs should report runtime
capabilities and telemetry. Suggested Brain-to-codex-chat interactions:

- Brain reads codex-chat runtime health/capability manifest.
- Brain writes policy to Brain store or shared config store.
- codex-chat loads policy snapshot at runtime through a safe config/API boundary.
- codex-chat reports redacted telemetry back to Brain's store or exposes a
  redacted telemetry endpoint.
- Brain never asks codex-chat to reveal Slack secrets; it only manages presence
  and write-only updates.

## Implementation path

Tim has chosen to skip a shadow-only first slice. The current implementation path
is:

1. Normalize root channel app mentions to an output target with
   `thread_ts = message_ts`; normalize existing thread mentions to the supplied
   source `thread_ts`.
2. Hydrate bounded source-channel history for root channel mentions and bounded
   source-thread replies for thread mentions.
3. Redact and label Slack snippets before prompt exposure.
4. Emit metadata-only telemetry for source kind, selected context source, message
   counts, fallback codes, truncation, prompt exposure, and output thread
   presence.
5. Persist stored Slack output targets through subagent dispatch/callback paths.
6. Keep rollback simple: disable hydration to source-event-only if Slack history
   reads misbehave, while preserving root-thread delivery unless Tim requests a
   visible product rollback.

Deferred work remains: durable event journals, channel summaries, explicit
cross-channel controls, admin policy UI, interactive Slack buttons, retention
purge, and ambient/proactive modes.

## Canary and test matrix

### Unit tests

| Area | Cases |
| --- | --- |
| Source classification | root channel, root private channel, thread reply, thread root with `thread_ts == ts`, DM, MPIM, unknown channel type |
| Conversation key | root channel mention key uses attached root thread, existing thread key includes source thread, DM key by channel ID, MPIM key by channel ID |
| Output target | root channel target has `threadId = message_ts`; existing thread target has `threadId = thread_ts`; DM has no cross-target |
| Context controls | parse source-only, thread-only, recent channel, include channel, explicit output, no-history |
| Capability checks | allow source channel, deny additional channel, deny private export, allow explicit grant |
| Hydrator source plan | channel default, thread default, DM default, no-history/off modes |
| Web API client | success, missing_scope, not_in_channel, channel_not_found, rate_limited, timeout, malformed payload |
| Event journal | append idempotency, retention expiry, source labels, no raw text in metadata-only mode |
| Prompt packaging | source labels preserved, untrusted context instruction, redaction, truncation order |
| Telemetry | no raw text, selected sources, fallback codes, prompt exposure flag |
| Subagent routing | channel job, thread job, DM job, hibernation reload, explicit reroute denial |

### Integration tests with mocked Slack

| Scenario | Expected |
| --- | --- |
| Root channel mention with history success | Hydrates recent channel window; output target unchanged for current phase |
| Root channel mention missing scope | Source event only; fallback recorded |
| Thread mention with replies success | Hydrates thread replies; no unrelated channel messages |
| Thread too large | Root + recent replies + summary; truncation telemetry |
| DM names channel without grant | No channel read; asks/denies |
| Private channel export to public | Denied before prompt/output |
| Rate limit with retry-after | No aggressive retry; fallback telemetry |
| Duplicate event | No duplicate journal/run/hydration side effects |
| Subagent completes after restart simulation | Callback target restored from binding |

### Live Slack canaries

| Canary | Steps | Pass criteria |
| --- | --- | --- |
| Public channel current behavior baseline | Mention Brain in canary channel before changes | Existing delivery still works |
| Public channel hydration | Mention Brain referencing recent messages | Prompt context and telemetry show channel window/fallback; reply lands in attached root thread |
| Public channel assist hydration | Enable assist in canary; ask about recent allowed discussion | Answer uses only allowed recent channel context |
| Public channel continuity | Ask follow-up in the attached root thread | Same root thread session used; no cross-channel/thread leakage |
| Existing public thread | Mention Brain inside a thread | Thread replies used; output stays in thread |
| Thread isolation | Ask in another thread for first thread details | No leakage without explicit include |
| Second channel isolation | Ask similar question in another channel | No first-channel context appears |
| Private channel root | Invite bot; mention Brain | Context/output stay private channel |
| Private-to-public denial | Ask public channel to summarize private channel | Clean denial, no private details |
| DM continuity | DM follow-up | DM session resumes; no channel reads by default |
| MPIM | Group DM mention/follow-up | MPIM continuity, no public/private channel leakage |
| Rate-limit fallback | Force/mock low budget | Source/summary fallback and telemetry |
| Subagent channel callback | Dispatch long task from channel | Late result returns to channel target |
| Subagent thread callback | Dispatch long task from thread | Late result returns to thread target |
| Hibernation/restart | Simulate worker restart in safe env | Session/output target restored |
| Telemetry audit | Inspect Brain admin | Redacted join across inbound, hydration, checks, output, callback |

### Manual review checklist

Before rollout beyond canary:

- Confirm Slack app scopes/events match intended mode.
- Confirm Brain admin allowlist contains only canary channels.
- Confirm fallback messages do not reveal private channel existence/content.
- Confirm telemetry has no raw Slack text.
- Confirm output target did not change in hydration-only phases.
- Confirm rollback toggles work.
- Confirm no codex-chat restart is attempted by subagent/documentation work.

## Rollout and rollback

### Rollout sequence

1. Docs updated to record Tim's root-thread/assist-mode decision.
2. Implement normalization, bounded hydration, prompt packaging, telemetry, and tests.
3. Build and deploy codex-chat with the existing Slack fast-ack path preserved.
4. Run live canaries for root channel mention -> attached thread, existing thread
   continuation, history fallback, subagent callback routing, and second-channel
   isolation.
5. If public channel history scopes are missing, add optional public history scopes
   and reinstall only after confirming the fallback path remains safe.
6. Add event journaling/summaries for selected high-value channels.
7. Add explicit cross-channel controls.
8. Consider ambient/proactive only after all safety gates pass.

### Rollback levers

Each lever should be available independently:

- `SLACK_CONTEXT_HYDRATION_MODE=off` or Brain policy equivalent.
- Disable prompt exposure by setting hydration off/source-event-only.
- Disable Slack Web API history reads.
- Disable event journal writes.
- Disable summary retrieval.
- Disable explicit cross-channel includes.
- Revert root-thread delivery only as an explicit visible product rollback.
- Revert manifest to minimal scopes/events and reinstall if broader scopes cause
  operational concern.
- Purge raw event journal for selected channel/retention class.

### Rollback validation

After rollback:

- Root mention delivery still works under the previous known-good behavior.
- Thread mentions still work under the previous known-good behavior.
- DMs still work.
- No hydration prompt exposure occurs.
- Telemetry marks rollback state.
- Brain admin shows disabled mode.

## Implementation task breakdown

This checklist now reflects the active implementation request. Items beyond
source-scoped history hydration remain future work.

### codex-chat tasks

1. Add Slack source classifier helper and tests.
2. Add `HydratedSlackContext` types.
3. Add `SlackContextPolicySnapshot` loader seam.
4. Add metadata-only telemetry enums/events.
5. Add source-only fallback hydrator for disabled/unavailable history.
6. Add mocked Slack history client.
7. Add Web API wrappers with token isolation, timeouts, rate limits.
8. Add event journal interface and in-memory/test implementation.
9. Add prompt packaging helper with source labels/redaction.
10. Add capability-check integration points.
11. Add subagent routing binding persistence contract.
12. Add canary fixtures and integration tests.
13. Root channel routing is now root-attached-thread behavior.
14. Later: implement event journal durable store and summaries.
15. Later: implement explicit context controls and interactive actions.

### Brain tasks

1. Add Slack context policy schema/store.
2. Add admin page controls for hydration mode and channel allowlist.
3. Show installed scopes/events and required optional scopes.
4. Show canary status and telemetry rollups.
5. Add retention/memory controls.
6. Add one-time approval records for explicit context/export controls.
7. Add rollout/rollback buttons with exact approval phrases.
8. Render manifest variants or warnings for optional history scopes.
9. Add admin audit views for context hydration and denials.
10. Add purge/forget controls after durable storage exists.

### Shared coordination tasks

1. Define durable store choice and migration owner.
2. Define capability IDs for Slack read/write/export/context use.
3. Define redaction policy/versioning.
4. Define channel ID display/redaction policy in Brain admin.
5. Define canary channels and acceptance criteria.
6. Define rollback owner and emergency procedure.

## Open questions

1. Answered 2026-06-29: implement visible root-thread delivery and assist-mode source-scoped hydration from the start; do not start shadow-only.
2. What durable store should hold channel policies, event journal metadata,
   summaries, and subagent routing bindings for production?
3. For Tim's main workspace, is the Brain Slack app an internal customer-built
   app for Slack rate-limit purposes, and should we plan around internal-app
   limits or worst-case non-Marketplace limits?
4. Which public/private channels should be the first canary allowlist?
5. What should the default raw-text retention be for triggered Slack events?
6. Should channel memory summaries be visible in Brain admin by default, or only
   via per-channel drilldown with additional authorization?
7. Should root channel answers include a visible context note, or should context
   provenance appear only on demand/admin telemetry?
8. What exact phrase/control should users use to move a root channel task into a
   thread?
9. Should thread sessions expire on a shorter TTL than channel memory?
10. Should Brain support Slack Connect/external shared channels in the first
    hydration release, or fail closed until a separate plan?
11. Which capability vocabulary should govern `read source`, `read channel`,
    `read thread`, `include channel`, `summarize`, `export`, `post source`, and
    `post explicit target`?
12. Should event-journal raw text be encrypted in the first production store, or
    should the first production mode be summary-only/metadata-only?
13. How should Slack file attachments, snippets, and canvases be represented in
    context windows?
14. How should old channel summaries be invalidated when Slack membership or
    Brain grants change?
15. What cost/spend budget should Brain enforce per channel for hydration,
    summaries, and future ambient behavior?
