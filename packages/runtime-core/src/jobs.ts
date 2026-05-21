import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const providerEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export const resultRouteSchema = z.enum(["return_to_main", "send_to_user", "send_progress_and_return", "send_to_admins", "dispatch_subagent", "store_only", "silent"]);
export const subagentJobStatusSchema = z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled", "timed_out", "abandoned"]);
export type SubagentJobStatus = z.infer<typeof subagentJobStatusSchema>;

export const activeSubagentJobStatuses = ["queued", "running", "cancelling"] as const satisfies readonly SubagentJobStatus[];
export const terminalSubagentJobStatuses = ["completed", "failed", "cancelled", "timed_out", "abandoned"] as const satisfies readonly SubagentJobStatus[];
const activeSubagentJobStatusSet = new Set<SubagentJobStatus>(activeSubagentJobStatuses);
const terminalSubagentJobStatusSet = new Set<SubagentJobStatus>(terminalSubagentJobStatuses);

export function isActiveSubagentJobStatus(status: SubagentJobStatus): boolean {
  return activeSubagentJobStatusSet.has(status);
}

export function isTerminalSubagentJobStatus(status: SubagentJobStatus): boolean {
  return terminalSubagentJobStatusSet.has(status);
}

export const subagentJobSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  profile: z.string().min(1),
  route: resultRouteSchema.default("return_to_main"),
  ownerType: z.enum(["main", "loop", "monitor", "employee", "system"]).default("main"),
  ownerId: z.string().optional(),
  ownerRequestId: z.string().optional(),
  parentTurnId: z.string().optional(),
  resultTarget: z.enum(["main", "user", "employee", "admins", "store_only", "silent"]).optional(),
  status: subagentJobStatusSchema.default("queued"),
  prompt: z.string().min(1),
  artifactDir: z.string().min(1),
  promptPath: z.string().optional(),
  lastMessagePath: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: providerEffortSchema.optional(),
  timeoutSec: z.number().int().positive().optional(),
  summary: z.string().optional(),
  enqueuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  abandonedAt: z.string().datetime().optional(),
  cancelRequestedAt: z.string().datetime().optional(),
  cancelReason: z.string().optional(),
  lastSteeredAt: z.string().datetime().optional(),
  steerCount: z.number().int().nonnegative().optional(),
  resultText: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type SubagentJob = z.infer<typeof subagentJobSchema>;
export type SubagentJobPatch = Partial<Omit<SubagentJob, "id">>;

export interface SubagentJobListFilter {
  workspaceId?: string;
  statuses?: readonly SubagentJobStatus[];
  ownerType?: SubagentJob["ownerType"];
  ownerId?: string;
}

export interface SubagentJobStore {
  init?(): Promise<void>;
  save(job: SubagentJob): Promise<void>;
  get(id: string): Promise<SubagentJob | undefined>;
  list(filter?: SubagentJobListFilter): Promise<SubagentJob[]>;
  update(id: string, patch: SubagentJobPatch): Promise<SubagentJob>;
  updateStatus(id: string, status: SubagentJobStatus, fields?: SubagentJobPatch): Promise<SubagentJob>;
}

export const loopDefinitionSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(false),
  description: z.string().optional(),
  schedule: z.string().min(1),
  timezone: z.string().default("Etc/UTC"),
  type: z.enum(["prompt", "command", "dispatch_subagent"]),
  prompt: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  route: resultRouteSchema.default("return_to_main"),
  profile: z.string().optional(),
  timeoutSec: z.number().int().positive().default(1800),
  model: z.string().optional(),
  effort: providerEffortSchema.optional(),
  lock: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(false),
}).strict().superRefine((loop, ctx) => {
  if (loop.type === "prompt" && !loop.prompt) ctx.addIssue({ code: "custom", message: "prompt loops require prompt" });
  if (loop.type === "command" && !loop.command) ctx.addIssue({ code: "custom", message: "command loops require command" });
  if (loop.type === "dispatch_subagent" && (!loop.prompt || !loop.profile)) ctx.addIssue({ code: "custom", message: "dispatch_subagent loops require prompt and profile" });
});
export type LoopDefinition = z.infer<typeof loopDefinitionSchema>;

export const monitorDefinitionSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(false),
  description: z.string().optional(),
  source: z.enum(["filesystem", "http", "command", "entrypoint", "custom"]),
  schedule: z.string().optional(),
  route: resultRouteSchema.default("return_to_main"),
  prompt: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type MonitorDefinition = z.infer<typeof monitorDefinitionSchema>;

export type RuntimeJob = SubagentJob | { kind: "loop"; definition: LoopDefinition } | { kind: "monitor"; definition: MonitorDefinition };

export class InMemorySubagentJobStore implements SubagentJobStore {
  private readonly jobs = new Map<string, SubagentJob>();

  async init(): Promise<void> {
    // No-op: memory store has no backing directories to prepare.
  }

  async save(job: SubagentJob): Promise<void> {
    this.jobs.set(job.id, subagentJobSchema.parse(job));
  }

  async get(id: string): Promise<SubagentJob | undefined> {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  async list(filter: SubagentJobListFilter = {}): Promise<SubagentJob[]> {
    return filterJobs([...this.jobs.values()], filter).map((job) => cloneJob(job));
  }

  async update(id: string, patch: SubagentJobPatch): Promise<SubagentJob> {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`Unknown subagent job: ${id}`);
    const next = subagentJobSchema.parse({ ...current, ...patch });
    this.jobs.set(id, next);
    return cloneJob(next);
  }

  async updateStatus(id: string, status: SubagentJobStatus, fields: SubagentJobPatch = {}): Promise<SubagentJob> {
    return this.update(id, { ...fields, status });
  }
}

export interface FileRuntimeStateStoreOptions {
  /** Root directory for runtime state. Use this when state is already resolved. */
  root?: string;
  /** Workspace root used with stateDir when root is not supplied. */
  workspacePath?: string;
  /** State directory relative to workspacePath; defaults to "state". */
  stateDir?: string;
  schemaVersion?: number;
}

export class FileRuntimeStateStore {
  readonly root: string;
  private readonly schemaVersion: number;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: FileRuntimeStateStoreOptions) {
    if (options.root) this.root = path.resolve(options.root);
    else if (options.workspacePath) this.root = path.resolve(options.workspacePath, options.stateDir ?? "state");
    else throw new Error("FileRuntimeStateStore requires either root or workspacePath");
    this.schemaVersion = options.schemaVersion ?? 1;
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const dir of ["jobs", "events", "values", "idempotency"]) {
      await mkdir(this.path(dir), { recursive: true, mode: 0o700 });
    }
    const schemaPath = this.path("schema.json");
    try {
      await readFile(schemaPath, "utf8");
    } catch {
      await this.writeJson("schema.json", { version: this.schemaVersion, createdAt: new Date().toISOString() });
    }
  }

  path(relativePath: string): string {
    if (path.isAbsolute(relativePath)) throw new Error(`State path must be relative: ${relativePath}`);
    const resolved = path.resolve(this.root, relativePath);
    if (!isInsidePath(resolved, this.root)) throw new Error(`State path escapes root: ${relativePath}`);
    return resolved;
  }

  async readJson<T>(relativePath: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path(relativePath), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.serialized(this.path(relativePath), (target) => atomicWriteJson(target, value));
  }

  async appendJsonl(relativePath: string, value: unknown): Promise<void> {
    const target = this.path(relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await appendFile(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  private async serialized(target: string, write: (target: string) => Promise<void>): Promise<void> {
    const previous = this.queues.get(target) ?? Promise.resolve();
    const next = previous.then(() => write(target));
    this.queues.set(target, next.catch(() => undefined));
    await next;
  }
}

export interface FileSubagentJobStoreOptions {
  /** Root state directory. Jobs are stored under root/jobs. */
  root?: string;
  /** Workspace root used with stateDir when root is not supplied. */
  workspacePath?: string;
  /** State directory relative to workspacePath; defaults to "state". */
  stateDir?: string;
}

export class FileSubagentJobStore implements SubagentJobStore {
  readonly state: FileRuntimeStateStore;

  constructor(options: FileSubagentJobStoreOptions | FileRuntimeStateStore) {
    this.state = options instanceof FileRuntimeStateStore ? options : new FileRuntimeStateStore(options);
  }

  async init(): Promise<void> {
    await this.state.init();
    await mkdir(this.state.path("jobs"), { recursive: true, mode: 0o700 });
  }

  async save(job: SubagentJob): Promise<void> {
    await this.state.writeJson(this.relativeJobPath(job.id), subagentJobSchema.parse(job));
  }

  async get(id: string): Promise<SubagentJob | undefined> {
    try {
      const parsed = subagentJobSchema.parse(JSON.parse(await readFile(this.jobPath(id), "utf8")));
      return cloneJob(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(filter: SubagentJobListFilter = {}): Promise<SubagentJob[]> {
    await this.init();
    const dir = this.state.path("jobs");
    const files = await readdir(dir).catch(() => []);
    const jobs: SubagentJob[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        jobs.push(subagentJobSchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8"))));
      } catch {
        // Ignore malformed historical state files so one bad job does not
        // prevent the runtime from hydrating all other jobs.
      }
    }
    return filterJobs(jobs, filter).map((job) => cloneJob(job));
  }

  async update(id: string, patch: SubagentJobPatch): Promise<SubagentJob> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown subagent job: ${id}`);
    const next = subagentJobSchema.parse({ ...current, ...patch });
    await this.save(next);
    return cloneJob(next);
  }

  async updateStatus(id: string, status: SubagentJobStatus, fields: SubagentJobPatch = {}): Promise<SubagentJob> {
    return this.update(id, { ...fields, status });
  }

  private relativeJobPath(id: string): string {
    return `jobs/${encodeURIComponent(id)}.json`;
  }

  private jobPath(id: string): string {
    return this.state.path(this.relativeJobPath(id));
  }
}

function filterJobs(jobs: SubagentJob[], filter: SubagentJobListFilter): SubagentJob[] {
  const statuses = filter.statuses ? new Set(filter.statuses) : undefined;
  return jobs
    .filter((job) => filter.workspaceId === undefined || job.workspaceId === filter.workspaceId)
    .filter((job) => statuses === undefined || statuses.has(job.status))
    .filter((job) => filter.ownerType === undefined || job.ownerType === filter.ownerType)
    .filter((job) => filter.ownerId === undefined || job.ownerId === filter.ownerId)
    .sort((a, b) => jobSortTime(b).localeCompare(jobSortTime(a)) || a.id.localeCompare(b.id));
}

function jobSortTime(job: SubagentJob): string {
  return job.startedAt ?? job.enqueuedAt ?? job.completedAt ?? job.abandonedAt ?? "";
}

function cloneJob(job: SubagentJob): SubagentJob {
  return structuredClone(job);
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

function isInsidePath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}
