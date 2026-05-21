import { z } from "zod";

export const providerEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export const resultRouteSchema = z.enum(["return_to_main", "send_to_user", "send_progress_and_return", "send_to_admins", "dispatch_subagent", "store_only", "silent"]);

export const subagentJobSchema = z.object({
  id: z.string().min(1),
  profile: z.string().min(1),
  route: resultRouteSchema.default("return_to_main"),
  ownerType: z.enum(["main", "loop", "monitor", "employee", "system"]).default("main"),
  ownerId: z.string().optional(),
  parentTurnId: z.string().optional(),
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled", "timed_out", "abandoned"]).default("queued"),
  prompt: z.string().min(1),
  artifactDir: z.string().min(1),
  model: z.string().optional(),
  effort: providerEffortSchema.optional(),
  summary: z.string().optional(),
  enqueuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
}).strict();
export type SubagentJob = z.infer<typeof subagentJobSchema>;

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

export class InMemorySubagentJobStore {
  private readonly jobs = new Map<string, SubagentJob>();

  async save(job: SubagentJob): Promise<void> {
    this.jobs.set(job.id, subagentJobSchema.parse(job));
  }

  async get(id: string): Promise<SubagentJob | undefined> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async list(): Promise<SubagentJob[]> {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  async updateStatus(id: string, status: SubagentJob["status"], fields: Partial<Pick<SubagentJob, "startedAt" | "completedAt" | "error">> = {}): Promise<SubagentJob> {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`Unknown subagent job: ${id}`);
    const next = subagentJobSchema.parse({ ...current, ...fields, status });
    this.jobs.set(id, next);
    return structuredClone(next);
  }
}
