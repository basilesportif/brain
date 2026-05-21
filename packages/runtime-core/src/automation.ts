import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
  spool?: AutomationEventSpool;
  locks?: AutomationLockStore;
  notifier?: AutomationNotifier;
  commandRunner?: AutomationCommandRunner;
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
  | { status: "executed"; loopId: string; dryRun: false; outputText?: string; notificationCount: number }
  | { status: "dry_run"; loopId: string; jobId?: undefined; dryRun: true; detail: string }
  | { status: "disabled" | "not_found" | "not_runnable"; loopId: string; dryRun: boolean; detail: string };

export type AutomationMonitorRunResult =
  | { status: "dispatched"; monitorId: string; jobId: string; dryRun: false }
  | { status: "notified"; monitorId: string; dryRun: false; notificationCount: number }
  | { status: "dry_run"; monitorId: string; dryRun: true; detail: string }
  | { status: "disabled" | "not_found" | "not_runnable"; monitorId: string; dryRun: boolean; detail: string };

export interface AutomationDueRunOptions {
  dryRun?: boolean;
  now?: Date;
}

export interface AutomationEvent {
  id: string;
  workspaceId: string;
  kind: "loop" | "monitor";
  definitionId: string;
  phase: "scheduled" | "started" | "completed" | "failed" | "skipped";
  at: string;
  detail?: string;
  metadata?: JsonRecord;
}

export interface AutomationEventSpool {
  append(event: AutomationEvent): Promise<void>;
}

export interface AutomationLock {
  release(): Promise<void>;
}

export interface AutomationLockStore {
  acquire(key: string): Promise<AutomationLock | undefined>;
}

export interface AutomationNotifier {
  notifyAdmins(text: string, metadata?: JsonRecord): Promise<void>;
  enqueueMain?(text: string, metadata?: JsonRecord): Promise<void>;
}

export interface AutomationCommandRunner {
  run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutSec?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
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
    if (loop.type === "dispatch_subagent" && (!loop.profile || !loop.prompt)) return { status: "not_runnable", loopId, dryRun, detail: `Loop ${loopId} is missing profile or prompt.` };
    if (loop.type === "command" && !loop.command) return { status: "not_runnable", loopId, dryRun, detail: `Loop ${loopId} is missing command.` };
    if (loop.type === "prompt" && !loop.prompt) return { status: "not_runnable", loopId, dryRun, detail: `Loop ${loopId} is missing prompt.` };
    if (dryRun) {
      return { status: "dry_run", loopId, dryRun: true, detail: dryRunLoopDetail(loop) };
    }
    if (loop.lock) {
      const lock = await this.options.locks?.acquire(`loop:${loop.id}`);
      if (!lock && this.options.locks) return { status: "not_runnable", loopId, dryRun, detail: `Loop ${loopId} is already locked.` };
      try {
        return await this.executeLoop(loop);
      } finally {
        await lock?.release();
      }
    }
    return this.executeLoop(loop);
  }

  async runMonitorOnce(monitorId: string, input: { line?: string; context?: string; dryRun?: boolean } = {}): Promise<AutomationMonitorRunResult> {
    const dryRun = input.dryRun ?? false;
    const monitor = this.monitors.find((candidate) => candidate.id === monitorId);
    if (!monitor) return { status: "not_found", monitorId, dryRun, detail: `No monitor matched ${monitorId}.` };
    if (!monitor.enabled) return { status: "disabled", monitorId, dryRun, detail: `Monitor ${monitorId} is disabled.` };
    const prompt = monitor.prompt ?? ["Monitor event received.", `Monitor: ${monitor.id}`, input.line ? `Line: ${input.line}` : undefined, input.context ? `Context:\n${input.context}` : undefined].filter(Boolean).join("\n");
    if (dryRun) return { status: "dry_run", monitorId, dryRun: true, detail: `Would handle monitor ${monitorId} with route ${monitor.route}.` };
    await this.appendEvent("monitor", monitor.id, "started", { detail: input.line });
    try {
      if (monitor.route === "store_only" || monitor.route === "silent") {
        await this.appendEvent("monitor", monitor.id, "completed", { detail: "stored only" });
        return { status: "notified", monitorId, dryRun: false, notificationCount: 0 };
      }
      if (monitor.route === "dispatch_subagent") {
        if (!this.options.subagents) return { status: "not_runnable", monitorId, dryRun, detail: "No subagent dispatch port is configured." };
        const jobId = await this.options.subagents.dispatch({
          workspaceId: this.options.workspaceId,
          profile: stringFromConfig(monitor.config.profile) ?? "debugger",
          prompt,
          route: "return_to_main",
          ownerType: "monitor",
          ownerId: monitor.id,
          summary: monitor.description ?? `Monitor ${monitor.id}`,
          metadata: compactJsonRecord({ automationKind: "monitor", monitorId: monitor.id, triggeredAt: this.nowIso(), line: input.line }),
        });
        await this.appendEvent("monitor", monitor.id, "completed", { detail: `dispatched ${jobId}` });
        return { status: "dispatched", monitorId, jobId, dryRun: false };
      }
      if (!this.options.notifier) return { status: "not_runnable", monitorId, dryRun, detail: "No notifier is configured." };
      await this.options.notifier.enqueueMain?.(prompt, compactJsonRecord({ source: "monitor", monitorId: monitor.id }));
      if (monitor.route === "send_to_admins") await this.options.notifier.notifyAdmins(prompt, compactJsonRecord({ source: "monitor", monitorId: monitor.id }));
      await this.appendEvent("monitor", monitor.id, "completed", { detail: "notified" });
      return { status: "notified", monitorId, dryRun: false, notificationCount: monitor.route === "send_to_admins" ? 1 : 0 };
    } catch (error) {
      await this.appendEvent("monitor", monitor.id, "failed", { detail: errorMessage(error) });
      throw error;
    }
  }

  private async executeLoop(loop: LoopDefinition): Promise<AutomationRunResult> {
    await this.appendEvent("loop", loop.id, "started", { detail: loop.description });
    try {
      if (loop.type === "dispatch_subagent") {
        if (!this.options.subagents) return { status: "not_runnable", loopId: loop.id, dryRun: false, detail: "No subagent dispatch port is configured." };
        const jobId = await this.options.subagents.dispatch({
          workspaceId: this.options.workspaceId,
          profile: loop.profile as string,
          prompt: loop.prompt as string,
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
            triggeredAt: this.nowIso(),
          }),
        });
        await this.appendEvent("loop", loop.id, "completed", { detail: `dispatched ${jobId}` });
        return { status: "dispatched", loopId: loop.id, jobId, dryRun: false };
      }

      if (loop.type === "command") {
        if (!this.options.commandRunner) return { status: "not_runnable", loopId: loop.id, dryRun: false, detail: "No command runner is configured." };
        const output = await this.options.commandRunner.run(loop.command as string, loop.args ?? [], { timeoutSec: loop.timeoutSec });
        const text = [output.stdout, output.stderr].filter(Boolean).join("\n").trim();
        if (output.exitCode !== 0) {
          if (loop.notifyOnFailure) await this.options.notifier?.notifyAdmins(`Loop ${loop.id} failed with exit ${output.exitCode}:\n${text}`, compactJsonRecord({ source: "loop", loopId: loop.id }));
          await this.appendEvent("loop", loop.id, "failed", { detail: `exit ${output.exitCode}` });
          return { status: "not_runnable", loopId: loop.id, dryRun: false, detail: `Command exited ${output.exitCode}` };
        }
        if (loop.route === "send_to_admins") await this.options.notifier?.notifyAdmins(text || `Loop ${loop.id} completed.`, compactJsonRecord({ source: "loop", loopId: loop.id }));
        await this.appendEvent("loop", loop.id, "completed", { detail: "command executed" });
        return { status: "executed", loopId: loop.id, dryRun: false, outputText: text, notificationCount: loop.route === "send_to_admins" ? 1 : 0 };
      }

      const prompt = loop.prompt ?? "";
      if (loop.route === "dispatch_subagent") {
        if (!this.options.subagents) return { status: "not_runnable", loopId: loop.id, dryRun: false, detail: "No subagent dispatch port is configured." };
        const jobId = await this.options.subagents.dispatch({
          workspaceId: this.options.workspaceId,
          profile: loop.profile ?? "researcher",
          prompt,
          route: "return_to_main",
          ownerType: "loop",
          ownerId: loop.id,
          timeoutSec: loop.timeoutSec,
          model: loop.model,
          effort: loop.effort,
          summary: loop.description ?? `Loop ${loop.id}`,
          metadata: compactJsonRecord({ automationKind: "loop", loopId: loop.id, schedule: loop.schedule, triggeredAt: this.nowIso() }),
        });
        await this.appendEvent("loop", loop.id, "completed", { detail: `dispatched ${jobId}` });
        return { status: "dispatched", loopId: loop.id, jobId, dryRun: false };
      }
      if (loop.route === "send_to_admins") await this.options.notifier?.notifyAdmins(prompt, compactJsonRecord({ source: "loop", loopId: loop.id }));
      else await this.options.notifier?.enqueueMain?.(prompt, compactJsonRecord({ source: "loop", loopId: loop.id }));
      await this.appendEvent("loop", loop.id, "completed", { detail: "prompt routed" });
      return { status: "executed", loopId: loop.id, dryRun: false, outputText: prompt, notificationCount: loop.route === "send_to_admins" ? 1 : 0 };
    } catch (error) {
      await this.appendEvent("loop", loop.id, "failed", { detail: errorMessage(error) });
      throw error;
    }
  }

  private async appendEvent(kind: AutomationEvent["kind"], definitionId: string, phase: AutomationEvent["phase"], options: { detail?: string; metadata?: JsonRecord } = {}): Promise<void> {
    await this.options.spool?.append({
      id: `${kind}_${definitionId}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      workspaceId: this.options.workspaceId,
      kind,
      definitionId,
      phase,
      at: this.nowIso(),
      detail: options.detail,
      metadata: options.metadata,
    });
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
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
    if (loop.type === "command" && !this.options.commandRunner) {
      return { id: loop.id, enabled: true, status: "not_runnable", detail: "command loop is valid but no command runner is configured; no cron or shell side effects are installed", schedule };
    }
    if (loop.type === "prompt" && !this.options.notifier && loop.route !== "dispatch_subagent") {
      return { id: loop.id, enabled: true, status: "not_runnable", detail: "prompt loop is valid but no notifier/main queue is configured; no cron side effects are installed", schedule };
    }
    if ((loop.type === "dispatch_subagent" || loop.route === "dispatch_subagent") && !this.options.subagents) {
      return { id: loop.id, enabled: true, status: "ready", detail: "definition is runnable when a subagent dispatch port is configured; current CLI may dry-run only", schedule };
    }
    return { id: loop.id, enabled: true, status: "ready", schedule };
  }

  private monitorHealth(monitor: MonitorDefinition): AutomationDefinitionHealth {
    if (!monitor.enabled) return { id: monitor.id, enabled: false, status: "disabled" };
    return { id: monitor.id, enabled: true, status: "ready", detail: "monitor schema is valid; no host watcher or crontab side effects are installed by default" };
  }
}

export class InMemoryAutomationSpool implements AutomationEventSpool {
  readonly events: AutomationEvent[] = [];

  async append(event: AutomationEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

export class FileAutomationSpool implements AutomationEventSpool {
  constructor(readonly root: string) {}

  async append(event: AutomationEvent): Promise<void> {
    const file = path.join(this.root, "spool", "automation-events.jsonl");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
}

export class InMemoryAutomationLockStore implements AutomationLockStore {
  private readonly locks = new Set<string>();

  async acquire(key: string): Promise<AutomationLock | undefined> {
    if (this.locks.has(key)) return undefined;
    this.locks.add(key);
    return { release: async () => { this.locks.delete(key); } };
  }
}

export class FileAutomationLockStore implements AutomationLockStore {
  constructor(readonly root: string) {}

  async acquire(key: string): Promise<AutomationLock | undefined> {
    const safeKey = key.replace(/[^A-Za-z0-9._-]/g, "_");
    const file = path.join(this.root, "locks", `${safeKey}.lock`);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await writeFile(file, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    }
    return { release: async () => { await rm(file, { force: true }); } };
  }
}

function compactJsonRecord(record: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as JsonRecord;
}

function dryRunLoopDetail(loop: LoopDefinition): string {
  if (loop.type === "dispatch_subagent") return `Would dispatch ${loop.profile} from loop ${loop.id}.`;
  if (loop.type === "command") return `Would run command loop ${loop.id}: ${loop.command} ${(loop.args ?? []).join(" ")}`.trim();
  return `Would route prompt loop ${loop.id}.`;
}

function stringFromConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
