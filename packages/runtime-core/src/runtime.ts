import { routeOutboundToOrigin, type BrainOutboundAction, type EntryPointInboundEvent } from "@brain/entrypoint-protocol";
import type { WorkspaceConfig } from "@brain/workspace-schema";
import { parseBrainDirectives } from "./directives.js";
import type { ProviderAdapter, ProviderHealth, ProviderResumeHandle, ProviderSession, ProviderTurnEvent } from "./provider.js";
import type { ActiveSubagentSnapshot, SubagentControlPort } from "./subagents.js";
import { sanitizeUserFacingText } from "./user-facing-format.js";

export interface RuntimeControlResult {
  action: BrainOutboundAction;
  status: string;
  message: string;
  raw?: unknown;
}

export interface RuntimeTurnResult {
  eventId: string;
  cleanText: string;
  finalText?: string;
  actions: BrainOutboundAction[];
  streamingActions: BrainOutboundAction[];
  subagentJobIds: string[];
  controlResults: RuntimeControlResult[];
  providerEvents: ProviderTurnEvent[];
  directiveErrors: string[];
}

export interface BrainRuntimeOptions {
  workspaceId: string;
  workspace: WorkspaceConfig;
  provider: ProviderAdapter;
  subagents?: SubagentControlPort;
}

export interface BrainRuntimeHandleOptions {
  /**
   * Called while a provider turn is still streaming for transient user-visible
   * actions that are safe to execute before final text is known.
   */
  onStreamingAction?(action: BrainOutboundAction): Promise<void> | void;
}

export interface BuildPromptOptions {
  activeSubagents?: ActiveSubagentSnapshot;
}

export class BrainRuntime {
  private session?: ProviderSession;

  constructor(private readonly options: BrainRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.session) return;
    this.session = await this.options.provider.createSession({ workspaceId: this.options.workspaceId });
    await this.session.start();
  }

  async stop(): Promise<void> {
    await this.session?.stop();
    this.session = undefined;
  }

  async health(): Promise<ProviderHealth> {
    if (!this.session) {
      return { ok: false, provider: this.options.provider.id, detail: "runtime session is not started" };
    }
    return this.session.health();
  }

  async resumeHandle(): Promise<ProviderResumeHandle | undefined> {
    return this.session?.resumeHandle?.();
  }

  async handleInboundEvent(event: EntryPointInboundEvent, handleOptions: BrainRuntimeHandleOptions = {}): Promise<RuntimeTurnResult> {
    if (event.workspaceId !== this.options.workspaceId) {
      throw new Error(`Inbound event workspace mismatch: ${event.workspaceId} !== ${this.options.workspaceId}`);
    }
    if (!this.session) await this.start();
    const session = this.session;
    if (!session) throw new Error("Provider session failed to start");

    const providerEvents: ProviderTurnEvent[] = [];
    const actions: BrainOutboundAction[] = [];
    const streamingActions: BrainOutboundAction[] = [];
    const subagentJobIds: string[] = [];
    const controlResults: RuntimeControlResult[] = [];
    let finalText: string | undefined;
    for await (const providerEvent of session.sendTurn({
      id: `turn_${event.id}`,
      sessionId: session.id,
      inboundEvent: event,
      prompt: await this.buildTurnPrompt(event),
      attachments: event.attachments,
    })) {
      providerEvents.push(providerEvent);
      if (providerEvent.type === "action") {
        const collected = await this.collectRuntimeAction(event, providerEvent.action, actions, subagentJobIds, controlResults);
        const preDispatchable = collected.filter(isStreamingPreDispatchAction);
        if (preDispatchable.length > 0) {
          for (const action of preDispatchable) {
            removeActionByIdentity(actions, action);
            streamingActions.push(action);
            await handleOptions.onStreamingAction?.(action);
          }
        }
      }
      if (providerEvent.type === "final") finalText = providerEvent.text;
    }

    const parsed = parseBrainDirectives(finalText ?? "");
    for (const block of parsed.blocks) {
      for (const action of block.actions) await this.collectRuntimeAction(event, action, actions, subagentJobIds, controlResults);
    }
    if (parsed.cleanText) {
      actions.unshift(routeOutboundToOrigin(event, { type: "send_text", text: sanitizeUserFacingText(parsed.cleanText, { workspacePath: this.options.workspace.workspacePath }), format: "markdown" }));
    }

    return {
      eventId: event.id,
      cleanText: parsed.cleanText,
      finalText,
      actions,
      streamingActions,
      subagentJobIds,
      controlResults,
      providerEvents,
      directiveErrors: parsed.errors,
    };
  }

  private async collectRuntimeAction(
    event: EntryPointInboundEvent,
    action: BrainOutboundAction,
    actions: BrainOutboundAction[],
    subagentJobIds: string[],
    controlResults: RuntimeControlResult[],
  ): Promise<BrainOutboundAction[]> {
    const sanitizedAction = action.type === "send_text"
      ? { ...action, text: sanitizeUserFacingText(action.text, { workspacePath: this.options.workspace.workspacePath }) }
      : action;
    const routed = routeOutboundToOrigin(event, sanitizedAction);
    if (routed.type === "dispatch_subagent" && this.options.subagents) {
      const jobId = await this.options.subagents.dispatch({
        workspaceId: routed.workspaceId ?? event.workspaceId,
        profile: routed.profile,
        prompt: routed.prompt,
        route: routed.route ?? "return_to_main",
        ownerType: "main",
        ownerRequestId: routed.idempotencyKey ?? routed.id,
        parentTurnId: `turn_${event.id}`,
        timeoutSec: routed.timeoutSec,
        model: routed.model,
        effort: routed.effort,
        summary: routed.summary,
        images: routed.images,
        metadata: {
          originatingEventId: routed.originatingEventId ?? event.id,
          actionId: routed.id ?? routed.idempotencyKey ?? "",
          origin: originMetadata(event),
        },
      });
      subagentJobIds.push(jobId);
      const feedback = routeOutboundToOrigin(event, dispatchFeedbackAction(routed, jobId));
      actions.push(feedback);
      return [feedback];
    }
    if (routed.type === "cancel_subagent") {
      if (!this.options.subagents?.requestCancel) {
        controlResults.push({ action: routed, status: "unsupported", message: "Subagent cancellation is not configured for this runtime." });
        return [];
      }
      const result = await this.options.subagents.requestCancel(routed.jobId, routed.reason ?? "runtime directive");
      controlResults.push({ action: routed, status: result.status, message: result.message, raw: summarizeControlResult(result) });
      return [];
    }
    if (routed.type === "steer_subagent") {
      if (!this.options.subagents?.steerJob) {
        controlResults.push({ action: routed, status: "unsupported", message: "Subagent steering is not configured for this runtime." });
        return [];
      }
      const result = await this.options.subagents.steerJob(routed.jobId, routed.text);
      controlResults.push({ action: routed, status: result.status, message: result.message, raw: summarizeControlResult(result) });
      return [];
    }
    actions.push(routed);
    return [routed];
  }

  private async buildTurnPrompt(event: EntryPointInboundEvent): Promise<string> {
    const activeSubagents = await this.options.subagents?.activeSnapshot?.(12).catch(() => undefined);
    return buildPrompt(event, this.options.workspace, { activeSubagents });
  }
}

export function buildPrompt(event: EntryPointInboundEvent, workspace: WorkspaceConfig, options: BuildPromptOptions = {}): string {
  const entrypoint = workspace.enabledEntrypoints[event.entrypoint.entrypointId];
  const workspacePath = workspace.workspacePath;
  const activeMetadata = {
    workspaceId: event.workspaceId,
    workspace: {
      path: workspacePath,
      assistantJsonState: {
        todos: `${workspacePath}/data/todos.json`,
        projects: `${workspacePath}/data/projects.json`,
        crm: `${workspacePath}/data/crm.json`,
        reminders: `${workspacePath}/data/reminders.json`,
      },
      assistantScripts: {
        package: "packages/assistant-logic",
        commandShape: `cd /abs/path/to/brain && pnpm run brainctl workspace run --path ${workspacePath} <script>.js -- <args>`,
        brainctlWrapper: `pnpm run brainctl workspace run --path ${workspacePath} <script>.js -- <args>`,
        examples: [
          "todo-list.js",
          "project-list.js",
          "crm-list-people.js",
          "reminder-list.js",
          "file-list.js",
        ],
      },
      instructionOverlaysPath: `${workspacePath}/instructions`,
      skillOverlayPath: `${workspacePath}/instructions/skills`,
      tasksPath: `${workspacePath}/tasks`,
      repoRegistryPath: `${workspacePath}/.claude/repo-registry`,
      fileSaveMetadataPath: `${workspacePath}/private/documents/metadata.jsonl`,
      markdownResourcePaths: {
        projects: `${workspacePath}/projects`,
        notes: `${workspacePath}/notes`,
        documentsMetadata: `${workspacePath}/documents/metadata`,
      },
    },
    assistantLogic: {
      skillDocs: "packages/assistant-logic/config/skills/*.md",
      commandWrapper: `pnpm run brainctl workspace run --path ${workspacePath} <script>.js -- <args>`,
      commonScripts: {
        todos: ["todo-add.js", "todo-list.js", "todo-delete.js"],
        projects: ["project-add.js", "project-list.js", "project-view.js", "project-update.js", "project-note.js", "project-notes-list.js", "project-resource.js", "project-task.js", "project-delete.js"],
        crm: ["crm-add-person.js", "crm-add-business.js", "crm-list-people.js", "crm-list-businesses.js", "crm-view.js", "crm-log.js", "crm-history.js", "crm-follow-ups.js", "crm-resolve.js", "crm-link.js", "crm-unlink.js", "crm-update-person.js", "crm-update-business.js", "crm-missing-fields.js", "crm-pipeline.js", "crm-stale.js", "crm-delete.js"],
        reminders: ["reminder-add.js", "reminder-list.js", "reminder-update.js", "reminder-delete.js", "reminder-check.js"],
        fileSave: ["file-save.js", "file-list.js"],
        calendarEmailComposio: ["calendar-events.js", "calendar-search.js", "calendar-create-event.js", "gmail-recent.js", "gmail-search.js", "gmail-send.js", "composio-connect.js"],
      },
    },
    activeEntrypoint: {
      entrypointId: event.entrypoint.entrypointId,
      channelKind: event.entrypoint.channelKind,
      displayName: entrypoint?.displayName ?? event.entrypoint.displayName,
      capabilities: entrypoint?.capabilities ?? event.entrypoint.capabilities ?? {},
    },
    outboundDefaults: workspace.outboundDefaults ?? { route: "originating-entrypoint" },
  };
  return [
    "You are Brain, a provider-neutral assistant runtime.",
    "Use generic entrypoint, inbound event, outbound action, and artifact language.",
    "Do not expose channel secrets or raw adapter credentials.",
    "Brain must preserve behavioral parity with Tim's current codex-chat + assistant-agent-logic workflow unless a private credential or live account blocks validation.",
    "Telegram user messages already receive an immediate service-level 👀 reaction at ingress; do not emit a normal acknowledgement reaction. Start with the real work, a user-visible reply, or a dispatch_subagent directive.",
    "Todos, projects, CRM, reminders, saved-file metadata, instruction overlays, scheduled tasks, and repo-registry state are JSON-backed assistant workspace state, not markdown notes.",
    "Use Brain's native assistant-logic CLI commands through the brainctl workspace run wrapper for todos/projects/CRM/reminders/file-save; do not port or reinterpret those stores ad hoc.",
    "Markdown project/notes/documents directories are supporting resources only. Do not convert JSON state to markdown or claim markdown is the source of truth.",
    "When asked about personal workspace state, inspect the private JSON paths and overlays in Active runtime context before answering.",
    "If filesystem or script inspection fails, report the exact command or path failure; do not claim no project/todo/CRM/reminder list exists from runtime metadata alone.",
    ...behaviorParityInstructions(workspacePath),
    `Active runtime context: ${JSON.stringify(activeMetadata)}`,
    formatActiveSubagentSnapshot(options.activeSubagents),
    event.text ? `Inbound text: ${event.text}` : "Inbound text: (none)",
  ].filter(Boolean).join("\n");
}

function behaviorParityInstructions(workspacePath: string): string[] {
  const wrapper = `pnpm run brainctl workspace run --path ${workspacePath}`;
  return [
    "Main-loop routing parity: before doing work, decide whether the work stays in the main loop or must be delegated.",
    "Keep only simple acknowledgements, service commands, direct todo/project JSON mutations/listing, direct file-save of already-provided attachments, and trivial deterministic local checks in the main loop.",
    "Dispatch a subagent for repo/file inspection, code or docs edits, review, debugging, architecture, research, external/current-data lookup, calendar/email/Gmail lookup, finance/health/betting/account reads, ambiguous or multi-step work, generated images, and scratch web pages.",
    "For every dispatch_subagent action include summary, model, and effort. Use model gpt-5.5; effort medium for mechanical scoped edits and straightforward calendar event creation/adding with needed details and no external lookup; high for normal research/inspection/account lookup including calendar/email lookup and calendar creation requiring research/external-data lookup; and xhigh for risky ambiguous scheduling debugging architecture multi-step deploy-sensitive work.",
    "For user-facing main-loop work, begin with the exact routing disclosure `main_loop: model=gpt-5.5 effort=medium` before the result, unless the message is only a terse service-command response.",
    "User-facing formatting parity: never paste raw assistant-logic JSON stdout, createdAt/updatedAt timestamps, or internal todo/reminder IDs into Telegram/user replies. Use clean lists/summaries from command results; Brain also applies a final sanitizer as a safety net.",
    "The runtime sends visible dispatch feedback for each dispatched subagent with summary, profile, model, effort, id, and ref. Do not hide delegation from the user.",
    "Subagent stress/fan-out requests: when the user asks to stress test or fan out N subagents, dispatch N distinct bounded researcher jobs in one response, avoid duplicating the same file/topic in the same batch, and send a short user-visible note telling them to use `agents` to monitor progress.",
    "Subagent callbacks with an origin entrypoint are user-originated work: summarize completion/failure back to the user. If the main turn is silent, Brain will send a direct fallback result.",
    "Natural-language subagent steering: use the Active subagent jobs snapshot when present. Emit steer_subagent only when exactly one matching job has steerable=true; otherwise ask which job or tell the user to run `agent steer <ref> <text>`. Use service commands `agents`, `agents detail`, `agent status <ref>`, `agent kill <ref>`, and `agent steer <ref> <text>` for mechanical control/status.",
    "Before touching todos, projects, CRM, reminders, calendar/email, finance, health/Whoop, betting, messaging, generated web pages, or file-save, read the matching skill doc under packages/assistant-logic/config/skills and then any workspace overlay under instructions/skills. Follow the doc's command flags exactly.",
    `Todos: direct main-loop operations only. For add/delete, run the mutation and then always run \`${wrapper} todo-list.js --\`; include the full updated numbered todo list in the same user reply and hide internal td_* IDs. For numeric deletes, pass \`--number N\` (or map #N to the internal ID) instead of treating the number as a title.`,
    `Reminders: direct deterministic reminder operations may stay in the main loop; list reminders as clean numbered human-readable schedules, hide rm_* IDs in user replies, and use \`--number N\` for numbered delete references.`,
    `Projects/resources: direct deterministic project mutations/listing may stay in the main loop using project-*.js commands, including project-resource.js and project-task.js. For broader project investigation or repo/account lookup, dispatch a subagent.`,
    `CRM/reminders: deterministic JSON-backed mutations/listing can use crm-*.js and reminder-*.js through \`${wrapper}\`; calendar/email/Gmail/Composio live account lookup should dispatch a subagent that reads the relevant skill docs and uses configured private refs.`,
    "File-save/PDF attach: if exactly one inbound/replied attachment is the intended file, save it directly in the main loop with file-save.js, copy bytes into private document storage, record metadata (received_at, entrypoint/chat/message ids, original name, MIME, size, sha256 when available), and never commit or publish the private bytes.",
    "Generated images: user image generation/editing must dispatch an implementer subagent. For edits, include source local image paths in images. The subagent owns imagegen, stages the chosen output under a temporary data/artifacts/generated-images path, and returns a send_image/send_artifact directive with deleteAfterSend true for the staged copy only.",
    "Scratch web pages / codex-chat-web: simple visualizations, maps, reports, charts, tables, calculators, and one-off static HTML/CSS/JS pages for me.galebach.com must dispatch an implementer subagent instructed to use packages/assistant-logic/config/skills/generated-web-page.md, resolve repo authority, build in the job artifact directory, validate static-only package with root index.html, publish only through codex-chat-web npm run publish:page to an unlisted /pages/<id>/ URL, verify the manifest, and report TTL/pruning or promotion status. Use web-page-design first only for real site/design-system/landing-page visual design work.",
    "Loops/monitors: scheduled or monitor events do not need Telegram ACKs. Routine checks can be concise; investigation/debugging/remediation should dispatch subagents with route return_to_main unless a direct notification route is explicitly configured.",
    "Setup/migration parity: Brain workspaces must keep assistant state JSON-backed under data/, private documents under private/documents, overlays under instructions/, and repo-registry state under .claude/repo-registry. Do not migrate private data into source repos or markdown-only stores.",
    "Directive syntax: emit fenced `brain-actions` or `codex-chat` JSON with version 1 and action objects. Side-effecting actions need idempotencyKey. Supported parity actions include send_text, send_image/send_document compatibility (normalized to send_artifact), send_artifact, dispatch_subagent, cancel_subagent/cancel_job, steer_subagent, react, request_clarification, edit_message, notify_owner, and enqueue_main.",
  ];
}

function formatActiveSubagentSnapshot(snapshot: ActiveSubagentSnapshot | undefined): string {
  if (!snapshot || snapshot.jobs.length === 0) return "";
  const lines = [
    "Active subagent jobs (compact routing snapshot; active/queued only):",
    "Use for natural-language steering: emit steer_subagent only when exactly one matching job has steerable=true. For status, ask which job or tell the user to run `agent status <ref>`. For no/multiple steering matches, ask which job or tell the user to run `agent steer <ref> <text>`.",
  ];
  for (const job of snapshot.jobs) {
    const parts = [
      `ref=${job.ref}`,
      `id=${job.id}`,
      `status=${job.status}`,
      `profile=${job.profile}`,
      `provider=${job.provider ?? "unknown"}`,
      `owner=${job.ownerType}:${job.ownerId ?? job.ownerType}`,
      `route=${job.route}`,
      `result=${job.resultTarget ?? "main"}`,
      `steerable=${job.steerable}`,
      `elapsed=${job.elapsedSec}s`,
      `enqueued=${job.enqueuedAt}`,
    ];
    if (job.startedAt) parts.push(`started=${job.startedAt}`);
    if (job.model) parts.push(`model=${job.model}`);
    if (job.effort) parts.push(`effort=${job.effort}`);
    if (job.summary) parts.push(`summary=${JSON.stringify(compactSnapshotText(job.summary))}`);
    lines.push(`- ${parts.join(" ")}`);
  }
  if (snapshot.omitted > 0) lines.push(`- ${snapshot.omitted} more active job(s) omitted; use the service-level \`agents\` command for full status.`);
  return lines.join("\n");
}

function dispatchFeedbackAction(action: Extract<BrainOutboundAction, { type: "dispatch_subagent" }>, jobId: string): BrainOutboundAction {
  return {
    type: "send_text",
    idempotencyKey: `subagent-dispatch-status-${jobId}`,
    text: formatSubagentDispatchFeedback(action, jobId),
    format: "markdown",
    metadata: { runtimeDispatchFeedback: true },
  };
}

function formatSubagentDispatchFeedback(action: Extract<BrainOutboundAction, { type: "dispatch_subagent" }>, jobId: string): string {
  const summary = compactSnapshotText(action.summary || action.prompt.split(/\r?\n/).find((line) => line.trim())?.trim() || action.profile, 160);
  const model = action.model ?? "default";
  const effort = action.effort ?? "default";
  const ref = shortJobRef(jobId);
  const route = action.route ?? "return_to_main";
  return [
    `Sub: ${summary}`,
    `${action.profile} · ${model} · ${effort}`,
    `ref: ${ref} · id: ${jobId} · route: ${route}`,
    "Use `agents` for live status or `agent status <ref>` / `agent steer <ref> <text>` when supported.",
  ].join("\n");
}

function compactSnapshotText(text: string, maxLength = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function summarizeControlResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as { job?: { id?: string; status?: string; profile?: string }; previousStatus?: string; candidates?: unknown[] };
  return {
    job: record.job ? { id: record.job.id, status: record.job.status, profile: record.job.profile } : undefined,
    previousStatus: record.previousStatus,
    candidates: record.candidates,
  };
}

function isStreamingPreDispatchAction(action: BrainOutboundAction): boolean {
  return action.type === "react" || action.type === "show_status" || (action.type === "send_text" && action.metadata?.runtimeDispatchFeedback === true);
}

function shortJobRef(id: string): string {
  const raw = id.startsWith("job_") ? id.slice(4) : id;
  return raw.slice(0, Math.min(8, raw.length));
}

function removeActionByIdentity(actions: BrainOutboundAction[], action: BrainOutboundAction): void {
  const index = actions.findIndex((candidate) => candidate === action);
  if (index >= 0) actions.splice(index, 1);
}

function originMetadata(event: EntryPointInboundEvent): Record<string, string> {
  return Object.fromEntries(Object.entries({
    eventId: event.id,
    entrypointId: event.entrypoint.entrypointId,
    channelKind: event.entrypoint.channelKind,
    conversationId: event.conversation?.id,
    threadId: event.conversation?.threadId,
    replyToExternalMessageId: event.kind === "message" ? event.conversation?.metadata?.messageId?.toString() : undefined,
  }).filter(([, value]) => value !== undefined)) as Record<string, string>;
}
