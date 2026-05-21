import { routeOutboundToOrigin, type BrainEntrypointAdapter, type BrainOutboundAction, type EntryPointHealth, type EntryPointInboundEvent, type OutboundDispatchResult } from "@brain/entrypoint-protocol";
import type { ProviderHealth } from "./provider.js";
import type { BrainRuntime, RuntimeTurnResult } from "./runtime.js";
import { RuntimeCommandInterceptor, type RuntimeCommandInterceptResult } from "./command-intercepts.js";

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

export class BrainSupervisor {
  private started = false;
  private startedAt?: string;
  private processedEvents = 0;
  private lastEventId?: string;
  private lastError?: string;
  private stopping = false;

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
    try {
      const intercepted = await this.options.commandInterceptor?.handle(event);
      if (intercepted?.handled) {
        const dispatchResults = await this.dispatchActions(event, intercepted.actions);
        this.processedEvents++;
        await this.log("info", "commands", `Intercepted service command: ${intercepted.command}`, event.id);
        return { event, intercepted, dispatchResults };
      }

      const turn = await this.options.runtime.handleInboundEvent(event);
      const dispatchResults = await this.dispatchActions(event, turn.actions);
      this.processedEvents++;
      await this.log("info", "runtime", "Provider turn completed", event.id, { actions: turn.actions.length, directiveErrors: turn.directiveErrors });
      return { event, turn, dispatchResults };
    } catch (error) {
      this.lastError = errorMessage(error);
      await this.log("error", "supervisor", `Event handling failed: ${this.lastError}`, event.id);
      const fallback = routeOutboundToOrigin(event, { type: "send_text", text: `⚠️ Brain runtime error: ${this.lastError}`, format: "markdown" });
      const dispatchResults = await this.dispatchActions(event, [fallback]).catch(() => []);
      this.processedEvents++;
      return { event, dispatchResults };
    }
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
      await this.log("debug", "entrypoint", `Dispatched outbound action: ${routed.type}`, event.id, { status: result.status, target: routed.target });
    }
    return results;
  }

  private async log(level: BrainSupervisorLogRecord["level"], component: string, message: string, eventId?: string, raw?: unknown): Promise<void> {
    await this.options.logger?.({ at: this.nowIso(), level, component, message, eventId, raw });
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
