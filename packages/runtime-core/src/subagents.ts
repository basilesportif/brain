import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrainAttachment, DispatchSubagentAction, EntryPointInboundEvent, JsonRecord } from "@brain/entrypoint-protocol";
import {
  activeSubagentJobStatuses,
  isActiveSubagentJobStatus,
  isTerminalSubagentJobStatus,
  resultRouteSchema,
  subagentJobSchema,
  type SubagentJob,
  type SubagentJobPatch,
  type SubagentJobStatus,
  type SubagentJobStore,
} from "./jobs.js";
import type { ProviderAdapter, ProviderSession, ProviderTurnEvent } from "./provider.js";

export interface SubagentDispatchInput {
  id?: string;
  workspaceId?: string;
  profile: string;
  prompt: string;
  route?: SubagentJob["route"];
  ownerType?: SubagentJob["ownerType"];
  ownerId?: string;
  ownerRequestId?: string;
  parentTurnId?: string;
  resultTarget?: SubagentJob["resultTarget"];
  timeoutSec?: number;
  model?: string;
  effort?: SubagentJob["effort"];
  summary?: string;
  images?: string[];
  metadata?: JsonRecord;
}

export interface SubagentDispatchPort {
  dispatch(input: SubagentDispatchInput): Promise<string>;
}

export interface SubagentRunResult {
  status?: Extract<SubagentJobStatus, "completed" | "failed" | "cancelled" | "timed_out">;
  outputText?: string;
  error?: string;
  raw?: unknown;
}

export interface StartedSubagentRun {
  readonly provider?: string;
  readonly finished: Promise<SubagentRunResult>;
  cancel?(reason?: string): Promise<void>;
  steer?(text: string): Promise<void>;
  isAlive?(): boolean;
}

export interface SubagentExecutorStartInput {
  signal: AbortSignal;
  artifactDir: string;
  images: string[];
  onJobUpdated(job: SubagentJob): Promise<void>;
}

export interface SubagentExecutor {
  readonly id: string;
  start(job: SubagentJob, input: SubagentExecutorStartInput): Promise<StartedSubagentRun>;
}

export interface SubagentLifecycleOptions {
  workspaceId?: string;
  store: SubagentJobStore;
  executor: SubagentExecutor;
  artifactRoot: string;
  maxConcurrent?: number;
  maxQueueDepth?: number;
  defaultTimeoutSec?: number;
  maxTimeoutSec?: number;
  maxPromptBytes?: number;
  now?: () => Date;
  idFactory?: () => string;
  onTerminal?(job: SubagentJob, result: SubagentRunResult): Promise<void> | void;
}

interface QueuedDispatch {
  id: string;
  input: SubagentDispatchInput;
}

interface RunningSubagentJob {
  job: SubagentJob;
  controller: AbortController;
  run: StartedSubagentRun;
  timeout?: NodeJS.Timeout;
}

export type JobRefResolution =
  | { status: "matched"; ref: string; job: SubagentJob }
  | { status: "not_found"; ref: string }
  | { status: "ambiguous"; ref: string; candidates: JobRefCandidate[] };

export interface JobRefCandidate {
  id: string;
  ref: string;
  status: SubagentJobStatus;
  profile: string;
  summary?: string;
}

export type CancelSubagentJobResult =
  | { status: "success"; ref: string; message: string; job: SubagentJob; previousStatus: SubagentJobStatus }
  | { status: "not_found"; ref: string; message: string }
  | { status: "ambiguous"; ref: string; message: string; candidates: JobRefCandidate[] }
  | { status: "already_terminal" | "already_cancelling"; ref: string; message: string; job: SubagentJob; previousStatus: SubagentJobStatus };

export type SteerSubagentJobResult =
  | { status: "success"; ref: string; message: string; job: SubagentJob }
  | { status: "not_found"; ref: string; message: string }
  | { status: "ambiguous"; ref: string; message: string; candidates: JobRefCandidate[] }
  | { status: "not_running" | "not_steerable" | "failed"; ref: string; message: string; job: SubagentJob };

export interface ActiveSubagentJobSnapshot {
  id: string;
  ref: string;
  status: Extract<SubagentJobStatus, "queued" | "running" | "cancelling">;
  profile: string;
  provider?: string;
  summary?: string;
  ownerType: SubagentJob["ownerType"];
  ownerId?: string;
  route: SubagentJob["route"];
  resultTarget?: SubagentJob["resultTarget"];
  model?: string;
  effort?: SubagentJob["effort"];
  enqueuedAt: string;
  startedAt?: string;
  elapsedSec: number;
  steerable: boolean;
}

export interface ActiveSubagentSnapshot {
  jobs: ActiveSubagentJobSnapshot[];
  omitted: number;
}

export interface SubagentHydrationResult {
  loaded: number;
  abandoned: number;
}

export class SubagentLifecycle implements SubagentDispatchPort {
  private readonly queue: QueuedDispatch[] = [];
  private readonly running = new Map<string, RunningSubagentJob>();
  private readonly idleResolvers = new Set<() => void>();
  private draining = false;

  constructor(private readonly options: SubagentLifecycleOptions) {
    if (options.maxConcurrent !== undefined && options.maxConcurrent < 1) throw new Error("maxConcurrent must be at least 1");
  }

  async init(): Promise<SubagentHydrationResult> {
    await this.options.store.init?.();
    return this.hydratePersistedJobs();
  }

  async hydratePersistedJobs(): Promise<SubagentHydrationResult> {
    const jobs = await this.options.store.list({ workspaceId: this.options.workspaceId });
    let abandoned = 0;
    for (const job of jobs) {
      if (!isActiveSubagentJobStatus(job.status)) continue;
      abandoned++;
      await this.options.store.updateStatus(job.id, "abandoned", {
        abandonedAt: this.nowIso(),
        completedAt: job.completedAt ?? this.nowIso(),
        error: job.error ?? "Job was active in persisted state during runtime startup; not safely recoverable.",
      });
    }
    return { loaded: jobs.length, abandoned };
  }

  async dispatch(input: SubagentDispatchInput): Promise<string> {
    await this.options.store.init?.();
    if (this.queue.length >= (this.options.maxQueueDepth ?? 200)) {
      throw new Error(`Subagent dispatch queue is full (depth=${this.queue.length})`);
    }
    if (Buffer.byteLength(input.prompt, "utf8") > (this.options.maxPromptBytes ?? 512_000)) {
      throw new Error("Subagent prompt exceeds maxPromptBytes");
    }

    const id = input.id ?? this.options.idFactory?.() ?? makeSubagentJobId();
    const route = resultRouteSchema.parse(input.route ?? "return_to_main");
    const artifactDir = path.resolve(this.options.artifactRoot, id);
    const job = subagentJobSchema.parse({
      id,
      workspaceId: input.workspaceId ?? this.options.workspaceId,
      profile: input.profile,
      route,
      ownerType: input.ownerType ?? "main",
      ownerId: input.ownerId,
      ownerRequestId: input.ownerRequestId,
      parentTurnId: input.parentTurnId,
      resultTarget: input.resultTarget ?? resultTargetForRoute(route),
      status: "queued",
      prompt: input.prompt,
      artifactDir,
      provider: this.options.executor.id,
      model: input.model,
      effort: input.effort,
      timeoutSec: input.timeoutSec,
      summary: input.summary,
      enqueuedAt: this.nowIso(),
      metadata: input.metadata,
    });
    await this.options.store.save(job);
    this.queue.push({ id, input });
    await this.drain();
    return id;
  }

  async dispatchFromAction(action: DispatchSubagentAction, event?: EntryPointInboundEvent): Promise<string> {
    return this.dispatch({
      workspaceId: action.workspaceId ?? event?.workspaceId ?? this.options.workspaceId,
      profile: action.profile,
      prompt: action.prompt,
      route: action.route ?? "return_to_main",
      ownerType: "main",
      ownerRequestId: action.idempotencyKey ?? action.id,
      parentTurnId: event ? `turn_${event.id}` : undefined,
      timeoutSec: action.timeoutSec,
      model: action.model,
      effort: action.effort,
      summary: action.summary,
      images: action.images,
      metadata: compactJsonRecord({
        ...(action.metadata ?? {}),
        originatingEventId: action.originatingEventId ?? event?.id,
        actionId: action.id,
      }),
    });
  }

  async listJobs(): Promise<SubagentJob[]> {
    return this.options.store.list({ workspaceId: this.options.workspaceId });
  }

  async activeSnapshot(limit = 20, now = this.options.now?.() ?? new Date()): Promise<ActiveSubagentSnapshot> {
    const jobs = await this.options.store.list({ workspaceId: this.options.workspaceId, statuses: activeSubagentJobStatuses });
    return {
      jobs: jobs.slice(0, limit).map((job) => this.activeJobSnapshot(job, now)),
      omitted: Math.max(0, jobs.length - limit),
    };
  }

  async resolveJobRef(ref: string): Promise<JobRefResolution> {
    const normalized = normalizeJobRef(ref);
    const jobs = await this.listJobs();
    const exact = jobs.find((job) => job.id.toLowerCase() === normalized.toLowerCase());
    if (exact) return { status: "matched", ref, job: exact };

    const candidates = jobs.filter((job) => job.id.toLowerCase().startsWith(normalized.toLowerCase()) || jobHex(job.id).startsWith(normalized.toLowerCase()));
    if (candidates.length === 0) return { status: "not_found", ref };
    if (candidates.length === 1 && candidates[0]) return { status: "matched", ref, job: candidates[0] };
    return { status: "ambiguous", ref, candidates: candidates.map((job) => this.candidateFor(job)) };
  }

  async requestCancel(ref: string, reason = "user"): Promise<CancelSubagentJobResult> {
    const resolution = await this.resolveJobRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No subagent job matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, candidates: resolution.candidates, message: `Ambiguous subagent job ref "${ref}".` };

    const previousStatus = resolution.job.status;
    if (isTerminalSubagentJobStatus(resolution.job.status)) {
      return { status: "already_terminal", ref, job: resolution.job, previousStatus, message: `Subagent job ${resolution.job.id} is already ${resolution.job.status}.` };
    }
    if (resolution.job.status === "cancelling") {
      return { status: "already_cancelling", ref, job: resolution.job, previousStatus, message: `Subagent job ${resolution.job.id} is already cancelling.` };
    }

    if (resolution.job.status === "queued") {
      this.removeQueued(resolution.job.id);
      const cancelled = await this.options.store.updateStatus(resolution.job.id, "cancelled", {
        cancelRequestedAt: this.nowIso(),
        cancelReason: reason,
        completedAt: this.nowIso(),
      });
      this.notifyIdleIfNeeded();
      return { status: "success", ref, job: cancelled, previousStatus, message: `Cancelled queued subagent job ${cancelled.id}.` };
    }

    const running = this.running.get(resolution.job.id);
    if (!running) {
      const abandoned = await this.options.store.updateStatus(resolution.job.id, "abandoned", {
        abandonedAt: this.nowIso(),
        completedAt: this.nowIso(),
        error: resolution.job.error ?? "Job was marked running but no provider run is tracked in this runtime process.",
      });
      this.notifyIdleIfNeeded();
      return { status: "already_terminal", ref, job: abandoned, previousStatus, message: `Subagent job ${abandoned.id} had no tracked provider run and was marked abandoned.` };
    }

    await this.options.store.updateStatus(resolution.job.id, "cancelling", {
      cancelRequestedAt: this.nowIso(),
      cancelReason: reason,
    });
    running.controller.abort(reason);
    await running.run.cancel?.(reason).catch(() => undefined);
    const current = await this.options.store.get(resolution.job.id) ?? resolution.job;
    return { status: "success", ref, job: current, previousStatus, message: `Cancellation requested for subagent job ${resolution.job.id}.` };
  }

  async steerJob(ref: string, text: string): Promise<SteerSubagentJobResult> {
    const steeringText = text.trim();
    const resolution = await this.resolveJobRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No subagent job matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, candidates: resolution.candidates, message: `Ambiguous subagent job ref "${ref}".` };
    if (resolution.job.status !== "running") return { status: "not_running", ref, job: resolution.job, message: `Subagent job ${resolution.job.id} is ${resolution.job.status}, not running.` };
    const running = this.running.get(resolution.job.id);
    if (!running?.run.steer) return { status: "not_steerable", ref, job: resolution.job, message: `Subagent job ${resolution.job.id} is not steerable by its provider.` };
    if (!steeringText) return { status: "failed", ref, job: resolution.job, message: "Steering text cannot be empty." };

    try {
      await running.run.steer(steeringText);
      const updated = await this.options.store.update(resolution.job.id, {
        lastSteeredAt: this.nowIso(),
        steerCount: (resolution.job.steerCount ?? 0) + 1,
      });
      return { status: "success", ref, job: updated, message: `Steered subagent job ${updated.id}.` };
    } catch (error) {
      return { status: "failed", ref, job: resolution.job, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async waitForIdle(timeoutMs = 5_000): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleResolvers.delete(done);
        reject(new Error(`Timed out waiting for subagent lifecycle to become idle after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.idleResolvers.add(done);
    });
  }

  async shutdown(reason = "shutdown"): Promise<void> {
    const active = await this.options.store.list({ workspaceId: this.options.workspaceId, statuses: activeSubagentJobStatuses });
    await Promise.all(active.map((job) => this.requestCancel(job.id, reason).catch(() => undefined)));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running.size < (this.options.maxConcurrent ?? 1) && this.queue.length > 0) {
        const queued = this.queue.shift();
        if (!queued) break;
        const job = await this.options.store.get(queued.id);
        if (!job || job.status !== "queued") continue;
        await this.startJob(job, queued.input).catch(async (error) => {
          await this.options.store.updateStatus(job.id, "failed", {
            completedAt: this.nowIso(),
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } finally {
      this.draining = false;
      this.notifyIdleIfNeeded();
    }
  }

  private async startJob(job: SubagentJob, input: SubagentDispatchInput): Promise<void> {
    await mkdir(job.artifactDir, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    const started = await this.options.store.updateStatus(job.id, "running", {
      startedAt: this.nowIso(),
      provider: this.options.executor.id,
    });
    const run = await this.options.executor.start(started, {
      signal: controller.signal,
      artifactDir: started.artifactDir,
      images: input.images ?? [],
      onJobUpdated: (updatedJob) => this.options.store.save(updatedJob),
    });
    const timeoutSec = Math.min(input.timeoutSec ?? this.options.defaultTimeoutSec ?? 3_600, this.options.maxTimeoutSec ?? 7_200);
    const timeout = setTimeout(() => {
      void this.requestCancel(job.id, "timeout");
    }, timeoutSec * 1000);
    timeout.unref?.();
    this.running.set(job.id, { job: started, controller, run, timeout });
    void run.finished.then(
      (result) => this.finishJob(job.id, result),
      (error) => this.finishJob(job.id, { status: "failed", error: error instanceof Error ? error.message : String(error) }),
    );
  }

  private async finishJob(jobId: string, result: SubagentRunResult): Promise<void> {
    const running = this.running.get(jobId);
    if (!running) return;
    this.running.delete(jobId);
    if (running.timeout) clearTimeout(running.timeout);

    const current = await this.options.store.get(jobId) ?? running.job;
    const status = terminalStatusFor(current, result);
    const patch: SubagentJobPatch = {
      status,
      completedAt: this.nowIso(),
      resultText: result.outputText,
      error: result.error,
      lastMessagePath: lastArtifactPathFromResult(result),
    };
    const updated = await this.options.store.update(jobId, patch);
    await this.options.onTerminal?.(updated, result);
    await this.drain();
    this.notifyIdleIfNeeded();
  }

  private activeJobSnapshot(job: SubagentJob, now: Date): ActiveSubagentJobSnapshot {
    const elapsedFrom = job.status === "queued" ? job.enqueuedAt : job.startedAt ?? job.enqueuedAt;
    const elapsedMs = now.getTime() - new Date(elapsedFrom).getTime();
    return {
      id: job.id,
      ref: shortRef(job.id),
      status: job.status as Extract<SubagentJobStatus, "queued" | "running" | "cancelling">,
      profile: job.profile,
      provider: job.provider,
      summary: job.summary,
      ownerType: job.ownerType,
      ownerId: job.ownerId,
      route: job.route,
      resultTarget: job.resultTarget,
      model: job.model,
      effort: job.effort,
      enqueuedAt: job.enqueuedAt,
      startedAt: job.startedAt,
      elapsedSec: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs / 1000)) : 0,
      steerable: job.status === "running" && Boolean(this.running.get(job.id)?.run.steer),
    };
  }

  private candidateFor(job: SubagentJob): JobRefCandidate {
    return { id: job.id, ref: shortRef(job.id), status: job.status, profile: job.profile, summary: job.summary };
  }

  private removeQueued(id: string): void {
    const index = this.queue.findIndex((queued) => queued.id === id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.running.size === 0 && !this.draining;
  }

  private notifyIdleIfNeeded(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

export interface StaticSubagentExecutorOptions {
  id?: string;
  delayMs?: number;
  outputText?: string;
  fail?: boolean;
}

export class StaticSubagentExecutor implements SubagentExecutor {
  readonly id: string;

  constructor(private readonly options: StaticSubagentExecutorOptions = {}) {
    this.id = options.id ?? "static";
  }

  async start(job: SubagentJob, input: SubagentExecutorStartInput): Promise<StartedSubagentRun> {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finished = new Promise<SubagentRunResult>((resolve) => {
      const settle = (result: SubagentRunResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      input.signal.addEventListener("abort", () => settle({ status: "cancelled", error: String(input.signal.reason ?? "cancelled") }), { once: true });
      timer = setTimeout(() => {
        if (this.options.fail) settle({ status: "failed", error: `Static executor failed job ${job.id}` });
        else settle({ status: "completed", outputText: this.options.outputText ?? `Static executor completed ${job.profile}` });
      }, this.options.delayMs ?? 0);
    });
    return {
      provider: this.id,
      finished,
      cancel: async () => undefined,
      isAlive: () => !settled,
    };
  }
}

export interface ProviderSubagentExecutorOptions {
  id?: string;
  provider: ProviderAdapter;
  workspaceId?: string;
  entrypointId?: string;
  entrypointDisplayName?: string;
  sessionMetadata?: JsonRecord;
  now?: () => Date;
}

export class ProviderSubagentExecutor implements SubagentExecutor {
  readonly id: string;

  constructor(private readonly options: ProviderSubagentExecutorOptions) {
    this.id = options.id ?? `provider:${options.provider.id}`;
  }

  async start(job: SubagentJob, input: SubagentExecutorStartInput): Promise<StartedSubagentRun> {
    const workspaceId = job.workspaceId ?? this.options.workspaceId ?? "default";
    const session = await this.options.provider.createSession({
      workspaceId,
      metadata: compactJsonRecord({
        ...(this.options.sessionMetadata ?? {}),
        subagentJobId: job.id,
        subagentProfile: job.profile,
      }),
    });
    await session.start();

    let alive = true;
    const turnId = `turn_${job.id}`;
    const finished = this.runProviderTurn(session, job, input, workspaceId, turnId)
      .finally(async () => {
        alive = false;
        await session.stop().catch(() => undefined);
      });

    input.signal.addEventListener("abort", () => {
      void session.cancelTurn?.(turnId, String(input.signal.reason ?? "cancelled")).catch(() => undefined);
    }, { once: true });

    const steer = session.steerTurn ? async (text: string): Promise<void> => {
      await session.steerTurn?.(turnId, text);
    } : undefined;

    return {
      provider: this.id,
      finished,
      cancel: async (reason) => {
        await session.cancelTurn?.(turnId, reason);
        await session.stop();
      },
      steer,
      isAlive: () => alive,
    };
  }

  private async runProviderTurn(
    session: ProviderSession,
    job: SubagentJob,
    input: SubagentExecutorStartInput,
    workspaceId: string,
    turnId: string,
  ): Promise<SubagentRunResult> {
    const events: ProviderTurnEvent[] = [];
    let finalText: string | undefined;
    let error: string | undefined;
    let lastArtifactPath: string | undefined;

    try {
      for await (const event of session.sendTurn({
        id: turnId,
        sessionId: session.id,
        inboundEvent: providerSubagentInboundEvent(job, workspaceId, this.options, turnId),
        prompt: job.prompt,
        attachments: imageAttachments(input.images),
        artifactDir: input.artifactDir,
        abortSignal: input.signal,
        metadata: compactJsonRecord({
          ...(job.metadata ?? {}),
          subagentJobId: job.id,
          subagentProfile: job.profile,
          route: job.route,
        }),
      })) {
        events.push(event);
        if (event.type === "final") finalText = event.text;
        if (event.type === "error") error = event.message;
        if (event.type === "artifact" && event.artifact.localPath) {
          lastArtifactPath = event.artifact.localPath;
        }
      }
    } catch (caught) {
      if (input.signal.aborted) {
        return { status: "cancelled", error: String(input.signal.reason ?? "cancelled"), raw: { providerEvents: events } };
      }
      return { status: "failed", error: caught instanceof Error ? caught.message : String(caught), raw: { providerEvents: events } };
    }

    if (input.signal.aborted) {
      return { status: "cancelled", error: String(input.signal.reason ?? "cancelled"), raw: { providerEvents: events, lastArtifactPath } };
    }
    if (error && !finalText) {
      return { status: "failed", error, raw: { providerEvents: events, lastArtifactPath } };
    }
    return {
      status: "completed",
      outputText: finalText ?? events.filter((event) => event.type === "delta").map((event) => event.text).join("").trim(),
      error,
      raw: { providerEvents: events, lastArtifactPath },
    };
  }
}

function resultTargetForRoute(route: SubagentJob["route"]): SubagentJob["resultTarget"] {
  if (route === "send_to_user") return "user";
  if (route === "send_to_admins") return "admins";
  if (route === "store_only") return "store_only";
  if (route === "silent") return "silent";
  return "main";
}

function providerSubagentInboundEvent(job: SubagentJob, workspaceId: string, options: ProviderSubagentExecutorOptions, turnId: string): EntryPointInboundEvent {
  return {
    id: `subagent_${job.id}`,
    kind: "message",
    workspaceId,
    entrypoint: {
      entrypointId: options.entrypointId ?? "subagent-runtime",
      channelKind: "system",
      displayName: options.entrypointDisplayName ?? "Subagent runtime",
    },
    text: job.prompt,
    receivedAt: (options.now?.() ?? new Date()).toISOString(),
    correlationId: turnId,
    metadata: compactJsonRecord({
      subagentJobId: job.id,
      profile: job.profile,
      ownerType: job.ownerType,
      ownerId: job.ownerId,
    }),
  };
}

function imageAttachments(images: string[]): BrainAttachment[] {
  return images.map((localPath, index) => ({
    id: `image_${index + 1}`,
    kind: "image",
    localPath,
  }));
}

function terminalStatusFor(job: SubagentJob, result: SubagentRunResult): SubagentJobStatus {
  if (job.status === "cancelling") return job.cancelReason === "timeout" ? "timed_out" : "cancelled";
  if (result.status === "failed") return "failed";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "timed_out") return "timed_out";
  if (result.error) return "failed";
  return "completed";
}

function lastArtifactPathFromResult(result: SubagentRunResult): string | undefined {
  const raw = result.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as { lastArtifactPath?: unknown }).lastArtifactPath;
  return typeof value === "string" && value ? value : undefined;
}

function makeSubagentJobId(): string {
  return `job_${randomUUID().replaceAll("-", "")}`;
}

function normalizeJobRef(ref: string): string {
  return ref.trim().replace(/^[[(<]+/, "").replace(/[\])>.,;:]+$/, "");
}

function jobHex(id: string): string {
  return id.startsWith("job_") ? id.slice(4).toLowerCase() : id.toLowerCase();
}

function shortRef(id: string): string {
  const hex = jobHex(id);
  return hex.slice(0, Math.min(8, hex.length));
}

function compactJsonRecord(record: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as JsonRecord;
}
