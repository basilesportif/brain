import path from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapController } from "./bootstrap.js";
import {
  defaultControllerRoot,
  ensureDir,
  nowIso,
  parseArgs,
  pathExists,
  readYaml,
  registryRoot,
  repoStateDir,
  requireStringArg,
  sanitizeAlias,
  writeText,
  writeYaml
} from "./fs-utils.js";
import { getCurrentBranch, getDefaultBranch, getRemoteUrl, resolveGitRoot } from "./git-utils.js";
import { backfillAppsMetadata, legacyDeploymentFromApps, mergeAppsMetadata, mergeMetadata, metadataOrUndefined } from "./metadata.js";
import {
  RegistryConfigSchema,
  RegistryIndexSchema,
  RepoStateSchema,
  type RegistryIndex,
  type RepoState
} from "./schema.js";

export async function registerRepo(options: {
  alias: string;
  targetPath?: string;
  controllerRoot?: string;
}): Promise<RepoState> {
  const controllerRoot = options.controllerRoot || defaultControllerRoot();
  await bootstrapController(controllerRoot);

  const root = registryRoot(controllerRoot);
  const indexPath = path.join(root, "index.yaml");
  const configPath = path.join(root, "config.yaml");
  const index = await readYaml(indexPath, RegistryIndexSchema);
  const config = await readYaml(configPath, RegistryConfigSchema);

  const alias = sanitizeAlias(options.alias);
  if (!alias) {
    throw new Error("Alias cannot be empty");
  }

  const targetPath = options.targetPath || process.cwd();
  const repoRoot = await resolveGitRoot(targetPath);
  const existing = index.repos[alias];
  if (existing && existing.path !== repoRoot) {
    throw new Error(`Alias '${alias}' is already registered for ${existing.path}`);
  }

  const defaultBranch = await getDefaultBranch(repoRoot);
  const currentBranch = await getCurrentBranch(repoRoot);
  const remoteUrl = await getRemoteUrl(repoRoot);
  const repoName = path.basename(repoRoot);
  const repoLocalDir = path.join(repoRoot, ".claude", "repo-registry");
  const manifestPath = path.join(repoLocalDir, "manifest.yaml");

  const stateDir = repoStateDir(controllerRoot, alias);
  const notesPath = path.join(stateDir, "notes.md");
  const guidancePath = path.join(stateDir, "guidance.md");
  const guidanceJsonPath = path.join(stateDir, "guidance.json");
  const artifactsDir = path.join(stateDir, "artifacts");
  const sessionsDir = path.join(stateDir, "sessions");
  const statePath = path.join(stateDir, "state.yaml");
  const timestamp = nowIso();
  const existingState = (await pathExists(statePath)) ? await readYaml(statePath, RepoStateSchema) : null;
  const existingApps = mergeAppsMetadata(existingState?.apps, existing?.apps);
  const existingOps = mergeMetadata(existingState?.ops, existing?.ops);
  const appDeployment = legacyDeploymentFromApps(existingApps, alias);
  const deploymentHost = existingState?.deployment_host ?? existing?.deploy_host ?? appDeployment.deployHost;
  const deploymentPath = existingState?.deployment_path ?? existing?.deploy_path ?? appDeployment.deployPath;
  const deploymentDomain = existingState?.domain ?? existing?.domain ?? appDeployment.domain;
  const apps = metadataOrUndefined(
    backfillAppsMetadata(existingApps, {
      alias,
      sourceHost: existing?.host ?? "local",
      sourcePath: repoRoot,
      deployHost: deploymentHost,
      deployPath: deploymentPath,
      domain: deploymentDomain
    })
  );
  const ops = metadataOrUndefined(existingOps);

  await ensureDir(stateDir);
  await ensureDir(artifactsDir);
  await ensureDir(sessionsDir);
  await ensureDir(repoLocalDir);

  const state: RepoState = RepoStateSchema.parse({
    version: 1,
    alias,
    controller_root: controllerRoot,
    repo_root: repoRoot,
    repo_manifest_path: manifestPath,
    notes_path: notesPath,
    guidance_path: guidancePath,
    guidance_json_path: guidanceJsonPath,
    artifacts_dir: artifactsDir,
    sessions_dir: existingState?.sessions_dir ?? sessionsDir,
    active_plan_session_path: existingState?.active_plan_session_path ?? null,
    ...(deploymentHost ? { deployment_host: deploymentHost } : {}),
    ...(deploymentPath ? { deployment_path: deploymentPath } : {}),
    ...(deploymentDomain ? { domain: deploymentDomain } : {}),
    ...(apps ? { apps } : {}),
    ...(ops ? { ops } : {}),
    preferred_engine: existingState?.preferred_engine ?? existing?.preferred_engine ?? config.default_engine,
    codex: {
      model: existingState?.codex.model ?? existing?.codex_model ?? config.default_codex_model,
      effort: existingState?.codex.effort ?? existing?.codex_effort ?? config.default_codex_effort
    },
    latest: {
      plan: existingState?.latest.plan ?? existing?.latest_plan ?? null,
      review: existingState?.latest.review ?? existing?.latest_review ?? null,
      pr: existingState?.latest.pr ?? existing?.latest_pr ?? null
    },
    registered_at: existingState?.registered_at ?? existing?.registered_at ?? timestamp,
    updated_at: timestamp
  });

  const nextIndex: RegistryIndex = RegistryIndexSchema.parse({
    ...index,
    repos: {
      ...index.repos,
      [alias]: {
        ...existing,
        alias,
        host: existing?.host ?? "local",
        path: repoRoot,
        repo_name: repoName,
        default_branch: defaultBranch,
        current_branch: currentBranch,
        remote_url: remoteUrl,
        preferred_engine: state.preferred_engine,
        codex_model: state.codex.model,
        codex_effort: state.codex.effort,
        repo_manifest_path: manifestPath,
        latest_plan: state.latest.plan,
        latest_review: state.latest.review,
        latest_pr: state.latest.pr,
        ...(deploymentHost ? { deploy_host: deploymentHost } : {}),
        ...(deploymentPath ? { deploy_path: deploymentPath } : {}),
        ...(deploymentDomain ? { domain: deploymentDomain } : {}),
        ...(apps ? { apps } : {}),
        ...(ops ? { ops } : {}),
        registered_at: existing?.registered_at ?? timestamp,
        updated_at: timestamp
      }
    }
  });

  await writeYaml(indexPath, nextIndex);
  await writeYaml(statePath, state);
  if (!(await pathExists(notesPath))) {
    await writeText(
      notesPath,
      `# ${alias}\n\n- Repo root: ${repoRoot}\n- Default branch: ${defaultBranch}\n- Preferred engine: ${state.preferred_engine}\n\nAdd user-facing notes for this repo here.\n`
    );
  }
  if (!(await pathExists(guidancePath))) {
    await writeText(
      guidancePath,
      `# Guidance for ${alias}\n\nGuidance has not been collected yet. Run \`collect-guidance\` before the next handoff.\n`
    );
  }
  if (!(await pathExists(guidanceJsonPath))) {
    await writeText(
      guidanceJsonPath,
      JSON.stringify(
        {
          alias,
          repo_root: repoRoot,
          ...(deploymentHost ? { deployment_host: deploymentHost } : {}),
          ...(deploymentPath ? { deployment_path: deploymentPath } : {}),
          ...(deploymentDomain ? { domain: deploymentDomain } : {}),
          ...(apps ? { apps } : {}),
          ...(ops ? { ops } : {}),
          has_agents: false,
          files: [],
          skill_directories: []
        },
        null,
        2
      )
    );
  }

  await writeYaml(manifestPath, {
    version: 1,
    alias,
    controller_root: controllerRoot,
    repo_root: repoRoot,
    controller_state_path: statePath
  });

  return state;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const alias = sanitizeAlias(requireStringArg(args, "alias"));
  const controllerRoot = args["controller-root"] ? String(args["controller-root"]) : defaultControllerRoot();
  const targetPath = typeof args.path === "string" ? args.path : process.cwd();
  const state = await registerRepo({
    alias,
    targetPath,
    controllerRoot
  });
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
