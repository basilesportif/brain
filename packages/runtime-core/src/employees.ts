import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { FileRuntimeStateStore } from "./jobs.js";
import type { JsonRecord } from "@brain/entrypoint-protocol";

export const employeeStatusSchema = z.enum(["stopped", "running", "failed"]);
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>;

export const employeeRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  profile: z.string().min(1).default("employee"),
  label: z.string().min(1).optional(),
  status: employeeStatusSchema.default("stopped"),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  prompt: z.string().optional(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  stoppedAt: z.string().datetime().optional(),
  lastSteeredAt: z.string().datetime().optional(),
  steerCount: z.number().int().nonnegative().default(0),
  lastInstruction: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type EmployeeRecord = z.infer<typeof employeeRecordSchema>;
export type EmployeePatch = Partial<Omit<EmployeeRecord, "id">>;

export interface EmployeeListFilter {
  workspaceId?: string;
  statuses?: readonly EmployeeStatus[];
}

export interface EmployeeStore {
  init?(): Promise<void>;
  save(employee: EmployeeRecord): Promise<void>;
  get(id: string): Promise<EmployeeRecord | undefined>;
  list(filter?: EmployeeListFilter): Promise<EmployeeRecord[]>;
  update(id: string, patch: EmployeePatch): Promise<EmployeeRecord>;
}

export interface EmployeeStartInput {
  id: string;
  workspaceId?: string;
  profile?: string;
  label?: string;
  prompt?: string;
  model?: string;
  effort?: EmployeeRecord["effort"];
  metadata?: JsonRecord;
}

export type EmployeeRefResolution =
  | { status: "matched"; ref: string; employee: EmployeeRecord }
  | { status: "not_found"; ref: string }
  | { status: "ambiguous"; ref: string; candidates: EmployeeCandidate[] };

export interface EmployeeCandidate {
  id: string;
  status: EmployeeStatus;
  profile: string;
  label?: string;
}

export type EmployeeLifecycleResult =
  | { status: "success"; ref: string; message: string; employee: EmployeeRecord; previousStatus?: EmployeeStatus }
  | { status: "not_found"; ref: string; message: string }
  | { status: "ambiguous"; ref: string; message: string; candidates: EmployeeCandidate[] }
  | { status: "failed"; ref: string; message: string; employee?: EmployeeRecord };

export interface EmployeeControlPort {
  listEmployees?(): Promise<EmployeeRecord[]>;
  resolveEmployeeRef?(ref: string): Promise<EmployeeRefResolution>;
  startEmployee(input: EmployeeStartInput): Promise<EmployeeLifecycleResult>;
  stopEmployee(ref: string, reason?: string): Promise<EmployeeLifecycleResult>;
  steerEmployee(ref: string, text: string): Promise<EmployeeLifecycleResult>;
}

export interface EmployeeLifecycleOptions {
  workspaceId?: string;
  store: EmployeeStore;
  provider?: string;
  now?: () => Date;
}

export class EmployeeLifecycle implements EmployeeControlPort {
  constructor(private readonly options: EmployeeLifecycleOptions) {}

  async init(): Promise<void> {
    await this.options.store.init?.();
  }

  async listEmployees(): Promise<EmployeeRecord[]> {
    await this.options.store.init?.();
    return this.options.store.list({ workspaceId: this.options.workspaceId });
  }

  async resolveEmployeeRef(ref: string): Promise<EmployeeRefResolution> {
    const normalized = normalizeRef(ref);
    const employees = await this.listEmployees();
    const exact = employees.find((employee) => employee.id.toLowerCase() === normalized.toLowerCase());
    if (exact) return { status: "matched", ref, employee: exact };
    const candidates = employees.filter((employee) => employee.id.toLowerCase().startsWith(normalized.toLowerCase()));
    if (candidates.length === 0) return { status: "not_found", ref };
    if (candidates.length === 1 && candidates[0]) return { status: "matched", ref, employee: candidates[0] };
    return { status: "ambiguous", ref, candidates: candidates.map(employeeCandidate) };
  }

  async startEmployee(input: EmployeeStartInput): Promise<EmployeeLifecycleResult> {
    await this.options.store.init?.();
    const id = normalizeRef(input.id);
    if (!id) return { status: "failed", ref: input.id, message: "Employee id cannot be empty." };
    const now = this.nowIso();
    const existing = await this.options.store.get(id);
    const previousStatus = existing?.status;
    const employee = existing
      ? await this.options.store.update(id, {
        status: "running",
        workspaceId: input.workspaceId ?? existing.workspaceId ?? this.options.workspaceId,
        profile: input.profile ?? existing.profile,
        label: input.label ?? existing.label,
        prompt: input.prompt ?? existing.prompt,
        model: input.model ?? existing.model,
        effort: input.effort ?? existing.effort,
        provider: this.options.provider ?? existing.provider ?? "configured-at-runtime",
        startedAt: now,
        stoppedAt: undefined,
        error: undefined,
        metadata: input.metadata ?? existing.metadata,
      })
      : await this.createEmployee({ ...input, id }, now);
    return {
      status: "success",
      ref: input.id,
      employee,
      previousStatus,
      message: previousStatus === "running"
        ? `Employee ${employee.id} was already running; metadata refreshed.`
        : `Employee ${employee.id} marked running through the safe lifecycle seam.`,
    };
  }

  async stopEmployee(ref: string, reason = "operator"): Promise<EmployeeLifecycleResult> {
    const resolution = await this.resolveEmployeeRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No employee matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, message: `Ambiguous employee ref "${ref}".`, candidates: resolution.candidates };
    const previousStatus = resolution.employee.status;
    if (previousStatus === "stopped") {
      return { status: "success", ref, employee: resolution.employee, previousStatus, message: `Employee ${resolution.employee.id} is already stopped.` };
    }
    const employee = await this.options.store.update(resolution.employee.id, {
      status: "stopped",
      stoppedAt: this.nowIso(),
      error: reason,
    });
    return { status: "success", ref, employee, previousStatus, message: `Employee ${employee.id} marked stopped.` };
  }

  async steerEmployee(ref: string, text: string): Promise<EmployeeLifecycleResult> {
    const instruction = text.trim();
    const resolution = await this.resolveEmployeeRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No employee matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, message: `Ambiguous employee ref "${ref}".`, candidates: resolution.candidates };
    if (!instruction) return { status: "failed", ref, employee: resolution.employee, message: "Employee steering text cannot be empty." };
    if (resolution.employee.status !== "running") {
      return { status: "failed", ref, employee: resolution.employee, message: `Employee ${resolution.employee.id} is ${resolution.employee.status}, not running.` };
    }
    const employee = await this.options.store.update(resolution.employee.id, {
      lastInstruction: instruction,
      lastSteeredAt: this.nowIso(),
      steerCount: (resolution.employee.steerCount ?? 0) + 1,
    });
    return { status: "success", ref, employee, previousStatus: resolution.employee.status, message: `Recorded steering instruction for employee ${employee.id}.` };
  }

  private async createEmployee(input: EmployeeStartInput, now: string): Promise<EmployeeRecord> {
    const employee = employeeRecordSchema.parse({
      id: input.id,
      workspaceId: input.workspaceId ?? this.options.workspaceId,
      profile: input.profile ?? "employee",
      label: input.label,
      status: "running",
      provider: this.options.provider ?? "configured-at-runtime",
      model: input.model,
      effort: input.effort,
      prompt: input.prompt,
      createdAt: now,
      startedAt: now,
      steerCount: 0,
      metadata: input.metadata,
    });
    await this.options.store.save(employee);
    return cloneEmployee(employee);
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

export class InMemoryEmployeeStore implements EmployeeStore {
  private readonly employees = new Map<string, EmployeeRecord>();

  async init(): Promise<void> {}

  async save(employee: EmployeeRecord): Promise<void> {
    this.employees.set(employee.id, employeeRecordSchema.parse(employee));
  }

  async get(id: string): Promise<EmployeeRecord | undefined> {
    const employee = this.employees.get(id);
    return employee ? cloneEmployee(employee) : undefined;
  }

  async list(filter: EmployeeListFilter = {}): Promise<EmployeeRecord[]> {
    return filterEmployees([...this.employees.values()], filter).map(cloneEmployee);
  }

  async update(id: string, patch: EmployeePatch): Promise<EmployeeRecord> {
    const current = this.employees.get(id);
    if (!current) throw new Error(`Unknown employee: ${id}`);
    const next = employeeRecordSchema.parse({ ...current, ...stripUndefined(patch) });
    this.employees.set(id, next);
    return cloneEmployee(next);
  }
}

export class FileEmployeeStore implements EmployeeStore {
  readonly state: FileRuntimeStateStore;

  constructor(options: FileRuntimeStateStore | { root?: string; workspacePath?: string; stateDir?: string }) {
    this.state = options instanceof FileRuntimeStateStore ? options : new FileRuntimeStateStore(options);
  }

  async init(): Promise<void> {
    await this.state.init();
    await mkdir(this.state.path("employees"), { recursive: true, mode: 0o700 });
  }

  async save(employee: EmployeeRecord): Promise<void> {
    await this.state.writeJson(this.relativeEmployeePath(employee.id), employeeRecordSchema.parse(employee));
  }

  async get(id: string): Promise<EmployeeRecord | undefined> {
    try {
      return cloneEmployee(employeeRecordSchema.parse(JSON.parse(await readFile(this.employeePath(id), "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(filter: EmployeeListFilter = {}): Promise<EmployeeRecord[]> {
    await this.init();
    const files = await readdir(this.state.path("employees")).catch(() => []);
    const employees: EmployeeRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        employees.push(employeeRecordSchema.parse(JSON.parse(await readFile(path.join(this.state.path("employees"), file), "utf8"))));
      } catch {
        // Ignore malformed historical employee state so one bad file does not
        // prevent lifecycle inspection.
      }
    }
    return filterEmployees(employees, filter).map(cloneEmployee);
  }

  async update(id: string, patch: EmployeePatch): Promise<EmployeeRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown employee: ${id}`);
    const next = employeeRecordSchema.parse({ ...current, ...stripUndefined(patch) });
    await this.save(next);
    return cloneEmployee(next);
  }

  private relativeEmployeePath(id: string): string {
    return `employees/${encodeURIComponent(id)}.json`;
  }

  private employeePath(id: string): string {
    return this.state.path(this.relativeEmployeePath(id));
  }
}

function filterEmployees(employees: EmployeeRecord[], filter: EmployeeListFilter): EmployeeRecord[] {
  const statuses = filter.statuses ? new Set(filter.statuses) : undefined;
  return employees
    .filter((employee) => filter.workspaceId === undefined || employee.workspaceId === filter.workspaceId)
    .filter((employee) => statuses === undefined || statuses.has(employee.status))
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt) || a.id.localeCompare(b.id));
}

function employeeCandidate(employee: EmployeeRecord): EmployeeCandidate {
  return { id: employee.id, status: employee.status, profile: employee.profile, label: employee.label };
}

function normalizeRef(ref: string): string {
  return ref.trim().replace(/^[[(<]+/, "").replace(/[\])>.,;:]+$/, "");
}

function stripUndefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function cloneEmployee(employee: EmployeeRecord): EmployeeRecord {
  return structuredClone(employee);
}
