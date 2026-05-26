import { routeOutboundToOrigin, type BrainOutboundAction, type EntryPointInboundEvent } from "@brain/entrypoint-protocol";
import type { WorkspaceConfig } from "@brain/workspace-schema";
import { parseBrainDirectives } from "./directives.js";
import type { ProviderAdapter, ProviderHealth, ProviderResumeHandle, ProviderSession, ProviderTurnEvent } from "./provider.js";
import type { SubagentControlPort } from "./subagents.js";

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
      prompt: buildPrompt(event, this.options.workspace),
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
      actions.unshift(routeOutboundToOrigin(event, { type: "send_text", text: parsed.cleanText, format: "markdown" }));
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
    const routed = routeOutboundToOrigin(event, action);
    if (routed.type === "dispatch_subagent" && this.options.subagents) {
      subagentJobIds.push(await this.options.subagents.dispatch({
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
      }));
      return [];
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
}

export function buildPrompt(event: EntryPointInboundEvent, workspace: WorkspaceConfig): string {
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
      tasksPath: `${workspacePath}/tasks`,
      repoRegistryPath: `${workspacePath}/.claude/repo-registry`,
      fileSaveMetadataPath: `${workspacePath}/private/documents/metadata.jsonl`,
      markdownResourcePaths: {
        projects: `${workspacePath}/projects`,
        notes: `${workspacePath}/notes`,
        documentsMetadata: `${workspacePath}/documents/metadata`,
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
    "Todos, projects, CRM, reminders, saved-file metadata, instruction overlays, scheduled tasks, and repo-registry state are JSON-backed assistant workspace state, not markdown notes.",
    "Use Brain's native assistant-logic CLI commands through the brainctl workspace run wrapper for todos/projects/CRM/reminders/file-save; do not port or reinterpret those stores ad hoc.",
    "Markdown project/notes/documents directories are supporting resources only. Do not convert JSON state to markdown or claim markdown is the source of truth.",
    "When asked about personal workspace state, inspect the private JSON paths and overlays in Active runtime context before answering.",
    "If filesystem or script inspection fails, report the exact command or path failure; do not claim no project/todo/CRM/reminder list exists from runtime metadata alone.",
    `Active runtime context: ${JSON.stringify(activeMetadata)}`,
    event.text ? `Inbound text: ${event.text}` : "Inbound text: (none)",
  ].join("\n");
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
  return action.type === "react" || action.type === "show_status";
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
