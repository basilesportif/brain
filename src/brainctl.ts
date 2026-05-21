#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { validateAssistantPack } from "@brain/assistant-pack-schema";
import { validateWorkspaceConfig, type BrainConfig } from "@brain/workspace-schema";
import { FileSubagentJobStore, StaticSubagentExecutor, SubagentLifecycle } from "@brain/runtime-core";

interface CliResult {
  ok: boolean;
  summary: string;
  details?: unknown;
}

const program = new Command();
program
  .name("brainctl")
  .description("Operator CLI for validating and preparing Brain runtime workspaces.")
  .version("0.0.0");

program.command("setup")
  .description("Create a private workspace directory scaffold without writing secrets.")
  .option("--workspace <name>", "workspace id", "personal")
  .option("--path <path>", "private workspace path", path.join(process.env.HOME ?? ".", ".brain", "workspaces", "personal"))
  .option("--dry-run", "show actions without creating directories")
  .action(async (options) => exitWith(await setupCommand(options)));

program.command("doctor")
  .description("Run skeleton health checks for config, pack, private boundaries, and toolchain.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--pack <path>", "assistant pack directory", "assistant-packs/core")
  .action(async (options) => exitWith(await doctorCommand(options)));

const config = program.command("config").description("Runtime configuration commands");
config.command("validate")
  .description("Validate workspace runtime configuration.")
  .argument("[file]", "runtime YAML/TOML/JSON file", "examples/config/runtime.yaml")
  .action(async (file) => exitWith(await configValidateCommand(file)));

const secrets = program.command("secrets").description("Secret metadata checks");
secrets.command("check")
  .description("Check that config secret refs are present or clearly pending without printing secret values.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .action(async (options) => exitWith(await secretsCheckCommand(options.config)));

const pack = program.command("pack").description("Assistant pack commands");
pack.command("validate")
  .description("Validate an assistant pack manifest and public-safety hygiene.")
  .argument("[dir]", "assistant pack directory", "assistant-packs/core")
  .action(async (dir) => exitWith(await packValidateCommand(dir)));

await program.parseAsync(process.argv);

async function setupCommand(options: { workspace: string; path: string; dryRun?: boolean }): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path);
  const dirs = ["config", "secrets", "logs", "artifacts", "state", "backups", "tmp"].map((dir) => path.join(workspaceRoot, dir));
  if (!options.dryRun) {
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    for (const dir of dirs) await mkdir(dir, { recursive: true, mode: dir.endsWith("secrets") ? 0o700 : 0o755 });
  }
  return {
    ok: true,
    summary: options.dryRun ? "setup plan ready (dry run)" : "private workspace scaffold created",
    details: { workspace: options.workspace, workspaceRoot, directories: dirs.map((dir) => path.relative(workspaceRoot, dir)), secrets: "not written" },
  };
}

async function doctorCommand(options: { config: string; pack: string }): Promise<CliResult> {
  const configResult = await configValidateCommand(options.config);
  const packResult = await packValidateCommand(options.pack);
  const privateBoundary = await privateBoundaryCheck();
  const runtimeCore = await runtimeCoreSelfTest();
  const toolchain = {
    node: process.version,
    git: runVersion("git", ["--version"]),
    pnpm: runVersion("pnpm", ["--version"]),
  };
  const ok = configResult.ok && packResult.ok && privateBoundary.ok && runtimeCore.ok;
  return {
    ok,
    summary: ok ? "doctor checks passed" : "doctor checks failed",
    details: { config: configResult, pack: packResult, privateBoundary, runtimeCore, toolchain },
  };
}

async function configValidateCommand(file: string): Promise<CliResult> {
  const raw = await readFile(file, "utf8");
  const parsed = parseConfigText(file, raw);
  const result = validateWorkspaceConfig(parsed);
  return {
    ok: result.ok,
    summary: result.ok ? "runtime config valid" : "runtime config invalid",
    details: result.ok ? configSummary(result.config) : { issues: result.issues },
  };
}

async function secretsCheckCommand(file: string): Promise<CliResult> {
  const raw = await readFile(file, "utf8");
  const parsed = parseConfigText(file, raw);
  const validation = validateWorkspaceConfig(parsed);
  if (!validation.ok || !validation.config) {
    return { ok: false, summary: "cannot check secrets until config is valid", details: { issues: validation.issues } };
  }
  const refs = collectConfigRefs(validation.config);
  const details = [];
  for (const ref of refs) {
    if (ref.ref.startsWith("env:")) {
      const key = ref.ref.slice("env:".length);
      details.push({ ...ref, kind: "env", present: Boolean(process.env[key]), value: "redacted" });
    } else if (ref.ref.startsWith("file:")) {
      const filePath = ref.ref.slice("file:".length);
      details.push({ ...ref, kind: "file", ...(await fileMetadata(filePath)) });
    } else {
      details.push({ ...ref, kind: "opaque", present: false, note: "non-env/file refs are accepted but not inspectable by the skeleton checker" });
    }
  }
  return { ok: true, summary: refs.length === 0 ? "no secret refs declared" : "secret refs checked without printing values", details };
}

async function packValidateCommand(dir: string): Promise<CliResult> {
  const result = await validateAssistantPack(dir);
  return {
    ok: result.ok,
    summary: result.ok ? "assistant pack valid" : "assistant pack invalid",
    details: result.ok ? { id: result.manifest?.id, skills: result.manifest?.skills.length ?? 0, prompts: result.manifest?.prompts.length ?? 0, workflows: result.manifest?.workflows.length ?? 0 } : { issues: result.issues },
  };
}

function parseConfigText(file: string, raw: string): unknown {
  if (file.endsWith(".yaml") || file.endsWith(".yml")) return YAML.parse(raw);
  if (file.endsWith(".toml")) return parseToml(raw);
  return JSON.parse(raw);
}

function configSummary(config: BrainConfig | undefined) {
  if (!config) return undefined;
  return {
    activeEntrypointMode: config.runtime.activeEntrypointMode,
    workspaces: Object.fromEntries(Object.entries(config.workspaces).map(([id, workspace]) => [id, {
      provider: workspace.provider ?? "not configured",
      primaryEntrypointId: workspace.primaryEntrypointId,
      enabledEntrypoints: Object.entries(workspace.enabledEntrypoints).filter(([, entry]) => entry.enabled).map(([entrypointId, entry]) => ({ entrypointId, kind: entry.kind })),
    }])),
  };
}

function collectConfigRefs(config: BrainConfig): Array<{ workspaceId: string; entrypointId: string; ref: string }> {
  const refs = [];
  for (const [workspaceId, workspace] of Object.entries(config.workspaces)) {
    for (const [entrypointId, entrypoint] of Object.entries(workspace.enabledEntrypoints)) {
      if (entrypoint.configRef) refs.push({ workspaceId, entrypointId, ref: entrypoint.configRef });
    }
  }
  return refs;
}

async function fileMetadata(filePath: string) {
  try {
    const info = await stat(filePath);
    return { present: true, path: filePath, mode: `0${(info.mode & 0o777).toString(8)}`, sizeBytes: info.size, value: "redacted" };
  } catch {
    return { present: false, path: filePath, value: "redacted" };
  }
}

async function privateBoundaryCheck(): Promise<CliResult> {
  const expected = ["workspace", "private", "data"];
  const missing = [];
  for (const dir of expected) {
    try {
      await access(path.join(dir, "README.md"), fsConstants.R_OK);
    } catch {
      missing.push(`${dir}/README.md`);
    }
  }
  return { ok: missing.length === 0, summary: missing.length === 0 ? "private boundary placeholders present" : "private boundary placeholders missing", details: { missing } };
}

async function runtimeCoreSelfTest(): Promise<CliResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-runtime-doctor-"));
  try {
    const store = new FileSubagentJobStore({ root: path.join(root, "state") });
    const lifecycle = new SubagentLifecycle({
      workspaceId: "doctor",
      store,
      executor: new StaticSubagentExecutor({ id: "doctor-static", outputText: "ok" }),
      artifactRoot: path.join(root, "artifacts"),
      idFactory: () => "job_doctor",
    });
    await lifecycle.init();
    const jobId = await lifecycle.dispatch({ profile: "doctor", prompt: "runtime self-test", route: "store_only" });
    await lifecycle.waitForIdle();
    const job = await store.get(jobId);
    return {
      ok: job?.status === "completed" && job.resultText === "ok",
      summary: job?.status === "completed" ? "runtime store and subagent lifecycle self-test passed" : "runtime store and subagent lifecycle self-test failed",
      details: { jobId, status: job?.status, provider: job?.provider, stateRoot: "temporary" },
    };
  } catch (error) {
    return { ok: false, summary: "runtime store and subagent lifecycle self-test failed", details: { error: error instanceof Error ? error.message : String(error) } };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) return `unavailable: ${result.error.message}`;
  return (result.stdout || result.stderr).trim();
}

function exitWith(result: CliResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
