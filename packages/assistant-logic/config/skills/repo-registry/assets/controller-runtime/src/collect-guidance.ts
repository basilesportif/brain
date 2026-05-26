import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultControllerRoot,
  ensureDir,
  extractLocalReferences,
  isPathWithinRoot,
  listFilesRecursively,
  normalizeLocalReference,
  nowIso,
  parseArgs,
  pathExists,
  readText,
  readTextIfExists,
  repoStateDir,
  requireStringArg,
  writeText
} from "./fs-utils.js";
import { backfillAppsMetadata, legacyDeploymentFromApps, mergeAppsMetadata, mergeMetadata, metadataOrUndefined } from "./metadata.js";
import { resolveRepo } from "./resolve-repo.js";
import { GuidanceBundleSchema, RepoStateSchema, type GuidanceBundle } from "./schema.js";

const ROOT_GUIDANCE_FILES = ["AGENTS.md", "README.md", "SETUP.md", "SKILLS_INDEX.md"];
const SKILL_DIRECTORIES = ["skills", ".agents/skills", ".claude/skills"];

export async function collectGuidance(alias: string, controllerRoot = defaultControllerRoot()): Promise<{
  bundle: GuidanceBundle;
  guidancePath: string;
  guidanceJsonPath: string;
}> {
  const { entry, state } = await resolveRepo(alias, controllerRoot);
  const parsedState = RepoStateSchema.parse(state);
  const repoRoot = parsedState.repo_root;
  const repoDir = repoStateDir(controllerRoot, parsedState.alias);
  await ensureDir(repoDir);
  const existingApps = mergeAppsMetadata(parsedState.apps, entry.apps);
  const appDeployment = legacyDeploymentFromApps(existingApps, parsedState.alias);
  const deploymentHost = parsedState.deployment_host ?? entry.deploy_host ?? appDeployment.deployHost;
  const deploymentPath = parsedState.deployment_path ?? entry.deploy_path ?? appDeployment.deployPath;
  const deploymentDomain = parsedState.domain ?? entry.domain ?? appDeployment.domain;
  const apps = metadataOrUndefined(
    backfillAppsMetadata(existingApps, {
      alias: parsedState.alias,
      sourceHost: entry.host,
      sourcePath: repoRoot,
      deployHost: deploymentHost,
      deployPath: deploymentPath,
      domain: deploymentDomain
    })
  );
  const ops = metadataOrUndefined(mergeMetadata(parsedState.ops, entry.ops));

  const fileRecords: GuidanceBundle["files"] = [];
  const includedTexts: Array<{ path: string; contents: string }> = [];
  const candidatePaths = new Set<string>(ROOT_GUIDANCE_FILES);

  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const agentsText = await readTextIfExists(agentsPath);
  if (agentsText) {
    for (const reference of extractLocalReferences(agentsText)) {
      const normalized = normalizeLocalReference(reference);
      if (normalized) {
        candidatePaths.add(normalized);
      }
    }
  }

  for (const relativePath of [...candidatePaths]) {
    const absolutePath = path.join(repoRoot, relativePath);
    const exists = (await pathExists(absolutePath)) && isPathWithinRoot(repoRoot, absolutePath);
    fileRecords.push({
      path: relativePath,
      reason: ROOT_GUIDANCE_FILES.includes(relativePath) ? "root-default" : "agents-reference",
      exists
    });

    if (!exists) continue;

    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) continue;
    includedTexts.push({
      path: relativePath,
      contents: await readText(absolutePath)
    });
  }

  const skillDirectories: GuidanceBundle["skill_directories"] = [];
  for (const relativeDir of SKILL_DIRECTORIES) {
    const absoluteDir = path.join(repoRoot, relativeDir);
    if (!(await pathExists(absoluteDir))) continue;
    const entries = (await listFilesRecursively(absoluteDir, 2, (candidate) => candidate.endsWith("SKILL.md"))).map((candidate) =>
      path.relative(repoRoot, candidate)
    );
    skillDirectories.push({
      path: relativeDir,
      entries
    });
  }

  const bundle = GuidanceBundleSchema.parse({
    alias: parsedState.alias,
    repo_root: repoRoot,
    host: entry.host,
    ...(deploymentHost ? { deployment_host: deploymentHost } : {}),
    ...(deploymentPath ? { deployment_path: deploymentPath } : {}),
    ...(deploymentDomain ? { domain: deploymentDomain } : {}),
    ...(apps ? { apps } : {}),
    ...(ops ? { ops } : {}),
    has_agents: Boolean(agentsText),
    files: fileRecords,
    skill_directories: skillDirectories
  });

  const missingFiles = fileRecords.filter((record) => !record.exists).map((record) => record.path);
  const sections: string[] = [
    `# Guidance Bundle for ${parsedState.alias}`,
    "",
    `- Repo root: ${repoRoot}`,
    `- Host: ${entry.host}`,
    ...(deploymentHost ? [`- Deployment host: ${deploymentHost}`] : []),
    ...(deploymentPath ? [`- Deployment path: ${deploymentPath}`] : []),
    ...(deploymentDomain ? [`- Domain: ${deploymentDomain}`] : []),
    `- Generated at: ${nowIso()}`,
    `- AGENTS present: ${bundle.has_agents ? "yes" : "no"}`,
    ""
  ];

  if (!bundle.has_agents) {
    sections.push("> No AGENTS.md found at the repo root.", "");
  }

  if (apps) {
    sections.push("## App metadata", "", "```json", JSON.stringify(apps, null, 2), "```", "");
  }

  if (ops) {
    sections.push("## Ops metadata", "", "```json", JSON.stringify(ops, null, 2), "```", "");
  }

  for (const item of includedTexts) {
    sections.push(`## ${item.path}`, "", "```text", item.contents.replace(/\n$/, ""), "```", "");
  }

  if (skillDirectories.length > 0) {
    sections.push("## Repo-local skill inventory", "");
    for (const directory of skillDirectories) {
      sections.push(`### ${directory.path}`, "");
      if (directory.entries.length === 0) {
        sections.push("- No SKILL.md files found", "");
      } else {
        for (const entry of directory.entries) {
          sections.push(`- ${entry}`);
        }
        sections.push("");
      }
    }
  }

  if (missingFiles.length > 0) {
    sections.push("## Missing guidance files", "");
    for (const missing of missingFiles) {
      sections.push(`- ${missing}`);
    }
    sections.push("");
  }

  await writeText(parsedState.guidance_path, sections.join("\n"));
  await writeText(parsedState.guidance_json_path, JSON.stringify(bundle, null, 2));

  return {
    bundle,
    guidancePath: parsedState.guidance_path,
    guidanceJsonPath: parsedState.guidance_json_path
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const alias = requireStringArg(args, "alias");
  const controllerRoot = typeof args["controller-root"] === "string" ? args["controller-root"] : defaultControllerRoot();
  const result = await collectGuidance(alias, controllerRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
