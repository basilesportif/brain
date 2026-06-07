import type { BrainOutboundAction, EntryPointInboundEvent, JsonRecord } from "@brain/entrypoint-protocol";
import type { AutomationHealth } from "./automation.js";
import type { SubagentJob, SubagentJobStatus } from "./jobs.js";
import type { ActiveSubagentSnapshot, CancelSubagentJobResult, JobRefResolution, SteerSubagentJobResult, SubagentControlPort } from "./subagents.js";
import type { EmployeeControlPort, EmployeeLifecycleResult, EmployeeRecord } from "./employees.js";

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

export interface AutomationInspectionPort {
  health(): Promise<AutomationHealth> | AutomationHealth;
}

export interface AssistantWorkspaceCommandResult {
  ok: boolean;
  userFacingText?: string;
  error?: string;
  stderr?: string;
  stdout?: unknown;
}

export interface AssistantWorkspaceCommandPort {
  run(script: string, args?: string[]): Promise<AssistantWorkspaceCommandResult> | AssistantWorkspaceCommandResult;
}

export interface SubagentInspectionPort extends SubagentControlPort {
  listJobs?(): Promise<SubagentJob[]>;
  activeSnapshot?(limit?: number, now?: Date): Promise<ActiveSubagentSnapshot>;
  resolveJobRef?(ref: string): Promise<JobRefResolution>;
}

export interface RuntimeCommandInterceptorOptions {
  subagents?: SubagentInspectionPort;
  employees?: EmployeeControlPort;
  automation?: AutomationInspectionPort;
  assistantCommands?: AssistantWorkspaceCommandPort;
  logs?: RuntimeLogReader;
  health?: RuntimeHealthProvider;
  maxLogLines?: number;
  mainLoop?: { model?: string; effort?: string };
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
  loops                   — configured loop and monitor status
  loop status             — alias for loops
  agents                  — active subagent jobs and usable refs
  agents detail           — active jobs plus 10 recent terminal jobs
  agents <N>              — active jobs plus N recent terminal jobs
  agent status <ref>      — mechanical subagent status for one job
  agent kill <ref>        — cancel a subagent by full ID, displayed ref, or hex prefix
  agent steer <ref> <text> — steer a running steerable subagent
  agent backend           — show backend seam status (configuration-only in Brain)
  employees               — list durable Employee lifecycle records
  employee status <id>    — inspect one Employee lifecycle record
  employee start <id>     — mark an Employee running through the safe seam
  employee stop <id>      — mark an Employee stopped through the safe seam
  employee steer <id> <text> — record a steering instruction for a running Employee
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

    if (parseLoopsCommand(text)) return this.textResult("loops", await this.formatAutomationStatus());

    const backend = parseSubagentBackendCommand(text);
    if (backend.isBackend) return this.textResult("agent backend", this.formatBackendSeam(backend));

    const todo = parseTodoCommand(text);
    if (todo.isTodo) return this.textResult("todos", await this.handleTodoCommand(todo));

    const employee = parseEmployeeCommand(text);
    if (employee.isEmployee) return this.textResult("employees", await this.handleEmployeeCommand(employee));

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

  private async formatAutomationStatus(): Promise<string> {
    if (!this.options.automation) return "Automation runtime is not configured.";
    try {
      const health = await this.options.automation.health();
      const enabledLoops = health.loops.filter((loop) => loop.enabled).length;
      const enabledMonitors = health.monitors.filter((monitor) => monitor.enabled).length;
      const lines = [
        `Automation status: ${health.ok ? "ok" : "needs attention"} (workspace=${health.workspaceId})`,
        `Loops: ${enabledLoops}/${health.loops.length} enabled`,
      ];
      if (health.loops.length === 0) lines.push("- no loops configured");
      for (const loop of health.loops) {
        const due = loop.schedule?.dueNow === undefined ? "" : ` dueNow=${loop.schedule.dueNow}`;
        const schedule = loop.schedule ? ` scheduleValid=${loop.schedule.valid}${due}` : "";
        lines.push(`- ${loop.enabled ? "enabled" : "disabled"} ${loop.id} status=${loop.status}${schedule}${loop.detail ? ` — ${loop.detail}` : ""}`);
      }
      lines.push(`Monitors: ${enabledMonitors}/${health.monitors.length} enabled`);
      if (health.monitors.length === 0) lines.push("- no monitors configured");
      for (const monitor of health.monitors) {
        lines.push(`- ${monitor.enabled ? "enabled" : "disabled"} ${monitor.id} status=${monitor.status}${monitor.detail ? ` — ${monitor.detail}` : ""}`);
      }
      return lines.join("\n");
    } catch (error) {
      return `Automation status failed: ${errorMessage(error)}`;
    }
  }

  private async formatJobs(lastN: number): Promise<string> {
    const subagents = this.options.subagents;
    if (!subagents) return "Subagent lifecycle is not configured.";
    const jobs = subagents.listJobs ? await subagents.listJobs() : [];
    const running = jobs.filter((job) => job.status === "running");
    const cancelling = jobs.filter((job) => job.status === "cancelling");
    const queued = jobs.filter((job) => job.status === "queued");
    const terminal = jobs.filter((job) => !activeStatuses.has(job.status));
    const active = [...running, ...cancelling, ...queued];
    const lines: string[] = [];

    if (lastN > 0) {
      lines.push(`${formatActiveSummary(active)}, ${terminal.length} terminal (${terminalStatusCountText(terminal)})`);
    } else {
      lines.push(formatActiveSummary(active));
      if (active.length === 0) lines.push("No active subagent jobs. Use `agents detail` for recent terminal jobs.");
    }

    appendJobSection(lines, "Running", running, { includeControls: true, includeSteer: true, now: this.now() });
    appendJobSection(lines, "Cancelling", cancelling, { includeControls: true, includeSteer: false, now: this.now() });
    appendJobSection(lines, "Queued", queued, { includeControls: true, includeSteer: false, now: this.now() });

    if (lastN > 0) {
      const recent = terminal.slice(0, lastN);
      if (recent.length > 0) {
        lines.push("", `Recently terminal (last ${lastN}):`);
        recent.forEach((job, index) => {
          lines.push(formatTerminalJobLine(job, index + 1));
        });
      }
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
    const refText = shortRef(job.id);
    const elapsed = formatDurationSeconds(elapsedSeconds(job, this.now()));
    const steerable = job.status === "running";
    const lines = [
      `Subagent ${job.id}`,
      `ref: ${refText}`,
      `status: ${job.status}`,
      `profile: ${job.profile}`,
      `provider: ${job.provider ?? "unknown"}`,
      `owner: ${job.ownerType ?? "main"}:${job.ownerId ?? job.ownerType ?? "main"}`,
      `route: ${job.route}`,
      `resultTarget: ${job.resultTarget ?? "main"}`,
      `steerable: ${steerable ? "yes" : "no"}`,
      `elapsed: ${elapsed}`,
      `model/effort: ${[job.model, job.effort].filter(Boolean).join("/") || "default"}`,
      `enqueued: ${job.enqueuedAt}`,
    ];
    if (job.startedAt) lines.push(`started: ${job.startedAt}`);
    if (job.completedAt) lines.push(`completed: ${job.completedAt}`);
    if (job.summary) lines.push(`summary: ${job.summary}`);
    if (job.error) lines.push(`error: ${job.error}`);
    if (job.resultText) lines.push(`result: ${truncate(job.resultText, 1200)}`);
    if (activeStatuses.has(job.status)) lines.push(`cancel: agent kill ${refText}`);
    if (steerable) lines.push(`steer: agent steer ${refText} <text>`);
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

  private async handleTodoCommand(command: Extract<TodoCommand, { isTodo: true }>): Promise<string> {
    const assistantCommands = this.options.assistantCommands;
    if (!assistantCommands) return withMainLoopDisclosure("Assistant workspace command runner is not configured.", this.options.mainLoop);
    const result = await runTodoCommand(assistantCommands, command);
    const text = result.userFacingText?.trim() || result.error || result.stderr || "Todo command completed without user-facing output.";
    return withMainLoopDisclosure(text, this.options.mainLoop);
  }

  private async handleEmployeeCommand(command: Extract<EmployeeCommand, { isEmployee: true }>): Promise<string> {
    const employees = this.options.employees;
    if (!employees) {
      if (command.action === "list") return "Employee runtime seam: no Employee lifecycle store is configured for this supervisor.";
      return `Employee command recognized (${command.action}${command.employeeId ? ` ${command.employeeId}` : ""}), but no Employee lifecycle store is configured for this supervisor.`;
    }
    if (command.action === "list") return formatEmployees(await employees.listEmployees?.() ?? []);
    if (!command.employeeId) return "Employee id is required.";
    if (command.action === "status") {
      const resolved = employees.resolveEmployeeRef ? await employees.resolveEmployeeRef(command.employeeId) : await resolveEmployeeFromList(employees, command.employeeId);
      if (resolved.status === "not_found") return `No employee matched "${command.employeeId}".`;
      if (resolved.status === "ambiguous") return [`Ambiguous employee ref "${command.employeeId}". Use a longer ref.`, ...resolved.candidates.map((candidate) => `- ${candidate.id} ${candidate.status} ${candidate.profile}${candidate.label ? ` — ${candidate.label}` : ""}`)].join("\n");
      return formatEmployeeDetail(resolved.employee);
    }
    if (command.action === "start") return formatEmployeeLifecycleResult(await employees.startEmployee({ id: command.employeeId }));
    if (command.action === "stop") return formatEmployeeLifecycleResult(await employees.stopEmployee(command.employeeId, "service command"));
    if (command.action === "steer") return formatEmployeeLifecycleResult(await employees.steerEmployee(command.employeeId, command.text ?? ""));
    return "Unsupported employee command.";
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
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

export function parseLoopsCommand(text: string): boolean {
  return /^\/?(?:loops|loops?\s+status)$/i.test(text.trim());
}

export type TodoCommand =
  | { isTodo: false }
  | { isTodo: true; action: "list" }
  | { isTodo: true; action: "add"; title: string }
  | { isTodo: true; action: "delete"; ref: string };

export function parseTodoCommand(text: string): TodoCommand {
  const trimmed = text.trim();
  if (/^\/?(?:todos?|todo\s+list|list\s+todos?|show\s+todos?|current\s+todos?)$/i.test(trimmed)) return { isTodo: true, action: "list" };

  const add = trimmed.match(/^\/?(?:add\s+(?:a\s+)?todo|todo\s+add|new\s+todo)\s*:?\s+([\s\S]+)$/i);
  if (add?.[1]?.trim()) return { isTodo: true, action: "add", title: add[1].trim() };

  const deleteMatch = trimmed.match(/^\/?(?:(?:delete|remove)\s+todo|todo\s+(?:delete|remove))\s+([\s\S]+)$/i)
    ?? trimmed.match(/^\/?(?:delete|remove)\s+(#\d+|\d+)$/i)
    ?? trimmed.match(/^\/?mark\s+(#\d+|\d+)\s+(?:done|complete|completed)$/i);
  if (deleteMatch?.[1]?.trim()) return { isTodo: true, action: "delete", ref: deleteMatch[1].trim() };

  return { isTodo: false };
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

async function runTodoCommand(port: AssistantWorkspaceCommandPort, command: Extract<TodoCommand, { isTodo: true }>): Promise<AssistantWorkspaceCommandResult> {
  if (command.action === "list") return port.run("todo-list.js", []);
  if (command.action === "add") return port.run("todo-add.js", ["--title", command.title]);
  const normalized = normalizeRef(command.ref);
  if (/^(?:#)?\d+$/.test(normalized)) return port.run("todo-delete.js", ["--number", normalized.replace(/^#/, "")]);
  if (/^td_[0-9a-f]+$/i.test(normalized)) return port.run("todo-delete.js", ["--id", normalized]);
  return port.run("todo-delete.js", ["--title", command.ref]);
}

function formatActiveSummary(jobs: SubagentJob[]): string {
  const counts = jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] ?? 0) + 1;
    return acc;
  }, {});
  return `Subagents: ${counts.running ?? 0} running, ${counts.cancelling ?? 0} cancelling, ${counts.queued ?? 0} queued`;
}

function appendJobSection(lines: string[], label: string, jobs: SubagentJob[], options: { includeControls: boolean; includeSteer: boolean; now: Date }): void {
  if (jobs.length === 0) return;
  lines.push("", `${label}:`);
  jobs.forEach((job, index) => {
    lines.push(formatJobLine(job, index + 1, options));
  });
}

function formatJobLine(job: SubagentJob, index: number, options: { includeControls: boolean; includeSteer: boolean; now: Date }): string {
  const ref = shortRef(job.id);
  const details = formatJobSummaryDetails(job);
  if (options.includeControls && activeStatuses.has(job.status)) details.push(`cancel: \`agent kill ${ref}\``);
  if (options.includeSteer && job.status === "running") details.push(`steer: \`agent steer ${ref} <text>\``);
  const header = `${index}. \`${ref}\` — ${compactText(formatJobHeader(job, options.now))}`;
  return [header, ...details.map((detail) => `   ${compactText(detail)}`)].join("\n");
}

function formatTerminalJobLine(job: SubagentJob, index: number): string {
  const parts = [
    `${index}. ${job.status} ${job.id.startsWith("job_") ? `job_${shortRef(job.id)}` : shortRef(job.id)} — ${compactText(job.profile)}`,
  ];
  const details = formatJobSummaryDetails(job);
  if (job.completedAt) details.push(`completed: ${job.completedAt}`);
  if (job.error) details.push(`error: ${job.error}`);
  return [...parts, ...details.map((detail) => `   ${compactText(detail)}`)].join("\n");
}

function formatJobHeader(job: SubagentJob, now: Date): string {
  const elapsed = formatDurationSeconds(elapsedSeconds(job, now));
  return [job.profile, job.effort ?? "default", elapsed].filter(Boolean).join(" / ");
}

function formatJobSummaryDetails(job: SubagentJob): string[] {
  const details: string[] = [];
  if (job.summary) details.push(job.summary);
  const owner = formatJobOwnerDetails(job);
  if (owner) details.push(owner);
  return details;
}

function formatJobOwnerDetails(job: SubagentJob): string {
  const ownerType = job.ownerType ?? "main";
  const resultTarget = job.resultTarget ?? resultTargetForRoute(job.route);
  if (ownerType === "main" && resultTarget === resultTargetForRoute(job.route) && !job.ownerRequestId && !job.parentTurnId) return "";
  const parts = [
    `owner: ${ownerType}:${compactText(job.ownerId ?? ownerType)}`,
    job.ownerRequestId ? `request: ${compactText(job.ownerRequestId)}` : "",
    job.parentTurnId ? `parentTurn: ${compactText(job.parentTurnId)}` : "",
    `result: ${resultTarget}`,
  ].filter(Boolean);
  return parts.join(" ");
}

function resultTargetForRoute(route: SubagentJob["route"]): string {
  if (route === "send_to_user") return "user";
  if (route === "send_to_admins") return "admins";
  if (route === "store_only") return "store_only";
  if (route === "silent") return "silent";
  return "main";
}

function terminalStatusCountText(jobs: SubagentJob[]): string {
  const counts = jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] ?? 0) + 1;
    return acc;
  }, {});
  return `${counts.completed ?? 0} completed, ${counts.failed ?? 0} failed, ${counts.cancelled ?? 0} cancelled, ${counts.timed_out ?? 0} timed_out, ${counts.abandoned ?? 0} abandoned`;
}

function elapsedSeconds(job: SubagentJob, now: Date): number {
  const from = job.status === "queued"
    ? job.enqueuedAt
    : job.status === "cancelling"
      ? job.cancelRequestedAt ?? job.startedAt ?? job.enqueuedAt
      : job.startedAt ?? job.enqueuedAt ?? job.completedAt ?? job.abandonedAt;
  if (!from) return 0;
  const elapsedMs = now.getTime() - new Date(from).getTime();
  return Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs / 1000)) : 0;
}

function formatDurationSeconds(seconds: number): string {
  const rounded = Math.round(seconds);
  const totalSeconds = Number.isFinite(rounded) ? Math.max(0, rounded) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
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

function formatEmployees(employees: EmployeeRecord[]): string {
  if (employees.length === 0) return "No Employee lifecycle records. Use `employee start <id>` to create a safe runtime record.";
  return [
    `Employees (${employees.length}):`,
    ...employees.map((employee) => `- ${employee.status} ${employee.id} profile=${employee.profile}${employee.label ? ` label=${JSON.stringify(employee.label)}` : ""}${employee.startedAt ? ` started=${employee.startedAt}` : ""}${employee.steerCount ? ` steers=${employee.steerCount}` : ""}`),
  ].join("\n");
}

function formatEmployeeDetail(employee: EmployeeRecord): string {
  const lines = [
    `Employee ${employee.id}`,
    `status: ${employee.status}`,
    `profile: ${employee.profile}`,
    `provider: ${employee.provider ?? "configured-at-runtime"}`,
  ];
  if (employee.label) lines.push(`label: ${employee.label}`);
  if (employee.model || employee.effort) lines.push(`model/effort: ${[employee.model, employee.effort].filter(Boolean).join("/")}`);
  lines.push(`created: ${employee.createdAt}`);
  if (employee.startedAt) lines.push(`started: ${employee.startedAt}`);
  if (employee.stoppedAt) lines.push(`stopped: ${employee.stoppedAt}`);
  if (employee.lastSteeredAt) lines.push(`lastSteered: ${employee.lastSteeredAt}`);
  if (employee.lastInstruction) lines.push(`lastInstruction: ${truncate(employee.lastInstruction, 600)}`);
  if (employee.error) lines.push(`note: ${employee.error}`);
  return lines.join("\n");
}

function formatEmployeeLifecycleResult(result: EmployeeLifecycleResult): string {
  if (result.status === "success") return result.message;
  if (result.status === "ambiguous") return [result.message, ...result.candidates.map((candidate) => `- ${candidate.id} ${candidate.status} ${candidate.profile}`)].join("\n");
  return result.message;
}

async function resolveEmployeeFromList(employees: EmployeeControlPort, ref: string) {
  const records = await employees.listEmployees?.() ?? [];
  const normalized = normalizeRef(ref);
  const exact = records.find((employee) => employee.id.toLowerCase() === normalized.toLowerCase());
  if (exact) return { status: "matched" as const, ref, employee: exact };
  const candidates = records.filter((employee) => employee.id.toLowerCase().startsWith(normalized.toLowerCase()));
  if (candidates.length === 0) return { status: "not_found" as const, ref };
  if (candidates.length === 1 && candidates[0]) return { status: "matched" as const, ref, employee: candidates[0] };
  return { status: "ambiguous" as const, ref, candidates: candidates.map((employee) => ({ id: employee.id, status: employee.status, profile: employee.profile, label: employee.label })) };
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
  const base = redactString(`${prefix ? `${prefix} ` : ""}${entry.message ?? "(no message)"}`);
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

function withMainLoopDisclosure(text: string, mainLoop: RuntimeCommandInterceptorOptions["mainLoop"] = {}): string {
  if (/^main_loop:\s*model=/i.test(text.trim())) return text.trim();
  const model = mainLoop?.model ?? "gpt-5.5";
  const effort = mainLoop?.effort ?? "medium";
  return `main_loop: model=${model} effort=${effort}\n\n${text.trim()}`;
}

function compactText(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim();
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
