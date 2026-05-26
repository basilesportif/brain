import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { bootstrapController } from "../src/bootstrap.js";
import { collectGuidance } from "../src/collect-guidance.js";
import { readText, readYaml, resolveControllerRoot, writeYaml } from "../src/fs-utils.js";
import { registerRepo } from "../src/register-repo.js";
import { resolveRepo } from "../src/resolve-repo.js";
import { runHandoff } from "../src/run-handoff.js";
import { GuidanceBundleSchema, PlanningSessionSchema, RegistryIndexSchema, RepoStateSchema } from "../src/schema.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

async function makeFixture(name: string): Promise<{
  baseDir: string;
  controllerRoot: string;
  repoRoot: string;
}> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), `repo-registry-${name}-`));
  tempDirs.push(baseDir);

  const controllerRoot = path.join(baseDir, "assistant-home");
  const repoRoot = path.join(baseDir, "demo-repo");

  await mkdir(controllerRoot, { recursive: true });
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["-C", repoRoot, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", repoRoot, "remote", "add", "origin", "https://example.com/demo.git"]);

  return { baseDir, controllerRoot, repoRoot };
}

async function seedRepoGuidance(repoRoot: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "AGENTS.md"),
    [
      "# Repo Rules",
      "",
      "Read [playbook](docs/playbook.md) before editing.",
      "Local skill refs live in `skills/example/SKILL.md`.",
      "This also points at [missing](docs/missing.md)."
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(repoRoot, "README.md"), "# Demo Repo\n", "utf8");
  await writeFile(path.join(repoRoot, "SETUP.md"), "# Setup\n", "utf8");
  await writeFile(path.join(repoRoot, "SKILLS_INDEX.md"), "# Skills\n", "utf8");
  await mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await writeFile(path.join(repoRoot, "docs", "playbook.md"), "# Playbook\n", "utf8");
  await mkdir(path.join(repoRoot, "skills", "example"), { recursive: true });
  await writeFile(path.join(repoRoot, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\n", "utf8");
}

describe("repo-registry runtime", () => {
  it("resolves controller root from workspace and assistant container env", async () => {
    const { baseDir } = await makeFixture("controller-root");
    const workspaceRoot = path.join(baseDir, "explicit-workspace");
    const assistantHome = path.join(baseDir, "assistant-home");
    const assistantContainer = path.join(baseDir, "assistant-container");
    const legacyRoot = path.join(baseDir, "legacy-root");

    expect(
      resolveControllerRoot({
        ASSISTANT_WORKSPACE: workspaceRoot,
        ASSISTANT_HOME: assistantHome,
        ASSISTANT_CONTAINER_ROOT: assistantContainer,
        ASSISTANT_CLAUDE_ROOT: legacyRoot
      })
    ).toEqual({
      controllerRoot: workspaceRoot,
      source: "env:ASSISTANT_WORKSPACE"
    });

    expect(
      resolveControllerRoot({
        ASSISTANT_HOME: assistantHome,
        ASSISTANT_CONTAINER_ROOT: assistantContainer,
        ASSISTANT_CLAUDE_ROOT: legacyRoot
      })
    ).toEqual({
      controllerRoot: path.join(assistantHome, "workspace"),
      source: "env:ASSISTANT_HOME/workspace"
    });

    expect(
      resolveControllerRoot({
        ASSISTANT_CONTAINER_ROOT: assistantContainer,
        ASSISTANT_CLAUDE_ROOT: legacyRoot
      })
    ).toEqual({
      controllerRoot: path.join(assistantContainer, "workspace"),
      source: "env:ASSISTANT_CONTAINER_ROOT/workspace"
    });

    expect(resolveControllerRoot({ ASSISTANT_CLAUDE_ROOT: legacyRoot })).toEqual({
      controllerRoot: path.join(legacyRoot, "workspace"),
      source: "env:ASSISTANT_CLAUDE_ROOT/workspace"
    });
  });

  it("rejects relative controller root env values", () => {
    expect(() => resolveControllerRoot({ ASSISTANT_WORKSPACE: "relative/workspace" })).toThrow(
      /ASSISTANT_WORKSPACE must be an absolute path/
    );
    expect(() => resolveControllerRoot({ ASSISTANT_HOME: "relative/home" })).toThrow(
      /ASSISTANT_HOME must be an absolute path/
    );
  });

  it("bootstraps controller state with defaults", async () => {
    const { controllerRoot } = await makeFixture("bootstrap");
    const result = await bootstrapController(controllerRoot);

    expect(result.registryRoot).toBe(path.join(controllerRoot, ".claude", "repo-registry"));
    const index = await readYaml(path.join(result.registryRoot, "index.yaml"), RegistryIndexSchema);
    expect(index.repos).toEqual({});

    const configText = await readText(path.join(result.registryRoot, "config.yaml"));
    expect(configText).toContain("default_engine: claude");
    expect(configText).toContain("default_codex_model: gpt-5.5");
    expect(configText).toContain("default_codex_effort: xhigh");
  });

  it("registers a repo, resolves it, and preserves existing notes on refresh", async () => {
    const { controllerRoot, repoRoot } = await makeFixture("register");
    const state = await registerRepo({ alias: "Demo Repo", targetPath: repoRoot, controllerRoot });

    await writeFile(state.notes_path, "# custom notes\n", "utf8");
    await registerRepo({ alias: "Demo Repo", targetPath: repoRoot, controllerRoot });

    const resolved = await resolveRepo("demo-repo", controllerRoot);
    expect(await realpath(resolved.entry.path)).toBe(await realpath(repoRoot));
    expect(await readText(state.notes_path)).toBe("# custom notes\n");
    expect(state.codex.model).toBe("gpt-5.5");
    expect(state.codex.effort).toBe("xhigh");
    expect(state.sessions_dir).toBe(path.join(controllerRoot, ".claude", "repo-registry", "repos", "demo-repo", "sessions"));
    expect(state.active_plan_session_path).toBeNull();

    const manifestText = await readText(path.join(repoRoot, ".claude", "repo-registry", "manifest.yaml"));
    expect(manifestText).toContain("alias: demo-repo");
  });

  it("preserves deployment metadata across repo refresh and handoff writes", async () => {
    const { controllerRoot, repoRoot } = await makeFixture("deployment-metadata");
    await seedRepoGuidance(repoRoot);
    const state = await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });

    const indexPath = path.join(controllerRoot, ".claude", "repo-registry", "index.yaml");
    const index = await readYaml(indexPath, RegistryIndexSchema);
    const apps = {
      demo: {
        kind: "web",
        environments: {
          production: {
            source: {
              host: "dev.example.com",
              path: "~/pkg/demo"
            },
            deploy: {
              host: "deploy.example.com",
              path: "/srv/demo",
              domain: "demo.example.com",
              service: "demo.service",
              env_file: "/etc/demo.env",
              env_vars: ["DEMO_API_TOKEN"],
              port: 3099,
              reverse_proxy: {
                upstream: "http://127.0.0.1:3099"
              }
            },
            health_checks: [
              {
                kind: "http",
                url: "https://demo.example.com/api/health"
              }
            ],
            backups: [
              {
                kind: "local-tar",
                source: "/srv/demo/data",
                destination: "/srv/demo/backups",
                schedule: "systemd timer every 15m",
                metadata: "latest-backup.json"
              }
            ],
            dependencies: {
              database_resources: [
                {
                  provider: "database-server",
                  namespace: "demo",
                  endpoint_env: "DATABASE_SERVER_URL",
                  token_env: "DATABASE_SERVER_TOKEN",
                  scopes: ["read", "write"]
                }
              ]
            },
            assumptions: ["Code edits happen on the source checkout; production only runs the service."]
          }
        }
      }
    };
    const ops = {
      runbook: {
        env_files: ["/etc/demo.env"],
        notes: ["Store env var names only, never secret values."]
      }
    };
    index.repos.demo = {
      ...index.repos.demo,
      deploy_host: "deploy.example.com",
      deploy_path: "/srv/demo",
      domain: "demo.example.com",
      apps,
      ops
    };
    await writeYaml(indexPath, index);

    await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });
    const refreshedIndex = await readYaml(indexPath, RegistryIndexSchema);
    expect(refreshedIndex.repos.demo.deploy_host).toBe("deploy.example.com");
    expect(refreshedIndex.repos.demo.deploy_path).toBe("/srv/demo");
    expect(refreshedIndex.repos.demo.domain).toBe("demo.example.com");
    expect(refreshedIndex.repos.demo.apps).toEqual(apps);
    expect(refreshedIndex.repos.demo.ops).toEqual(ops);

    const refreshedState = await readYaml(path.join(path.dirname(state.notes_path), "state.yaml"), RepoStateSchema);
    expect(refreshedState.deployment_host).toBe("deploy.example.com");
    expect(refreshedState.deployment_path).toBe("/srv/demo");
    expect(refreshedState.domain).toBe("demo.example.com");
    expect(refreshedState.apps).toEqual(apps);
    expect(refreshedState.ops).toEqual(ops);

    await runHandoff({
      alias: "demo",
      action: "review",
      engine: "claude",
      title: "Metadata Check",
      userInstruction: "Prepare a preview.",
      previewOnly: true,
      controllerRoot
    });

    const handoffIndex = await readYaml(indexPath, RegistryIndexSchema);
    expect(handoffIndex.repos.demo.deploy_host).toBe("deploy.example.com");
    expect(handoffIndex.repos.demo.deploy_path).toBe("/srv/demo");
    expect(handoffIndex.repos.demo.domain).toBe("demo.example.com");
    expect(handoffIndex.repos.demo.apps).toEqual(apps);
    expect(handoffIndex.repos.demo.ops).toEqual(ops);

    const guidanceJson = GuidanceBundleSchema.parse(JSON.parse(await readText(state.guidance_json_path)));
    expect(guidanceJson.deployment_host).toBe("deploy.example.com");
    expect(guidanceJson.deployment_path).toBe("/srv/demo");
    expect(guidanceJson.domain).toBe("demo.example.com");
    expect(guidanceJson.apps).toEqual(apps);
    expect(guidanceJson.ops).toEqual(ops);
    expect(await readText(state.guidance_path)).toContain("## App metadata");
  });

  it("backfills apps metadata from legacy deployment fields", async () => {
    const { controllerRoot, repoRoot } = await makeFixture("legacy-deployment-backfill");
    await seedRepoGuidance(repoRoot);
    await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });

    const indexPath = path.join(controllerRoot, ".claude", "repo-registry", "index.yaml");
    const index = await readYaml(indexPath, RegistryIndexSchema);
    index.repos.demo = {
      ...index.repos.demo,
      deploy_host: "deploy.example.com",
      deploy_path: "/srv/demo",
      domain: "demo.example.com"
    };
    await writeYaml(indexPath, index);

    await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });
    const refreshedState = await readYaml(
      path.join(controllerRoot, ".claude", "repo-registry", "repos", "demo", "state.yaml"),
      RepoStateSchema
    );

    expect(refreshedState.apps?.demo.environments?.production.source).toEqual({
      host: "local",
      path: repoRoot
    });
    expect(refreshedState.apps?.demo.environments?.production.deploy).toEqual({
      host: "deploy.example.com",
      path: "/srv/demo",
      domain: "demo.example.com"
    });
  });

  it("collects AGENTS guidance, explicit references, and skill inventory", async () => {
    const { controllerRoot, repoRoot } = await makeFixture("guidance");
    await seedRepoGuidance(repoRoot);
    await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });

    const { bundle, guidancePath, guidanceJsonPath } = await collectGuidance("demo", controllerRoot);

    expect(bundle.has_agents).toBe(true);
    expect(bundle.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "AGENTS.md", exists: true }),
        expect.objectContaining({ path: "docs/playbook.md", exists: true }),
        expect.objectContaining({ path: "docs/missing.md", exists: false })
      ])
    );
    expect(bundle.skill_directories).toEqual([
      {
        path: "skills",
        entries: ["skills/example/SKILL.md"]
      }
    ]);

    const guidanceText = await readText(guidancePath);
    expect(guidanceText).toContain("## AGENTS.md");
    expect(guidanceText).toContain("## docs/playbook.md");
    expect(guidanceText).toContain("## Repo-local skill inventory");
    expect(guidanceText).toContain("skills/example/SKILL.md");
    expect(guidanceText).toContain("docs/missing.md");

    const parsedBundle = GuidanceBundleSchema.parse(JSON.parse(await readText(guidanceJsonPath)));
    expect(parsedBundle.alias).toBe("demo");
  });

  it("records missing AGENTS guidance without failing", async () => {
    const { controllerRoot, repoRoot } = await makeFixture("no-agents");
    await writeFile(path.join(repoRoot, "README.md"), "# Demo\n", "utf8");
    await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });

    const { guidancePath } = await collectGuidance("demo", controllerRoot);
    const guidanceText = await readText(guidancePath);

    expect(guidanceText).toContain("No AGENTS.md found");
    expect(guidanceText).toContain("## README.md");
  });

  it("writes preview artifacts without invoking Codex when preview-only is set", async () => {
    const { controllerRoot, repoRoot } = await makeFixture("preview");
    await seedRepoGuidance(repoRoot);
    await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });

    const result = await runHandoff({
      alias: "demo",
      action: "pr",
      engine: "codex",
      title: "Feature Upgrade",
      userInstruction: "Prepare the draft only.",
      previewOnly: true,
      controllerRoot
    });

    expect(path.basename(result.artifactPath)).toBe("PR_feature_upgrade.md");
    const artifactText = await readText(result.artifactPath);
    expect(artifactText).toContain("Pending execution.");
    const promptText = await readText(result.promptPath);
    expect(promptText).toContain("## Repo guidance bundle");
    expect(promptText).toContain("## AGENTS.md");

    const { state } = await resolveRepo("demo", controllerRoot);
    expect(RepoStateSchema.parse(state).latest.pr).toBe(result.artifactPath);
  });

  it("creates and tracks a controller-side planning session for plan handoffs", async () => {
    const { controllerRoot, repoRoot } = await makeFixture("plan-session");
    await seedRepoGuidance(repoRoot);
    await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });

    const result = await runHandoff({
      alias: "demo",
      action: "plan",
      engine: "codex",
      title: "Feature Upgrade",
      userInstruction: "Plan the feature upgrade.",
      previewOnly: true,
      sessionStatus: "open",
      codexThreadId: "thread-preview-1",
      openDecisions: ["Choose rollout path", "Choose schema migration timing"],
      controllerRoot
    });

    expect(path.basename(result.artifactPath)).toBe("PLAN_feature_upgrade.md");
    expect(path.basename(result.sessionPath ?? "")).toBe("feature_upgrade.yaml");

    const artifactText = await readText(result.artifactPath);
    expect(artifactText).toContain("## Goal");
    expect(artifactText).toContain("## Decision Log");

    const session = await readYaml(result.sessionPath!, PlanningSessionSchema);
    expect(session.status).toBe("open");
    expect(session.codex_thread_id).toBe("thread-preview-1");
    expect(session.open_decisions).toEqual(["Choose rollout path", "Choose schema migration timing"]);
    expect(session.last_prompt_path).toBe(result.promptPath);
    expect(session.plan_artifact_path).toBe(result.artifactPath);

    const { state } = await resolveRepo("demo", controllerRoot);
    expect(RepoStateSchema.parse(state).active_plan_session_path).toBe(result.sessionPath);
  });

  it("preserves an existing plan artifact when re-running a plan handoff in preview mode", async () => {
    const { controllerRoot, repoRoot } = await makeFixture("plan-preserve");
    await seedRepoGuidance(repoRoot);
    await registerRepo({ alias: "demo", targetPath: repoRoot, controllerRoot });

    const first = await runHandoff({
      alias: "demo",
      action: "plan",
      engine: "codex",
      title: "Execution Plan",
      userInstruction: "Plan the execution work.",
      previewOnly: true,
      codexThreadId: "thread-plan-1",
      openDecisions: ["Pick batching strategy"],
      controllerRoot
    });

    await writeFile(first.artifactPath, "# Custom Plan\n\n## Decision Log\n- keep me\n", "utf8");
    const second = await runHandoff({
      alias: "demo",
      action: "plan",
      engine: "claude",
      title: "Execution Plan",
      userInstruction: "Refresh metadata only.",
      previewOnly: true,
      sessionStatus: "locked",
      responseSummary: "Plan approved and locked.",
      controllerRoot
    });

    expect(await readText(second.artifactPath)).toBe("# Custom Plan\n\n## Decision Log\n- keep me\n");
    const updatedSession = await readYaml(second.sessionPath!, PlanningSessionSchema);
    expect(updatedSession.status).toBe("locked");
    expect(updatedSession.codex_thread_id).toBe("thread-plan-1");
    expect(updatedSession.last_response_summary).toBe("Plan approved and locked.");
  });
});
