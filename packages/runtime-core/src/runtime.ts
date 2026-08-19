import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { routeOutboundToOrigin, type BrainOutboundAction, type EntryPointInboundEvent } from "@brain/entrypoint-protocol";
import type { WorkspaceConfig } from "@brain/workspace-schema";
import { parseBrainDirectives } from "./directives.js";
import type { ProviderAdapter, ProviderHealth, ProviderResumeHandle, ProviderSession, ProviderTurnEvent } from "./provider.js";
import type { ActiveSubagentSnapshot, SubagentControlPort } from "./subagents.js";
import { sanitizeUserFacingText } from "./user-facing-format.js";

export interface RuntimeControlResult {
  action: BrainOutboundAction;
  status: string;
  message: string;
  raw?: unknown;
}

export interface RuntimeTurnResult {
  eventId: string;
  cleanText: string;
  finalText?: string;
  actions: BrainOutboundAction[];
  streamingActions: BrainOutboundAction[];
  subagentJobIds: string[];
  controlResults: RuntimeControlResult[];
  providerEvents: ProviderTurnEvent[];
  directiveErrors: string[];
}

export interface BrainRuntimeOptions {
  workspaceId: string;
  workspace: WorkspaceConfig;
  provider: ProviderAdapter;
  subagents?: SubagentControlPort;
}

export interface BrainRuntimeHandleOptions {
  /**
   * Called while a provider turn is still streaming for transient user-visible
   * actions that are safe to execute before final text is known.
   */
  onStreamingAction?(action: BrainOutboundAction): Promise<void> | void;
}

export interface BuildPromptOptions {
  activeSubagents?: ActiveSubagentSnapshot;
}

interface LoadedContextFile {
  label: string;
  path: string;
  present: boolean;
  bytes?: number;
  text?: string;
  truncated?: boolean;
}

interface RuntimeContextResolution {
  roots: {
    workspaceRoot: string;
    controlPlaneRoot?: string;
    codexChatRoot?: string;
    assistantLogicRoot?: string;
    assistantDataRoot?: string;
  };
  setupContext: {
    path?: string;
    present: boolean;
    used: boolean;
  };
  repoRegistry: {
    path?: string;
    present: boolean;
    used: boolean;
    resolvedAliases: Record<string, { host?: string; path?: string; localPath?: string; source?: string }>;
  };
  assistantPack: {
    root?: string;
    promptFiles: LoadedContextFile[];
  };
  instructionFiles: LoadedContextFile[];
  assistantLogicSkills: {
    root?: string;
    directory?: string;
    available: string[];
    loaded: LoadedContextFile[];
  };
  warnings: string[];
}

export class BrainRuntime {
  private session?: ProviderSession;

  constructor(private readonly options: BrainRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.session) return;
    this.session = await this.options.provider.createSession({ workspaceId: this.options.workspaceId });
    await this.session.start();
  }

  async stop(): Promise<void> {
    await this.session?.stop();
    this.session = undefined;
  }

  async health(): Promise<ProviderHealth> {
    if (!this.session) {
      return { ok: false, provider: this.options.provider.id, detail: "runtime session is not started" };
    }
    return this.session.health();
  }

  async resumeHandle(): Promise<ProviderResumeHandle | undefined> {
    return this.session?.resumeHandle?.();
  }

  async handleInboundEvent(event: EntryPointInboundEvent, handleOptions: BrainRuntimeHandleOptions = {}): Promise<RuntimeTurnResult> {
    if (event.workspaceId !== this.options.workspaceId) {
      throw new Error(`Inbound event workspace mismatch: ${event.workspaceId} !== ${this.options.workspaceId}`);
    }
    if (!this.session) await this.start();
    const session = this.session;
    if (!session) throw new Error("Provider session failed to start");

    const providerEvents: ProviderTurnEvent[] = [];
    const actions: BrainOutboundAction[] = [];
    const streamingActions: BrainOutboundAction[] = [];
    const subagentJobIds: string[] = [];
    const controlResults: RuntimeControlResult[] = [];
    let finalText: string | undefined;
    for await (const providerEvent of session.sendTurn({
      id: `turn_${event.id}`,
      sessionId: session.id,
      inboundEvent: event,
      prompt: await this.buildTurnPrompt(event),
      attachments: event.attachments,
    })) {
      providerEvents.push(providerEvent);
      if (providerEvent.type === "action") {
        const collected = await this.collectRuntimeAction(event, providerEvent.action, actions, subagentJobIds, controlResults);
        const preDispatchable = collected.filter(isStreamingPreDispatchAction);
        if (preDispatchable.length > 0) {
          for (const action of preDispatchable) {
            removeActionByIdentity(actions, action);
            streamingActions.push(action);
            await handleOptions.onStreamingAction?.(action);
          }
        }
      }
      if (providerEvent.type === "final") finalText = providerEvent.text;
    }

    const parsed = parseBrainDirectives(finalText ?? "");
    for (const block of parsed.blocks) {
      for (const action of block.actions) await this.collectRuntimeAction(event, action, actions, subagentJobIds, controlResults);
    }
    if (parsed.cleanText) {
      actions.unshift(routeOutboundToOrigin(event, { type: "send_text", text: sanitizeUserFacingText(parsed.cleanText, { workspacePath: this.options.workspace.workspacePath }), format: "text" }));
    }

    return {
      eventId: event.id,
      cleanText: parsed.cleanText,
      finalText,
      actions,
      streamingActions,
      subagentJobIds,
      controlResults,
      providerEvents,
      directiveErrors: parsed.errors,
    };
  }

  private async collectRuntimeAction(
    event: EntryPointInboundEvent,
    action: BrainOutboundAction,
    actions: BrainOutboundAction[],
    subagentJobIds: string[],
    controlResults: RuntimeControlResult[],
  ): Promise<BrainOutboundAction[]> {
    const sanitizedAction = action.type === "send_text"
      ? { ...action, text: sanitizeUserFacingText(action.text, { workspacePath: this.options.workspace.workspacePath }) }
      : action;
    const routed = routeOutboundToOrigin(event, sanitizedAction);
    if (routed.type === "dispatch_subagent" && this.options.subagents) {
      const jobId = await this.options.subagents.dispatch({
        workspaceId: routed.workspaceId ?? event.workspaceId,
        profile: routed.profile,
        prompt: routed.prompt,
        route: routed.route ?? "return_to_main",
        ownerType: "main",
        ownerRequestId: routed.idempotencyKey ?? routed.id,
        parentTurnId: `turn_${event.id}`,
        timeoutSec: routed.timeoutSec,
        model: routed.model,
        effort: routed.effort,
        summary: routed.summary,
        images: routed.images,
        metadata: {
          originatingEventId: routed.originatingEventId ?? event.id,
          actionId: routed.id ?? routed.idempotencyKey ?? "",
          origin: originMetadata(event),
        },
      });
      subagentJobIds.push(jobId);
      const feedback = routeOutboundToOrigin(event, dispatchFeedbackAction(routed, jobId));
      actions.push(feedback);
      return [feedback];
    }
    if (routed.type === "cancel_subagent") {
      if (!this.options.subagents?.requestCancel) {
        controlResults.push({ action: routed, status: "unsupported", message: "Subagent cancellation is not configured for this runtime." });
        return [];
      }
      const result = await this.options.subagents.requestCancel(routed.jobId, routed.reason ?? "runtime directive");
      controlResults.push({ action: routed, status: result.status, message: result.message, raw: summarizeControlResult(result) });
      return [];
    }
    if (routed.type === "steer_subagent") {
      if (!this.options.subagents?.steerJob) {
        controlResults.push({ action: routed, status: "unsupported", message: "Subagent steering is not configured for this runtime." });
        return [];
      }
      const result = await this.options.subagents.steerJob(routed.jobId, routed.text);
      controlResults.push({ action: routed, status: result.status, message: result.message, raw: summarizeControlResult(result) });
      return [];
    }
    actions.push(routed);
    return [routed];
  }

  private async buildTurnPrompt(event: EntryPointInboundEvent): Promise<string> {
    const activeSubagents = await this.options.subagents?.activeSnapshot?.(12).catch(() => undefined);
    return buildPrompt(event, this.options.workspace, { activeSubagents });
  }
}

export function buildPrompt(event: EntryPointInboundEvent, workspace: WorkspaceConfig, options: BuildPromptOptions = {}): string {
  const entrypoint = workspace.enabledEntrypoints[event.entrypoint.entrypointId];
  const workspacePath = workspace.workspacePath;
  const runtimeContext = resolveRuntimeContext(workspace);
  const activeMetadata = {
    workspaceId: event.workspaceId,
    workspace: {
      path: workspacePath,
      assistantJsonState: {
        todos: `${workspacePath}/data/todos.json`,
        projects: `${workspacePath}/data/projects`,
        crm: `${workspacePath}/data/crm.json`,
        reminders: `${workspacePath}/data/reminders.json`,
      },
      assistantScripts: {
        package: "packages/assistant-logic",
        commandShape: `cd /abs/path/to/brain && pnpm run brainctl workspace run --path ${workspacePath} <script>.js -- <args>`,
        brainctlWrapper: `pnpm run brainctl workspace run --path ${workspacePath} <script>.js -- <args>`,
        examples: [
          "todo-list.js",
          "project-list.js",
          "crm-list-people.js",
          "reminder-list.js",
          "file-list.js",
        ],
      },
      instructionOverlaysPath: `${workspacePath}/instructions`,
      skillOverlayPath: `${workspacePath}/instructions/skills`,
      tasksPath: `${workspacePath}/tasks`,
      repoRegistryPath: `${workspacePath}/.claude/repo-registry`,
      fileSaveMetadataPath: `${workspacePath}/private/documents/metadata.jsonl`,
      markdownResourcePaths: {
        projects: `${workspacePath}/projects`,
        notes: `${workspacePath}/notes`,
        documentsMetadata: `${workspacePath}/documents/metadata`,
      },
    },
    runtimeContext: promptSafeRuntimeContext(runtimeContext),
    assistantLogic: {
      source: "configured assistant pack / registered assistant-agent-logic checkout",
      root: runtimeContext.roots.assistantLogicRoot,
      skillDocs: runtimeContext.assistantLogicSkills.directory
        ? `${runtimeContext.assistantLogicSkills.directory}/*.md`
        : undefined,
      labFallbackSkillDocs: "packages/assistant-logic/config/skills/*.md",
      commandWrapper: `pnpm run brainctl workspace run --path ${workspacePath} <script>.js -- <args>`,
      commonScripts: {
        todos: ["todo-add.js", "todo-list.js", "todo-delete.js"],
        projects: ["project-add.js", "project-list.js", "project-view.js", "project-update.js", "project-note.js", "project-note-update.js", "project-notes-list.js", "project-index.js", "project-resource.js", "project-task.js", "project-delete.js", "project-reindex.js", "meeting-note.js", "runbook-check.js"],
        crm: ["crm-add-person.js", "crm-add-business.js", "crm-list-people.js", "crm-list-businesses.js", "crm-view.js", "crm-log.js", "crm-history.js", "crm-follow-ups.js", "crm-resolve.js", "crm-link.js", "crm-unlink.js", "crm-update-person.js", "crm-update-business.js", "crm-missing-fields.js", "crm-pipeline.js", "crm-stale.js", "crm-delete.js"],
        reminders: ["reminder-add.js", "reminder-list.js", "reminder-update.js", "reminder-delete.js", "reminder-check.js"],
        fileSave: ["file-save.js", "file-list.js"],
        calendarEmailComposio: ["calendar-events.js", "calendar-search.js", "calendar-create-event.js", "gmail-recent.js", "gmail-search.js", "gmail-send.js", "composio-connect.js"],
      },
    },
    activeEntrypoint: {
      entrypointId: event.entrypoint.entrypointId,
      channelKind: event.entrypoint.channelKind,
      displayName: entrypoint?.displayName ?? event.entrypoint.displayName,
      capabilities: entrypoint?.capabilities ?? event.entrypoint.capabilities ?? {},
    },
    outboundDefaults: workspace.outboundDefaults ?? { route: "originating-entrypoint" },
  };
  return [
    "You are Brain's lab-only provider-neutral runtime seam.",
    "Use generic entrypoint, inbound event, outbound action, and artifact language.",
    "Do not expose channel secrets or raw adapter credentials.",
    "Production live assistant traffic must run through codex-chat.service with the separate assistant-agent-logic checkout and assistant-agent-data/workspace.",
    "Do not treat Brain's in-repo lab compatibility commands or prompt fragments as production domain behavior.",
    "For domain-specific workflows, load and follow assistant-agent-logic resources from the configured separate checkout when explicitly available to this lab run.",
    "If filesystem or script inspection fails, report the exact command or path failure rather than inferring private assistant state from Brain metadata alone.",
    ...behaviorParityInstructions(workspacePath),
    formatLoadedRuntimeContext(runtimeContext),
    `Active runtime context: ${JSON.stringify(activeMetadata)}`,
    formatActiveSubagentSnapshot(options.activeSubagents),
    event.text ? `Inbound text: ${event.text}` : "Inbound text: (none)",
  ].filter(Boolean).join("\n");
}

function behaviorParityInstructions(workspacePath: string): string[] {
  const wrapper = `pnpm run brainctl workspace run --path ${workspacePath}`;
  return [
    "Lab-only compatibility boundary: BrainRuntime is not the production assistant runtime. Production Telegram/Codex traffic must run through codex-chat with assistant-agent-logic; these instructions apply only to explicit lab/fake Brain runtime smoke.",
    `The \`${wrapper}\` command family is a legacy/lab compatibility wrapper only. Do not present it as production assistant logic; production uses the separate assistant-agent-logic checkout.`,
    "For any lab dispatch_subagent directive include profile, summary, model, effort, and idempotencyKey so tests can validate routing without owning domain behavior.",
    "For user-facing lab workspace-command output, preserve safe formatting and redact raw ids/secrets; the compatibility formatter may add a main_loop routing disclosure for deterministic commands.",
    "Setup/migration parity: Brain workspaces are private state/control-plane metadata only. Do not migrate private data into Brain source repos or make Brain markdown/JSON stores the production source of truth.",
    "Directive syntax: emit fenced `brain-actions` or `codex-chat` JSON with version 1 and action objects. Side-effecting actions need idempotencyKey. Supported parity actions include send_text, send_image/send_document compatibility (normalized to send_artifact), send_artifact, dispatch_subagent, cancel_subagent/cancel_job, steer_subagent, react, request_clarification, edit_message, notify_owner, and enqueue_main.",
  ];
}

function resolveRuntimeContext(workspace: WorkspaceConfig): RuntimeContextResolution {
  const cfg = workspace.runtimeContext ?? {};
  const warnings: string[] = [];
  const workspaceRoot = path.resolve(workspace.workspacePath);
  let controlPlaneRoot = resolveOptionalPath(cfg.controlPlaneRoot);
  let codexChatRoot = resolveOptionalPath(cfg.codexChatRoot);
  let assistantLogicRoot = resolveOptionalPath(cfg.assistantLogicRoot);
  let assistantDataRoot = resolveOptionalPath(cfg.assistantDataRoot) ?? workspaceRoot;

  const setupContextPath = resolveOptionalPath(cfg.setupContextPath)
    ?? (controlPlaneRoot ? path.join(controlPlaneRoot, "private", "setup-context.json") : undefined);
  const setupContext = readJsonRecord(setupContextPath, warnings);
  if (setupContext.record) {
    controlPlaneRoot = controlPlaneRoot ?? resolveOptionalPath(stringValue(setupContext.record.repoPath));
    assistantDataRoot = resolveOptionalPath(stringValue(setupContext.record.workspaceRoot)) ?? assistantDataRoot;
  }

  const repoRegistryPath = resolveOptionalPath(cfg.repoRegistryPath)
    ?? path.join(assistantDataRoot, ".claude", "repo-registry", "index.yaml");
  const repoRegistry = readYamlRecord(repoRegistryPath, warnings);
  const registryAliases: RuntimeContextResolution["repoRegistry"]["resolvedAliases"] = {};
  if (repoRegistry.record) {
    const codex = registryRepo(repoRegistry.record, ["codex-chat"]);
    const logic = registryRepo(repoRegistry.record, ["assistant-agent-logic", "assistant-claude"]);
    const data = registryRepo(repoRegistry.record, ["assistant-agent-data", "assistant-data"]);
    registryAliases.codexChat = repoDescriptor(codex);
    registryAliases.assistantLogic = repoDescriptor(logic);
    registryAliases.assistantData = repoDescriptor(data);
    codexChatRoot = codexChatRoot ?? localPathFromRepo(codex);
    assistantLogicRoot = assistantLogicRoot ?? localPathFromRepo(logic);
    assistantDataRoot = localPathFromRepo(data) ?? assistantDataRoot;
  }

  const assistantPackRoot = resolveOptionalPath(cfg.assistantPackRoot)
    ?? assistantPackRootFromPromptPath(cfg.assistantPackPromptPath)
    ?? (controlPlaneRoot ? path.join(controlPlaneRoot, "assistant-packs", "core") : undefined);
  const assistantPackPromptFiles = loadAssistantPackPrompts(assistantPackRoot, cfg.assistantPackPromptPath, warnings);
  const instructionFiles = loadInstructionFiles({
    controlPlaneRoot,
    codexChatRoot,
    assistantLogicRoot,
  });
  const assistantLogicSkills = loadAssistantLogicSkills(assistantLogicRoot);

  return {
    roots: {
      workspaceRoot,
      controlPlaneRoot,
      codexChatRoot,
      assistantLogicRoot,
      assistantDataRoot,
    },
    setupContext: {
      path: setupContextPath,
      present: setupContext.present,
      used: Boolean(setupContext.record),
    },
    repoRegistry: {
      path: repoRegistryPath,
      present: repoRegistry.present,
      used: Boolean(repoRegistry.record),
      resolvedAliases: registryAliases,
    },
    assistantPack: {
      root: assistantPackRoot,
      promptFiles: assistantPackPromptFiles,
    },
    instructionFiles,
    assistantLogicSkills,
    warnings,
  };
}

function promptSafeRuntimeContext(context: RuntimeContextResolution): Record<string, unknown> {
  return {
    roots: context.roots,
    setupContext: context.setupContext,
    repoRegistry: context.repoRegistry,
    assistantPack: {
      root: context.assistantPack.root,
      promptFiles: context.assistantPack.promptFiles.map(fileSummary),
    },
    instructionFiles: context.instructionFiles.map(fileSummary),
    assistantLogicSkills: {
      root: context.assistantLogicSkills.root,
      directory: context.assistantLogicSkills.directory,
      available: context.assistantLogicSkills.available,
      loaded: context.assistantLogicSkills.loaded.map(fileSummary),
    },
    warnings: context.warnings,
  };
}

function fileSummary(file: LoadedContextFile): Record<string, unknown> {
  return {
    label: file.label,
    path: file.path,
    present: file.present,
    bytes: file.bytes,
    truncated: file.truncated,
  };
}

function formatLoadedRuntimeContext(context: RuntimeContextResolution): string {
  const lines = [
    "Resolved runtime roots (do not infer these from the private workspace cwd):",
    JSON.stringify(promptSafeRuntimeContext(context), null, 2),
  ];
  const loadedFiles = [
    ...context.instructionFiles.filter((file) => file.present && file.text),
    ...context.assistantPack.promptFiles.filter((file) => file.present && file.text),
    ...context.assistantLogicSkills.loaded.filter((file) => file.present && file.text),
  ];
  if (loadedFiles.length > 0) {
    lines.push("Loaded AGENTS, assistant-pack prompt, and assistant-agent-logic skill excerpts:");
    for (const file of loadedFiles) {
      lines.push(`--- ${file.label}: ${file.path}${file.truncated ? " (truncated)" : ""} ---`);
      lines.push(file.text ?? "");
    }
  }
  if (context.assistantLogicSkills.directory) {
    lines.push(`Assistant-agent-logic skill docs root: ${context.assistantLogicSkills.directory}`);
    lines.push(`Available assistant-agent-logic skill docs: ${context.assistantLogicSkills.available.join(", ") || "(none found)"}`);
  }
  return lines.join("\n");
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return process.env.HOME ?? trimmed;
  if (trimmed.startsWith("~/")) return path.join(process.env.HOME ?? ".", trimmed.slice(2));
  return path.resolve(trimmed);
}

function readJsonRecord(filePath: string | undefined, warnings: string[]): { present: boolean; record?: Record<string, unknown> } {
  if (!filePath) return { present: false };
  if (!existsSync(filePath)) return { present: false };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return { present: true, record: asRecord(parsed) };
  } catch (error) {
    warnings.push(`could not parse setup context at ${filePath}: ${errorMessage(error)}`);
    return { present: true };
  }
}

function readYamlRecord(filePath: string | undefined, warnings: string[]): { present: boolean; record?: Record<string, unknown> } {
  if (!filePath) return { present: false };
  if (!existsSync(filePath)) return { present: false };
  try {
    const parsed = YAML.parse(readFileSync(filePath, "utf8")) as unknown;
    return { present: true, record: asRecord(parsed) };
  } catch (error) {
    warnings.push(`could not parse repo registry at ${filePath}: ${errorMessage(error)}`);
    return { present: true };
  }
}

function registryRepo(registry: Record<string, unknown>, aliases: readonly string[]): Record<string, unknown> | undefined {
  const repos = asRecord(registry.repos) ?? {};
  for (const alias of aliases) {
    const direct = asRecord(repos[alias]);
    if (direct) return direct;
  }
  for (const [key, value] of Object.entries(repos)) {
    const repo = asRecord(value);
    if (!repo) continue;
    const values = [key, stringValue(repo.alias), stringValue(repo.repo_name)];
    if (values.some((value) => value && aliases.includes(value))) return repo;
  }
  return undefined;
}

function repoDescriptor(repo: Record<string, unknown> | undefined): { host?: string; path?: string; localPath?: string; source?: string } {
  return {
    host: stringValue(repo?.host),
    path: stringValue(repo?.path),
    localPath: localPathFromRepo(repo),
    source: stringValue(repo?.repo_name) ?? stringValue(repo?.alias),
  };
}

function localPathFromRepo(repo: Record<string, unknown> | undefined): string | undefined {
  const repoPath = stringValue(repo?.path);
  if (!repoPath) return undefined;
  const host = stringValue(repo?.host);
  if (host && host !== "local" && host !== "localhost") return undefined;
  return resolveOptionalPath(repoPath);
}

function assistantPackRootFromPromptPath(value: string | undefined): string | undefined {
  const resolved = resolveOptionalPath(value);
  if (!resolved) return undefined;
  const info = safeStat(resolved);
  if (info?.isDirectory()) return resolved;
  if (info?.isFile()) {
    const parent = path.basename(path.dirname(resolved)) === "prompts"
      ? path.dirname(path.dirname(resolved))
      : path.dirname(resolved);
    return parent;
  }
  return undefined;
}

function loadAssistantPackPrompts(root: string | undefined, explicitPromptPath: string | undefined, warnings: string[]): LoadedContextFile[] {
  const explicit = resolveOptionalPath(explicitPromptPath);
  if (explicit && safeStat(explicit)?.isFile()) return [loadContextFile("assistant-pack prompt", explicit, 6_000)];
  if (!root || !existsSync(root)) return [];
  const manifestPath = path.join(root, "assistant-pack.json");
  const manifest = readJsonRecord(manifestPath, warnings).record;
  const promptEntries = Array.isArray(manifest?.prompts)
    ? manifest.prompts.filter((item): item is string => typeof item === "string")
    : [];
  const promptFiles = promptEntries.length > 0
    ? promptEntries.map((item) => path.resolve(root, item))
    : safeReadDir(path.join(root, "prompts")).filter((item) => item.endsWith(".md")).map((item) => path.join(root, "prompts", item));
  return promptFiles.map((file) => loadContextFile("assistant-pack prompt", file, 6_000));
}

function loadInstructionFiles(input: { controlPlaneRoot?: string; codexChatRoot?: string; assistantLogicRoot?: string }): LoadedContextFile[] {
  const candidates = [
    input.controlPlaneRoot ? { label: "Brain AGENTS", path: path.join(input.controlPlaneRoot, "AGENTS.md") } : undefined,
    input.codexChatRoot ? { label: "codex-chat AGENTS", path: path.join(input.codexChatRoot, "AGENTS.md") } : undefined,
    input.codexChatRoot ? { label: "codex-chat behavior AGENTS", path: path.join(input.codexChatRoot, "behavior", "AGENTS.md") } : undefined,
    input.assistantLogicRoot ? { label: "assistant-agent-logic AGENTS", path: path.join(input.assistantLogicRoot, "AGENTS.md") } : undefined,
    input.assistantLogicRoot ? { label: "assistant-agent-logic CLAUDE", path: path.join(input.assistantLogicRoot, "CLAUDE.md") } : undefined,
  ].filter((item): item is { label: string; path: string } => Boolean(item));
  return candidates.map((item) => loadContextFile(item.label, item.path, 5_000));
}

function loadAssistantLogicSkills(assistantLogicRoot: string | undefined): RuntimeContextResolution["assistantLogicSkills"] {
  if (!assistantLogicRoot) return { root: undefined, directory: undefined, available: [], loaded: [] };
  const skillDir = path.join(assistantLogicRoot, "config", "skills");
  const available = discoverSkillDocs(skillDir);
  const priority = [
    "todo.md",
    "projects.md",
    "crm.md",
    "reminders.md",
    "file-save.md",
    "generated-web-page.md",
    "repo-registry/SKILL.md",
    "setup-composio-connect.md",
  ];
  const loaded = priority
    .filter((item) => available.includes(item))
    .map((item) => loadContextFile(`assistant-agent-logic skill ${item}`, path.join(skillDir, item), 4_000));
  return {
    root: assistantLogicRoot,
    directory: existsSync(skillDir) ? skillDir : undefined,
    available,
    loaded,
  };
}

function discoverSkillDocs(skillDir: string): string[] {
  if (!safeStat(skillDir)?.isDirectory()) return [];
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of safeReadDir(dir)) {
      const full = path.join(dir, entry);
      const info = safeStat(full);
      if (info?.isDirectory()) visit(full);
      else if (info?.isFile() && (entry.endsWith(".md") || entry === "SKILL.md")) {
        results.push(path.relative(skillDir, full).split(path.sep).join("/"));
      }
    }
  };
  visit(skillDir);
  return results.sort();
}

function loadContextFile(label: string, filePath: string, maxChars: number): LoadedContextFile {
  const info = safeStat(filePath);
  if (!info?.isFile()) return { label, path: filePath, present: false };
  const raw = readFileSync(filePath, "utf8");
  const truncated = raw.length > maxChars;
  return {
    label,
    path: filePath,
    present: true,
    bytes: Number(info.size),
    text: truncated ? `${raw.slice(0, maxChars).trimEnd()}\n...[truncated]` : raw.trimEnd(),
    truncated,
  };
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function safeStat(filePath: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatActiveSubagentSnapshot(snapshot: ActiveSubagentSnapshot | undefined): string {
  if (!snapshot || snapshot.jobs.length === 0) return "";
  const lines = [
    "Active subagent jobs (compact routing snapshot; active/queued only):",
    "Use for natural-language steering: emit steer_subagent only when exactly one matching job has steerable=true. For status, ask which job or tell the user to run `agent status <ref>`. For no/multiple steering matches, ask which job or tell the user to run `agent steer <ref> <text>`.",
  ];
  for (const job of snapshot.jobs) {
    const parts = [
      `ref=${job.ref}`,
      `id=${job.id}`,
      `status=${job.status}`,
      `profile=${job.profile}`,
      `provider=${job.provider ?? "unknown"}`,
      `owner=${job.ownerType}:${job.ownerId ?? job.ownerType}`,
      `route=${job.route}`,
      `result=${job.resultTarget ?? "main"}`,
      `steerable=${job.steerable}`,
      `elapsed=${job.elapsedSec}s`,
      `enqueued=${job.enqueuedAt}`,
    ];
    if (job.startedAt) parts.push(`started=${job.startedAt}`);
    if (job.model) parts.push(`model=${job.model}`);
    if (job.effort) parts.push(`effort=${job.effort}`);
    if (job.summary) parts.push(`summary=${JSON.stringify(compactSnapshotText(job.summary))}`);
    lines.push(`- ${parts.join(" ")}`);
  }
  if (snapshot.omitted > 0) lines.push(`- ${snapshot.omitted} more active job(s) omitted; use the service-level \`agents\` command for full status.`);
  return lines.join("\n");
}

function dispatchFeedbackAction(action: Extract<BrainOutboundAction, { type: "dispatch_subagent" }>, jobId: string): BrainOutboundAction {
  return {
    type: "send_text",
    idempotencyKey: `subagent-dispatch-status-${jobId}`,
    text: formatSubagentDispatchFeedback(action, jobId),
    format: "text",
    metadata: { runtimeDispatchFeedback: true },
  };
}

function formatSubagentDispatchFeedback(action: Extract<BrainOutboundAction, { type: "dispatch_subagent" }>, jobId: string): string {
  const summary = compactSnapshotText(action.summary || action.prompt.split(/\r?\n/).find((line) => line.trim())?.trim() || action.profile, 160);
  const model = action.model ?? "default";
  const effort = action.effort ?? "default";
  const ref = shortJobRef(jobId);
  const route = action.route ?? "return_to_main";
  return [
    `Sub: ${summary}`,
    `${action.profile} · ${model} · ${effort}`,
    `ref: ${ref} · id: ${jobId} · route: ${route}`,
    "Use `agents` for live status or `agent status <ref>` / `agent steer <ref> <text>` when supported.",
  ].join("\n");
}

function compactSnapshotText(text: string, maxLength = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function summarizeControlResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as { job?: { id?: string; status?: string; profile?: string }; previousStatus?: string; candidates?: unknown[] };
  return {
    job: record.job ? { id: record.job.id, status: record.job.status, profile: record.job.profile } : undefined,
    previousStatus: record.previousStatus,
    candidates: record.candidates,
  };
}

function isStreamingPreDispatchAction(action: BrainOutboundAction): boolean {
  return action.type === "react" || action.type === "show_status" || (action.type === "send_text" && action.metadata?.runtimeDispatchFeedback === true);
}

function shortJobRef(id: string): string {
  const raw = id.startsWith("job_") ? id.slice(4) : id;
  return raw.slice(0, Math.min(8, raw.length));
}

function removeActionByIdentity(actions: BrainOutboundAction[], action: BrainOutboundAction): void {
  const index = actions.findIndex((candidate) => candidate === action);
  if (index >= 0) actions.splice(index, 1);
}

function originMetadata(event: EntryPointInboundEvent): Record<string, string> {
  return Object.fromEntries(Object.entries({
    eventId: event.id,
    entrypointId: event.entrypoint.entrypointId,
    channelKind: event.entrypoint.channelKind,
    conversationId: event.conversation?.id,
    threadId: event.conversation?.threadId,
    replyToExternalMessageId: event.kind === "message" ? event.conversation?.metadata?.messageId?.toString() : undefined,
  }).filter(([, value]) => value !== undefined)) as Record<string, string>;
}
