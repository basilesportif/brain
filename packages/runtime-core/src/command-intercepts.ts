import type { BrainOutboundAction, EntryPointInboundEvent, JsonRecord } from "@brain/entrypoint-protocol";
import type { SubagentJob, SubagentJobStatus } from "./jobs.js";
import type { ActiveSubagentSnapshot, CancelSubagentJobResult, JobRefResolution, SteerSubagentJobResult, SubagentControlPort } from "./subagents.js";

export interface RuntimeLogEntry {
  at?: string;
  level?: string;
  component?: string;
  message?: string;
  raw?: unknown;
}

export interface RuntimeLogReader {
  tail(lines: number, options?: { includeRaw?: boolean }): Promise<RuntimeLogEntry[]>;
}

export interface RuntimeHealthProvider {
  health(): Promise<unknown> | unknown;
}

export interface SubagentInspectionPort extends SubagentControlPort {
  listJobs?(): Promise<SubagentJob[]>;
  activeSnapshot?(limit?: number, now?: Date): Promise<ActiveSubagentSnapshot>;
  resolveJobRef?(ref: string): Promise<JobRefResolution>;
}

export interface RuntimeCommandInterceptorOptions {
  subagents?: SubagentInspectionPort;
  logs?: RuntimeLogReader;
  health?: RuntimeHealthProvider;
  maxLogLines?: number;
  now?: () => Date;
}

export interface RuntimeCommandInterceptResult {
  handled: boolean;
  command: string;
  actions: BrainOutboundAction[];
  details?: JsonRecord;
}

export const BRAIN_SERVICE_HELP_TEXT = `Brain service commands (handled before provider turns):

  help                    — this message
  health                  — supervisor/runtime health snapshot
  logs [N]                — last N runtime log lines (default 100)
  logs raw [N]            — include raw structured log payloads when available
  introspect [N]          — alias for logs
  agents                  — active subagent jobs and usable refs
  agents detail           — active jobs plus 10 recent terminal jobs
  agents <N>              — active jobs plus N recent terminal jobs
  agent status <ref>      — mechanical subagent status for one job
  agent kill <ref>        — cancel a subagent by full ID, displayed ref, or hex prefix
  agent steer <ref> <text> — steer a running steerable subagent
  agent backend           — show backend seam status (configuration-only in Brain)
  employees               — Employee runtime seam status (real lifecycle not wired yet)
  update / deploy         — safe seam only; Brain does not self-deploy from chat`;

export class RuntimeCommandInterceptor {
  constructor(private readonly options: RuntimeCommandInterceptorOptions = {}) {}

  async handle(event: EntryPointInboundEvent): Promise<RuntimeCommandInterceptResult | undefined> {
    const text = commandText(event);
    if (!text) return undefined;

    if (parseHelpCommand(text)) return this.textResult("help", BRAIN_SERVICE_HELP_TEXT);
    if (parseHealthCommand(text)) return this.textResult("health", await this.formatHealth());

    const logCommand = parseLogCommand(text, this.options.maxLogLines ?? 2_000);
    if (logCommand.isLog) return this.textResult("logs", await this.formatLogs(logCommand.lines, logCommand.includeRaw));

    const backend = parseSubagentBackendCommand(text);
    if (backend.isBackend) return this.textResult("agent backend", this.formatBackendSeam(backend));

    const employee = parseEmployeeCommand(text);
    if (employee.isEmployee) return this.textResult("employees", this.formatEmployeeSeam(employee));

    if (parseDeployCommand(text)) return this.textResult("deploy", "Deploy/update commands are recognized, but Brain will not pull, rebuild, restart, or mutate services from chat in this parity slice. Use documented operator scripts/systemd outside the runtime.");

    const status = parseAgentStatusCommand(text);
    if (status.isStatus) return this.textResult("agent status", await this.formatSingleSubagentStatus(status.jobId));

    const steer = parseAgentSteerCommand(text);
    if (steer.isSteer) return this.textResult("agent steer", await this.steerJob(steer.jobId, steer.text));

    const kill = parseAgentKillCommand(text);
    if (kill.isKill) return this.textResult("agent kill", await this.cancelJob(kill.jobId));

    const agents = parseAgentsCommand(text);
    if (agents.isAgents) return this.textResult("agents", await this.formatJobs(agents.lastN));

    return undefined;
  }

  private textResult(command: string, text: string): RuntimeCommandInterceptResult {
    return { handled: true, command, actions: [{ type: "send_text", text, format: "markdown" }] };
  }

  private async formatHealth(): Promise<string> {
    if (!this.options.health) return "Health provider is not configured.";
    try {
      const health = await this.options.health.health();
      return `Health snapshot:\n\n${safeJson(health)}`;
    } catch (error) {
      return `Health check failed: ${errorMessage(error)}`;
    }
  }

  private async formatLogs(lines: number, includeRaw: boolean): Promise<string> {
    if (!this.options.logs) return "Runtime log reader is not configured.";
    const entries = await this.options.logs.tail(lines, { includeRaw });
    if (entries.length === 0) return "No runtime log entries.";
    const rendered = entries.map((entry) => formatLogEntry(entry, includeRaw));
    return [`Runtime logs (last ${entries.length}${includeRaw ? ", raw" : ""}):`, "", ...rendered].join("\n");
  }

  private async formatJobs(lastN: number): Promise<string> {
    const subagents = this.options.subagents;
    if (!subagents) return "Subagent lifecycle is not configured.";
    const jobs = subagents.listJobs ? await subagents.listJobs() : [];
    if (jobs.length === 0) return "No subagent jobs.";
    const active = jobs.filter((job) => activeStatuses.has(job.status));
    const terminal = jobs.filter((job) => !activeStatuses.has(job.status)).slice(0, lastN);
    const lines = [formatActiveSummary(active)];
    if (active.length === 0) lines.push("No active subagent jobs. Use `agents detail` for recent terminal jobs.");
    for (const job of active) lines.push(formatJobLine(job, { includeControls: true }));
    if (lastN > 0) {
      lines.push("", `Recent terminal subagent jobs (last ${terminal.length}):`);
      if (terminal.length === 0) lines.push("None.");
      for (const job of terminal) lines.push(formatJobLine(job, { includeControls: false }));
    }
    return lines.join("\n");
  }

  private async formatSingleSubagentStatus(ref: string): Promise<string> {
    const subagents = this.options.subagents;
    if (!subagents) return "Subagent lifecycle is not configured.";
    const resolved = subagents.resolveJobRef ? await subagents.resolveJobRef(ref) : await resolveFromList(subagents, ref);
    if (resolved.status === "not_found") return `No subagent job matched "${ref}". Use "agents" to list usable refs.`;
    if (resolved.status === "ambiguous") return [`Ambiguous subagent ref "${ref}". Use a longer ref.`, ...resolved.candidates.map((candidate) => `- ${candidate.ref} ${candidate.status} ${candidate.profile}${candidate.summary ? ` — ${candidate.summary}` : ""}`)].join("\n");
    const job = resolved.job;
    const lines = [
      `Subagent ${job.id}`,
      `status: ${job.status}`,
      `profile: ${job.profile}`,
      `route: ${job.route}`,
      `resultTarget: ${job.resultTarget ?? "main"}`,
      `provider: ${job.provider ?? "unknown"}`,
      `model/effort: ${[job.model, job.effort].filter(Boolean).join("/") || "default"}`,
      `enqueued: ${job.enqueuedAt}`,
    ];
    if (job.startedAt) lines.push(`started: ${job.startedAt}`);
    if (job.completedAt) lines.push(`completed: ${job.completedAt}`);
    if (job.summary) lines.push(`summary: ${job.summary}`);
    if (job.error) lines.push(`error: ${job.error}`);
    if (job.resultText) lines.push(`result: ${truncate(job.resultText, 1200)}`);
    const refText = shortRef(job.id);
    if (activeStatuses.has(job.status)) lines.push(`cancel: agent kill ${refText}`);
    if (job.status === "running") lines.push(`steer: agent steer ${refText} <text>`);
    return lines.join("\n");
  }

  private async cancelJob(ref: string): Promise<string> {
    if (!this.options.subagents?.requestCancel) return "Subagent cancellation is not configured.";
    return formatCancelJobResult(await this.options.subagents.requestCancel(ref, "service command"));
  }

  private async steerJob(ref: string, text: string): Promise<string> {
    if (!this.options.subagents?.steerJob) return "Subagent steering is not configured.";
    return formatSteerJobResult(await this.options.subagents.steerJob(ref, text));
  }

  private formatBackendSeam(command: Extract<SubagentBackendCommand, { isBackend: true }>): string {
    if (command.action === "status") return "Subagent backend seam: configured by the Brain runtime at startup. Chat-time backend switching is intentionally not wired yet.";
    return `Subagent backend command recognized (${command.action}${command.backend ? ` ${command.backend}` : ""}), but chat-time backend mutation is disabled in Brain. Restart with the desired provider/executor configuration.`;
  }

  private formatEmployeeSeam(command: Extract<EmployeeCommand, { isEmployee: true }>): string {
    if (command.action === "list") return "Employee runtime seam: scaffold/status commands are recognized, but real durable Employee app-server lifecycle is not wired in Brain yet.";
    return `Employee command recognized (${command.action}${command.employeeId ? ` ${command.employeeId}` : ""}), but Employee lifecycle/steering is intentionally out of scope for this parity slice.`;
  }
}

export function parseHelpCommand(text: string): boolean {
  return /^\/?help$/i.test(text.trim());
}

export function parseHealthCommand(text: string): boolean {
  return /^\/?health$/i.test(text.trim());
}

export function parseLogCommand(text: string, maxLines = 2_000): { isLog: boolean; lines: number; includeRaw: boolean } {
  const match = text.trim().match(/^\/?(logs?|introspect)(?:\s+(raw))?(?:\s+(\d+))?$/i);
  if (!match) return { isLog: false, lines: 0, includeRaw: false };
  const includeRaw = match[2]?.toLowerCase() === "raw";
  const lines = match[3] ? Math.min(Math.max(parseInt(match[3], 10), 1), maxLines) : 100;
  return { isLog: true, lines, includeRaw };
}

export function parseAgentsCommand(text: string): { isAgents: boolean; lastN: number } {
  const match = text.trim().match(/^\/?(?:agents?|subagents?|sub)(?:\s+(detail|\d+))?$/i);
  if (!match) return { isAgents: false, lastN: 0 };
  const arg = match[1]?.toLowerCase();
  const lastN = arg === "detail" ? 10 : arg ? Math.min(Math.max(parseInt(arg, 10), 0), 200) : 0;
  return { isAgents: true, lastN };
}

export function parseAgentKillCommand(text: string): { isKill: boolean; jobId: string } {
  const match = text.trim().match(/^\/?(?:agents?|subagents?)\s+kill\s+(\S+)$/i);
  if (!match) return { isKill: false, jobId: "" };
  return { isKill: true, jobId: match[1] as string };
}

export function parseAgentSteerCommand(text: string): { isSteer: boolean; jobId: string; text: string } {
  const match = text.trim().match(/^\/?(?:agents?|subagents?)\s+(?:steer|tell)\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) return { isSteer: false, jobId: "", text: "" };
  return { isSteer: true, jobId: match[1] as string, text: (match[2] as string).trim() };
}

export function parseAgentStatusCommand(text: string): { isStatus: boolean; jobId: string } {
  const match = text.trim().match(/^\/?(?:agents?|subagents?)\s+status\s+(\S+)$/i);
  if (!match) return { isStatus: false, jobId: "" };
  return { isStatus: true, jobId: match[1] as string };
}

export type SubagentBackendCommand =
  | { isBackend: false }
  | { isBackend: true; action: "status" | "set" | "clear"; backend?: "codex_exec" | "codex_app_server" };

export function parseSubagentBackendCommand(text: string): SubagentBackendCommand {
  const match = text.trim().match(/^\/?(?:agents?|subagents?)\s+backend(?:\s+(\S+))?$/i);
  if (!match) return { isBackend: false };
  const value = (match[1] ?? "status").toLowerCase();
  if (value === "status") return { isBackend: true, action: "status" };
  if (value === "config" || value === "clear" || value === "default") return { isBackend: true, action: "clear" };
  if (value === "exec" || value === "codex_exec") return { isBackend: true, action: "set", backend: "codex_exec" };
  if (value === "app-server" || value === "app_server" || value === "codex_app_server") return { isBackend: true, action: "set", backend: "codex_app_server" };
  return { isBackend: false };
}

export type EmployeeCommand =
  | { isEmployee: false }
  | { isEmployee: true; action: "list" | "status" | "start" | "stop" | "steer"; employeeId?: string; text?: string };

export function parseEmployeeCommand(text: string): EmployeeCommand {
  const trimmed = text.trim();
  if (/^\/?employees$/i.test(trimmed)) return { isEmployee: true, action: "list" };
  const match = trimmed.match(/^\/?employee\s+(status|start|stop)\s+(\S+)$/i);
  if (match) return { isEmployee: true, action: match[1]?.toLowerCase() as "status" | "start" | "stop", employeeId: match[2] };
  const steer = trimmed.match(/^\/?employee\s+(?:steer|tell)\s+(\S+)\s+([\s\S]+)$/i);
  if (steer) return { isEmployee: true, action: "steer", employeeId: steer[1], text: steer[2]?.trim() };
  return { isEmployee: false };
}

export function parseDeployCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return ["update", "update yourself", "update self", "deploy", "redeploy", "pull and restart", "self-update", "self update"].includes(normalized);
}

function commandText(event: EntryPointInboundEvent): string | undefined {
  if (event.command) return [event.command, ...(event.args ?? [])].join(" ").trim();
  return event.text?.trim();
}

function formatActiveSummary(jobs: SubagentJob[]): string {
  const counts = jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] ?? 0) + 1;
    return acc;
  }, {});
  return `Subagents: ${counts.running ?? 0} running, ${counts.cancelling ?? 0} cancelling, ${counts.queued ?? 0} queued`;
}

function formatJobLine(job: SubagentJob, options: { includeControls: boolean }): string {
  const ref = shortRef(job.id);
  const parts = [
    `- ${job.status} ${job.profile}`,
    `id=${job.id}`,
    `ref=${ref}`,
    `route=${job.route}`,
    `provider=${job.provider ?? "unknown"}`,
  ];
  if (job.summary) parts.push(`summary=${JSON.stringify(job.summary)}`);
  if (job.completedAt) parts.push(`completed=${job.completedAt}`);
  if (options.includeControls && activeStatuses.has(job.status)) parts.push(`cancel="agent kill ${ref}"`);
  if (options.includeControls && job.status === "running") parts.push(`steer="agent steer ${ref} <text>"`);
  return parts.join(" ");
}

function formatCancelJobResult(result: CancelSubagentJobResult): string {
  if (result.status === "success") {
    if (result.previousStatus === "queued") return `Cancelled queued subagent ${result.job.id} (${result.job.profile}).`;
    return `Cancellation requested for subagent ${result.job.id} (${result.job.profile}).`;
  }
  if (result.status === "already_cancelling") return `Subagent ${result.job.id} (${result.job.profile}) is already cancelling.`;
  if (result.status === "already_terminal") return `Subagent ${result.job.id} (${result.job.profile}) is already ${result.job.status}; no cancellation sent.`;
  if (result.status === "ambiguous") return [`Ambiguous subagent ref "${result.ref}". Use a longer ref.`, ...result.candidates.map((candidate) => `- ${candidate.ref} ${candidate.status} ${candidate.profile}`)].join("\n");
  return `No subagent job matched "${result.ref}". Use "agents" to list usable refs.`;
}

function formatSteerJobResult(result: SteerSubagentJobResult): string {
  if (result.status === "success") return `Steered subagent ${result.job.id} (${result.job.profile}).`;
  if (result.status === "not_running") return `Subagent ${result.job.id} (${result.job.profile}) is ${result.job.status}, not running.`;
  if (result.status === "not_steerable") return `Subagent ${result.job.id} (${result.job.profile}) is not currently steerable: ${result.message}`;
  if (result.status === "failed") return `Failed to steer subagent "${result.ref}": ${result.message}`;
  if (result.status === "ambiguous") return [`Ambiguous subagent ref "${result.ref}". Use a longer ref.`, ...result.candidates.map((candidate) => `- ${candidate.ref} ${candidate.status} ${candidate.profile}`)].join("\n");
  return `No subagent job matched "${result.ref}". Use "agents" to list usable refs.`;
}

async function resolveFromList(subagents: SubagentInspectionPort, ref: string): Promise<JobRefResolution> {
  const jobs = await subagents.listJobs?.() ?? [];
  const normalized = normalizeRef(ref);
  const exact = jobs.find((job) => job.id.toLowerCase() === normalized.toLowerCase());
  if (exact) return { status: "matched", ref, job: exact };
  const candidates = jobs.filter((job) => job.id.toLowerCase().startsWith(normalized.toLowerCase()) || jobHex(job.id).startsWith(normalized.toLowerCase()));
  if (candidates.length === 0) return { status: "not_found", ref };
  if (candidates.length === 1 && candidates[0]) return { status: "matched", ref, job: candidates[0] };
  return { status: "ambiguous", ref, candidates: candidates.map((job) => ({ id: job.id, ref: shortRef(job.id), status: job.status, profile: job.profile, summary: job.summary })) };
}

function formatLogEntry(entry: RuntimeLogEntry, includeRaw: boolean): string {
  const prefix = [entry.at, entry.level, entry.component].filter(Boolean).join(" ");
  const base = `${prefix ? `${prefix} ` : ""}${entry.message ?? "(no message)"}`;
  if (!includeRaw || entry.raw === undefined) return base;
  return `${base} ${safeJson(entry.raw)}`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(redactSecrets(value), null, 2);
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, secretKey(key) ? "[redacted]" : redactSecrets(item)]));
}

function redactString(value: string): string {
  return value.replace(/\b\d{5,}:[A-Za-z0-9_-]{16,}\b/g, "[redacted-telegram-token]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted-api-key]");
}

function secretKey(key: string): boolean {
  return /(token|secret|password|api[_-]?key|authorization)/i.test(key);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function shortRef(id: string): string {
  const hex = jobHex(id);
  return hex.slice(0, Math.min(8, hex.length));
}

function normalizeRef(ref: string): string {
  return ref.trim().replace(/^[[(<]+/, "").replace(/[\])>.,;:]+$/, "");
}

function jobHex(id: string): string {
  return id.startsWith("job_") ? id.slice(4).toLowerCase() : id.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const activeStatuses = new Set<SubagentJobStatus>(["queued", "running", "cancelling"]);
