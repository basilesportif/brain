import { routeOutboundToOrigin, type BrainEntrypointAdapter, type BrainOutboundAction, type EntryPointHealth, type EntryPointInboundEvent, type OutboundDispatchResult, type OutboundTarget } from "@brain/entrypoint-protocol";
import type { ProviderHealth } from "./provider.js";
import type { BrainRuntime, RuntimeTurnResult } from "./runtime.js";
import { RuntimeCommandInterceptor, type RuntimeCommandInterceptResult } from "./command-intercepts.js";
import type { SubagentJob } from "./jobs.js";
import type { SubagentRunResult } from "./subagents.js";

export interface BrainSupervisorLogRecord {
  at: string;
  level: "debug" | "info" | "warn" | "error";
  component: string;
  message: string;
  eventId?: string;
  raw?: unknown;
}

export type BrainSupervisorLogger = (record: BrainSupervisorLogRecord) => void | Promise<void>;

export interface BrainSupervisorOptions {
  runtime: BrainRuntime;
  entrypoint: BrainEntrypointAdapter;
  commandInterceptor?: RuntimeCommandInterceptor;
  logger?: BrainSupervisorLogger;
  now?: () => Date;
}

export interface BrainSupervisorEventResult {
  event: EntryPointInboundEvent;
  intercepted?: RuntimeCommandInterceptResult;
  turn?: RuntimeTurnResult;
  dispatchResults: OutboundDispatchResult[];
  streamingDispatchResults?: OutboundDispatchResult[];
}

export interface BrainSupervisorRunOptions {
  maxEvents?: number;
  signal?: AbortSignal;
}

export interface BrainSupervisorRunResult {
  processed: BrainSupervisorEventResult[];
  stoppedReason: "entrypoint-closed" | "max-events" | "aborted" | "stopped";
}

export interface BrainSupervisorHealth {
  ok: boolean;
  started: boolean;
  startedAt?: string;
  processedEvents: number;
  lastEventId?: string;
  lastError?: string;
  entrypoint?: EntryPointHealth;
  provider?: ProviderHealth;
}

export interface BrainSupervisorSubagentDeliveryResult {
  jobId: string;
  route: SubagentJob["route"];
  actions: BrainOutboundAction[];
  dispatchResults: OutboundDispatchResult[];
  returnToMain?: RuntimeTurnResult;
}

export class BrainSupervisor {
  private started = false;
  private startedAt?: string;
  private processedEvents = 0;
  private lastEventId?: string;
  private lastError?: string;
  private stopping = false;
  private runtimeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrainSupervisorOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.startedAt = this.nowIso();
    this.stopping = false;
    await this.options.entrypoint.start?.();
    await this.options.runtime.start();
    this.started = true;
    await this.log("info", "supervisor", "Brain supervisor started");
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.log("info", "supervisor", "Brain supervisor stopping");
    await this.options.runtime.stop().catch(async (error) => {
      await this.log("warn", "runtime", `Runtime stop failed: ${errorMessage(error)}`);
    });
    await this.options.entrypoint.stop?.().catch(async (error) => {
      await this.log("warn", "entrypoint", `Entrypoint stop failed: ${errorMessage(error)}`);
    });
    this.started = false;
  }

  async health(): Promise<BrainSupervisorHealth> {
    const entrypoint = await this.options.entrypoint.health?.().catch((error) => ({ ok: false, entrypointId: this.options.entrypoint.id, detail: errorMessage(error) }));
    const provider = await this.options.runtime.health?.().catch((error) => ({ ok: false, provider: "unknown", detail: errorMessage(error) }));
    return {
      ok: Boolean(this.started && (entrypoint?.ok ?? true) && (provider?.ok ?? true) && !this.lastError),
      started: this.started,
      startedAt: this.startedAt,
      processedEvents: this.processedEvents,
      lastEventId: this.lastEventId,
      lastError: this.lastError,
      entrypoint,
      provider,
    };
  }

  async handleEvent(event: EntryPointInboundEvent): Promise<BrainSupervisorEventResult> {
    this.lastEventId = event.id;
    await this.log("info", "entrypoint", `Inbound ${event.kind} event received`, event.id, { command: event.command, hasText: Boolean(event.text), attachmentCount: event.attachments?.length ?? 0 });
    const streamingDispatchResults: OutboundDispatchResult[] = [];
    try {
      const intercepted = await this.options.commandInterceptor?.handle(event);
      if (intercepted?.handled) {
        const dispatchResults = await this.dispatchActions(event, intercepted.actions);
        this.processedEvents++;
        await this.log("info", "commands", `Intercepted service command: ${intercepted.command}`, event.id);
        return { event, intercepted, dispatchResults, streamingDispatchResults };
      }

      const turn = await this.runRuntimeTurn(() => this.options.runtime.handleInboundEvent(event, {
        onStreamingAction: async (action) => {
          streamingDispatchResults.push(...await this.dispatchActions(event, [action]));
        },
      }));
      const dispatchResults = await this.dispatchActions(event, turn.actions);
      this.processedEvents++;
      await this.log("info", "runtime", "Provider turn completed", event.id, { actions: turn.actions.length, streamingActions: turn.streamingActions.length, directiveErrors: turn.directiveErrors });
      return { event, turn, dispatchResults, streamingDispatchResults };
    } catch (error) {
      this.lastError = errorMessage(error);
      await this.log("error", "supervisor", `Event handling failed: ${this.lastError}`, event.id);
      const fallback = routeOutboundToOrigin(event, { type: "send_text", text: `⚠️ Brain runtime error: ${this.lastError}`, format: "markdown" });
      const dispatchResults = await this.dispatchActions(event, [fallback]).catch(() => []);
      this.processedEvents++;
      return { event, dispatchResults, streamingDispatchResults };
    }
  }

  async deliverSubagentResult(job: SubagentJob, result: SubagentRunResult): Promise<BrainSupervisorSubagentDeliveryResult> {
    const actions = subagentDeliveryActions(job, result);
    const dispatchResults: OutboundDispatchResult[] = [];
    let returnToMain: RuntimeTurnResult | undefined;
    const originEvent = subagentOriginEvent(job, result, this.options.entrypoint.ref, this.nowIso());

    if (job.route === "return_to_main" || job.route === "dispatch_subagent" || job.route === "send_progress_and_return") {
      returnToMain = await this.runRuntimeTurn(() => this.options.runtime.handleInboundEvent(originEvent, {
        onStreamingAction: async (action) => {
          dispatchResults.push(...await this.dispatchActions(originEvent, [action]));
        },
      }));
      dispatchResults.push(...await this.dispatchActions(originEvent, returnToMain.actions));
    }

    if (actions.length > 0) {
      dispatchResults.push(...await this.dispatchActions(originEvent, actions));
    }

    await this.log("info", "subagents", `Subagent result delivered: ${job.id}`, originEvent.id, { route: job.route, status: job.status, dispatches: dispatchResults.length });
    return { jobId: job.id, route: job.route, actions, dispatchResults, returnToMain };
  }

  async run(options: BrainSupervisorRunOptions = {}): Promise<BrainSupervisorRunResult> {
    const processed: BrainSupervisorEventResult[] = [];
    const abortStop = (): void => {
      void this.stop();
    };
    options.signal?.addEventListener("abort", abortStop, { once: true });
    await this.start();
    try {
      for await (const event of this.options.entrypoint.inboundEvents()) {
        if (this.stopping) return { processed, stoppedReason: "stopped" };
        if (options.signal?.aborted) return { processed, stoppedReason: "aborted" };
        processed.push(await this.handleEvent(event));
        if (options.maxEvents !== undefined && processed.length >= options.maxEvents) return { processed, stoppedReason: "max-events" };
      }
      return { processed, stoppedReason: options.signal?.aborted ? "aborted" : "entrypoint-closed" };
    } finally {
      options.signal?.removeEventListener("abort", abortStop);
      await this.stop();
    }
  }

  private async dispatchActions(event: EntryPointInboundEvent, actions: BrainOutboundAction[]): Promise<OutboundDispatchResult[]> {
    const results: OutboundDispatchResult[] = [];
    for (const action of actions) {
      const routed = routeOutboundToOrigin(event, action);
      const result = await this.options.entrypoint.dispatch(routed);
      results.push(result);
      const dispatchLevel = result.status === "sent" || result.status === "queued"
        ? "info"
        : result.status === "failed"
          ? "error"
          : "warn";
      await this.log(dispatchLevel, "entrypoint", `Dispatched outbound action: ${routed.type}`, event.id, {
        status: result.status,
        target: routed.target,
        error: result.error,
      });
    }
    return results;
  }

  private async log(level: BrainSupervisorLogRecord["level"], component: string, message: string, eventId?: string, raw?: unknown): Promise<void> {
    await this.options.logger?.({ at: this.nowIso(), level, component, message, eventId, raw });
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private async runRuntimeTurn<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.runtimeQueue;
    let release: () => void = () => undefined;
    this.runtimeQueue = previous.then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function subagentDeliveryActions(job: SubagentJob, result: SubagentRunResult): BrainOutboundAction[] {
  if (job.route === "store_only" || job.route === "silent" || job.route === "return_to_main" || job.route === "dispatch_subagent") return [];
  const text = formatSubagentResult(job, result);
  const artifactPath = resultArtifactPath(job, result);
  if (job.route === "send_to_admins" || job.resultTarget === "admins") {
    return [
      { type: "send_text", text, format: "markdown", target: { route: "admins" } },
      ...artifactActions(artifactPath, { route: "admins" }),
    ];
  }
  if (job.route === "send_to_user" || job.route === "send_progress_and_return" || job.resultTarget === "user") {
    const target = originTargetFromJob(job);
    return [
      { type: "send_text", text, format: "markdown", target },
      ...artifactActions(artifactPath, target),
    ];
  }
  return [];
}

function subagentOriginEvent(job: SubagentJob, result: SubagentRunResult, fallbackEntrypoint: EntryPointInboundEvent["entrypoint"], nowIso: string): EntryPointInboundEvent {
  const origin = originRecord(job);
  return {
    id: `subagent_result_${job.id}`,
    kind: "delivery",
    workspaceId: job.workspaceId ?? "default",
    entrypoint: {
      entrypointId: stringValue(origin.entrypointId) ?? fallbackEntrypoint.entrypointId,
      channelKind: stringValue(origin.channelKind) ?? fallbackEntrypoint.channelKind,
      displayName: fallbackEntrypoint.displayName,
      capabilities: fallbackEntrypoint.capabilities,
    },
    text: [
      `Subagent ${job.profile} (${job.id}) finished with status ${job.status}.`,
      job.summary ? `Summary: ${job.summary}` : undefined,
      result.outputText ?? job.resultText ? `Result:\n${result.outputText ?? job.resultText}` : undefined,
      result.error ?? job.error ? `Error: ${result.error ?? job.error}` : undefined,
    ].filter(Boolean).join("\n\n"),
    conversation: stringValue(origin.conversationId) ? {
      id: stringValue(origin.conversationId),
      threadId: stringValue(origin.threadId),
    } : undefined,
    receivedAt: nowIso,
    correlationId: job.parentTurnId,
    metadata: compactJsonRecord({
      subagentJobId: job.id,
      subagentRoute: job.route,
      parentTurnId: job.parentTurnId,
    }),
  };
}

function formatSubagentResult(job: SubagentJob, result: SubagentRunResult): string {
  const status = result.status ?? job.status;
  const header = status === "completed"
    ? `✅ Subagent ${job.profile} completed`
    : `⚠️ Subagent ${job.profile} ${status}`;
  const lines = [header, `id: ${job.id}`];
  if (job.summary) lines.push(`summary: ${job.summary}`);
  const body = result.outputText ?? job.resultText;
  if (body) lines.push("", body);
  const error = result.error ?? job.error;
  if (error) lines.push("", `Error: ${error}`);
  return lines.join("\n");
}

function resultArtifactPath(job: SubagentJob, result: SubagentRunResult): string | undefined {
  const fromResult = lastArtifactPathFromRaw(result.raw);
  return fromResult ?? job.lastMessagePath;
}

function lastArtifactPathFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as { lastArtifactPath?: unknown }).lastArtifactPath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function artifactActions(artifactPath: string | undefined, target: OutboundTarget): BrainOutboundAction[] {
  if (!artifactPath) return [];
  return [{
    type: "send_artifact",
    path: artifactPath,
    caption: "Subagent artifact",
    asDocument: true,
    target,
    metadata: { source: "subagent-result" },
  }];
}

function originTargetFromJob(job: SubagentJob): OutboundTarget {
  const origin = originRecord(job);
  return {
    route: "originating-entrypoint",
    entrypointId: stringValue(origin.entrypointId),
    conversationId: stringValue(origin.conversationId),
    threadId: stringValue(origin.threadId),
    replyToExternalMessageId: stringValue(origin.replyToExternalMessageId),
  };
}

function originRecord(job: SubagentJob): Record<string, unknown> {
  const origin = job.metadata?.origin;
  return origin && typeof origin === "object" && !Array.isArray(origin) ? origin as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactJsonRecord(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => typeof value === "string" && value.length > 0)) as Record<string, string>;
}
