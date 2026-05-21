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
  schedule?: {
    valid: boolean;
    dueNow?: boolean;
    noHostSchedulerInstalled: true;
  };
}

export type AutomationRunResult =
  | { status: "dispatched"; loopId: string; jobId: string; dryRun: false }
  | { status: "dry_run"; loopId: string; jobId?: undefined; dryRun: true; detail: string }
  | { status: "disabled" | "not_found" | "not_runnable"; loopId: string; dryRun: boolean; detail: string };

export interface AutomationDueRunOptions {
  dryRun?: boolean;
  now?: Date;
}

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

  async runDueLoops(options: AutomationDueRunOptions = {}): Promise<AutomationRunResult[]> {
    const now = options.now ?? this.options.now?.() ?? new Date();
    const due = this.loops.filter((loop) => loop.enabled && isCronDueNow(loop.schedule, now));
    const results: AutomationRunResult[] = [];
    for (const loop of due) results.push(await this.runLoopOnce(loop.id, { dryRun: options.dryRun ?? true }));
    return results;
  }

  private loopHealth(loop: LoopDefinition): AutomationDefinitionHealth {
    const schedule = {
      valid: isValidCronExpression(loop.schedule),
      dueNow: isValidCronExpression(loop.schedule) ? isCronDueNow(loop.schedule, this.options.now?.() ?? new Date()) : undefined,
      noHostSchedulerInstalled: true as const,
    };
    if (!loop.enabled) return { id: loop.id, enabled: false, status: "disabled", schedule };
    if (!schedule.valid) return { id: loop.id, enabled: true, status: "not_runnable", detail: "invalid cron schedule expression; no host cron is installed", schedule };
    if (loop.type !== "dispatch_subagent") {
      return { id: loop.id, enabled: true, status: "not_runnable", detail: "runtime only dispatches subagent loops by default; no cron or shell side effects are installed", schedule };
    }
    return { id: loop.id, enabled: true, status: "ready", schedule };
  }

  private monitorHealth(monitor: MonitorDefinition): AutomationDefinitionHealth {
    if (!monitor.enabled) return { id: monitor.id, enabled: false, status: "disabled" };
    return { id: monitor.id, enabled: true, status: "ready", detail: "monitor schema is valid; no host watcher or crontab side effects are installed by default" };
  }
}

function compactJsonRecord(record: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as JsonRecord;
}

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  return fields.every((field, index) => cronFieldValid(field, ranges[index][0], ranges[index][1]));
}

export function isCronDueNow(expression: string, now = new Date()): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [now.getUTCMinutes(), now.getUTCHours(), now.getUTCDate(), now.getUTCMonth() + 1, now.getUTCDay()];
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  return fields.every((field, index) => cronFieldMatches(field, ranges[index][0], ranges[index][1], values[index]));
}

function cronFieldMatches(field: string, min: number, max: number, value: number): boolean {
  return field.split(",").every((part) => cronPartMatches(part, min, max, value));
}

function cronFieldValid(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => cronPartBounds(part, min, max) !== undefined);
}

function cronPartMatches(part: string, min: number, max: number, value: number): boolean {
  const bounds = cronPartBounds(part, min, max);
  if (!bounds) return false;
  let { start, end, step } = bounds;
  if (value === 7 && max === 7) value = 0;
  if (start === 7 && end === 7 && max === 7) {
    start = 0;
    end = 0;
  } else {
    if (end === 7 && max === 7) end = 6;
    if (start === 7 && max === 7) start = 0;
  }
  return value >= start && value <= end && (value - start) % step === 0;
}

function cronPartBounds(part: string, min: number, max: number): { start: number; end: number; step: number } | undefined {
  const [rangePart, stepPart] = part.split("/");
  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (!Number.isInteger(step) || step <= 0) return undefined;
  const [start, end] = rangePart === "*"
    ? [min, max]
    : rangePart?.includes("-")
      ? rangePart.split("-").map(Number)
      : [Number(rangePart), Number(rangePart)];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return undefined;
  return { start, end, step };
}
