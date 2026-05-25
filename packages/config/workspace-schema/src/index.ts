import { z } from "zod";

export const activeEntrypointModeSchema = z.enum(["single-primary", "multi-explicit"]);
export type ActiveEntrypointMode = z.infer<typeof activeEntrypointModeSchema>;

export const entrypointCapabilitiesSchema = z.record(z.string(), z.boolean()).default({});

export const entrypointConfigSchema = z.object({
  kind: z.string().min(1),
  enabled: z.boolean().default(false),
  displayName: z.string().min(1).optional(),
  configRef: z.string().min(1).optional(),
  capabilities: entrypointCapabilitiesSchema.optional(),
}).strict();
export type EntrypointConfig = z.infer<typeof entrypointConfigSchema>;

export const outboundDefaultsSchema = z.object({
  route: z.enum(["originating-entrypoint", "explicit-entrypoint", "admins", "store-only", "silent"]).default("originating-entrypoint"),
  allowCrossEntrypointReplies: z.boolean().default(false),
}).default({ route: "originating-entrypoint", allowCrossEntrypointReplies: false });

export const promptContextSchema = z.object({
  includeActiveEntrypointMetadata: z.boolean().default(true),
  exposeChannelSecrets: z.boolean().default(false),
}).default({ includeActiveEntrypointMetadata: true, exposeChannelSecrets: false });

export const backupStrategySchema = z.enum(["none", "local-snapshot", "private-git"]);
export type BackupStrategy = z.infer<typeof backupStrategySchema>;

export const defaultBackupInclude = [
  "config/**",
  "state/**",
  "data/**",
  "instructions/**",
  "tasks/**",
  "projects/**",
  "notes/**",
  "documents/metadata/**",
  "private/documents/metadata.jsonl",
  "artifacts/metadata/**",
  ".claude/repo-registry/index.yaml",
  ".claude/repo-registry/config.yaml",
  ".claude/repo-registry/repos/**/state.yaml",
  ".claude/repo-registry/repos/**/guidance.md",
  ".claude/repo-registry/repos/**/guidance.json",
  ".claude/repo-registry/repos/**/notes.md",
];
export const defaultBackupExclude = [
  "secrets/**",
  "logs/**",
  "tmp/**",
  "cache/**",
  "caches/**",
  "state/setup-progress.json",
  "private/documents/files/**",
  ".claude/repo-registry/runtime/node_modules/**",
  ".claude/repo-registry/runtime/dist/**",
  ".claude/repo-registry/runtime/.turbo/**",
  "**/.cache/**",
  "**/node_modules/**",
  "**/*.log",
];

export const backupPrivateGitSchema = z.object({
  repoPath: z.string().min(1).optional(),
  remote: z.string().min(1).optional(),
  branch: z.string().min(1).default("main"),
  include: z.array(z.string().min(1)).default(defaultBackupInclude),
  exclude: z.array(z.string().min(1)).default(defaultBackupExclude),
}).strict().default({ branch: "main", include: defaultBackupInclude, exclude: defaultBackupExclude });
export type BackupPrivateGitConfig = z.infer<typeof backupPrivateGitSchema>;

export const backupLocalSnapshotSchema = z.object({
  root: z.string().min(1).optional(),
  retention: z.string().min(1).optional(),
  include: z.array(z.string().min(1)).default(defaultBackupInclude),
  exclude: z.array(z.string().min(1)).default(defaultBackupExclude),
}).strict().default({ include: defaultBackupInclude, exclude: defaultBackupExclude });
export type BackupLocalSnapshotConfig = z.infer<typeof backupLocalSnapshotSchema>;

export const backupConfigSchema = z.object({
  strategy: backupStrategySchema.default("none"),
  localSnapshot: backupLocalSnapshotSchema.optional(),
  privateGit: backupPrivateGitSchema.optional(),
}).strict().default({ strategy: "none" });
export type BackupConfig = z.infer<typeof backupConfigSchema>;

export const webPublishingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["disabled", "domain", "ip"]).default("disabled"),
  domain: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  publishRoot: z.string().min(1).optional(),
  publicBaseUrl: z.string().min(1).optional(),
  manifestPath: z.string().min(1).optional(),
  reverseProxy: z.object({
    kind: z.string().min(1).default("caddy"),
    note: z.string().min(1).optional(),
  }).strict().optional(),
  dns: z.object({
    required: z.boolean().optional(),
    record: z.string().min(1).optional(),
  }).strict().optional(),
}).strict().default({ enabled: false, mode: "disabled" });
export type WebPublishingConfig = z.infer<typeof webPublishingConfigSchema>;

export const composioDataSourceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  connectedAccountRef: z.string().min(1).optional(),
  metadataRef: z.string().min(1).optional(),
  requiredEnvRefs: z.array(z.string().min(1)).default([]),
}).strict().default({ enabled: false, requiredEnvRefs: [] });
export type ComposioDataSourceConfig = z.infer<typeof composioDataSourceConfigSchema>;

export const composioConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKeyRef: z.string().min(1).optional(),
  connectedAccountRef: z.string().min(1).optional(),
  metadataRef: z.string().min(1).optional(),
  dataSources: z.object({
    googleCalendar: composioDataSourceConfigSchema.optional(),
    chat: composioDataSourceConfigSchema.optional(),
  }).strict().default({}),
}).strict().default({ enabled: false, dataSources: {} });
export type ComposioConfig = z.infer<typeof composioConfigSchema>;


export const transcriptionAttachmentKindSchema = z.enum(["voice", "audio", "video"]);
export type TranscriptionAttachmentKind = z.infer<typeof transcriptionAttachmentKindSchema>;

export const transcriptionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["openai"]).default("openai"),
  apiKeyRef: z.string().min(1).optional(),
  model: z.string().min(1).default("gpt-4o-mini-transcribe"),
  language: z.string().default(""),
  promptPath: z.string().default(""),
  scope: z.object({
    entrypointIds: z.array(z.string().min(1)).default([]),
    attachmentKinds: z.array(transcriptionAttachmentKindSchema).min(1).default(["voice", "audio"]),
  }).strict().default({ entrypointIds: [], attachmentKinds: ["voice", "audio"] }),
}).strict().default({ enabled: false, provider: "openai", model: "gpt-4o-mini-transcribe", language: "", promptPath: "", scope: { entrypointIds: [], attachmentKinds: ["voice", "audio"] } });
export type TranscriptionConfig = z.infer<typeof transcriptionConfigSchema>;

export const integrationsConfigSchema = z.object({
  composio: composioConfigSchema.optional(),
}).strict().default({});
export type IntegrationsConfig = z.infer<typeof integrationsConfigSchema>;

export const workspaceConfigSchema = z.object({
  workspacePath: z.string().min(1),
  provider: z.string().min(1).optional(),
  primaryEntrypointId: z.string().min(1),
  enabledEntrypoints: z.record(z.string().min(1), entrypointConfigSchema),
  outboundDefaults: outboundDefaultsSchema.optional(),
  promptContext: promptContextSchema.optional(),
  activeEntrypointMode: activeEntrypointModeSchema.optional(),
  backup: backupConfigSchema.optional(),
  webPublishing: webPublishingConfigSchema.optional(),
  integrations: integrationsConfigSchema.optional(),
  transcription: transcriptionConfigSchema.optional(),
}).strict();
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export const brainConfigSchema = z.object({
  runtime: z.object({
    activeEntrypointMode: activeEntrypointModeSchema.default("single-primary"),
  }).default({ activeEntrypointMode: "single-primary" }),
  workspaces: z.record(z.string().min(1), workspaceConfigSchema),
}).strict();
export type BrainConfig = z.infer<typeof brainConfigSchema>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface WorkspaceValidationResult {
  ok: boolean;
  config?: BrainConfig;
  issues: ValidationIssue[];
}

export function validateWorkspaceConfig(input: unknown): WorkspaceValidationResult {
  const parsed = brainConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }

  const config = parsed.data;
  const issues: ValidationIssue[] = [];
  for (const [workspaceId, workspace] of Object.entries(config.workspaces)) {
    const mode = workspace.activeEntrypointMode ?? config.runtime.activeEntrypointMode;
    const prefix = `workspaces.${workspaceId}`;
    const entries = workspace.enabledEntrypoints;
    const primary = entries[workspace.primaryEntrypointId];
    if (!primary) {
      issues.push({ path: `${prefix}.primaryEntrypointId`, message: "primaryEntrypointId must exist in enabledEntrypoints" });
    } else if (!primary.enabled) {
      issues.push({ path: `${prefix}.enabledEntrypoints.${workspace.primaryEntrypointId}.enabled`, message: "primaryEntrypointId must be enabled" });
    }

    const enabledEntries = Object.entries(entries).filter(([, entry]) => entry.enabled);
    if (mode === "single-primary") {
      if (enabledEntries.length !== 1) {
        issues.push({ path: `${prefix}.enabledEntrypoints`, message: "single-primary mode requires exactly one enabled entrypoint" });
      }
      if (enabledEntries.length === 1 && enabledEntries[0]?.[0] !== workspace.primaryEntrypointId) {
        issues.push({ path: `${prefix}.enabledEntrypoints`, message: "single-primary mode requires the only enabled entrypoint to be primary" });
      }
      const allowCross = workspace.outboundDefaults?.allowCrossEntrypointReplies ?? false;
      if (allowCross) {
        issues.push({ path: `${prefix}.outboundDefaults.allowCrossEntrypointReplies`, message: "single-primary mode must not allow cross-entrypoint replies" });
      }
    }

    if ((workspace.promptContext?.exposeChannelSecrets ?? false) === true) {
      issues.push({ path: `${prefix}.promptContext.exposeChannelSecrets`, message: "prompt context must not expose channel secrets" });
    }

    if ((workspace.backup?.strategy ?? "none") === "private-git" && !workspace.backup?.privateGit?.repoPath) {
      issues.push({ path: `${prefix}.backup.privateGit.repoPath`, message: "private-git backup strategy requires privateGit.repoPath" });
    }

    if ((workspace.backup?.strategy ?? "none") === "local-snapshot" && !workspace.backup?.localSnapshot?.root) {
      issues.push({ path: `${prefix}.backup.localSnapshot.root`, message: "local-snapshot backup strategy requires localSnapshot.root" });
    }

    if ((workspace.webPublishing?.enabled ?? false) && !(workspace.webPublishing?.baseUrl ?? workspace.webPublishing?.publicBaseUrl)) {
      issues.push({ path: `${prefix}.webPublishing.baseUrl`, message: "enabled web publishing requires baseUrl or publicBaseUrl" });
    }

    if ((workspace.transcription?.enabled ?? false) && !workspace.transcription?.apiKeyRef) {
      issues.push({ path: `${prefix}.transcription.apiKeyRef`, message: "enabled OpenAI transcription requires apiKeyRef" });
    }

    for (const entrypointId of workspace.transcription?.scope?.entrypointIds ?? []) {
      if (!entries[entrypointId]) {
        issues.push({ path: `${prefix}.transcription.scope.entrypointIds`, message: `transcription scope entrypoint does not exist: ${entrypointId}` });
      }
    }

    const route = workspace.outboundDefaults?.route ?? "originating-entrypoint";
    if (route !== "originating-entrypoint") {
      issues.push({ path: `${prefix}.outboundDefaults.route`, message: "initial runtime requires outbound default route to be originating-entrypoint" });
    }
  }

  return { ok: issues.length === 0, config, issues };
}

export function enabledEntrypointIds(workspace: WorkspaceConfig): string[] {
  return Object.entries(workspace.enabledEntrypoints)
    .filter(([, entry]) => entry.enabled)
    .map(([id]) => id);
}
