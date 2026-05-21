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

export const workspaceConfigSchema = z.object({
  workspacePath: z.string().min(1),
  provider: z.string().min(1).optional(),
  primaryEntrypointId: z.string().min(1),
  enabledEntrypoints: z.record(z.string().min(1), entrypointConfigSchema),
  outboundDefaults: outboundDefaultsSchema.optional(),
  promptContext: promptContextSchema.optional(),
  activeEntrypointMode: activeEntrypointModeSchema.optional(),
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
