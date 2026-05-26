import { z } from "zod";

export const EngineSchema = z.enum(["claude", "codex"]);
export const HandoffActionSchema = z.enum(["plan", "review", "pr"]);
export const PlanningSessionStatusSchema = z.enum(["open", "locked", "executing", "done"]);

export const DevServerSchema = z.object({
  host: z.string(),
  default_repo_root: z.string()
});

export const SourceMetadataSchema = z
  .object({
    host: z.string().optional(),
    path: z.string().optional(),
    branch: z.string().optional(),
    remote_url: z.string().nullable().optional()
  })
  .passthrough();

export const ReverseProxyMetadataSchema = z
  .object({
    kind: z.string().optional(),
    upstream: z.string().optional(),
    domain: z.string().optional(),
    origin_ip: z.string().optional()
  })
  .passthrough();

export const DeployMetadataSchema = z
  .object({
    host: z.string().optional(),
    path: z.string().optional(),
    domain: z.string().optional(),
    service: z.string().optional(),
    env_file: z.string().optional(),
    env_vars: z.array(z.string()).optional(),
    runtime_user: z.string().optional(),
    port: z.number().int().positive().optional(),
    reverse_proxy: ReverseProxyMetadataSchema.optional(),
    provider: z.string().optional(),
    project: z.string().optional(),
    branch: z.string().optional(),
    output_dir: z.string().optional(),
    command: z.string().optional()
  })
  .passthrough();

export const HealthCheckMetadataSchema = z
  .object({
    kind: z.string(),
    url: z.string().optional(),
    command: z.string().optional()
  })
  .passthrough();

export const BackupMetadataSchema = z
  .object({
    kind: z.string(),
    source: z.string().optional(),
    destination: z.string().optional(),
    schedule: z.string().optional(),
    metadata: z.string().optional(),
    command: z.string().optional(),
    env_file: z.string().optional()
  })
  .passthrough();

export const AppEnvironmentMetadataSchema = z
  .object({
    source: SourceMetadataSchema.optional(),
    deploy: DeployMetadataSchema.optional(),
    health_checks: z.array(HealthCheckMetadataSchema).optional(),
    backups: z.array(BackupMetadataSchema).optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
    assumptions: z.array(z.string()).optional()
  })
  .passthrough();

export const AppMetadataSchema = z
  .object({
    kind: z.string().optional(),
    description: z.string().optional(),
    environments: z.record(z.string(), AppEnvironmentMetadataSchema).optional()
  })
  .passthrough();

export const AppsMetadataSchema = z.record(z.string(), AppMetadataSchema);
export const OpsMetadataSchema = z.record(z.string(), z.unknown());

export const RepoIndexEntrySchema = z.object({
  alias: z.string(),
  host: z.string().default("local"),
  path: z.string(),
  repo_name: z.string(),
  default_branch: z.string(),
  current_branch: z.string().nullable(),
  remote_url: z.string().nullable(),
  preferred_engine: EngineSchema,
  codex_model: z.string().nullable(),
  codex_effort: z.string().nullable().optional(),
  repo_manifest_path: z.string().nullable(),
  latest_plan: z.string().nullable(),
  latest_review: z.string().nullable(),
  latest_pr: z.string().nullable(),
  deploy_host: z.string().nullable().optional(),
  deploy_path: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  apps: AppsMetadataSchema.optional(),
  ops: OpsMetadataSchema.optional(),
  registered_at: z.string(),
  updated_at: z.string()
});

export const RegistryIndexSchema = z.object({
  version: z.literal(1),
  controller_root: z.string(),
  dev_servers: z.record(z.string(), DevServerSchema).optional().default({}),
  repos: z.record(z.string(), RepoIndexEntrySchema)
});

export const RegistryConfigSchema = z.object({
  version: z.literal(1),
  default_engine: EngineSchema.default("claude"),
  default_codex_model: z.string().default("gpt-5.5"),
  default_codex_effort: z.string().nullable().default("xhigh")
});

export const RepoStateSchema = z.object({
  version: z.literal(1),
  alias: z.string(),
  controller_root: z.string(),
  repo_root: z.string(),
  repo_manifest_path: z.string(),
  notes_path: z.string(),
  guidance_path: z.string(),
  guidance_json_path: z.string(),
  artifacts_dir: z.string(),
  sessions_dir: z.string().optional(),
  active_plan_session_path: z.string().nullable().optional().default(null),
  deployment_host: z.string().nullable().optional(),
  deployment_path: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  apps: AppsMetadataSchema.optional(),
  ops: OpsMetadataSchema.optional(),
  preferred_engine: EngineSchema,
  codex: z
    .object({
      model: z.string().nullable(),
      effort: z.string().nullable().optional()
    })
    .passthrough(),
  latest: z.object({
    plan: z.string().nullable(),
    review: z.string().nullable(),
    pr: z.string().nullable()
  }),
  registered_at: z.string(),
  updated_at: z.string()
});

export const PlanningSessionSchema = z.object({
  version: z.literal(1),
  alias: z.string(),
  title: z.string(),
  plan_slug: z.string(),
  plan_artifact_path: z.string(),
  status: PlanningSessionStatusSchema,
  backend: EngineSchema,
  codex_thread_id: z.string().nullable(),
  last_prompt_path: z.string().nullable(),
  last_response_summary: z.string().nullable(),
  open_decisions: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string()
});

export const GuidanceFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  exists: z.boolean()
});

export const SkillDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(z.string())
});

export const GuidanceBundleSchema = z.object({
  alias: z.string(),
  repo_root: z.string(),
  host: z.string().nullable().optional(),
  deployment_host: z.string().nullable().optional(),
  deployment_path: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  apps: AppsMetadataSchema.optional(),
  ops: OpsMetadataSchema.optional(),
  has_agents: z.boolean(),
  files: z.array(GuidanceFileSchema),
  skill_directories: z.array(SkillDirectorySchema)
});

export type Engine = z.infer<typeof EngineSchema>;
export type HandoffAction = z.infer<typeof HandoffActionSchema>;
export type PlanningSessionStatus = z.infer<typeof PlanningSessionStatusSchema>;
export type DevServer = z.infer<typeof DevServerSchema>;
export type AppMetadataMap = z.infer<typeof AppsMetadataSchema>;
export type OpsMetadata = z.infer<typeof OpsMetadataSchema>;
export type RepoIndexEntry = z.infer<typeof RepoIndexEntrySchema>;
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;
export type RepoState = z.infer<typeof RepoStateSchema>;
export type GuidanceBundle = z.infer<typeof GuidanceBundleSchema>;
export type PlanningSession = z.infer<typeof PlanningSessionSchema>;
