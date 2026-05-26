import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGuidance } from "./collect-guidance.js";
import {
  artifactName,
  defaultControllerRoot,
  getBooleanArg,
  getStringArgs,
  nowIso,
  parseArgs,
  pathExists,
  promptFileName,
  readText,
  readYaml,
  registryRoot,
  requireStringArg,
  writeText,
  writeYaml
} from "./fs-utils.js";
import { backfillAppsMetadata, legacyDeploymentFromApps, mergeAppsMetadata, mergeMetadata, metadataOrUndefined } from "./metadata.js";
import { sessionPathForTitle, sessionsDirForState, summarizeSessionText, upsertPlanningSession } from "./planning-session.js";
import { runCodexSdk } from "./run-codex-sdk.js";
import { resolveRepo } from "./resolve-repo.js";
import {
  EngineSchema,
  HandoffActionSchema,
  PlanningSessionStatusSchema,
  RegistryConfigSchema,
  RegistryIndexSchema,
  RepoStateSchema,
  type HandoffAction,
  type PlanningSessionStatus,
  type RepoState
} from "./schema.js";

function actionInstructions(action: HandoffAction): string {
  switch (action) {
    case "plan":
      return "Produce a concrete implementation plan with checkbox tasks, explicit acceptance criteria, and any repo-specific constraints that matter.";
    case "review":
      return "Perform a code review. Findings come first, ordered by severity, with concrete evidence and residual risks.";
    case "pr":
      return "Prepare a PR draft with title, summary, verification notes, rollout notes, and any follow-up items. Do not open a remote PR.";
    default:
      return "Complete the requested repo handoff.";
  }
}

function initialPlanArtifact(options: {
  alias: string;
  engine: "claude" | "codex";
  title: string;
  generatedAt: string;
}): string {
  return [
    `# PLAN ${options.title}`,
    "",
    `- Alias: ${options.alias}`,
    `- Engine: ${options.engine}`,
    `- Generated at: ${options.generatedAt}`,
    "",
    "## Goal",
    "- Pending refinement.",
    "",
    "## Current Recommendation",
    "- Pending planning output.",
    "",
    "## Open Questions",
    "- None recorded yet.",
    "",
    "## Decision Log",
    "- No decisions recorded yet.",
    "",
    "## Locked Plan",
    "- Not locked yet.",
    "",
    "## Execution Handoff",
    "- Pending.",
    ""
  ].join("\n");
}

export function buildPromptBundle(options: {
  alias: string;
  repoRoot: string;
  action: HandoffAction;
  title: string;
  artifactPath: string;
  guidanceText: string;
  notesText: string | null;
  userInstruction: string | null;
}): string {
  const lines = [
    "# Repo Registry Handoff",
    "",
    `- Alias: ${options.alias}`,
    `- Repo root: ${options.repoRoot}`,
    `- Action: ${options.action}`,
    `- Title: ${options.title}`,
    `- Artifact path: ${options.artifactPath}`,
    "",
    "## Task contract",
    "",
    actionInstructions(options.action),
    "",
    "Write the final result to the artifact path above.",
    ""
  ];

  if (options.userInstruction) {
    lines.push("## User instruction", "", options.userInstruction, "");
  }

  if (options.notesText) {
    lines.push("## Registry notes", "", options.notesText.trim(), "");
  }

  lines.push("## Repo guidance bundle", "", options.guidanceText.trim(), "");
  return lines.join("\n");
}

export async function runHandoff(options: {
  alias: string;
  action: HandoffAction;
  engine: "claude" | "codex";
  title: string;
  userInstruction: string | null;
  previewOnly?: boolean;
  codexThreadId?: string | null;
  sessionStatus?: PlanningSessionStatus;
  responseSummary?: string | null;
  openDecisions?: string[];
  controllerRoot?: string;
}): Promise<{
  alias: string;
  action: HandoffAction;
  engine: "claude" | "codex";
  artifactPath: string;
  promptPath: string;
  repoRoot: string;
  guidancePath: string;
  sessionPath: string | null;
}> {
  const controllerRoot = options.controllerRoot || defaultControllerRoot();
  const { entry, state, statePath } = await resolveRepo(options.alias, controllerRoot);
  const parsedState = RepoStateSchema.parse(state);
  const sessionsDir = sessionsDirForState(parsedState);
  const { guidancePath } = await collectGuidance(options.alias, controllerRoot);
  const guidanceText = await readText(guidancePath);
  const notesText = await readText(parsedState.notes_path);
  const generatedAt = nowIso();

  const artifactPath = path.join(parsedState.artifacts_dir, artifactName(options.action, options.title));
  const promptPath = path.join(parsedState.artifacts_dir, promptFileName(options.action, options.title));
  const promptBundle = buildPromptBundle({
    alias: parsedState.alias,
    repoRoot: parsedState.repo_root,
    action: options.action,
    title: options.title,
    artifactPath,
    guidanceText,
    notesText,
    userInstruction: options.userInstruction
  });

  const artifactExists = await pathExists(artifactPath);
  if (!artifactExists) {
    await writeText(
      artifactPath,
      options.action === "plan"
        ? initialPlanArtifact({
            alias: parsedState.alias,
            engine: options.engine,
            title: options.title,
            generatedAt
          })
        : `# ${options.action.toUpperCase()} ${options.title}\n\n- Alias: ${parsedState.alias}\n- Engine: ${options.engine}\n- Generated at: ${generatedAt}\n\nPending execution.\n`
    );
  }
  await writeText(promptPath, promptBundle);

  let sessionPath: string | null = null;
  if (options.action === "plan") {
    sessionPath = sessionPathForTitle(
      {
        ...parsedState,
        sessions_dir: sessionsDir
      },
      options.title
    );

    await upsertPlanningSession({
      state: {
        ...parsedState,
        sessions_dir: sessionsDir
      },
      title: options.title,
      artifactPath,
      promptPath,
      backend: options.engine,
      status: options.sessionStatus,
      codexThreadId: options.codexThreadId,
      lastResponseSummary: options.responseSummary,
      openDecisions: options.openDecisions
    });
  }

  const stateExistingApps = mergeAppsMetadata(parsedState.apps, entry.apps);
  const stateAppDeployment = legacyDeploymentFromApps(stateExistingApps, parsedState.alias);
  const stateDeploymentHost = parsedState.deployment_host ?? entry.deploy_host ?? stateAppDeployment.deployHost;
  const stateDeploymentPath = parsedState.deployment_path ?? entry.deploy_path ?? stateAppDeployment.deployPath;
  const stateDeploymentDomain = parsedState.domain ?? entry.domain ?? stateAppDeployment.domain;
  const stateApps = metadataOrUndefined(
    backfillAppsMetadata(stateExistingApps, {
      alias: parsedState.alias,
      sourceHost: entry.host,
      sourcePath: parsedState.repo_root,
      deployHost: stateDeploymentHost,
      deployPath: stateDeploymentPath,
      domain: stateDeploymentDomain
    })
  );
  const stateOps = metadataOrUndefined(mergeMetadata(parsedState.ops, entry.ops));

  const nextState: RepoState = RepoStateSchema.parse({
    ...parsedState,
    sessions_dir: sessionsDir,
    active_plan_session_path: options.action === "plan" ? sessionPath : parsedState.active_plan_session_path ?? null,
    ...(stateDeploymentHost ? { deployment_host: stateDeploymentHost } : {}),
    ...(stateDeploymentPath ? { deployment_path: stateDeploymentPath } : {}),
    ...(stateDeploymentDomain ? { domain: stateDeploymentDomain } : {}),
    ...(stateApps ? { apps: stateApps } : {}),
    ...(stateOps ? { ops: stateOps } : {}),
    latest: {
      ...parsedState.latest,
      [options.action]: artifactPath
    },
    updated_at: generatedAt
  });

  await writeYaml(statePath, nextState);

  const indexPath = path.join(registryRoot(controllerRoot), "index.yaml");
  const parsedIndex = await readYaml(indexPath, RegistryIndexSchema);
  const existingEntry = parsedIndex.repos[parsedState.alias];
  const existingApps = mergeAppsMetadata(nextState.apps, existingEntry?.apps);
  const appDeployment = legacyDeploymentFromApps(existingApps, parsedState.alias);
  const deploymentHost = nextState.deployment_host ?? existingEntry?.deploy_host ?? appDeployment.deployHost;
  const deploymentPath = nextState.deployment_path ?? existingEntry?.deploy_path ?? appDeployment.deployPath;
  const deploymentDomain = nextState.domain ?? existingEntry?.domain ?? appDeployment.domain;
  const apps = metadataOrUndefined(
    backfillAppsMetadata(existingApps, {
      alias: parsedState.alias,
      sourceHost: existingEntry?.host,
      sourcePath: parsedState.repo_root,
      deployHost: deploymentHost,
      deployPath: deploymentPath,
      domain: deploymentDomain
    })
  );
  const ops = metadataOrUndefined(mergeMetadata(nextState.ops, existingEntry?.ops));
  parsedIndex.repos[parsedState.alias] = {
    ...existingEntry,
    latest_plan: options.action === "plan" ? artifactPath : existingEntry?.latest_plan ?? null,
    latest_review: options.action === "review" ? artifactPath : existingEntry?.latest_review ?? null,
    latest_pr: options.action === "pr" ? artifactPath : existingEntry?.latest_pr ?? null,
    preferred_engine: options.engine,
    codex_model: nextState.codex.model,
    codex_effort: nextState.codex.effort,
    updated_at: nextState.updated_at,
    current_branch: existingEntry?.current_branch ?? null,
    remote_url: existingEntry?.remote_url ?? null,
    default_branch: existingEntry?.default_branch ?? "main",
    repo_name: existingEntry?.repo_name ?? path.basename(parsedState.repo_root),
    repo_manifest_path: parsedState.repo_manifest_path,
    alias: parsedState.alias,
    path: parsedState.repo_root,
    ...(deploymentHost ? { deploy_host: deploymentHost } : {}),
    ...(deploymentPath ? { deploy_path: deploymentPath } : {}),
    ...(deploymentDomain ? { domain: deploymentDomain } : {}),
    ...(apps ? { apps } : {}),
    ...(ops ? { ops } : {}),
    registered_at: existingEntry?.registered_at ?? nextState.registered_at
  };
  await writeYaml(indexPath, parsedIndex);

  if (options.engine === "codex" && !options.previewOnly) {
    const configPath = path.join(registryRoot(controllerRoot), "config.yaml");
    const config = await readYaml(configPath, RegistryConfigSchema);
    const model = nextState.codex.model || config.default_codex_model;
    const effort = nextState.codex.effort || config.default_codex_effort;
    await runCodexSdk({
      alias: parsedState.alias,
      promptFile: promptPath,
      artifactPath,
      model,
      effort,
      controllerRoot
    });
  }

  if (options.action === "plan" && sessionPath) {
    const responseSummary =
      options.responseSummary ??
      (options.engine === "codex" && !options.previewOnly ? summarizeSessionText(await readText(artifactPath)) : null);

    await upsertPlanningSession({
      state: nextState,
      title: options.title,
      artifactPath,
      promptPath,
      backend: options.engine,
      status: options.sessionStatus,
      codexThreadId: options.codexThreadId,
      lastResponseSummary: responseSummary,
      openDecisions: options.openDecisions
    });
  }

  return {
    alias: parsedState.alias,
    action: options.action,
    engine: options.engine,
    artifactPath,
    promptPath,
    repoRoot: parsedState.repo_root,
    guidancePath,
    sessionPath
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const alias = requireStringArg(args, "alias");
  const action = HandoffActionSchema.parse(requireStringArg(args, "action"));
  const engine = EngineSchema.parse(requireStringArg(args, "engine"));
  const title = requireStringArg(args, "title");
  const userInstruction =
    typeof args.instruction === "string"
      ? args.instruction
      : typeof args["instruction-file"] === "string"
        ? await readText(args["instruction-file"])
        : null;
  const previewOnly = getBooleanArg(args, "preview-only");
  const codexThreadId = typeof args["codex-thread-id"] === "string" ? args["codex-thread-id"] : null;
  const sessionStatus =
    typeof args["session-status"] === "string" ? PlanningSessionStatusSchema.parse(args["session-status"]) : undefined;
  const responseSummary =
    typeof args["response-summary"] === "string"
      ? args["response-summary"]
      : typeof args["response-summary-file"] === "string"
        ? await readText(args["response-summary-file"])
        : null;
  const openDecisions = getStringArgs(args, "open-decision");

  const result = await runHandoff({
    alias,
    action,
    engine,
    title,
    userInstruction,
    previewOnly,
    codexThreadId,
    sessionStatus,
    responseSummary,
    openDecisions: openDecisions.length > 0 ? openDecisions : undefined,
    controllerRoot: typeof args["controller-root"] === "string" ? args["controller-root"] : defaultControllerRoot()
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
