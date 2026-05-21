#!/usr/bin/env node
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { validateAssistantPack } from "@brain/assistant-pack-schema";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { validateWorkspaceConfig, type BrainConfig } from "@brain/workspace-schema";
import { AutomationRuntime, BrainRuntime, BrainSupervisor, EchoProviderAdapter, EmployeeLifecycle, FakeProviderAdapter, FileEmployeeStore, FileSubagentJobStore, RuntimeCommandInterceptor, RuntimeEntrypointBridge, StaticSubagentExecutor, SubagentLifecycle, createGuardedLiveValidationPlan, createOperationsPlan, parseBrainDirectives, renderSystemdService, type BrainSupervisorLogRecord, type OperationsPlan, type ProviderAdapter, type RuntimeLogEntry } from "@brain/runtime-core";
import { FileTelegramPairingStore, FileTelegramPollingStateStore, TelegramBotApiClient, TelegramEntrypointAdapter, loadTelegramToken } from "@brain/entrypoint-telegram";
import { createCodexProvider, type CodexTransportKind } from "@brain/provider-codex";
import { createClaudeCodeProvider, type ClaudeCodeTransportKind } from "@brain/provider-claude-code";

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

program.command("start")
  .description("Prepare or foreground a long-running Brain supervisor. Defaults to a safe dry-run plan unless --foreground is supplied.")
  .option("--foreground", "run the supervisor in this process instead of printing the start plan")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--entrypoint <kind>", "entrypoint kind: fake or telegram", "fake")
  .option("--provider <kind>", "provider kind: fake, echo, codex, claude-code", "fake")
  .option("--state <path>", "runtime state root")
  .option("--artifacts <path>", "runtime artifact root")
  .option("--log <path>", "runtime JSONL log path")
  .option("--once", "stop after one inbound event")
  .option("--fake-text <text>", "enqueue one fake inbound message for smoke testing")
  .option("--transport <kind>", "provider transport for codex/claude-code")
  .option("--binary <path>", "provider binary for live checks")
  .option("--cwd <path>", "provider working directory")
  .option("--app-server-url <url>", "Codex app-server WebSocket URL")
  .option("--telegram-token-env <name>", "Telegram token env var for explicit live polling")
  .option("--telegram-token-file <path>", "Telegram token file for explicit live polling")
  .option("--telegram-polling", "enable live Telegram getUpdates polling; requires a token ref")
  .option("--telegram-max-polls <n>", "maximum Telegram polls before stopping", parseNumberOption)
  .option("--polling-state <path>", "Telegram polling offset state path")
  .option("--telegram-pairing", "enable one-time /pair bootstrap state")
  .option("--telegram-pairing-state <dir>", "directory for Telegram paired identity state")
  .action(async (options) => exitWith(await startCommand(options)));

program.command("run")
  .description("Run the Brain supervisor in the foreground. Fake provider/entrypoint defaults avoid live side effects.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--entrypoint <kind>", "entrypoint kind: fake or telegram", "fake")
  .option("--provider <kind>", "provider kind: fake, echo, codex, claude-code", "fake")
  .option("--state <path>", "runtime state root")
  .option("--artifacts <path>", "runtime artifact root")
  .option("--log <path>", "runtime JSONL log path")
  .option("--once", "stop after one inbound event")
  .option("--fake-text <text>", "enqueue one fake inbound message for smoke testing")
  .option("--transport <kind>", "provider transport for codex/claude-code")
  .option("--binary <path>", "provider binary for live checks")
  .option("--cwd <path>", "provider working directory")
  .option("--app-server-url <url>", "Codex app-server WebSocket URL")
  .option("--telegram-token-env <name>", "Telegram token env var for explicit live polling")
  .option("--telegram-token-file <path>", "Telegram token file for explicit live polling")
  .option("--telegram-polling", "enable live Telegram getUpdates polling; requires a token ref")
  .option("--telegram-max-polls <n>", "maximum Telegram polls before stopping", parseNumberOption)
  .option("--polling-state <path>", "Telegram polling offset state path")
  .option("--telegram-pairing", "enable one-time /pair bootstrap state")
  .option("--telegram-pairing-state <dir>", "directory for Telegram paired identity state")
  .action(async (options) => exitWith(await runCommand(options)));

program.command("health")
  .description("Inspect runtime supervisor/state/log readiness without starting live providers by default.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--state <path>", "runtime state root")
  .option("--log <path>", "runtime JSONL log path")
  .action(async (options) => exitWith(await healthCommand(options)));

program.command("logs")
  .description("Tail Brain runtime JSONL logs with conservative redaction.")
  .option("--file <path>", "runtime JSONL log file")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--state <path>", "runtime state root used to derive default log path")
  .option("--lines <n>", "number of lines to return", parseNumberOption, 100)
  .option("--raw", "include raw payloads")
  .action(async (options) => exitWith(await logsCommand(options)));

const operations = program.command("operations").alias("ops").description("Safe deployment/update/rollback planning commands");
operations.command("plan")
  .description("Render a non-mutating systemd/update/rollback operations plan.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--state <path>", "runtime state root")
  .option("--artifacts <path>", "runtime artifact root")
  .option("--log <path>", "runtime JSONL log path")
  .option("--service-name <name>", "systemd service name")
  .option("--service-user <user>", "systemd service user", "brain")
  .option("--repo <path>", "deployment checkout path", process.cwd())
  .action(async (options) => exitWith(await operationsPlanCommand(options)));
operations.command("systemd")
  .description("Render a systemd service unit to stdout JSON without installing it.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--state <path>", "runtime state root")
  .option("--artifacts <path>", "runtime artifact root")
  .option("--log <path>", "runtime JSONL log path")
  .option("--service-name <name>", "systemd service name")
  .option("--service-user <user>", "systemd service user", "brain")
  .option("--repo <path>", "deployment checkout path", process.cwd())
  .action(async (options) => exitWith(await operationsSystemdCommand(options)));

const validate = program.command("validate").description("Guarded validation harnesses");
validate.command("live")
  .description("Create or run a no-secret live-readiness smoke plan for Telegram and Codex seams.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--telegram-token-env <name>", "Telegram token env var to check by metadata only")
  .option("--telegram-token-file <path>", "Telegram token file to check by metadata only")
  .option("--codex-transport <kind>", "Codex transport to include in the plan", "stub")
  .option("--allow-live", "allow live health-only provider checks; still sends no user tasks")
  .option("--run-safe", "run only checks marked safe for no-network/no-secret mode")
  .action(async (options) => exitWith(await liveValidateCommand(options)));

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

const provider = program.command("provider").description("Provider boundary checks");
provider.command("check")
  .description("Check a provider adapter without running a real task.")
  .argument("<provider>", "provider id: codex or claude-code")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--transport <kind>", "provider transport to instantiate")
  .option("--binary <path>", "provider CLI binary for exec health checks")
  .option("--cwd <path>", "provider working directory for CLI health checks")
  .option("--app-server-url <url>", "Codex app-server WebSocket URL for app-server transport")
  .option("--timeout-ms <ms>", "provider health timeout in milliseconds", parseNumberOption)
  .action(async (providerId, options) => exitWith(await providerCheckCommand(providerId, options)));

const entrypoint = program.command("entrypoint").description("Entrypoint boundary checks");
entrypoint.command("check")
  .description("Check an entrypoint adapter without requiring live credentials.")
  .argument("<entrypoint>", "entrypoint id: telegram")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--token-env <name>", "Telegram token env var to verify without printing")
  .option("--token-file <path>", "Telegram token file to verify without printing")
  .option("--polling-state <path>", "Telegram durable polling offset state path to inspect")
  .action(async (entrypointId, options) => exitWith(await entrypointCheckCommand(entrypointId, options)));

const runtime = program.command("runtime").description("Runtime state inspection commands");
runtime.command("status")
  .description("Inspect runtime job state without starting providers or entrypoints.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--state <path>", "runtime state root", path.join(process.env.HOME ?? ".", ".brain", "workspaces", "personal", "state"))
  .action(async (options) => exitWith(await runtimeStatusCommand(options)));
runtime.command("smoke")
  .description("Run a no-network runtime smoke: fake entrypoint -> fake provider -> outbound dispatch.")
  .option("--config <path>", "runtime YAML/TOML/JSON config to source workspace metadata from", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--text <text>", "inbound text for the fake turn", "ping")
  .action(async (options) => exitWith(await runtimeSmokeCommand(options)));

const directives = program.command("directives").description("Directive validation commands");
directives.command("check")
  .description("Parse Brain/codex-chat action blocks without executing them.")
  .argument("[file]", "file to parse, or '-' for stdin", "-")
  .action(async (file) => exitWith(await directivesCheckCommand(file)));

const automation = program.command("automation").description("Loop and monitor validation commands");
automation.command("validate")
  .description("Validate loop/monitor skeleton definitions from a small JSON/YAML file.")
  .argument("[file]", "automation JSON/YAML file with loops/monitors arrays")
  .option("--workspace <id>", "workspace id", "personal")
  .action(async (file, options) => exitWith(await automationValidateCommand(file, options)));
automation.command("run")
  .description("Evaluate one loop definition without installing cron; dry-run by default.")
  .argument("<loop>", "loop id")
  .option("--file <path>", "automation JSON/YAML file with loops/monitors arrays", "examples/config/automation.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--dry-run", "do not dispatch; this is the default safe behavior", true)
  .option("--dispatch", "attempt a real dispatch through the configured CLI runtime port (currently reports not-runnable)")
  .action(async (loopId, options) => exitWith(await automationRunCommand(loopId, options)));
automation.command("due")
  .description("Evaluate due loops for the current minute without installing cron; dry-run by default.")
  .option("--file <path>", "automation JSON/YAML file with loops/monitors arrays", "examples/config/automation.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--now <iso>", "override current time for deterministic checks")
  .option("--dry-run", "do not dispatch; this is the default safe behavior", true)
  .action(async (options) => exitWith(await automationDueCommand(options)));

interface SupervisorRunCommandOptions {
  config: string;
  workspace: string;
  entrypoint?: string;
  provider?: string;
  state?: string;
  artifacts?: string;
  log?: string;
  once?: boolean;
  fakeText?: string;
  transport?: string;
  binary?: string;
  cwd?: string;
  appServerUrl?: string;
  telegramTokenEnv?: string;
  telegramTokenFile?: string;
  telegramPolling?: boolean;
  telegramMaxPolls?: number;
  pollingState?: string;
  telegramPairing?: boolean;
  telegramPairingState?: string;
}

async function startCommand(options: SupervisorRunCommandOptions & { foreground?: boolean }): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  if (!config.config.workspaces[options.workspace]) return { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(config.config.workspaces) } };
  const paths = supervisorPaths(options.workspace, options);
  if (!options.foreground) {
    return {
      ok: true,
      summary: "supervisor start plan ready (dry run; pass --foreground to run)",
      details: {
        workspace: options.workspace,
        config: path.resolve(options.config),
        entrypoint: options.entrypoint ?? "fake",
        provider: options.provider ?? "fake",
        stateRoot: paths.stateRoot,
        artifactRoot: paths.artifactRoot,
        logPath: paths.logPath,
        liveTelegramPolling: Boolean(options.telegramPolling),
        deployment: "not performed",
      },
    };
  }
  return runCommand(options);
}

async function runCommand(options: SupervisorRunCommandOptions): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  const workspace = config.config.workspaces[options.workspace];
  if (!workspace) return { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(config.config.workspaces) } };

  const paths = supervisorPaths(options.workspace, options);
  await mkdir(path.dirname(paths.logPath), { recursive: true, mode: 0o700 });
  const provider = createCliProvider(options);
  let supervisor: BrainSupervisor | undefined;
  const store = new FileSubagentJobStore({ root: paths.stateRoot });
  const subagents = new SubagentLifecycle({
    workspaceId: options.workspace,
    store,
    executor: new StaticSubagentExecutor({ id: "brainctl-static", outputText: "Static subagent completed." }),
    artifactRoot: paths.artifactRoot,
    onTerminal: async (job, result) => {
      await supervisor?.deliverSubagentResult(job, result);
    },
  });
  const hydration = await subagents.init();
  const employees = new EmployeeLifecycle({
    workspaceId: options.workspace,
    store: new FileEmployeeStore({ root: paths.stateRoot }),
    provider: provider.id,
  });
  await employees.init();

  const entrypoint = await createCliEntrypoint(options.workspace, workspace.primaryEntrypointId, options, paths);
  const runtime = new BrainRuntime({ workspaceId: options.workspace, workspace, provider, subagents });
  const logReader = new FileRuntimeLogReader(paths.logPath);
  const commandInterceptor = new RuntimeCommandInterceptor({
    subagents,
    employees,
    logs: logReader,
    health: { health: () => supervisor?.health() ?? { ok: false, detail: "supervisor not constructed" } },
  });
  supervisor = new BrainSupervisor({
    runtime,
    entrypoint,
    commandInterceptor,
    logger: (record) => appendSupervisorLog(paths.logPath, record),
  });

  const controller = new AbortController();
  const onSignal = () => controller.abort("signal");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await supervisor.run({ maxEvents: options.once ? 1 : undefined, signal: controller.signal });
    const health = await supervisor.health();
    return {
      ok: result.stoppedReason !== "aborted" || controller.signal.aborted,
      summary: `supervisor stopped: ${result.stoppedReason}`,
      details: {
        workspace: options.workspace,
        provider: provider.id,
        entrypoint: entrypoint.id,
        processed: result.processed.length,
        stoppedReason: result.stoppedReason,
        hydration,
        dispatchResults: result.processed.flatMap((item) => item.dispatchResults.map((dispatch) => ({ type: dispatch.action.type, status: dispatch.status, target: dispatch.action.target }))),
        interceptedCommands: result.processed.map((item) => item.intercepted?.command).filter(Boolean),
        stateRoot: paths.stateRoot,
        artifactRoot: paths.artifactRoot,
        logPath: paths.logPath,
        health,
      },
    };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await subagents.shutdown("brainctl run stopped").catch(() => undefined);
  }
}

async function healthCommand(options: { config: string; workspace: string; state?: string; log?: string }): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  const paths = supervisorPaths(options.workspace, options);
  const state = await runtimeStatusCommand({ workspace: options.workspace, state: paths.stateRoot });
  const logMeta = await fileMetadata(paths.logPath);
  return {
    ok: config.ok && state.ok,
    summary: config.ok && state.ok ? "runtime health seams inspected" : "runtime health seams need attention",
    details: {
      config: config.ok ? config.details : config,
      workspace: options.workspace,
      state: state.details,
      logs: { path: paths.logPath, metadata: logMeta },
      liveProcessesStarted: false,
      deployment: "not performed",
    },
  };
}

async function logsCommand(options: { file?: string; workspace: string; state?: string; lines: number; raw?: boolean }): Promise<CliResult> {
  const paths = supervisorPaths(options.workspace, { state: options.state, log: options.file });
  const reader = new FileRuntimeLogReader(paths.logPath);
  const entries = await reader.tail(options.lines, { includeRaw: options.raw });
  return {
    ok: true,
    summary: entries.length === 0 ? "no runtime logs found" : "runtime logs tailed",
    details: { path: paths.logPath, lines: entries.length, entries },
  };
}

interface OperationsCommandOptions {
  config: string;
  workspace: string;
  state?: string;
  artifacts?: string;
  log?: string;
  serviceName?: string;
  serviceUser?: string;
  repo?: string;
}

async function operationsPlanCommand(options: OperationsCommandOptions): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  if (!config.config.workspaces[options.workspace]) return { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(config.config.workspaces) } };
  const plan = operationsPlan(options);
  return {
    ok: true,
    summary: "operations plan rendered without deployment side effects",
    details: {
      plan,
      sideEffects: "none",
    },
  };
}

async function operationsSystemdCommand(options: OperationsCommandOptions): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  if (!config.config.workspaces[options.workspace]) return { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(config.config.workspaces) } };
  const plan = operationsPlan(options);
  return {
    ok: true,
    summary: "systemd unit rendered without installing or restarting services",
    details: {
      unitPath: plan.unitPath,
      serviceName: plan.serviceName,
      serviceUser: plan.serviceUser,
      unit: renderSystemdService(plan),
      sideEffects: "none",
    },
  };
}

function operationsPlan(options: OperationsCommandOptions): OperationsPlan {
  const paths = supervisorPaths(options.workspace, options);
  return createOperationsPlan({
    workspaceId: options.workspace,
    repoPath: options.repo ?? process.cwd(),
    configPath: options.config,
    stateRoot: paths.stateRoot,
    artifactRoot: paths.artifactRoot,
    logPath: paths.logPath,
    serviceName: options.serviceName,
    serviceUser: options.serviceUser,
  });
}

async function liveValidateCommand(options: {
  config: string;
  workspace: string;
  telegramTokenEnv?: string;
  telegramTokenFile?: string;
  codexTransport: string;
  allowLive?: boolean;
  runSafe?: boolean;
}): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  if (!config.config.workspaces[options.workspace]) return { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(config.config.workspaces) } };
  const telegramTokenRef = options.telegramTokenEnv ? `env:${options.telegramTokenEnv}` : options.telegramTokenFile ? `file:${options.telegramTokenFile}` : undefined;
  const plan = createGuardedLiveValidationPlan({
    workspaceId: options.workspace,
    configPath: options.config,
    codexTransport: options.codexTransport,
    telegramTokenRef,
    allowLive: options.allowLive,
  });
  const safeResults = options.runSafe ? await runSafeValidationChecks(options, plan.checks.filter((check) => check.mode === "run")) : [];
  const ok = safeResults.every((result) => result.ok !== false);
  return {
    ok,
    summary: options.runSafe ? "guarded validation safe checks executed" : "guarded validation plan rendered without live side effects",
    details: {
      plan,
      results: safeResults,
      sideEffects: options.runSafe ? "safe local checks only" : "none",
    },
  };
}

async function runSafeValidationChecks(
  options: { config: string; workspace: string; telegramTokenEnv?: string; telegramTokenFile?: string; codexTransport: string; allowLive?: boolean },
  checks: Array<{ id: string }>,
): Promise<Array<{ id: string; ok: boolean; summary: string; details?: unknown }>> {
  const results = [];
  for (const check of checks) {
    if (check.id === "config") results.push({ id: check.id, ...await configValidateCommand(options.config) });
    else if (check.id === "secrets") results.push({ id: check.id, ...await secretsCheckCommand(options.config) });
    else if (check.id === "runtime-smoke") results.push({ id: check.id, ...await runtimeSmokeCommand({ config: options.config, workspace: options.workspace, text: "ping" }) });
    else if (check.id === "codex-provider") {
      const transport = options.allowLive ? options.codexTransport : "stub";
      results.push({ id: check.id, ...await providerCheckCommand("codex", { workspace: options.workspace, transport }) });
    } else if (check.id === "telegram-entrypoint") {
      results.push({ id: check.id, ...await entrypointCheckCommand("telegram", { workspace: options.workspace, tokenEnv: options.telegramTokenEnv, tokenFile: options.telegramTokenFile }) });
    }
  }
  return results;
}

function supervisorPaths(workspace: string, options: { state?: string; artifacts?: string; log?: string }): { stateRoot: string; artifactRoot: string; logPath: string } {
  const base = path.join(process.env.HOME ?? ".", ".brain", "workspaces", workspace);
  const stateRoot = path.resolve(options.state ?? path.join(base, "state"));
  return {
    stateRoot,
    artifactRoot: path.resolve(options.artifacts ?? path.join(base, "artifacts", "subagents")),
    logPath: path.resolve(options.log ?? path.join(base, "logs", "runtime.jsonl")),
  };
}

function createCliProvider(options: SupervisorRunCommandOptions): ProviderAdapter {
  const provider = (options.provider ?? "fake").toLowerCase();
  if (provider === "fake") return new FakeProviderAdapter();
  if (provider === "echo") return new EchoProviderAdapter();
  if (provider === "codex") return createCodexProvider({
    transport: (options.transport as CodexTransportKind | undefined) ?? "stub",
    binary: options.binary,
    cwd: options.cwd,
    appServerUrl: options.appServerUrl,
  });
  if (provider === "claude-code" || provider === "claude") return createClaudeCodeProvider({ transport: (options.transport as ClaudeCodeTransportKind | undefined) ?? "stub" });
  throw new Error(`unknown provider: ${options.provider}`);
}

async function createCliEntrypoint(workspaceId: string, primaryEntrypointId: string, options: SupervisorRunCommandOptions, paths: { stateRoot: string }): Promise<FakeEntrypointAdapter | TelegramEntrypointAdapter> {
  const kind = (options.entrypoint ?? "fake").toLowerCase();
  if (kind === "fake") {
    const entrypoint = new FakeEntrypointAdapter({ workspaceId, entrypointId: primaryEntrypointId, channelKind: "fake", displayName: "Brainctl fake entrypoint" });
    if (options.fakeText !== undefined) entrypoint.enqueueText(options.fakeText, { conversationId: "brainctl-run" });
    if (options.once) entrypoint.close();
    return entrypoint;
  }
  if (kind !== "telegram") throw new Error(`unknown entrypoint: ${options.entrypoint}`);
  const apiClient = options.telegramPolling
    ? await TelegramBotApiClient.fromTokenRef({ tokenEnv: options.telegramTokenEnv, tokenFile: options.telegramTokenFile, required: true })
    : undefined;
  const pairingState = options.telegramPairingState ? path.resolve(options.telegramPairingState) : path.join(paths.stateRoot, "telegram-pairing");
  return new TelegramEntrypointAdapter({
    workspaceId,
    entrypointId: primaryEntrypointId,
    apiClient,
    polling: options.telegramPolling ? {
      enabled: true,
      maxPolls: options.telegramMaxPolls,
      stateStore: new FileTelegramPollingStateStore(path.resolve(options.pollingState ?? path.join(paths.stateRoot, "telegram-offset.json"))),
    } : undefined,
    pairing: options.telegramPairing || options.telegramPairingState ? {
      enabled: true,
      store: new FileTelegramPairingStore(pairingState),
    } : undefined,
  });
}

async function appendSupervisorLog(filePath: string, record: BrainSupervisorLogRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await appendFile(filePath, `${JSON.stringify(redactSecrets(record))}\n`, { mode: 0o600 });
}

class FileRuntimeLogReader {
  constructor(private readonly filePath: string) {}

  async tail(lines: number, options: { includeRaw?: boolean } = {}): Promise<RuntimeLogEntry[]> {
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const selected = raw.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, lines));
    return selected.map((line) => {
      try {
        const parsed = redactSecrets(JSON.parse(line)) as Record<string, unknown>;
        return {
          at: stringField(parsed.at),
          level: stringField(parsed.level),
          component: stringField(parsed.component),
          message: stringField(parsed.message) ?? line,
          raw: options.includeRaw ? parsed.raw : undefined,
        };
      } catch {
        return { message: redactString(line) };
      }
    });
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /(token|secret|password|api[_-]?key|authorization)/i.test(key) ? "[redacted]" : redactSecrets(item)]));
}

function redactString(value: string): string {
  return value.replace(/\b\d{5,}:[A-Za-z0-9_-]{16,}\b/g, "[redacted-telegram-token]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted-api-key]");
}

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

async function loadValidConfig(file: string): Promise<CliResult & { config?: BrainConfig }> {
  const raw = await readFile(file, "utf8");
  const parsed = parseConfigText(file, raw);
  const result = validateWorkspaceConfig(parsed);
  return {
    ok: result.ok,
    summary: result.ok ? "runtime config valid" : "runtime config invalid",
    details: result.ok ? configSummary(result.config) : { issues: result.issues },
    config: result.config,
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

async function providerCheckCommand(providerId: string, options: { workspace: string; transport?: string; binary?: string; cwd?: string; appServerUrl?: string; timeoutMs?: number }): Promise<CliResult> {
  const normalized = providerId.toLowerCase();
  const adapter = normalized === "codex"
    ? createCodexProvider({ transport: (options.transport as CodexTransportKind | undefined) ?? "stub", binary: options.binary, cwd: options.cwd, appServerUrl: options.appServerUrl, timeoutMs: options.timeoutMs, appServerStartupTimeoutMs: options.timeoutMs })
    : normalized === "claude-code" || normalized === "claude"
      ? createClaudeCodeProvider({ transport: (options.transport as ClaudeCodeTransportKind | undefined) ?? "stub" })
      : undefined;
  if (!adapter) return { ok: false, summary: `unknown provider: ${providerId}`, details: { supported: ["codex", "claude-code"] } };
  const session = await adapter.createSession({ workspaceId: options.workspace, metadata: { check: "brainctl provider check" } });
  try {
    await session.start();
    const health = await session.health();
    return {
      ok: health.ok,
      summary: health.ok ? `${adapter.id} provider check passed` : `${adapter.id} provider check failed`,
      details: { health, transport: options.transport ?? "stub", taskStarted: false },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `${adapter.id} provider check failed to start`,
      details: { error: error instanceof Error ? error.message : String(error), transport: options.transport ?? "stub", taskStarted: false },
    };
  } finally {
    await session.stop();
  }
}

async function entrypointCheckCommand(entrypointId: string, options: { workspace: string; tokenEnv?: string; tokenFile?: string; pollingState?: string }): Promise<CliResult> {
  if (entrypointId !== "telegram") {
    return { ok: false, summary: `unknown entrypoint: ${entrypointId}`, details: { supported: ["telegram"] } };
  }
  const adapter = new TelegramEntrypointAdapter({ workspaceId: options.workspace, updates: [] });
  await adapter.start();
  try {
    const health = await adapter.health();
    const token = options.tokenEnv || options.tokenFile
      ? await loadTelegramToken({ tokenEnv: options.tokenEnv, tokenFile: options.tokenFile })
      : undefined;
    const polling = options.pollingState
      ? { statePath: path.resolve(options.pollingState), offset: await new FileTelegramPollingStateStore(path.resolve(options.pollingState)).getOffset() }
      : undefined;
    return {
      ok: health.ok,
      summary: "telegram entrypoint boundary check passed",
      details: { health, liveTokenRequired: false, token: token ? { present: token.present, source: token.source, redacted: token.redacted } : "not checked", polling, pollingStarted: false, webhookStarted: false },
    };
  } finally {
    await adapter.stop();
  }
}

async function runtimeStatusCommand(options: { workspace: string; state: string }): Promise<CliResult> {
  const store = new FileSubagentJobStore({ root: path.resolve(options.state) });
  await store.init();
  const jobs = await store.list({ workspaceId: options.workspace });
  const byStatus = jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] ?? 0) + 1;
    return acc;
  }, {});
  const active = jobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status)).map((job) => ({
    id: job.id,
    status: job.status,
    profile: job.profile,
    provider: job.provider,
    route: job.route,
    summary: job.summary,
  }));
  return {
    ok: true,
    summary: jobs.length === 0 ? "runtime state is initialized with no jobs" : "runtime state inspected",
    details: { workspace: options.workspace, stateRoot: path.resolve(options.state), jobs: jobs.length, byStatus, active },
  };
}

async function runtimeSmokeCommand(options: { config: string; workspace: string; text: string }): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  const workspace = config.config.workspaces[options.workspace];
  if (!workspace) {
    return { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(config.config.workspaces) } };
  }
  const primary = workspace.enabledEntrypoints[workspace.primaryEntrypointId];
  const entrypoint = new FakeEntrypointAdapter({
    workspaceId: options.workspace,
    entrypointId: workspace.primaryEntrypointId,
    channelKind: primary?.kind ?? "fake",
    displayName: primary?.displayName ?? workspace.primaryEntrypointId,
    capabilities: primary?.capabilities,
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });
  const runtime = new BrainRuntime({
    workspaceId: options.workspace,
    workspace,
    provider: new FakeProviderAdapter(),
  });
  const bridge = new RuntimeEntrypointBridge({ runtime, entrypoint });
  entrypoint.enqueueText(options.text, { conversationId: "brainctl-smoke" });
  entrypoint.close();
  const result = await bridge.run({ maxEvents: 1 });
  const dispatched = entrypoint.dispatchedActions;
  const ok = result.processed.length === 1 && dispatched.some((action) => action.type === "send_text");
  return {
    ok,
    summary: ok ? "runtime smoke passed without network or provider credentials" : "runtime smoke failed",
    details: {
      workspace: options.workspace,
      entrypointId: workspace.primaryEntrypointId,
      provider: "fake",
      processed: result.processed.length,
      stoppedReason: result.stoppedReason,
      dispatchedActions: dispatched.map((action) => ({ type: action.type, target: action.target })),
      providerEvents: result.processed[0]?.turn.providerEvents.map((event) => event.type) ?? [],
    },
  };
}

async function directivesCheckCommand(file: string): Promise<CliResult> {
  const raw = file === "-" ? await readStdin() : await readFile(file, "utf8");
  const parsed = parseBrainDirectives(raw);
  const actionCounts: Record<string, number> = {};
  for (const block of parsed.blocks) {
    for (const action of block.actions) actionCounts[action.type] = (actionCounts[action.type] ?? 0) + 1;
  }
  const actionTotal = Object.values(actionCounts).reduce((sum, count) => sum + count, 0);
  return {
    ok: parsed.errors.length === 0,
    summary: parsed.errors.length === 0 ? "directive blocks valid" : "directive blocks contain errors",
    details: {
      file: file === "-" ? "stdin" : path.resolve(file),
      blocks: parsed.blocks.length,
      actions: actionTotal,
      actionCounts,
      cleanTextBytes: Buffer.byteLength(parsed.cleanText, "utf8"),
      errors: parsed.errors,
    },
  };
}

async function automationValidateCommand(file: string | undefined, options: { workspace: string }): Promise<CliResult> {
  const parsed = file ? parseConfigText(file, await readFile(file, "utf8")) : {};
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { loops?: unknown[]; monitors?: unknown[] } : {};
  const runtime = new AutomationRuntime({ workspaceId: options.workspace, loops: record.loops ?? [], monitors: record.monitors ?? [] });
  const health = runtime.health();
  return {
    ok: health.ok,
    summary: health.ok ? "automation definitions valid" : "automation definitions need runtime implementation or fixes",
    details: health,
  };
}

async function automationRunCommand(loopId: string, options: { file: string; workspace: string; dryRun?: boolean; dispatch?: boolean }): Promise<CliResult> {
  const record = await readAutomationConfig(options.file);
  const runtime = new AutomationRuntime({ workspaceId: options.workspace, loops: record.loops ?? [], monitors: record.monitors ?? [] });
  const dryRun = options.dispatch ? false : options.dryRun !== false;
  const result = await runtime.runLoopOnce(loopId, { dryRun });
  return {
    ok: result.status === "dry_run" || result.status === "dispatched",
    summary: result.status === "dry_run" ? "loop dry-run evaluated without cron side effects" : `loop ${result.status}`,
    details: { result, safeDefault: "no crontab or watcher was installed" },
  };
}

async function automationDueCommand(options: { file: string; workspace: string; now?: string; dryRun?: boolean }): Promise<CliResult> {
  const record = await readAutomationConfig(options.file);
  const runtime = new AutomationRuntime({
    workspaceId: options.workspace,
    loops: record.loops ?? [],
    monitors: record.monitors ?? [],
    now: options.now ? () => new Date(options.now as string) : undefined,
  });
  const results = await runtime.runDueLoops({ dryRun: options.dryRun !== false, now: options.now ? new Date(options.now) : undefined });
  return {
    ok: results.every((result) => result.status === "dry_run" || result.status === "dispatched"),
    summary: results.length === 0 ? "no loops due; no cron side effects" : "due loops evaluated without cron side effects",
    details: { results, safeDefault: "no crontab or watcher was installed" },
  };
}

async function readAutomationConfig(file: string): Promise<{ loops?: unknown[]; monitors?: unknown[] }> {
  const parsed = parseConfigText(file, await readFile(file, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { loops?: unknown[]; monitors?: unknown[] } : {};
}

function parseConfigText(file: string, raw: string): unknown {
  if (file.endsWith(".yaml") || file.endsWith(".yml")) return YAML.parse(raw);
  if (file.endsWith(".toml")) return parseToml(raw);
  return JSON.parse(raw);
}

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive number, got ${value}`);
  return parsed;
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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

function exitWith(result: CliResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

await program.parseAsync(process.argv);
