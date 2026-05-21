import type { JsonRecord } from "@brain/entrypoint-protocol";
import {
  loopDefinitionSchema,
  monitorDefinitionSchema,
  type LoopDefinition,
  type MonitorDefinition,
} from "./jobs.js";
import type { SubagentDispatchPort } from "./subagents.js";

export interface AutomationRuntimeOptions {
  workspaceId: string;
  loops?: unknown[];
  monitors?: unknown[];
  subagents?: SubagentDispatchPort;
  now?: () => Date;
}

export interface AutomationHealth {
  ok: boolean;
  workspaceId: string;
  loops: AutomationDefinitionHealth[];
  monitors: AutomationDefinitionHealth[];
}

export interface AutomationDefinitionHealth {
  id: string;
  enabled: boolean;
  status: "ready" | "disabled" | "not_runnable";
  detail?: string;
}

export type AutomationRunResult =
  | { status: "dispatched"; loopId: string; jobId: string; dryRun: false }
  | { status: "dry_run"; loopId: string; jobId?: undefined; dryRun: true; detail: string }
  | { status: "disabled" | "not_found" | "not_runnable"; loopId: string; dryRun: boolean; detail: string };

export class AutomationRuntime {
  private readonly loops: LoopDefinition[];
  private readonly monitors: MonitorDefinition[];

  constructor(private readonly options: AutomationRuntimeOptions) {
    this.loops = (options.loops ?? []).map((loop) => loopDefinitionSchema.parse(loop));
    this.monitors = (options.monitors ?? []).map((monitor) => monitorDefinitionSchema.parse(monitor));
  }

  health(): AutomationHealth {
    return {
      ok: this.loops.every((loop) => this.loopHealth(loop).status !== "not_runnable")
        && this.monitors.every((monitor) => this.monitorHealth(monitor).status !== "not_runnable"),
      workspaceId: this.options.workspaceId,
      loops: this.loops.map((loop) => this.loopHealth(loop)),
      monitors: this.monitors.map((monitor) => this.monitorHealth(monitor)),
    };
  }

  listLoops(): LoopDefinition[] {
    return structuredClone(this.loops);
  }

  listMonitors(): MonitorDefinition[] {
    return structuredClone(this.monitors);
  }

  async runLoopOnce(loopId: string, options: { dryRun?: boolean } = {}): Promise<AutomationRunResult> {
    const dryRun = options.dryRun ?? false;
    const loop = this.loops.find((candidate) => candidate.id === loopId);
    if (!loop) return { status: "not_found", loopId, dryRun, detail: `No loop matched ${loopId}.` };
    if (!loop.enabled) return { status: "disabled", loopId, dryRun, detail: `Loop ${loopId} is disabled.` };
    if (loop.type !== "dispatch_subagent") {
      return { status: "not_runnable", loopId, dryRun, detail: `Loop ${loopId} is ${loop.type}; runtime skeleton only dispatches subagent loops.` };
    }
    if (!loop.profile || !loop.prompt) {
      return { status: "not_runnable", loopId, dryRun, detail: `Loop ${loopId} is missing profile or prompt.` };
    }
    if (dryRun) {
      return { status: "dry_run", loopId, dryRun: true, detail: `Would dispatch ${loop.profile} from loop ${loopId}.` };
    }
    if (!this.options.subagents) {
      return { status: "not_runnable", loopId, dryRun, detail: "No subagent dispatch port is configured." };
    }
    const jobId = await this.options.subagents.dispatch({
      workspaceId: this.options.workspaceId,
      profile: loop.profile,
      prompt: loop.prompt,
      route: loop.route,
      ownerType: "loop",
      ownerId: loop.id,
      timeoutSec: loop.timeoutSec,
      model: loop.model,
      effort: loop.effort,
      summary: loop.description ?? `Loop ${loop.id}`,
      metadata: compactJsonRecord({
        automationKind: "loop",
        loopId: loop.id,
        schedule: loop.schedule,
        triggeredAt: (this.options.now?.() ?? new Date()).toISOString(),
      }),
    });
    return { status: "dispatched", loopId, jobId, dryRun: false };
  }

  private loopHealth(loop: LoopDefinition): AutomationDefinitionHealth {
    if (!loop.enabled) return { id: loop.id, enabled: false, status: "disabled" };
    if (loop.type !== "dispatch_subagent") {
      return { id: loop.id, enabled: true, status: "not_runnable", detail: "skeleton runtime only dispatches subagent loops; no cron or shell side effects are installed" };
    }
    return { id: loop.id, enabled: true, status: "ready" };
  }

  private monitorHealth(monitor: MonitorDefinition): AutomationDefinitionHealth {
    if (!monitor.enabled) return { id: monitor.id, enabled: false, status: "disabled" };
    return { id: monitor.id, enabled: true, status: "ready", detail: "monitor schema is valid; no host watcher or crontab side effects are installed by the skeleton" };
  }
}

function compactJsonRecord(record: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as JsonRecord;
}
