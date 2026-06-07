#!/usr/bin/env node
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { validateAssistantPack } from "@brain/assistant-pack-schema";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { defaultBackupExclude, defaultBackupInclude, validateWorkspaceConfig, type BrainConfig, type EntrypointConfig, type TranscriptionConfig, type WorkspaceConfig } from "@brain/workspace-schema";
import { AutomationRuntime, BrainRuntime, BrainSupervisor, EchoProviderAdapter, EmployeeLifecycle, FakeProviderAdapter, FileAutomationLockStore, FileAutomationSpool, FileEmployeeStore, FileSubagentJobStore, ProviderEmployeeRuntime, ProviderSubagentExecutor, RuntimeCommandInterceptor, RuntimeEntrypointBridge, StaticSubagentExecutor, SubagentLifecycle, createGuardedLiveValidationPlan, createOperationsPlan, formatAssistantCommandOutput, parseBrainDirectives, renderSystemdService, type BrainSupervisorLogRecord, type OperationsPlan, type ProviderAdapter, type ProviderTurnEvent, type RuntimeLogEntry, type SubagentExecutor } from "@brain/runtime-core";
import { FileTelegramPairingStore, FileTelegramPollingStateStore, OpenAITelegramAttachmentTranscriber, TelegramBotApiClient, TelegramEntrypointAdapter, loadTelegramToken, type TelegramAttachmentTranscriber } from "@brain/entrypoint-telegram";
import { createCodexProvider, type CodexTransportKind } from "@brain/provider-codex";
import { createClaudeCodeProvider, type ClaudeCodeTransportKind } from "@brain/provider-claude-code";
import { pruneExpiredPages, publishPage, readManifest, validatePageDirectory } from "@brain/web";

interface CliResult {
  ok: boolean;
  summary: string;
  details?: unknown;
}

const program = new Command();
const TELEGRAM_DOWNLOAD_MAX_BYTES = 52_428_800;
const DEFAULT_WORKSPACE_ID = "personal";
const DEFAULT_SERVICE_USER = "brain";

type SetupDefaultsTarget = "local" | "remote";

program
  .name("brainctl")
  .description("Operator CLI for validating and preparing Brain runtime workspaces.")
  .version("0.0.0");

program.command("setup")
  .description("Create a private workspace directory scaffold without writing secrets.")
  .argument("[mode]", "optional mode: defaults, remote-bootstrap, inspect, status, reset, telegram-token-script, or codex-auth-script")
  .option("--workspace <name>", "workspace id", DEFAULT_WORKSPACE_ID)
  .option("--target <target>", "defaults target: local or remote")
  .option("--ssh-host <host>", "remote SSH IP/DNS host for setup defaults")
  .option("--ssh-user <user>", "remote initial SSH login user for setup defaults/bootstrap; defaults to root in remote mode")
  .option("--service-user <user>", "remote non-root service user for defaults", DEFAULT_SERVICE_USER)
  .option("--ssh-alias <alias>", "optional SSH config Host alias to generate/update after remote bootstrap")
  .option("--ssh-config <path>", "optional SSH config path to generate/update after remote bootstrap")
  .option("--service-name <name>", "systemd service name for setup status")
  .option("--path <path>", "private workspace path; setup defaults to ~/.brain/workspace for the default workspace, inspect defaults to config workspacePath")
  .option("--config <path>", "runtime YAML/TOML/JSON config to inspect before planning")
  .option("--repo <path>", "source checkout path to inspect", process.cwd())
  .option("--output <path>", "output path for generated setup helper scripts")
  .option("--token-file <path>", "private Telegram token file for generated token storage script")
  .option("--adapter-config <path>", "private Telegram adapter config file for generated token storage script")
  .option("--service-env <path>", "private service env file for generated token storage script")
  .option("--secrets-env <path>", "private secrets env file for generated token storage script")
  .option("--binary <path>", "provider binary for generated setup helper scripts")
  .option("--verbose", "include derived config, secrets, state, log, and command details in setup defaults")
  .option("--force", "allow explicitly requested non-destructive rewrites in future setup flows")
  .option("--replace", "allow explicitly requested destructive replacement in future setup flows")
  .option("--dry-run", "show actions without creating directories")
  .option("--yes", "confirm setup reset should remove only state/setup-progress.json")
  .action(async (mode: string | undefined, options) => {
    if (mode === "defaults") {
      return exitWith(await setupDefaultsCommand(options));
    }
    if (mode === "remote-bootstrap") {
      return exitWith(await setupRemoteBootstrapCommand(options));
    }
    if (mode === "inspect" || mode === "status") {
      return exitWith(await setupInspectCommand({ ...options, config: options.config ?? "examples/config/runtime.yaml" }));
    }
    if (mode === "reset") {
      return exitWith(await setupResetCommand(options));
    }
    if (mode === "telegram-token-script") {
      return exitWith(await setupTelegramTokenScriptCommand(options));
    }
    if (mode === "codex-auth-script") {
      return exitWith(await setupCodexAuthScriptCommand(options));
    }
    if (mode) return exitWith({ ok: false, summary: `unknown setup mode: ${mode}`, details: { supported: ["defaults", "remote-bootstrap", "inspect", "status", "reset", "telegram-token-script", "codex-auth-script"] } });
    return exitWith(await setupCommand(options));
  });

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
  .option("--entrypoint <kind>", "override entrypoint kind from config: fake or telegram")
  .option("--provider <kind>", "override provider kind from config: fake, echo, codex, claude-code")
  .option("--fake", "force fake provider and fake entrypoint for tests/dev smoke")
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
  .option("--telegram-pairing", "use optional one-time /pair code bootstrap instead of default first-user pairing")
  .option("--telegram-pairing-state <dir>", "directory for Telegram paired identity state")
  .option("--telegram-downloads", "download Telegram attachments to the private artifact directory before provider turns")
  .option("--telegram-download-dir <path>", "directory for downloaded Telegram attachments")
  .option("--telegram-transcription-command <cmd>", "private command used to transcribe local voice/audio/video files; receives file path as argv[1]")
  .option("--employee-runtime", "enable provider-backed Employee sessions for employee start/steer commands")
  .option("--automation-file <path>", "optional loops/monitors YAML/JSON file for service-level loop status")
  .action(async (options) => exitWith(await startCommand(options)));

program.command("run")
  .description("Run the Brain supervisor in the foreground. Provider and entrypoint default to runtime config; pass --fake for test/dev smoke.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--entrypoint <kind>", "override entrypoint kind from config: fake or telegram")
  .option("--provider <kind>", "override provider kind from config: fake, echo, codex, claude-code")
  .option("--fake", "force fake provider and fake entrypoint for tests/dev smoke")
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
  .option("--telegram-pairing", "use optional one-time /pair code bootstrap instead of default first-user pairing")
  .option("--telegram-pairing-state <dir>", "directory for Telegram paired identity state")
  .option("--telegram-downloads", "download Telegram attachments to the private artifact directory before provider turns")
  .option("--telegram-download-dir <path>", "directory for downloaded Telegram attachments")
  .option("--telegram-transcription-command <cmd>", "private command used to transcribe local voice/audio/video files; receives file path as argv[1]")
  .option("--employee-runtime", "enable provider-backed Employee sessions for employee start/steer commands")
  .option("--automation-file <path>", "optional loops/monitors YAML/JSON file for service-level loop status")
  .action(async (options) => exitWith(await runCommand(options)));

program.command("health")
  .description("Inspect runtime supervisor/state/log readiness without starting live providers by default.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--state <path>", "runtime state root")
  .option("--log <path>", "runtime JSONL log path")
  .action(async (options) => exitWith(await healthCommand(options)));

program.command("status")
  .description("Summarize config, runtime state, logs, and operations readiness without starting live providers.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--state <path>", "runtime state root")
  .option("--artifacts <path>", "runtime artifact root")
  .option("--log <path>", "runtime JSONL log path")
  .action(async (options) => exitWith(await statusCommand(options)));

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
operations.command("validate")
  .description("Validate deployment paths and render command readiness without installing or restarting services.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--state <path>", "runtime state root")
  .option("--artifacts <path>", "runtime artifact root")
  .option("--log <path>", "runtime JSONL log path")
  .option("--service-name <name>", "systemd service name")
  .option("--service-user <user>", "systemd service user", "brain")
  .option("--repo <path>", "deployment checkout path", process.cwd())
  .action(async (options) => exitWith(await operationsValidateCommand(options)));

const web = program.command("web").description("Generated static web page validation and publisher commands");
web.command("setup")
  .description("Render a safe web publishing setup plan for domain or direct-IP publishing without DNS/proxy changes.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--domain <domain>", "public domain to publish under")
  .option("--base-url <url>", "public base URL for generated pages")
  .option("--publish-root <path>", "server/runtime publish root")
  .action(async (options) => exitWith(await webSetupStatusCommand(options, "setup")));
web.command("status")
  .description("Inspect configured web publishing fields and DNS/proxy readiness without changing DNS.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--domain <domain>", "public domain to publish under")
  .option("--base-url <url>", "public base URL for generated pages")
  .option("--publish-root <path>", "server/runtime publish root")
  .action(async (options) => exitWith(await webSetupStatusCommand(options, "status")));
web.command("validate")
  .description("Validate a generated static page package without publishing it.")
  .requiredOption("--dir <path>", "page package directory containing index.html")
  .action(async (options) => exitWith(await webValidateCommand(options)));
web.command("publish")
  .description("Publish a generated static page package to the configured runtime root.")
  .requiredOption("--dir <path>", "page package directory containing index.html")
  .option("--id <id>", "page id")
  .option("--title <title>", "override page title")
  .option("--runtime-root <path>", "runtime pages root")
  .option("--runtime-host <host>", "optional SSH host that owns the runtime pages root")
  .option("--manifest-path <path>", "manifest path")
  .option("--public-base-url <url>", "public pages base URL")
  .option("--ttl-hours <n>", "scratch TTL in hours", parseNumberOption)
  .option("--promoted", "publish without TTL")
  .option("--replace", "replace existing page id")
  .option("--dry-run", "validate and render publish result without copying files")
  .action(async (options) => exitWith(await webPublishCommand(options)));
web.command("prune")
  .description("Prune expired generated pages from the runtime root.")
  .option("--runtime-root <path>", "runtime pages root")
  .option("--runtime-host <host>", "optional SSH host that owns the runtime pages root")
  .option("--manifest-path <path>", "manifest path")
  .option("--now <iso>", "override current time")
  .option("--dry-run", "render prune result without deleting files")
  .action(async (options) => exitWith(await webPruneCommand(options)));
web.command("manifest")
  .description("Inspect a generated-pages manifest.")
  .option("--manifest-path <path>", "manifest path", ".brain/web-pages/manifest.json")
  .action(async (options) => exitWith(await webManifestCommand(options)));

const backup = program.command("backup").description("Private workspace backup planning and safe initialization commands");
backup.command("plan")
  .description("Render backup strategy, include/exclude policy, and commands without touching private data.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path override")
  .action(async (options) => exitWith(await backupCommand("plan", options)));
backup.command("init")
  .description("Initialize backup metadata safely; dry-run unless --apply is supplied.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path override")
  .option("--apply", "create missing backup directories/repo and .gitignore")
  .option("--replace", "replace an existing generated .gitignore template")
  .action(async (options) => exitWith(await backupCommand("init", options)));
backup.command("check")
  .description("Check backup repository/snapshot metadata without printing private file contents.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path override")
  .action(async (options) => exitWith(await backupCommand("check", options)));
backup.command("status")
  .description("Inspect backup status without mutating repositories.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path override")
  .action(async (options) => exitWith(await backupCommand("status", options)));

const workspaceCommands = program.command("workspace").description("Brain assistant workspace helpers for native stores and vendored integrations");
workspaceCommands.command("scaffold")
  .description("Create the Brain assistant workspace scaffold without overwriting stores or secrets.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path")
  .option("--assistant-repo <path>", "deprecated; ignored because Brain uses the native @brain/assistant-logic package")
  .option("--dry-run", "show planned scaffold paths without writing files")
  .action(async (options) => exitWith(await workspaceScaffoldCommand(options)));
workspaceCommands.command("status")
  .description("Inspect Brain assistant workspace parity metadata, including vendored live-integration scripts.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path")
  .option("--assistant-repo <path>", "deprecated; ignored because Brain uses the native @brain/assistant-logic package")
  .action(async (options) => exitWith(await workspaceStatusCommand(options)));
workspaceCommands.command("commands")
  .description("List Brain assistant-logic commands, including native stores and vendored live integrations.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path")
  .option("--assistant-repo <path>", "deprecated; ignored because Brain uses the native @brain/assistant-logic package")
  .action(async (options) => exitWith(await workspaceCommandsCommand(options)));
workspaceCommands.command("run")
  .description("Run a Brain assistant-logic command with ASSISTANT_WORKSPACE and private roots set.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path")
  .option("--assistant-repo <path>", "deprecated; ignored because Brain uses the native @brain/assistant-logic package")
  .argument("<script>", "script basename or scripts/<name>.js")
  .argument("[scriptArgs...]", "arguments for the assistant-logic CLI command; use -- before command flags")
  .allowUnknownOption(true)
  .action(async (script: string, scriptArgs: string[], options) => exitWith(await workspaceRunCommand(script, scriptArgs, options)));

const composio = program.command("composio").description("Optional Composio setup/status checks for Google Calendar and chat data sources");
composio.command("setup")
  .description("Render generic Composio setup prompts and missing metadata refs without using real credentials.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--api-key-ref <ref>", "Composio API key secret ref, e.g. env:COMPOSIO_API_KEY")
  .option("--connected-account-ref <ref>", "Composio connected-account metadata ref")
  .action(async (options) => exitWith(await composioSetupStatusCommand(options, "setup")));
composio.command("status")
  .description("Inspect optional Composio refs and data-source readiness without printing values.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--api-key-ref <ref>", "Composio API key secret ref, e.g. env:COMPOSIO_API_KEY")
  .option("--connected-account-ref <ref>", "Composio connected-account metadata ref")
  .action(async (options) => exitWith(await composioSetupStatusCommand(options, "status")));

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
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--transport <kind>", "provider transport to instantiate")
  .option("--binary <path>", "provider CLI binary for exec health checks")
  .option("--cwd <path>", "provider working directory for CLI health checks")
  .option("--app-server-url <url>", "Codex app-server WebSocket URL for app-server transport")
  .option("--timeout-ms <ms>", "provider health timeout in milliseconds", parseNumberOption)
  .action(async (providerId, options) => exitWith(await providerCheckCommand(providerId, options)));
provider.command("smoke")
  .description("Run one provider turn through the provider boundary; non-stub transports require --allow-live.")
  .argument("<provider>", "provider id: codex or claude-code")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--transport <kind>", "provider transport to instantiate", "stub")
  .option("--binary <path>", "provider CLI binary for exec health/smoke checks")
  .option("--cwd <path>", "provider working directory for CLI checks")
  .option("--app-server-url <url>", "Codex app-server WebSocket URL")
  .option("--timeout-ms <ms>", "provider timeout in milliseconds", parseNumberOption)
  .option("--prompt <text>", "prompt text for the smoke turn", "ping")
  .option("--allow-live", "allow non-stub provider transports to receive the smoke turn")
  .action(async (providerId, options) => exitWith(await providerSmokeCommand(providerId, options)));

const entrypoint = program.command("entrypoint").description("Entrypoint boundary checks");
entrypoint.command("check")
  .description("Check an entrypoint adapter without requiring live credentials.")
  .argument("<entrypoint>", "entrypoint id: telegram")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--token-env <name>", "Telegram token env var to verify without printing")
  .option("--token-file <path>", "Telegram token file to verify without printing")
  .option("--polling-state <path>", "Telegram durable polling offset state path to inspect")
  .option("--pairing-state <dir>", "Telegram paired/admin identity state directory to inspect")
  .action(async (entrypointId, options) => exitWith(await entrypointCheckCommand(entrypointId, options)));

const runtime = program.command("runtime").description("Runtime state inspection commands");
runtime.command("status")
  .description("Inspect runtime job state without starting providers or entrypoints.")
  .option("--workspace <id>", "workspace id", DEFAULT_WORKSPACE_ID)
  .option("--state <path>", "runtime state root", path.join(defaultWorkspaceRoot(DEFAULT_WORKSPACE_ID), "state"))
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
  .option("--dispatch", "run through the local fake execution harness instead of dry-run")
  .option("--state <path>", "runtime state root for fake dispatch/spool")
  .option("--artifacts <path>", "artifact root for fake dispatch")
  .action(async (loopId, options) => exitWith(await automationRunCommand(loopId, options)));
automation.command("due")
  .description("Evaluate due loops for the current minute without installing cron; dry-run by default.")
  .option("--file <path>", "automation JSON/YAML file with loops/monitors arrays", "examples/config/automation.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--now <iso>", "override current time for deterministic checks")
  .option("--dry-run", "do not dispatch; this is the default safe behavior", true)
  .option("--dispatch", "attempt fake dispatch for due dispatch_subagent loops")
  .option("--state <path>", "runtime state root for fake dispatch/spool")
  .option("--artifacts <path>", "artifact root for fake dispatch")
  .action(async (options) => exitWith(await automationDueCommand(options)));
automation.command("monitor")
  .description("Evaluate one monitor event through safe fake execution; dry-run by default.")
  .argument("<monitor>", "monitor id")
  .option("--file <path>", "automation JSON/YAML file with loops/monitors arrays", "examples/config/automation.yaml")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--line <text>", "sample monitor line", "sample monitor event")
  .option("--context <text>", "sample monitor context")
  .option("--dry-run", "do not dispatch; this is the default safe behavior", true)
  .option("--dispatch", "attempt fake dispatch through a local static subagent lifecycle")
  .option("--state <path>", "runtime state root for fake dispatch/spool")
  .option("--artifacts <path>", "artifact root for fake dispatch")
  .action(async (monitorId, options) => exitWith(await automationMonitorCommand(monitorId, options)));

interface SupervisorRunCommandOptions {
  config: string;
  workspace: string;
  entrypoint?: string;
  provider?: string;
  fake?: boolean;
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
  telegramDownloads?: boolean;
  telegramDownloadDir?: string;
  telegramTranscriptionCommand?: string;
  employeeRuntime?: boolean;
  automationFile?: string;
}

type RuntimeSelectionSource = "cli" | "config" | "fallback" | "fake-flag";

interface ResolvedSupervisorRuntime {
  workspaceId: string;
  workspace: WorkspaceConfig;
  primaryEntrypointId: string;
  primaryEntrypoint: EntrypointConfig;
  providerKind: string;
  providerSource: RuntimeSelectionSource;
  entrypointKind: string;
  entrypointSource: RuntimeSelectionSource;
  configPath: string;
}

type ResolvedSupervisorRuntimeResult =
  | (CliResult & { ok: true; runtime: ResolvedSupervisorRuntime })
  | (CliResult & { ok: false; runtime?: undefined });

async function startCommand(options: SupervisorRunCommandOptions & { foreground?: boolean }): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  const selection = resolveSupervisorRuntime(config.config, options);
  if (!selection.ok) return selection;
  const paths = supervisorPaths(options.workspace, { ...options, workspacePath: selection.runtime.workspace.workspacePath });
  if (!options.foreground) {
    return {
      ok: true,
      summary: "supervisor start plan ready (dry run; pass --foreground to run)",
      details: {
        workspace: options.workspace,
        config: path.resolve(options.config),
        entrypoint: selection.runtime.entrypointKind,
        entrypointSource: selection.runtime.entrypointSource,
        provider: selection.runtime.providerKind,
        providerSource: selection.runtime.providerSource,
        primaryEntrypointId: selection.runtime.primaryEntrypointId,
        subagentExecutor: subagentExecutorIdFor(selection.runtime),
        stateRoot: paths.stateRoot,
        artifactRoot: paths.artifactRoot,
        logPath: paths.logPath,
        liveTelegramPolling: Boolean(options.telegramPolling),
        telegramBootstrapPairing: options.telegramPairing ? "optional /pair code" : "first-user",
        telegramTranscription: publicTelegramTranscriptionRuntime(telegramTranscriptionRuntime(selection.runtime, options)),
        automationFile: options.automationFile ? path.resolve(options.automationFile) : undefined,
        deployment: "not performed",
      },
    };
  }
  return runCommand(options);
}

async function runCommand(options: SupervisorRunCommandOptions): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  const selection = resolveSupervisorRuntime(config.config, options);
  if (!selection.ok) return selection;
  const { workspace } = selection.runtime;

  const paths = supervisorPaths(options.workspace, { ...options, workspacePath: workspace.workspacePath });
  await mkdir(path.dirname(paths.logPath), { recursive: true, mode: 0o700 });
  const provider = createCliProvider(selection.runtime, options);
  let supervisor: BrainSupervisor | undefined;
  const store = new FileSubagentJobStore({ root: paths.stateRoot });
  const subagentExecutor = createCliSubagentExecutor(selection.runtime, provider);
  const subagents = new SubagentLifecycle({
    workspaceId: options.workspace,
    store,
    executor: subagentExecutor,
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
    runtime: options.employeeRuntime ? new ProviderEmployeeRuntime({ provider, workspaceId: options.workspace }) : undefined,
  });
  await employees.init();

  const entrypoint = await createCliEntrypoint(selection.runtime, options, paths);
  const runtime = new BrainRuntime({ workspaceId: options.workspace, workspace, provider, subagents });
  const logReader = new FileRuntimeLogReader(paths.logPath);
  const automation = options.automationFile
    ? new AutomationRuntime({
        workspaceId: options.workspace,
        ...(await readAutomationConfig(options.automationFile)),
      })
    : undefined;
  const commandInterceptor = new RuntimeCommandInterceptor({
    subagents,
    employees,
    automation,
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
        providerKind: selection.runtime.providerKind,
        providerSource: selection.runtime.providerSource,
        entrypoint: entrypoint.id,
        entrypointKind: selection.runtime.entrypointKind,
        entrypointSource: selection.runtime.entrypointSource,
        primaryEntrypointId: selection.runtime.primaryEntrypointId,
        subagentExecutor: subagentExecutor.id,
        processed: result.processed.length,
        stoppedReason: result.stoppedReason,
        hydration,
        dispatchResults: result.processed.flatMap((item) => item.dispatchResults.map((dispatch) => ({ type: dispatch.action.type, status: dispatch.status, target: dispatch.action.target }))),
        interceptedCommands: result.processed.map((item) => item.intercepted?.command).filter(Boolean),
        stateRoot: paths.stateRoot,
        artifactRoot: paths.artifactRoot,
        logPath: paths.logPath,
        telegramTranscription: publicTelegramTranscriptionRuntime(telegramTranscriptionRuntime(selection.runtime, options)),
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
  const selection = config.ok && config.config ? resolveSupervisorRuntime(config.config, { ...options }) : undefined;
  const runtime = selection?.ok ? selection.runtime : undefined;
  const paths = supervisorPaths(options.workspace, { ...options, workspacePath: runtime?.workspace.workspacePath });
  const state = await runtimeStatusCommand({ workspace: options.workspace, state: paths.stateRoot });
  const logMeta = await fileMetadata(paths.logPath);
  return {
    ok: config.ok && (selection?.ok ?? true) && state.ok,
    summary: config.ok && (selection?.ok ?? true) && state.ok ? "runtime health seams inspected" : "runtime health seams need attention",
    details: {
      config: config.ok ? config.details : config,
      runtimeSelection: selection?.ok ? {
        provider: runtime?.providerKind,
        providerSource: runtime?.providerSource,
        entrypoint: runtime?.entrypointKind,
        entrypointSource: runtime?.entrypointSource,
        primaryEntrypointId: runtime?.primaryEntrypointId,
      } : selection,
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

async function statusCommand(options: { config: string; workspace: string; state?: string; artifacts?: string; log?: string }): Promise<CliResult> {
  const health = await healthCommand(options);
  const config = await loadValidConfig(options.config);
  const selection = config.ok && config.config ? resolveSupervisorRuntime(config.config, options) : undefined;
  const runtime = selection?.ok ? selection.runtime : undefined;
  const paths = supervisorPaths(options.workspace, { ...options, workspacePath: runtime?.workspace.workspacePath });
  const operations = health.ok ? operationsPlan({ ...options, repo: process.cwd() }, runtime) : undefined;
  return {
    ok: health.ok,
    summary: health.ok ? "runtime status inspected without live side effects" : "runtime status needs attention",
    details: {
      health: health.details,
      paths,
      operations: operations ? {
        serviceName: operations.serviceName,
        unitPath: operations.unitPath,
        preflight: operations.commands.preflight,
        postUpdateSmoke: operations.commands.postUpdateSmoke,
      } : undefined,
      liveProcessesStarted: false,
    },
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
  const selection = resolveSupervisorRuntime(config.config, options);
  if (!selection.ok) return selection;
  const plan = operationsPlan(options, selection.runtime);
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
  const selection = resolveSupervisorRuntime(config.config, options);
  if (!selection.ok) return selection;
  const plan = operationsPlan(options, selection.runtime);
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

async function operationsValidateCommand(options: OperationsCommandOptions): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  const selection = resolveSupervisorRuntime(config.config, options);
  if (!selection.ok) return selection;
  const plan = operationsPlan(options, selection.runtime);
  const [repo, configFile, stateParent, artifactRoot, logParent, envFile] = await Promise.all([
    fileMetadata(plan.repoPath),
    fileMetadata(plan.configPath),
    fileMetadata(path.dirname(plan.stateRoot)),
    fileMetadata(plan.artifactRoot),
    fileMetadata(path.dirname(plan.logPath)),
    fileMetadata(plan.environmentFile),
  ]);
  return {
    ok: true,
    summary: "operations readiness validated without deployment side effects",
    details: {
      serviceName: plan.serviceName,
      unitPath: plan.unitPath,
      metadata: { repo, configFile, stateParent, artifactRoot, logParent, environmentFile: envFile },
      commandPlan: plan.commands,
      safety: plan.safety,
      sideEffects: "none",
    },
  };
}

function operationsPlan(options: OperationsCommandOptions, runtime?: ResolvedSupervisorRuntime): OperationsPlan {
  const paths = supervisorPaths(options.workspace, { ...options, workspacePath: runtime?.workspace.workspacePath });
  return createOperationsPlan({
    workspaceId: options.workspace,
    repoPath: options.repo ?? process.cwd(),
    configPath: options.config,
    stateRoot: paths.stateRoot,
    artifactRoot: paths.artifactRoot,
    logPath: paths.logPath,
    serviceName: options.serviceName,
    serviceUser: options.serviceUser,
    providerKind: runtime?.providerKind,
    entrypointKind: runtime?.entrypointKind,
  });
}

async function webValidateCommand(options: { dir: string }): Promise<CliResult> {
  try {
    const validation = await validatePageDirectory(options.dir);
    return {
      ok: true,
      summary: "generated page package is valid",
      details: {
        root: validation.root,
        title: validation.title,
        files: validation.files,
        totalBytes: validation.totalBytes,
        sideEffects: "none",
      },
    };
  } catch (error) {
    return { ok: false, summary: "generated page package is invalid", details: { error: errorMessage(error), sideEffects: "none" } };
  }
}

async function webPublishCommand(options: {
  dir: string;
  id?: string;
  title?: string;
  runtimeRoot?: string;
  runtimeHost?: string;
  manifestPath?: string;
  publicBaseUrl?: string;
  ttlHours?: number;
  promoted?: boolean;
  replace?: boolean;
  dryRun?: boolean;
}): Promise<CliResult> {
  try {
    const result = await publishPage({
      sourceDir: options.dir,
      id: options.id,
      title: options.title,
      runtimeRoot: options.runtimeRoot,
      runtimeHost: options.runtimeHost,
      manifestPath: options.manifestPath,
      publicBaseUrl: options.publicBaseUrl,
      ttlHours: options.ttlHours,
      promoted: options.promoted,
      replace: options.replace,
      dryRun: options.dryRun,
      source: { publisher: "brainctl web publish" },
    });
    return { ok: true, summary: result.dryRun ? "generated page publish dry-run passed" : "generated page published", details: result };
  } catch (error) {
    return { ok: false, summary: "generated page publish failed", details: { error: errorMessage(error), dryRun: Boolean(options.dryRun) } };
  }
}

async function webPruneCommand(options: { runtimeRoot?: string; runtimeHost?: string; manifestPath?: string; now?: string; dryRun?: boolean }): Promise<CliResult> {
  try {
    const result = await pruneExpiredPages({ runtimeRoot: options.runtimeRoot, runtimeHost: options.runtimeHost, manifestPath: options.manifestPath, now: options.now, dryRun: options.dryRun });
    return { ok: true, summary: result.dryRun ? "generated page prune dry-run complete" : "generated pages pruned", details: result };
  } catch (error) {
    return { ok: false, summary: "generated page prune failed", details: { error: errorMessage(error), dryRun: Boolean(options.dryRun) } };
  }
}

async function webManifestCommand(options: { manifestPath: string }): Promise<CliResult> {
  try {
    const manifest = await readManifest(options.manifestPath);
    return {
      ok: true,
      summary: "generated page manifest inspected",
      details: {
        manifestPath: path.resolve(options.manifestPath),
        pages: Object.keys(manifest.pages).length,
        updatedAt: manifest.updatedAt,
        entries: Object.values(manifest.pages).map((page) => ({ id: page.id, title: page.title, url: page.url, status: page.status, expiresAt: page.expiresAt })),
      },
    };
  } catch (error) {
    return { ok: false, summary: "generated page manifest could not be read", details: { error: errorMessage(error) } };
  }
}

async function webSetupStatusCommand(options: { config: string; workspace: string; domain?: string; baseUrl?: string; publishRoot?: string }, mode: "setup" | "status"): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  const workspace = config.config?.workspaces[options.workspace];
  const configured = setupWebPublishingStatus(workspace);
  const baseUrl = options.baseUrl ?? configured.baseUrl ?? configured.publicBaseUrl;
  const domain = options.domain ?? configured.domain ?? hostnameFromUrl(baseUrl);
  const publishRoot = options.publishRoot ?? configured.publishRoot;
  const publishRootMeta = publishRoot ? await fileMetadata(publishRoot) : undefined;
  const dns = dnsStatusForWeb(domain, baseUrl, configured.mode);
  const missing = [];
  if (!baseUrl) missing.push("base URL");
  if (!publishRoot) missing.push("publish root");
  if (!domain) missing.push("domain or IP host");
  return {
    ok: true,
    summary: mode === "setup" ? "web publishing setup plan rendered without DNS or proxy changes" : "web publishing status inspected without DNS or proxy changes",
    details: {
      workspace: options.workspace,
      config: config.ok ? { path: path.resolve(options.config), valid: true } : config,
      enabled: configured.enabled,
      mode: configured.mode,
      domain,
      baseUrl,
      publishRoot,
      publishRootMetadata: publishRootMeta,
      dns,
      reverseProxy: {
        suggested: configured.reverseProxy?.kind ?? "caddy",
        note: configured.reverseProxy?.note ?? "Configure Caddy or another reverse proxy to serve the publish root/base URL after the operator confirms host changes.",
      },
      prompts: [
        "Should generated pages be published under a domain or directly to an IP address?",
        "What public base URL should page links use?",
        "What local/server publish root should the publisher copy files into?",
        "Will Caddy or another reverse proxy terminate HTTPS and serve the publish root?",
      ],
      missing,
      sideEffects: "none",
      dnsChanged: false,
    },
  };
}

async function backupCommand(action: "plan" | "init" | "check" | "status", options: { config: string; workspace: string; path?: string; apply?: boolean; replace?: boolean }): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  if (!config.ok || !config.config) return config;
  const workspace = config.config.workspaces[options.workspace];
  if (!workspace) return { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(config.config.workspaces) } };
  const workspaceRoot = path.resolve(options.path ?? workspace.workspacePath);
  const plan = backupPlanFor(workspace, workspaceRoot);

  if (action === "init") {
    const dryRun = !options.apply;
    const initResult: Record<string, unknown> = dryRun ? { actions: plan.commands.init, wroteGitignore: false, initializedRepo: false } : await applyBackupInit(plan, { replace: options.replace });
    return {
      ok: initResult.ok !== false,
      summary: dryRun ? "backup init plan ready (dry run; pass --apply to create metadata)" : "backup metadata initialized safely",
      details: { workspace: options.workspace, workspaceRoot, plan, init: initResult, sideEffects: dryRun ? "none" : "created backup metadata only; no private files committed" },
    };
  }

  const status = await backupStatusFor(plan);
  return {
    ok: action === "plan" ? true : status.ok,
    summary: action === "plan" ? "backup plan rendered without touching private data" : "backup status checked without printing private data",
    details: {
      workspace: options.workspace,
      workspaceRoot,
      plan,
      status: action === "plan" ? undefined : status,
      sideEffects: "none",
    },
  };
}

async function composioSetupStatusCommand(options: { config: string; workspace: string; apiKeyRef?: string; connectedAccountRef?: string }, mode: "setup" | "status"): Promise<CliResult> {
  const config = await loadValidConfig(options.config);
  const workspace = config.config?.workspaces[options.workspace];
  const status = await setupComposioStatus(workspace, {
    apiKeyRef: options.apiKeyRef,
    connectedAccountRef: options.connectedAccountRef,
  });
  return {
    ok: true,
    summary: mode === "setup" ? "Composio setup prompts rendered without using credentials" : "Composio status inspected without printing credentials",
    details: {
      workspace: options.workspace,
      config: config.ok ? { path: path.resolve(options.config), valid: true } : config,
      ...status,
      prompts: [
        "Do you want optional Google Calendar access through Composio?",
        "Do you want optional chat data-source access through Composio?",
        "Where should the Composio API key be referenced (env:NAME or file:/path) without storing the value in git?",
        "Where should connected account metadata refs live in the private workspace?",
      ],
      sideEffects: "none",
      credentialsUsed: false,
      secretValuesPrinted: false,
    },
  };
}

function setupBackupStatus(workspace: WorkspaceConfig | undefined, workspaceRoot: string) {
  return backupPlanFor(workspace, workspaceRoot).config;
}

function backupPlanFor(workspace: WorkspaceConfig | undefined, workspaceRoot: string) {
  const backup = workspace?.backup;
  const strategy = backup?.strategy ?? "none";
  const privateGit = {
    repoPath: path.resolve(backup?.privateGit?.repoPath ?? path.join(workspaceRoot, "backups", "private-git")),
    remote: backup?.privateGit?.remote,
    branch: backup?.privateGit?.branch ?? "main",
    include: backup?.privateGit?.include ?? defaultBackupInclude,
    exclude: backup?.privateGit?.exclude ?? defaultBackupExclude,
  };
  const localSnapshot = {
    root: path.resolve(backup?.localSnapshot?.root ?? path.join(workspaceRoot, "backups", "snapshots")),
    retention: backup?.localSnapshot?.retention ?? "operator-defined",
    include: backup?.localSnapshot?.include ?? defaultBackupInclude,
    exclude: backup?.localSnapshot?.exclude ?? defaultBackupExclude,
  };
  const initCommands = strategy === "private-git"
    ? [
      `mkdir -p ${shellQuote(privateGit.repoPath)}`,
      `git -C ${shellQuote(privateGit.repoPath)} init -b ${shellQuote(privateGit.branch)}`,
      `install -m 0600 <private-workspace.gitignore> ${shellQuote(path.join(privateGit.repoPath, ".gitignore"))}`,
      ...(privateGit.remote ? [`git -C ${shellQuote(privateGit.repoPath)} remote add origin ${shellQuote(privateGit.remote)}`] : []),
    ]
    : strategy === "local-snapshot"
      ? [`mkdir -p ${shellQuote(localSnapshot.root)}`]
      : [];
  return {
    config: {
      strategy,
      privateGit,
      localSnapshot,
      safeDefaultExcludes: defaultBackupExclude,
      secretsIncludedByDefault: false,
    },
    commands: {
      init: initCommands,
      check: strategy === "private-git" ? [`git -C ${shellQuote(privateGit.repoPath)} status --short --branch`] : [],
      commitExample: strategy === "private-git" ? [`git -C ${shellQuote(privateGit.repoPath)} add --all`, `git -C ${shellQuote(privateGit.repoPath)} commit -m ${shellQuote("Backup private workspace metadata")}`] : [],
    },
    dryRunDefault: true,
  };
}

async function applyBackupInit(plan: ReturnType<typeof backupPlanFor>, options: { replace?: boolean }): Promise<Record<string, unknown>> {
  const strategy = plan.config.strategy;
  if (strategy === "none") return { ok: true, actions: [], note: "backup strategy is none; nothing initialized" };
  if (strategy === "local-snapshot") {
    await mkdir(plan.config.localSnapshot.root, { recursive: true, mode: 0o700 });
    return { ok: true, actions: [`created ${plan.config.localSnapshot.root}`], initializedRepo: false, wroteGitignore: false };
  }

  const repoPath = plan.config.privateGit.repoPath;
  await mkdir(repoPath, { recursive: true, mode: 0o700 });
  const gitDir = path.join(repoPath, ".git");
  const gitDirMeta = await fileMetadata(gitDir);
  let initializedRepo = false;
  if (!gitDirMeta.present) {
    const init = spawnSync("git", ["-C", repoPath, "init", "-b", plan.config.privateGit.branch], { encoding: "utf8" });
    if ((init.status ?? 0) !== 0) return { ok: false, error: init.stderr || init.stdout || `git init exited ${init.status}` };
    initializedRepo = true;
  }
  let remoteConfigured = false;
  let remoteSkipped: string | undefined;
  if (plan.config.privateGit.remote) {
    const currentOrigin = spawnSync("git", ["-C", repoPath, "remote", "get-url", "origin"], { encoding: "utf8" });
    if ((currentOrigin.status ?? 0) === 0) {
      remoteSkipped = "origin remote already exists; not overwritten";
    } else {
      const remote = spawnSync("git", ["-C", repoPath, "remote", "add", "origin", plan.config.privateGit.remote], { encoding: "utf8" });
      if ((remote.status ?? 0) !== 0) return { ok: false, error: remote.stderr || remote.stdout || `git remote add exited ${remote.status}` };
      remoteConfigured = true;
    }
  }

  const gitignorePath = path.join(repoPath, ".gitignore");
  const existingGitignore = await fileMetadata(gitignorePath);
  if (existingGitignore.present && !options.replace) {
    return {
      ok: true,
      initializedRepo,
      remoteConfigured,
      remoteSkipped,
      wroteGitignore: false,
      unsafe_to_overwrite: [".gitignore exists; pass --replace to replace it with the Brain private workspace template"],
    };
  }
  await writeFile(gitignorePath, PRIVATE_WORKSPACE_GITIGNORE, { mode: 0o600 });
  return { ok: true, initializedRepo, remoteConfigured, remoteSkipped, wroteGitignore: true, gitignorePath };
}

async function backupStatusFor(plan: ReturnType<typeof backupPlanFor>): Promise<{ ok: boolean; metadata: unknown; git?: unknown; note?: string }> {
  if (plan.config.strategy === "none") return { ok: true, metadata: { strategy: "none" }, note: "backup is disabled" };
  if (plan.config.strategy === "local-snapshot") {
    const metadata = await fileMetadata(plan.config.localSnapshot.root);
    return { ok: metadata.present, metadata };
  }
  const metadata = await fileMetadata(plan.config.privateGit.repoPath);
  const git = await gitMetadata(plan.config.privateGit.repoPath);
  return { ok: metadata.present && Boolean(git.present), metadata, git };
}

async function workspaceScaffoldCommand(options: { workspace: string; path?: string; assistantRepo?: string; dryRun?: boolean }): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const scaffold = options.dryRun
    ? assistantWorkspaceScaffoldPlan(workspaceRoot)
    : await ensureAssistantWorkspaceScaffold(workspaceRoot);
  const status = await assistantWorkspaceParityStatus({ workspaceRoot, workspaceId: options.workspace, deprecatedAssistantRepo: options.assistantRepo });
  return {
    ok: options.dryRun ? true : status.ready,
    summary: options.dryRun
      ? "assistant workspace scaffold plan ready (dry run)"
      : "assistant workspace scaffold reconciled without overwriting stores or secrets",
    details: {
      workspace: options.workspace,
      workspaceRoot,
      scaffold,
      status,
      sideEffects: options.dryRun ? "none" : "created missing assistant JSON workspace directories/files only; existing stores were not overwritten",
    },
  };
}

async function workspaceStatusCommand(options: { workspace: string; path?: string; assistantRepo?: string }): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const status = await assistantWorkspaceParityStatus({ workspaceRoot, workspaceId: options.workspace, deprecatedAssistantRepo: options.assistantRepo });
  return {
    ok: status.ready,
    summary: status.ready
      ? "assistant-logic workspace parity paths and vendored commands are ready"
      : "assistant-logic workspace parity paths or vendored commands are missing or invalid",
    details: { workspace: options.workspace, workspaceRoot, status, sideEffects: "none" },
  };
}

async function workspaceCommandsCommand(options: { workspace: string; path?: string; assistantRepo?: string }): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const assistantLogicRoot = assistantLogicPackageRoot();
  const commands = assistantWorkspaceCommandCatalog(workspaceRoot, assistantLogicRoot);
  const scriptMetadata = await assistantCommandScriptMetadata(assistantLogicRoot, commands.flatMap((group) => group.scripts));
  return {
    ok: scriptMetadata.every((item) => item.present),
    summary: "assistant-logic workspace command catalog rendered",
    details: {
      workspace: options.workspace,
      workspaceRoot,
      assistantLogicRoot,
      assistantLogicSource: "in-repo:@brain/assistant-logic",
      deprecatedAssistantRepoIgnored: Boolean(options.assistantRepo),
      env: assistantWorkspaceEnv(workspaceRoot),
      commands,
      scripts: scriptMetadata,
      sideEffects: "none",
    },
  };
}

async function workspaceRunCommand(script: string, scriptArgs: string[], options: { workspace: string; path?: string; assistantRepo?: string }): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const assistantLogicRoot = assistantLogicPackageRoot();
  const resolved = await resolveAssistantScript(assistantLogicRoot, script);
  if (!resolved.ok) return resolved.result;
  const forwardedArgs = scriptArgs[0] === "--" ? scriptArgs.slice(1) : scriptArgs;
  const env = {
    ...process.env,
    ...assistantWorkspaceEnv(workspaceRoot),
  };
  const runner = resolved.script.endsWith(".sh") ? "bash" : process.execPath;
  const result = spawnSync(runner, [resolved.path, ...forwardedArgs], {
    cwd: resolved.cwd,
    encoding: "utf8",
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const parsedStdout = parseJsonOrString(stdout);
  const userFacingText = formatAssistantCommandOutput({
    script: resolved.script,
    stdout: parsedStdout,
    stderr,
    ok: (result.status ?? 1) === 0,
    workspacePath: workspaceRoot,
  });
  return {
    ok: (result.status ?? 1) === 0,
    summary: (result.status ?? 1) === 0
      ? `${resolved.kind} assistant-logic command completed: ${resolved.script}`
      : `${resolved.kind} assistant-logic command failed: ${resolved.script}`,
    details: {
      workspace: options.workspace,
      workspaceRoot,
      assistantLogicRoot,
      assistantLogicSource: "in-repo:@brain/assistant-logic",
      commandKind: resolved.kind,
      deprecatedAssistantRepoIgnored: Boolean(options.assistantRepo),
      script: resolved.script,
      scriptPath: resolved.path,
      args: forwardedArgs,
      env: assistantWorkspaceEnv(workspaceRoot),
      exitCode: result.status,
      stdout: parsedStdout,
      userFacingText,
      stderr: String(redactSecrets(stderr)),
      sideEffects: resolved.kind === "native"
        ? "native assistant-logic CLI controlled the JSON workspace state"
        : "vendored assistant-agent-logic script controlled workspace state or live integrations using private configuration",
    },
  };
}

function parseJsonOrString(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function assistantWorkspaceScaffoldPlan(workspaceRoot: string) {
  return {
    directories: assistantWorkspaceDirectories(workspaceRoot),
    jsonStores: ASSISTANT_STATE_STORES.map((store) => path.join(workspaceRoot, store.relativePath)),
    configTemplates: assistantWorkspaceTemplateFiles(workspaceRoot).map((item) => item.destination),
    instructionOverlays: [
      path.join(workspaceRoot, "instructions", "README.md"),
      ...ASSISTANT_OVERLAY_SKILLS.map((skill) => path.join(workspaceRoot, "instructions", "skills", `${skill}.md`)),
      ...ASSISTANT_OVERLAY_PROMPTS.map((prompt) => path.join(workspaceRoot, "instructions", "prompts", `${prompt}.md`)),
    ],
    tasksReadme: path.join(workspaceRoot, "tasks", "README.md"),
    repoRegistryReadme: path.join(workspaceRoot, ".claude", "repo-registry", "README.md"),
    fileSaveMetadata: assistantWorkspaceDocumentMetadataPath(workspaceRoot),
    markdownResourceDirs: ["projects", "notes", "documents", path.join("documents", "metadata")].map((dir) => path.join(workspaceRoot, dir)),
  };
}

async function ensureAssistantWorkspaceScaffold(workspaceRoot: string) {
  const plan = assistantWorkspaceScaffoldPlan(workspaceRoot);
  const createdDirs: string[] = [];
  const writtenFiles: string[] = [];
  const skippedExisting: string[] = [];
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await chmod(workspaceRoot, 0o700).catch(() => undefined);
  for (const dir of plan.directories) {
    const before = await fileMetadata(dir);
    await mkdir(dir, { recursive: true, mode: workspaceDirectoryMode(path.relative(workspaceRoot, dir)) });
    if (!before.present) createdDirs.push(path.relative(workspaceRoot, dir));
  }
  for (const store of ASSISTANT_STATE_STORES) {
    const filePath = path.join(workspaceRoot, store.relativePath);
    const result = await writeJsonIfMissing(filePath, store.defaultValue());
    (result.wrote ? writtenFiles : skippedExisting).push(path.relative(workspaceRoot, filePath));
  }
  for (const template of assistantWorkspaceTemplateFiles(workspaceRoot)) {
    const contents = await readFile(template.source, "utf8");
    const result = await writeTextIfMissing(template.destination, contents);
    (result.wrote ? writtenFiles : skippedExisting).push(path.relative(workspaceRoot, template.destination));
  }
  const instructionReadme = path.join(workspaceRoot, "instructions", "README.md");
  const readmeResult = await writeTextIfMissing(instructionReadme, renderInstructionsReadme());
  (readmeResult.wrote ? writtenFiles : skippedExisting).push(path.relative(workspaceRoot, instructionReadme));
  for (const skill of ASSISTANT_OVERLAY_SKILLS) {
    const filePath = path.join(workspaceRoot, "instructions", "skills", `${skill}.md`);
    const result = await writeTextIfMissing(filePath, renderSkillOverlayPlaceholder(skill));
    (result.wrote ? writtenFiles : skippedExisting).push(path.relative(workspaceRoot, filePath));
  }
  for (const prompt of ASSISTANT_OVERLAY_PROMPTS) {
    const filePath = path.join(workspaceRoot, "instructions", "prompts", `${prompt}.md`);
    const result = await writeTextIfMissing(filePath, renderPromptOverlayPlaceholder(prompt));
    (result.wrote ? writtenFiles : skippedExisting).push(path.relative(workspaceRoot, filePath));
  }
  const tasksReadmeResult = await writeTextIfMissing(path.join(workspaceRoot, "tasks", "README.md"), renderTasksReadme(workspaceRoot));
  (tasksReadmeResult.wrote ? writtenFiles : skippedExisting).push(path.join("tasks", "README.md"));
  const repoRegistryReadmeResult = await writeTextIfMissing(path.join(workspaceRoot, ".claude", "repo-registry", "README.md"), renderRepoRegistryReadme());
  (repoRegistryReadmeResult.wrote ? writtenFiles : skippedExisting).push(path.join(".claude", "repo-registry", "README.md"));
  const metadataResult = await writeTextIfMissing(assistantWorkspaceDocumentMetadataPath(workspaceRoot), "");
  (metadataResult.wrote ? writtenFiles : skippedExisting).push(path.relative(workspaceRoot, assistantWorkspaceDocumentMetadataPath(workspaceRoot)));
  return {
    ...plan,
    createdDirs,
    writtenFiles,
    skippedExisting,
    overwritten: false,
  };
}

function assistantWorkspaceTemplateFiles(workspaceRoot: string): Array<{ source: string; destination: string }> {
  const templateRoot = path.join(assistantLogicPackageRoot(), "config", "workspace-template");
  return [
    { source: path.join(templateRoot, ".env.example"), destination: path.join(workspaceRoot, ".env.example") },
    { source: path.join(templateRoot, "composio.yaml"), destination: path.join(workspaceRoot, "composio.yaml.example") },
    { source: path.join(templateRoot, "messaging.yaml"), destination: path.join(workspaceRoot, "messaging.yaml.example") },
    { source: path.join(templateRoot, "telegram.yaml"), destination: path.join(workspaceRoot, "telegram.yaml.example") },
    { source: path.join(templateRoot, "protonmail.yaml"), destination: path.join(workspaceRoot, "protonmail.yaml.example") },
  ];
}

function assistantWorkspaceDirectories(workspaceRoot: string): string[] {
  return [
    ...WORKSPACE_DIRS.map((dir) => path.join(workspaceRoot, dir)),
  ];
}

function workspaceDirectoryMode(relativePath: string): number {
  if (/^(secrets|data|private|instructions|tasks|\.claude)(\/|$)/.test(relativePath)) return 0o700;
  if (/^(config|state|backups|tmp)(\/|$)/.test(relativePath)) return 0o700;
  return 0o755;
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<{ wrote: boolean }> {
  const existing = await fileMetadata(filePath);
  if (existing.present) return { wrote: false };
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
  return { wrote: true };
}

async function writeTextIfMissing(filePath: string, value: string): Promise<{ wrote: boolean }> {
  const existing = await fileMetadata(filePath);
  if (existing.present) return { wrote: false };
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, value, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
  return { wrote: true };
}

async function assistantWorkspaceParityStatus(input: { workspaceRoot: string; workspaceId: string; deprecatedAssistantRepo?: string }) {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const assistantLogicRoot = assistantLogicPackageRoot();
  const assistantRepoMetadata = await fileMetadata(assistantLogicRoot);
  const commands = assistantWorkspaceCommandCatalog(workspaceRoot, assistantLogicRoot);
  const scriptMetadata = await assistantCommandScriptMetadata(assistantLogicRoot, commands.flatMap((group) => group.scripts));
  const stateStores = await Promise.all(ASSISTANT_STATE_STORES.map(async (store) => {
    const filePath = path.join(workspaceRoot, store.relativePath);
    const metadata = await fileMetadata(filePath);
    const validation = metadata.present ? await validateAssistantStateStore(filePath, store) : { valid: false, issue: "missing" };
    return { key: store.key, relativePath: store.relativePath, path: filePath, present: metadata.present, metadata, ...validation };
  }));
  const instructionFiles = [
    path.join(workspaceRoot, "instructions", "README.md"),
    ...ASSISTANT_OVERLAY_SKILLS.map((skill) => path.join(workspaceRoot, "instructions", "skills", `${skill}.md`)),
    ...ASSISTANT_OVERLAY_PROMPTS.map((prompt) => path.join(workspaceRoot, "instructions", "prompts", `${prompt}.md`)),
  ];
  const instructionMetadata = await Promise.all(instructionFiles.map(async (filePath) => ({
    relativePath: path.relative(workspaceRoot, filePath),
    path: filePath,
    metadata: await fileMetadata(filePath),
  })));
  const tasksReadme = path.join(workspaceRoot, "tasks", "README.md");
  const repoRegistryReadme = path.join(workspaceRoot, ".claude", "repo-registry", "README.md");
  const fileMetadataPath = assistantWorkspaceDocumentMetadataPath(workspaceRoot);
  const fileSaveMetadata = await fileMetadata(fileMetadataPath);
  const directories = await Promise.all([
    "data",
    "instructions",
    path.join("instructions", "skills"),
    path.join("instructions", "prompts"),
    "tasks",
    path.join(".claude", "repo-registry"),
    "private",
    path.join("private", "documents"),
    path.join("private", "documents", "files"),
    "projects",
    "notes",
    "documents",
    path.join("documents", "metadata"),
  ].map(async (dir) => ({ relativePath: dir, metadata: await fileMetadata(path.join(workspaceRoot, dir)) })));
  const instructionsReady = instructionMetadata.every((item) => item.metadata.present);
  const tasksReady = (await fileMetadata(tasksReadme)).present;
  const repoRegistryReady = (await fileMetadata(repoRegistryReadme)).present || (await fileMetadata(path.join(workspaceRoot, ".claude", "repo-registry", "index.yaml"))).present;
  const fileSaveReady = fileSaveMetadata.present && directories.some((item) => item.relativePath === path.join("private", "documents", "files") && item.metadata.present);
  const ready = assistantRepoMetadata.present
    && scriptMetadata.every((item) => item.present)
    && stateStores.every((store) => store.present && store.valid)
    && instructionsReady
    && tasksReady
    && repoRegistryReady
    && fileSaveReady;
  return {
    ready,
    workspaceId: input.workspaceId,
    workspaceRoot,
    assistantRepo: assistantLogicRoot,
    assistantLogicRoot,
    assistantRepoMetadata,
    assistantRepoSource: "in-repo:@brain/assistant-logic",
    assistantLogicSource: "in-repo:@brain/assistant-logic",
    deprecatedAssistantRepoIgnored: Boolean(input.deprecatedAssistantRepo),
    env: assistantWorkspaceEnv(workspaceRoot),
    directories,
    stateStores,
    instructions: { ready: instructionsReady, files: instructionMetadata },
    tasks: { ready: tasksReady, readme: { path: tasksReadme, metadata: await fileMetadata(tasksReadme) } },
    repoRegistry: {
      ready: repoRegistryReady,
      selectedBackupIncludes: repoRegistryBackupIncludes(),
      readme: { path: repoRegistryReadme, metadata: await fileMetadata(repoRegistryReadme) },
      index: { path: path.join(workspaceRoot, ".claude", "repo-registry", "index.yaml"), metadata: await fileMetadata(path.join(workspaceRoot, ".claude", "repo-registry", "index.yaml")) },
    },
    fileSave: {
      ready: fileSaveReady,
      privateRoot: assistantWorkspacePrivateRoot(workspaceRoot),
      metadataPath: fileMetadataPath,
      metadata: fileSaveMetadata,
      filesRoot: path.join(assistantWorkspacePrivateRoot(workspaceRoot), "documents", "files"),
    },
    commands,
    scripts: scriptMetadata,
  };
}

async function validateAssistantStateStore(filePath: string, spec: AssistantStateStoreSpec): Promise<{ valid: boolean; issue?: string }> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (spec.rootType === "array") {
      return Array.isArray(parsed) ? { valid: true } : { valid: false, issue: "root is not an array" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { valid: false, issue: "root is not an object" };
    for (const key of spec.arrayRootKeys) {
      if (!Array.isArray(parsed[key])) return { valid: false, issue: `missing array root key: ${key}` };
    }
    for (const key of spec.objectRootKeys ?? []) {
      if (!parsed[key] || typeof parsed[key] !== "object" || Array.isArray(parsed[key])) return { valid: false, issue: `missing object root key: ${key}` };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, issue: errorMessage(error) };
  }
}

function assistantWorkspacePrivateRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, "private");
}

function assistantWorkspaceDocumentMetadataPath(workspaceRoot: string): string {
  return path.join(assistantWorkspacePrivateRoot(workspaceRoot), "documents", "metadata.jsonl");
}

function assistantWorkspaceEnv(workspaceRoot: string): Record<string, string> {
  const privateRoot = assistantWorkspacePrivateRoot(workspaceRoot);
  return {
    ASSISTANT_WORKSPACE: workspaceRoot,
    ASSISTANT_PRIVATE_DIR: privateRoot,
    BRAIN_PRIVATE_DIR: privateRoot,
  };
}

function brainRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function assistantLogicPackageRoot(): string {
  return path.join(brainRepoRoot(), "packages", "assistant-logic");
}

function assistantScriptPath(assistantLogicRoot: string, script: string): string {
  return assistantNativeScriptPath(assistantLogicRoot, script);
}

function assistantNativeScriptPath(assistantLogicRoot: string, script: string): string {
  const scriptName = normalizeAssistantScriptName(script);
  return path.join(assistantLogicRoot, "dist", "cli", scriptName);
}

function assistantVendoredScriptPath(assistantLogicRoot: string, script: string): string {
  const scriptName = normalizeAssistantScriptName(script);
  return path.join(assistantLogicRoot, "scripts", scriptName);
}

function normalizeAssistantScriptName(script: string): string {
  const base = script.startsWith("scripts/") ? script.slice("scripts/".length) : script;
  const withExtension = /\.(?:c?js|mjs|sh)$/u.test(base) ? base : `${base}.js`;
  if (withExtension.includes("..") || path.isAbsolute(withExtension) || withExtension.includes(path.sep)) {
    throw new Error(`unsupported assistant script path: ${script}`);
  }
  return withExtension;
}

type AssistantCommandKind = "native" | "vendored";

type ResolvedAssistantCommand =
  | { ok: true; kind: AssistantCommandKind; script: string; path: string; cwd: string }
  | { ok: false; result: CliResult };

async function resolveAssistantScript(assistantLogicRoot: string, script: string): Promise<ResolvedAssistantCommand> {
  try {
    const normalized = normalizeAssistantScriptName(script);
    const nativePath = assistantNativeScriptPath(assistantLogicRoot, normalized);
    const nativeMetadata = await fileMetadata(nativePath);
    if (nativeMetadata.present) {
      return { ok: true, kind: "native", script: normalized, path: nativePath, cwd: assistantLogicRoot };
    }
    const vendoredPath = assistantVendoredScriptPath(assistantLogicRoot, normalized);
    const vendoredMetadata = await fileMetadata(vendoredPath);
    if (vendoredMetadata.present) {
      return { ok: true, kind: "vendored", script: normalized, path: vendoredPath, cwd: path.join(assistantLogicRoot, "scripts") };
    }
    return {
      ok: false,
      result: {
        ok: false,
        summary: "assistant-logic command is missing",
        details: {
          script,
          normalizedScript: normalized,
          assistantLogicRoot,
          nativePath,
          nativeMetadata,
          vendoredPath,
          vendoredMetadata,
          sideEffects: "none",
        },
      },
    };
  } catch (error) {
    return { ok: false, result: { ok: false, summary: "assistant-logic CLI command name is invalid", details: { script, error: errorMessage(error), sideEffects: "none" } } };
  }
}

async function assistantCommandScriptMetadata(assistantLogicRoot: string, scripts: readonly string[]) {
  const uniqueScripts = Array.from(new Set(scripts.map((script) => normalizeAssistantScriptName(script)))).sort();
  return Promise.all(uniqueScripts.map(async (script) => {
    const nativePath = assistantNativeScriptPath(assistantLogicRoot, script);
    const vendoredPath = assistantVendoredScriptPath(assistantLogicRoot, script);
    const nativeMetadata = await fileMetadata(nativePath);
    const vendoredMetadata = await fileMetadata(vendoredPath);
    const kind: AssistantCommandKind | "missing" = nativeMetadata.present ? "native" : vendoredMetadata.present ? "vendored" : "missing";
    const activePath = kind === "native" ? nativePath : kind === "vendored" ? vendoredPath : nativePath;
    return {
      script,
      present: kind !== "missing",
      kind,
      path: activePath,
      metadata: kind === "vendored" ? vendoredMetadata : nativeMetadata,
      native: { path: nativePath, metadata: nativeMetadata },
      vendored: { path: vendoredPath, metadata: vendoredMetadata },
    };
  }));
}

function assistantWorkspaceCommandCatalog(workspaceRoot: string, _assistantLogicRoot: string) {
  const runner = (script: string, args = "<args>") => `pnpm run brainctl workspace run --path ${shellQuote(workspaceRoot)} ${script}${args ? ` -- ${args}` : ""}`;
  return [
    {
      area: "todos",
      integration: "native-json-store",
      state: path.join(workspaceRoot, "data", "todos.json"),
      scripts: ["todo-add.js", "todo-list.js", "todo-delete.js"],
      examples: [
        runner("todo-add.js", '--title "Buy coffee"'),
        runner("todo-list.js", ""),
      ],
    },
    {
      area: "projects",
      integration: "native-json-store",
      state: path.join(workspaceRoot, "data", "projects.json"),
      scripts: ["project-add.js", "project-list.js", "project-view.js", "project-update.js", "project-note.js", "project-notes-list.js", "project-resource.js", "project-task.js", "project-delete.js"],
      examples: [
        runner("project-add.js", '--name "Tax Strategy 2026"'),
        runner("project-list.js", ""),
        runner("project-notes-list.js", "--current"),
      ],
    },
    {
      area: "crm",
      integration: "native-json-store",
      state: path.join(workspaceRoot, "data", "crm.json"),
      scripts: ["crm-add-person.js", "crm-add-notes.js", "crm-list-people.js", "crm-view.js", "crm-add-business.js", "crm-list-businesses.js", "crm-log.js", "crm-history.js", "crm-follow-ups.js", "crm-resolve.js", "crm-link.js", "crm-unlink.js", "crm-update-person.js", "crm-update-business.js", "crm-missing-fields.js", "crm-pipeline.js", "crm-stale.js", "crm-delete.js"],
      examples: [
        runner("crm-add-person.js", '--name "Jane Smith"'),
        runner("crm-list-people.js", ""),
      ],
    },
    {
      area: "reminders",
      integration: "native-json-store",
      state: path.join(workspaceRoot, "data", "reminders.json"),
      scripts: ["reminder-add.js", "reminder-list.js", "reminder-update.js", "reminder-delete.js", "reminder-check.js"],
      examples: [
        runner("reminder-add.js", '--title "Weekly review" --weekly friday --time "17:00"'),
        runner("reminder-list.js", ""),
      ],
    },
    {
      area: "file-save",
      integration: "native-private-files",
      state: assistantWorkspaceDocumentMetadataPath(workspaceRoot),
      scripts: ["file-save.js", "file-list.js"],
      examples: [
        runner("file-save.js", '--source "/path/to/file.pdf" --title "saved document"'),
        runner("file-list.js", ""),
      ],
    },
    {
      area: "betting",
      integration: "vendored-assistant-agent-logic",
      state: path.join(workspaceRoot, "data", "bets.json"),
      scripts: ["bet-add.js", "bet-list.js", "bet-result.js", "bet-summary.js", "bet-delete.js"],
      examples: [
        runner("bet-add.js", '--date 2026-05-26 --market moneyline --side home --home "Home" --away "Away" --odds -110 --units 1'),
        runner("bet-summary.js", ""),
      ],
    },
    {
      area: "gmail-email",
      integration: "vendored-live-composio-gmail",
      state: [path.join(workspaceRoot, "data", "seen-emails.json"), path.join(workspaceRoot, "data", "dismissed-emails.json"), path.join(workspaceRoot, "data", "urgent-emails.json")],
      privateConfig: [path.join(workspaceRoot, ".env"), path.join(workspaceRoot, "composio.yaml")],
      scripts: ["gmail-recent.js", "gmail-search.js", "gmail-send.js", "gmail-actionable.js", "email-actionable.js", "urgent-email.js", "dismiss-email.js"],
      examples: [
        runner("gmail-recent.js", "--limit 10"),
        runner("gmail-search.js", '--query "from:example@example.com"'),
      ],
    },
    {
      area: "google-calendar",
      integration: "vendored-live-composio-google-calendar",
      state: [path.join(workspaceRoot, "data", "calendar-allowlist.json"), path.join(workspaceRoot, "data", "seen-invites.json"), path.join(workspaceRoot, "data", "declined-invites-log.json"), path.join(workspaceRoot, "data", "flagged-events.json")],
      privateConfig: [path.join(workspaceRoot, ".env"), path.join(workspaceRoot, "composio.yaml")],
      scripts: ["calendar-events.js", "calendar-search.js", "calendar-create-event.js", "update-calendar-event.js", "calendar-add-guest.js", "calendar-check-invites.js", "calendar-allowlist.js", "flag-event.js", "fix-football-events.js"],
      examples: [
        runner("calendar-events.js", "--days 7"),
        runner("calendar-allowlist.js", "--list"),
      ],
    },
    {
      area: "composio",
      integration: "vendored-live-composio-connection",
      state: path.join(workspaceRoot, "composio.yaml"),
      privateConfig: [path.join(workspaceRoot, ".env"), path.join(workspaceRoot, "composio.yaml")],
      scripts: ["composio-connect.js"],
      examples: [
        runner("composio-connect.js", "--list-configs --app gmail"),
        runner("composio-connect.js", "--list"),
      ],
    },
    {
      area: "protonmail",
      integration: "vendored-live-protonmail-bridge",
      state: [path.join(workspaceRoot, "data", "protonmail-drafts.json"), path.join(workspaceRoot, "data", "protonmail-audit.jsonl")],
      privateConfig: [path.join(workspaceRoot, "protonmail.yaml")],
      scripts: ["protonmail-recent.js", "protonmail-search.js", "protonmail-send.js", "protonmail-actionable.js"],
      examples: [
        runner("protonmail-send.js", '--list-drafts'),
        runner("protonmail-recent.js", "--limit 10"),
      ],
    },
    {
      area: "finance-mercury-plaid",
      integration: "vendored-live-finance",
      state: [path.join(workspaceRoot, "data"), path.join(workspaceRoot, ".env")],
      privateConfig: [path.join(workspaceRoot, ".env")],
      scripts: ["finance-source.js", "finance-accounts.js", "finance-balances.js", "finance-transactions.js", "mercury-accounts.js", "mercury-balances.js", "mercury-transactions.js", "plaid-link.js"],
      examples: [
        runner("finance-accounts.js", ""),
        runner("finance-transactions.js", "--limit 25"),
      ],
    },
    {
      area: "whoop",
      integration: "vendored-live-whoop",
      state: path.join(workspaceRoot, ".env"),
      privateConfig: [path.join(workspaceRoot, ".env")],
      scripts: ["whoop-connect.js", "whoop-profile.js", "whoop-cycle.js", "whoop-recovery.js", "whoop-sleep.js", "whoop-workout.js"],
      examples: [
        runner("whoop-profile.js", ""),
        runner("whoop-recovery.js", "--limit 7"),
      ],
    },
    {
      area: "telegram-user-client-and-messaging",
      integration: "vendored-live-telegram-mtproto",
      state: [path.join(workspaceRoot, "data", "dismissed-messages.json"), path.join(workspaceRoot, "data", "urgent-messages.json")],
      privateConfig: [path.join(workspaceRoot, "messaging.yaml")],
      scripts: ["telegram-login.js", "telegram-history.js", "telegram-unread.js", "messages-unread.js", "urgent-message.js", "dismiss-message.js"],
      examples: [
        runner("telegram-login.js", ""),
        runner("messages-unread.js", "--telegram 20"),
      ],
    },
    {
      area: "utility-live-support",
      integration: "vendored-assistant-agent-logic-utilities",
      state: [path.join(workspaceRoot, "tasks"), path.join(workspaceRoot, "data")],
      scripts: ["dictionary-deploy.js", "transcribe-voice.js", "register-loops.sh", "dispatch-claude-sdk.mjs", "validate-repo.js"],
      examples: [
        runner("validate-repo.js", ""),
        runner("register-loops.sh", ""),
      ],
    },
  ];
}

function renderInstructionsReadme(): string {
  return [
    "# Workspace Instruction Overlays",
    "",
    "These files are the workspace-owned layer for user-specific preferences.",
    "They are additive overlays on top of Brain's in-repo `packages/assistant-logic/config/skills/*.md` and `packages/assistant-logic/config/prompts/*.md` resources.",
    "",
    "Do not use overlays to redefine commands, storage paths, JSON formats, approval requirements, or safety rules.",
    "",
    "Brain ships native TypeScript commands for todo, projects, CRM, reminders, and file-save.",
    "Brain also vendors the assistant-agent-logic live-integration command set for Composio/Gmail/Calendar, ProtonMail, finance/Mercury/Plaid, Whoop, Telegram user-client messaging, betting, dictionary, generated web pages, and loop utilities.",
    "Keep personal account IDs, OAuth/API tokens, Telegram sessions, ProtonMail Bridge credentials, and finance/Whoop secrets in this private workspace, not in the Brain repo.",
    "See `docs/assistant-logic-integration-audit.md` and `docs/migration.md` for the integrated/status table and private data migration guidance.",
    "",
  ].join("\n");
}

function renderSkillOverlayPlaceholder(skill: string): string {
  return [
    `# Workspace Overlay: ${titleCase(skill)}`,
    "",
    "Add only user-specific preferences here.",
    `This file is layered on top of Brain's in-repo \`packages/assistant-logic/config/skills/${skill === "repo-registry" ? "repo-registry/SKILL" : skill}.md\` resource.`,
    "",
    "Do not restate or override shared commands, storage paths, JSON formats, approval requirements, or safety rules.",
    "",
  ].join("\n");
}

function renderPromptOverlayPlaceholder(prompt: string): string {
  return [
    `# Workspace Overlay: ${titleCase(prompt)}`,
    "",
    "Add only user-specific prompt preferences here.",
    `This file is layered on top of Brain's in-repo \`packages/assistant-logic/config/prompts/${prompt}.md\` resource.`,
    "",
  ].join("\n");
}

function renderTasksReadme(workspaceRoot: string): string {
  return [
    "# Scheduled Tasks",
    "",
    "Scheduled tasks should target the Brain checkout and this workspace explicitly.",
    "",
    "Preferred command shape:",
    "",
    "```bash",
    `cd /abs/path/to/brain && pnpm run brainctl workspace run --path ${shellQuote(workspaceRoot)} reminder-check.js`,
    "```",
    "",
    "Do not install task commands that omit the explicit workspace path.",
    "",
  ].join("\n");
}

function renderRepoRegistryReadme(): string {
  return [
    "# Repo Registry State",
    "",
    "This directory may hold user-specific repo-registry controller state compatible with Brain's assistant-logic resources.",
    "Back up selected state files only; do not commit private hosts, paths, credentials, or runtime caches to a public source checkout.",
    "",
  ].join("\n");
}

function titleCase(value: string): string {
  return value.split(/[-_]/g).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function repoRegistryBackupIncludes(): string[] {
  return [
    ".claude/repo-registry/index.yaml",
    ".claude/repo-registry/config.yaml",
    ".claude/repo-registry/repos/**/state.yaml",
    ".claude/repo-registry/repos/**/guidance.md",
    ".claude/repo-registry/repos/**/guidance.json",
    ".claude/repo-registry/repos/**/notes.md",
  ];
}

function setupWebPublishingStatus(workspace: WorkspaceConfig | undefined) {
  const config = workspace?.webPublishing;
  return {
    enabled: config?.enabled ?? false,
    mode: config?.mode ?? "disabled",
    domain: config?.domain,
    baseUrl: config?.baseUrl,
    publicBaseUrl: config?.publicBaseUrl,
    publishRoot: config?.publishRoot,
    manifestPath: config?.manifestPath,
    reverseProxy: config?.reverseProxy,
    dns: dnsStatusForWeb(config?.domain, config?.baseUrl ?? config?.publicBaseUrl, config?.mode),
  };
}

async function setupComposioStatus(workspace: WorkspaceConfig | undefined, overrides: { apiKeyRef?: string; connectedAccountRef?: string } = {}) {
  const config = workspace?.integrations?.composio;
  const apiKeyRef = overrides.apiKeyRef ?? config?.apiKeyRef;
  const connectedAccountRef = overrides.connectedAccountRef ?? config?.connectedAccountRef;
  const googleCalendar = config?.dataSources?.googleCalendar;
  const chat = config?.dataSources?.chat;
  const refs: ConfigRef[] = [
    ...maybeRef(apiKeyRef, "integrations.composio.apiKeyRef", workspace ? "workspace" : "cli"),
    ...maybeRef(connectedAccountRef, "integrations.composio.connectedAccountRef", workspace ? "workspace" : "cli"),
    ...maybeRef(config?.metadataRef, "integrations.composio.metadataRef"),
    ...maybeRef(googleCalendar?.connectedAccountRef, "integrations.composio.dataSources.googleCalendar.connectedAccountRef"),
    ...maybeRef(googleCalendar?.metadataRef, "integrations.composio.dataSources.googleCalendar.metadataRef"),
    ...(googleCalendar?.requiredEnvRefs ?? []).map((ref) => ({ workspaceId: "workspace", ref: asSecretRef(ref), source: "integrations.composio.dataSources.googleCalendar.requiredEnvRefs" })),
    ...maybeRef(chat?.connectedAccountRef, "integrations.composio.dataSources.chat.connectedAccountRef"),
    ...maybeRef(chat?.metadataRef, "integrations.composio.dataSources.chat.metadataRef"),
    ...(chat?.requiredEnvRefs ?? []).map((ref) => ({ workspaceId: "workspace", ref: asSecretRef(ref), source: "integrations.composio.dataSources.chat.requiredEnvRefs" })),
  ];
  const refMetadata = await secretRefMetadata(refs);
  const missing = [];
  const enabled = config?.enabled ?? Boolean(overrides.apiKeyRef || overrides.connectedAccountRef);
  if (enabled && !apiKeyRef) missing.push("Composio API key ref");
  if (enabled && !connectedAccountRef) missing.push("Composio connected account metadata ref");
  if (googleCalendar?.enabled && !(googleCalendar.connectedAccountRef ?? connectedAccountRef)) missing.push("Google Calendar connected account ref");
  if (chat?.enabled && !(chat.connectedAccountRef ?? connectedAccountRef)) missing.push("chat connected account ref");
  return {
    enabled,
    apiKeyRefPresent: Boolean(apiKeyRef),
    connectedAccountRefPresent: Boolean(connectedAccountRef),
    dataSources: {
      googleCalendar: { enabled: googleCalendar?.enabled ?? false, connectedAccountRefPresent: Boolean(googleCalendar?.connectedAccountRef ?? connectedAccountRef), metadataRefPresent: Boolean(googleCalendar?.metadataRef) },
      chat: { enabled: chat?.enabled ?? false, connectedAccountRefPresent: Boolean(chat?.connectedAccountRef ?? connectedAccountRef), metadataRefPresent: Boolean(chat?.metadataRef) },
    },
    refs: refMetadata,
    missing,
  };
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
  const setupStateUpdate = options.runSafe && ok
    ? await updateSetupProgressFromLiveValidation(config.config.workspaces[options.workspace]?.workspacePath ?? defaultWorkspaceRoot(options.workspace), options, safeResults)
    : undefined;
  const wizard = liveValidationWizard(options, plan, safeResults, ok, setupStateUpdate);
  return {
    ok,
    summary: wizard.summary,
    details: {
      completedChecks: wizard.completedChecks,
      notLiveYet: wizard.notLiveYet,
      nextStep: wizard.nextStep,
      guidedSequence: wizard.guidedSequence,
      setupStateUpdate,
      plan,
      results: safeResults,
      sideEffects: options.runSafe ? "safe local checks and private setup progress metadata update when workspace state exists" : "none",
    },
  };
}

interface SafeValidationResult {
  id: string;
  ok: boolean;
  summary: string;
  details?: unknown;
}

async function runSafeValidationChecks(
  options: { config: string; workspace: string; telegramTokenEnv?: string; telegramTokenFile?: string; codexTransport: string; allowLive?: boolean },
  checks: Array<{ id: string }>,
): Promise<SafeValidationResult[]> {
  const results: SafeValidationResult[] = [];
  for (const check of checks) {
    if (check.id === "config") results.push({ id: check.id, ...await configValidateCommand(options.config) });
    else if (check.id === "secrets") results.push({ id: check.id, ...await secretsCheckCommand(options.config) });
    else if (check.id === "runtime-smoke") results.push({ id: check.id, ...await runtimeSmokeCommand({ config: options.config, workspace: options.workspace, text: "ping" }) });
    else if (check.id === "codex-provider") {
      const transport = options.allowLive ? options.codexTransport : "stub";
      results.push({ id: check.id, ...await providerCheckCommand("codex", { config: options.config, workspace: options.workspace, transport }) });
    } else if (check.id === "telegram-entrypoint") {
      results.push({ id: check.id, ...await entrypointCheckCommand("telegram", { workspace: options.workspace, tokenEnv: options.telegramTokenEnv, tokenFile: options.telegramTokenFile }) });
    }
  }
  return results;
}

function liveValidationWizard(
  options: { config: string; workspace: string; telegramTokenEnv?: string; telegramTokenFile?: string; codexTransport: string; allowLive?: boolean; runSafe?: boolean },
  plan: ReturnType<typeof createGuardedLiveValidationPlan>,
  safeResults: SafeValidationResult[],
  ok: boolean,
  setupStateUpdate?: Awaited<ReturnType<typeof updateSetupProgressFromLiveValidation>>,
) {
  const plannedChecks = plan.checks.filter((check) => check.mode === "plan");
  const completedChecks = options.runSafe
    ? safeResults
        .filter((result) => result.ok !== false)
        .map((result) => friendlyLiveCheckName(result.id))
    : [
        "Validation plan rendered; safe checks have not been executed yet.",
        "Run again with --run-safe to execute local config, secret-metadata, runtime, Codex stub, and Telegram adapter checks.",
      ];
  const notLiveYet = [
    "Brain has not started Telegram polling or webhooks.",
    "No provider user task, deployment, systemd install, service restart, or live chat message was started by this validation.",
    "Secret refs were checked by metadata only; token values must stay out of the repository, chat, and logs.",
    ...plannedChecks.map((check) => `${friendlyLiveCheckName(check.id).replace(/\.$/, "")} is still planned, not run: ${check.reason}`),
  ];
  const guidedSequence = [
    {
      step: "telegram-connection",
      title: "Connect Telegram.",
      prompt: "Create or choose the Telegram bot and store its token in a private secret ref.",
      botFatherSteps: botFatherSteps(),
      privateStorage: telegramTokenStorageGuidance(options),
      requiresConfirmation: "Starting Telegram polling/webhooks happens later, after Codex auth and service readiness are confirmed.",
    },
    {
      step: "private-data-repo",
      title: "Connect private data and backups.",
      prompt: "Choose an existing private data/backup repo to pull, or initialize one in the private workspace.",
      actions: [
        "Keep private workspace data outside the source checkout.",
        "Use private-git by default when a remote is available; otherwise initialize the local private repo and add a remote later.",
        "Keep secret values excluded from backups by default.",
      ],
      requiresConfirmation: "Pulling from or pushing to a private backup remote requires an explicit private remote target.",
    },
    {
      step: "composio-accounts",
      title: "Connect Composio accounts.",
      prompt: "Connect Google Calendar/chat accounts only if this workspace should use them.",
      actions: [
        "Store Composio API keys and connected-account metadata as private secret refs.",
        "Skip this step for a minimal Telegram + Codex setup and return later.",
      ],
    },
    {
      step: "essential-runtime-choices",
      title: "Confirm essential runtime choices.",
      prompt: "Confirm workspace path, provider, primary entrypoint, and service target before any live start.",
      actions: [
        "Validate the private runtime config and secret-reference metadata.",
        "Keep implementation details such as derived state/log paths in verbose/details output.",
      ],
    },
    {
      step: "configure-verify-codex-auth",
      title: "Verify Codex auth before service start.",
      actions: [
        "Confirm the selected Codex transport and auth path for this machine or server.",
        `Generate a guarded helper with: pnpm run brainctl setup codex-auth-script --config ${shellArg(options.config)} --workspace ${shellArg(options.workspace)} --repo <repo-root> --service-user <brain-service-user>`,
        "Run the returned command as the same OS user that will run Brain; for systemd this is usually the non-root service user.",
        "If a credential is needed, store it only in a private server env file or secret store, then verify by metadata/health check without printing the value.",
        `Run a guarded provider check for the chosen transport before accepting live user traffic.`,
      ],
      requiresConfirmation: "Writing credentials requires an explicit private target; live provider checks require explicit --allow-live.",
    },
    {
      step: "install-start-service",
      title: "Install and start the Brain service.",
      actions: [
        `Review the service plan with: pnpm run brainctl operations systemd --config ${shellArg(options.config)} --workspace ${shellArg(options.workspace)}`,
        "Install/enable systemd only after the user confirms the unit path, service user, working directory, and private env file.",
        "Start the service only after Telegram token storage, private data setup, and Codex auth are verified.",
      ],
      requiresConfirmation: "Privileged systemd installation, enablement, and service start require explicit user confirmation.",
    },
    {
      step: "first-user-pairing",
      title: "Optional follow-up: first-user pairing.",
      actions: [
        "After the service is running with the private Telegram token, send the bot its first Telegram message.",
        "That first user/chat becomes paired admin state by default and is persisted only in private Brain state.",
        "If a token was ever pasted into a repo, chat, or log, revoke it in @BotFather with /revoke before starting live polling.",
      ],
    },
    {
      step: "optional-follow-ups",
      title: "Optional follow-ups.",
      actions: [
        "Enable OpenAI voice/audio transcription only after the base Telegram path is working.",
        "Enable web publishing only when a publish root/base URL is chosen.",
        "Tune backup strategy, include/exclude policy, and remotes after the initial private repo is initialized or pulled.",
      ],
    },
  ];
  const nextStepId = normalizeGuidedSetupStepId(setupStateUpdate?.state?.nextRecommendedStep);
  const nextStep = guidedSequence.find((step) => step.step === nextStepId) ?? guidedSequence[0];
  const nextStepTitle = nextStep.title.replace(/\.$/, "");
  const summary = ok
    ? options.runSafe
      ? setupStateUpdate?.state
        ? `Pre-live checks passed. Next: ${nextStepTitle}.`
        : "Pre-live checks passed. Connect Telegram/private data/Composio, verify Codex auth, then start the service."
      : "Pre-live validation plan ready. Run safe checks, then connect Telegram/private data/Composio, verify Codex auth, and start the service."
    : "Pre-live validation needs attention before Telegram setup, private data setup, Codex auth, or service start.";
  return {
    summary,
    completedChecks,
    notLiveYet,
    nextStep,
    guidedSequence,
  };
}

function normalizeGuidedSetupStepId(step: string | undefined): string | undefined {
  if (step === "configure-telegram-token") return "telegram-connection";
  if (step === "workspace-scaffold" || step === "runtime-config") return "essential-runtime-choices";
  return step;
}

function friendlyLiveCheckName(id: string): string {
  switch (id) {
    case "config": return "Runtime config check completed.";
    case "secrets": return "Secret-reference metadata check completed with values redacted.";
    case "runtime-smoke": return "No-network runtime smoke check completed.";
    case "codex-provider": return "Codex provider health check completed.";
    case "telegram-entrypoint": return "Telegram adapter check completed without polling or webhook start.";
    default: return `${id} check completed.`;
  }
}

function botFatherSteps(): string[] {
  return [
    "Open Telegram and message @BotFather.",
    "Send /newbot.",
    "Choose a bot display name.",
    "Choose a unique username ending in bot, such as my_brain_bot.",
    "Store the returned token only through a one-use private temp script that prompts for hidden input and writes to Brain's private server secret file or configured env/secret store.",
  ];
}

function telegramTokenStorageGuidance(options: { telegramTokenEnv?: string; telegramTokenFile?: string }): string[] {
  const target = options.telegramTokenEnv
    ? `env:${options.telegramTokenEnv}`
    : options.telegramTokenFile
      ? `file:${options.telegramTokenFile}`
      : "a private env var such as TELEGRAM_BOT_TOKEN or a private file referenced by --telegram-token-file";
  return [
    `Use ${target}; never paste the token into the repo, setup chat, shell history, command output, or logs.`,
    "Prefer generating the secret-entry helper with: pnpm run brainctl setup telegram-token-script --path <workspace>; then run the returned bash /.../store-brain-telegram-token.sh command.",
    "If you provide a copy-paste command for secret entry, make it run that generated private temporary script, which is syntax-checked and reads the secret with hidden input.",
    "The temporary script directory must be outside version control, the script must not contain the secret value, and the script should delete itself after a successful write.",
    "Keep the secret file owner-readable only where practical and outside the source checkout.",
    "Re-run validation with the token ref to check only presence/metadata before starting live polling.",
  ];
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function supervisorPaths(workspace: string, options: { state?: string; artifacts?: string; log?: string; workspacePath?: string }): { stateRoot: string; artifactRoot: string; logPath: string } {
  const base = path.resolve(options.workspacePath ?? defaultWorkspaceRoot(workspace));
  const stateRoot = path.resolve(options.state ?? path.join(base, "state"));
  return {
    stateRoot,
    artifactRoot: path.resolve(options.artifacts ?? path.join(base, "artifacts", "subagents")),
    logPath: path.resolve(options.log ?? path.join(base, "logs", "runtime.jsonl")),
  };
}

function resolveSupervisorRuntime(config: BrainConfig, options: Pick<SupervisorRunCommandOptions, "workspace" | "config" | "provider" | "entrypoint" | "fake" | "fakeText">): ResolvedSupervisorRuntimeResult {
  const workspace = config.workspaces[options.workspace];
  if (!workspace) return { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(config.workspaces) } };
  const primaryEntrypoint = workspace.enabledEntrypoints[workspace.primaryEntrypointId];
  if (!primaryEntrypoint) return { ok: false, summary: `primary entrypoint not found: ${workspace.primaryEntrypointId}`, details: { workspace: options.workspace } };

  if (options.fake && ((options.provider && options.provider.toLowerCase() !== "fake") || (options.entrypoint && options.entrypoint.toLowerCase() !== "fake"))) {
    return { ok: false, summary: "--fake cannot be combined with non-fake --provider or --entrypoint", details: { provider: options.provider, entrypoint: options.entrypoint } };
  }

  let providerKind: string;
  let entrypointKind: string;
  try {
    providerKind = normalizeProviderKind(options.fake ? "fake" : options.provider ?? workspace.provider ?? "fake");
    entrypointKind = normalizeEntrypointKind(options.fake ? "fake" : options.entrypoint ?? primaryEntrypoint.kind ?? "fake");
  } catch (error) {
    return { ok: false, summary: "runtime selection invalid", details: { error: errorMessage(error), provider: options.provider ?? workspace.provider, entrypoint: options.entrypoint ?? primaryEntrypoint.kind } };
  }
  if (options.fakeText !== undefined && entrypointKind !== "fake") {
    return { ok: false, summary: "--fake-text requires --fake or --entrypoint fake", details: { entrypoint: entrypointKind, source: options.entrypoint ? "cli" : "config" } };
  }

  return {
    ok: true,
    summary: "runtime selection resolved",
    runtime: {
      workspaceId: options.workspace,
      workspace,
      primaryEntrypointId: workspace.primaryEntrypointId,
      primaryEntrypoint,
      providerKind,
      providerSource: options.fake ? "fake-flag" : options.provider ? "cli" : workspace.provider ? "config" : "fallback",
      entrypointKind,
      entrypointSource: options.fake ? "fake-flag" : options.entrypoint ? "cli" : primaryEntrypoint.kind ? "config" : "fallback",
      configPath: path.resolve(options.config),
    },
  };
}

function normalizeProviderKind(provider: string): string {
  const normalized = provider.toLowerCase();
  if (normalized === "claude") return "claude-code";
  if (["fake", "echo", "codex", "claude-code"].includes(normalized)) return normalized;
  throw new Error(`unknown provider: ${provider}`);
}

function normalizeEntrypointKind(entrypoint: string): string {
  const normalized = entrypoint.toLowerCase();
  if (["fake", "telegram"].includes(normalized)) return normalized;
  throw new Error(`unknown entrypoint: ${entrypoint}`);
}

function createCliProvider(selection: ResolvedSupervisorRuntime, options: SupervisorRunCommandOptions): ProviderAdapter {
  const provider = selection.providerKind.toLowerCase();
  if (provider === "fake") return new FakeProviderAdapter();
  if (provider === "echo") return new EchoProviderAdapter();
  if (provider === "codex") return createCodexProvider({
    transport: (options.transport as CodexTransportKind | undefined) ?? "stub",
    binary: options.binary,
    cwd: options.cwd ?? selection.workspace.workspacePath ?? process.cwd(),
    tmpDir: path.join(selection.workspace.workspacePath, "tmp"),
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    appServerUrl: options.appServerUrl,
    transcriptionApiKeyRef: selection.workspace.transcription?.apiKeyRef,
  });
  if (provider === "claude-code" || provider === "claude") return createClaudeCodeProvider({ transport: (options.transport as ClaudeCodeTransportKind | undefined) ?? "stub" });
  throw new Error(`unknown provider: ${selection.providerKind}`);
}

function createCliSubagentExecutor(selection: ResolvedSupervisorRuntime, provider: ProviderAdapter): SubagentExecutor {
  if (selection.providerKind === "fake") {
    return new StaticSubagentExecutor({ id: "brainctl-static", outputText: "Static subagent completed." });
  }
  return new ProviderSubagentExecutor({
    provider,
    workspaceId: selection.workspaceId,
    entrypointId: selection.primaryEntrypointId,
    entrypointDisplayName: selection.primaryEntrypoint.displayName ?? selection.primaryEntrypointId,
    sessionMetadata: {
      source: "brainctl-supervisor",
      primaryEntrypointId: selection.primaryEntrypointId,
    },
  });
}

function subagentExecutorIdFor(selection: ResolvedSupervisorRuntime): string {
  return selection.providerKind === "fake" ? "brainctl-static" : `provider:${selection.providerKind}`;
}

async function createCliEntrypoint(selection: ResolvedSupervisorRuntime, options: SupervisorRunCommandOptions, paths: { stateRoot: string; artifactRoot: string }): Promise<FakeEntrypointAdapter | TelegramEntrypointAdapter> {
  const kind = selection.entrypointKind;
  if (kind === "fake") {
    const entrypoint = new FakeEntrypointAdapter({ workspaceId: selection.workspaceId, entrypointId: selection.primaryEntrypointId, channelKind: "fake", displayName: "Brainctl fake entrypoint" });
    if (options.fakeText !== undefined) entrypoint.enqueueText(options.fakeText, { conversationId: "brainctl-run" });
    if (options.once) entrypoint.close();
    return entrypoint;
  }
  if (kind !== "telegram") throw new Error(`unknown entrypoint: ${selection.entrypointKind}`);
  const downloadDir = path.resolve(options.telegramDownloadDir ?? path.join(paths.stateRoot, "..", "artifacts", "telegram-downloads"));
  const transcription = telegramTranscriptionRuntime(selection, options);
  const needsTelegramDownloads = Boolean(options.telegramDownloads || options.telegramDownloadDir || transcription.enabled);
  // Keep codex-chat Telegram voice/audio user-visible behavior at the adapter
  // edge even when Brain's runtime/provider remains entrypoint-generic. In
  // particular, a disabled/unavailable voice transcriber should reply at
  // Telegram ingress and not become a generic provider event.
  const needsTelegramAttachmentParity = kind === "telegram";
  const apiClient = options.telegramPolling
    ? await TelegramBotApiClient.fromTokenRef({ tokenEnv: options.telegramTokenEnv, tokenFile: options.telegramTokenFile, required: true, downloadDir: needsTelegramDownloads ? downloadDir : undefined, downloadMaxBytes: TELEGRAM_DOWNLOAD_MAX_BYTES })
    : undefined;
  const pairingState = options.telegramPairingState ? path.resolve(options.telegramPairingState) : path.join(paths.stateRoot, "telegram-pairing");
  const transcriber = options.telegramTranscriptionCommand
    ? commandTranscriber(options.telegramTranscriptionCommand)
    : transcription.provider === "openai" && transcription.apiKeyRef
      ? new OpenAITelegramAttachmentTranscriber({
          apiKeyRef: transcription.apiKeyRef,
          model: transcription.model ?? "gpt-4o-mini-transcribe",
          language: transcription.language,
          promptPath: transcription.promptPath,
          rootDir: selection.workspace.workspacePath,
        })
      : undefined;
  return new TelegramEntrypointAdapter({
    workspaceId: selection.workspaceId,
    entrypointId: selection.primaryEntrypointId,
    displayName: selection.primaryEntrypoint.displayName,
    apiClient,
    allowedSendRoots: telegramAllowedSendRoots(selection, paths, downloadDir),
    polling: options.telegramPolling ? {
      enabled: true,
      maxPolls: options.telegramMaxPolls,
      stateStore: new FileTelegramPollingStateStore(path.resolve(options.pollingState ?? path.join(paths.stateRoot, "telegram-offset.json"))),
    } : undefined,
    pairing: {
      enabled: true,
      mode: options.telegramPairing ? "code" : "first-user",
      store: new FileTelegramPairingStore(pairingState),
    },
    attachmentHandling: needsTelegramAttachmentParity || needsTelegramDownloads || transcriber ? {
      download: needsTelegramDownloads,
      transcriber,
      transcribeKinds: transcription.attachmentKinds,
      transcriptionFailureMode: "codex-chat",
    } : undefined,
  });
}

function telegramAllowedSendRoots(selection: ResolvedSupervisorRuntime, paths: { stateRoot: string; artifactRoot: string }, downloadDir: string): string[] {
  const workspaceRoot = path.resolve(selection.workspace.workspacePath);
  const artifactRoot = path.resolve(paths.artifactRoot);
  const workspaceArtifactsRoot = path.resolve(workspaceRoot, "artifacts");
  const privateDocumentFiles = path.resolve(workspaceRoot, "private", "documents", "files");
  const telegramDownloads = path.resolve(downloadDir);
  return Array.from(new Set([artifactRoot, workspaceArtifactsRoot, privateDocumentFiles, telegramDownloads]));
}

function commandTranscriber(command: string): TelegramAttachmentTranscriber {
  return {
    async transcribe(input) {
      const result = spawnSync(command, [input.path], { encoding: "utf8", timeout: 120_000 });
      if (result.error) throw result.error;
      if ((result.status ?? 0) !== 0) throw new Error(result.stderr || `${command} exited ${result.status}`);
      return { text: (result.stdout ?? "").trim() };
    },
  };
}

type TelegramTranscriptionRuntime = {
  enabled: boolean;
  provider?: "openai" | "command";
  source: "config" | "cli" | "disabled";
  apiKeyRefPresent: boolean;
  apiKeyRef?: string;
  model?: string;
  language?: string;
  promptPath?: string;
  promptPathPresent: boolean;
  attachmentKinds: Array<"voice" | "audio" | "video">;
  scopedToEntrypoint: boolean;
};

function telegramTranscriptionRuntime(selection: ResolvedSupervisorRuntime, options: Pick<SupervisorRunCommandOptions, "telegramTranscriptionCommand">): TelegramTranscriptionRuntime {
  const config = selection.workspace.transcription;
  const configured = transcriptionAppliesToEntrypoint(config, selection.primaryEntrypointId);
  if (options.telegramTranscriptionCommand) {
    return {
      enabled: true,
      provider: "command",
      source: "cli",
      apiKeyRefPresent: false,
      attachmentKinds: [...(config?.scope?.attachmentKinds ?? ["voice", "audio"])],
      language: config?.language,
      promptPath: config?.promptPath,
      promptPathPresent: Boolean(config?.promptPath),
      scopedToEntrypoint: true,
    };
  }
  if (!configured.enabled || !config?.apiKeyRef) {
    return {
      enabled: false,
      source: "disabled",
      apiKeyRefPresent: Boolean(config?.apiKeyRef),
      model: config?.model,
      language: config?.language,
      promptPath: config?.promptPath,
      promptPathPresent: Boolean(config?.promptPath),
      attachmentKinds: configured.attachmentKinds,
      scopedToEntrypoint: configured.scopedToEntrypoint,
    };
  }
  return {
    enabled: true,
    provider: "openai",
    source: "config",
    apiKeyRefPresent: true,
    apiKeyRef: config.apiKeyRef,
    model: config.model,
    language: config.language,
    promptPath: config.promptPath,
    promptPathPresent: Boolean(config.promptPath),
    attachmentKinds: configured.attachmentKinds,
    scopedToEntrypoint: configured.scopedToEntrypoint,
  };
}

function publicTelegramTranscriptionRuntime(runtime: TelegramTranscriptionRuntime): Omit<TelegramTranscriptionRuntime, "apiKeyRef" | "promptPath"> {
  const { apiKeyRef: _apiKeyRef, promptPath: _promptPath, ...safe } = runtime;
  return safe;
}

function transcriptionAppliesToEntrypoint(config: TranscriptionConfig | undefined, entrypointId: string): { enabled: boolean; scopedToEntrypoint: boolean; attachmentKinds: Array<"voice" | "audio" | "video"> } {
  const entrypointIds = config?.scope?.entrypointIds ?? [];
  const scopedToEntrypoint = entrypointIds.length === 0 || entrypointIds.includes(entrypointId);
  return {
    enabled: Boolean(config?.enabled && scopedToEntrypoint),
    scopedToEntrypoint,
    attachmentKinds: [...(config?.scope?.attachmentKinds ?? ["voice", "audio"])],
  };
}

function setupTranscriptionStatus(workspace: WorkspaceConfig | undefined) {
  const config = workspace?.transcription;
  const attachmentKinds = config?.scope?.attachmentKinds ?? ["voice", "audio"];
  const entrypointIds = config?.scope?.entrypointIds ?? [];
  return {
    enabled: config?.enabled ?? false,
    provider: config?.provider ?? "openai",
    apiKeyRefPresent: Boolean(config?.apiKeyRef),
    model: config?.model ?? "gpt-4o-mini-transcribe",
    language: config?.language ?? "",
    promptPathPresent: Boolean(config?.promptPath),
    scope: {
      entrypointIds: entrypointIds.length > 0 ? entrypointIds : "all-enabled-entrypoints",
      attachmentKinds,
    },
    secretValuesPrinted: false,
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WORKSPACE_DIRS = [
  "config",
  "secrets",
  "logs",
  "artifacts",
  "state",
  "backups",
  "tmp",
  "data",
  "instructions",
  path.join("instructions", "skills"),
  path.join("instructions", "prompts"),
  "tasks",
  ".claude",
  path.join(".claude", "repo-registry"),
  "private",
  path.join("private", "documents"),
  path.join("private", "documents", "files"),
  "projects",
  "notes",
  "documents",
  path.join("documents", "metadata"),
] as const;
type AssistantStateStoreSpec = {
  key: string;
  relativePath: string;
  rootType?: "object" | "array";
  arrayRootKeys: readonly string[];
  objectRootKeys?: readonly string[];
  defaultValue: () => unknown;
};

const ASSISTANT_STATE_STORES: readonly AssistantStateStoreSpec[] = [
  { key: "todos", relativePath: path.join("data", "todos.json"), arrayRootKeys: ["todos"], defaultValue: () => ({ version: 1, updatedAt: new Date().toISOString(), todos: [] }) },
  { key: "projects", relativePath: path.join("data", "projects.json"), arrayRootKeys: ["projects"], defaultValue: () => ({ version: 1, updatedAt: new Date().toISOString(), projects: [] }) },
  { key: "crm", relativePath: path.join("data", "crm.json"), arrayRootKeys: ["people", "businesses", "correspondence"], defaultValue: () => ({ version: 1, updatedAt: new Date().toISOString(), people: [], businesses: [], correspondence: [] }) },
  { key: "reminders", relativePath: path.join("data", "reminders.json"), arrayRootKeys: ["reminders"], defaultValue: () => ({ version: 1, updatedAt: new Date().toISOString(), reminders: [] }) },
  { key: "calendarAllowlist", relativePath: path.join("data", "calendar-allowlist.json"), arrayRootKeys: ["emails", "domains"], defaultValue: () => ({ version: 1, enabled: false, emails: [], domains: [], updatedAt: null }) },
  { key: "seenInvites", relativePath: path.join("data", "seen-invites.json"), arrayRootKeys: [], objectRootKeys: ["seenIds"], defaultValue: () => ({ version: 1, seenIds: {}, updatedAt: null }) },
  { key: "declinedInvitesLog", relativePath: path.join("data", "declined-invites-log.json"), arrayRootKeys: ["log"], defaultValue: () => ({ version: 1, log: [] }) },
  { key: "dismissedEmails", relativePath: path.join("data", "dismissed-emails.json"), arrayRootKeys: [], objectRootKeys: ["threads", "senders"], defaultValue: () => ({ threads: {}, senders: {} }) },
  { key: "seenEmails", relativePath: path.join("data", "seen-emails.json"), arrayRootKeys: [], objectRootKeys: ["seenIds"], defaultValue: () => ({ version: 1, seenIds: {}, lastCheckedAt: null, updatedAt: null }) },
  { key: "urgentEmails", relativePath: path.join("data", "urgent-emails.json"), arrayRootKeys: [], objectRootKeys: ["threads"], defaultValue: () => ({ threads: {} }) },
  { key: "flaggedEvents", relativePath: path.join("data", "flagged-events.json"), arrayRootKeys: [], objectRootKeys: ["events"], defaultValue: () => ({ events: {} }) },
  { key: "dismissedMessages", relativePath: path.join("data", "dismissed-messages.json"), arrayRootKeys: [], objectRootKeys: ["chats"], defaultValue: () => ({ chats: {} }) },
  { key: "seenMessages", relativePath: path.join("data", "seen-messages.json"), arrayRootKeys: [], objectRootKeys: ["seenIds"], defaultValue: () => ({ version: 1, seenIds: {}, lastCheckedAt: null, updatedAt: null }) },
  { key: "urgentMessages", relativePath: path.join("data", "urgent-messages.json"), arrayRootKeys: [], objectRootKeys: ["chats"], defaultValue: () => ({ chats: {} }) },
  { key: "bets", relativePath: path.join("data", "bets.json"), arrayRootKeys: ["bets"], defaultValue: () => ({ version: 1, updatedAt: new Date().toISOString(), bets: [] }) },
  { key: "financeSources", relativePath: path.join("data", "finance-sources.json"), arrayRootKeys: ["sources"], defaultValue: () => ({ version: 1, sources: [] }) },
  { key: "whoopAuthPlaceholder", relativePath: path.join("data", "whoop-auth.example.json"), arrayRootKeys: [], defaultValue: () => ({ note: "whoop-connect.js writes private OAuth tokens to data/whoop-auth.json; this placeholder contains no token values." }) },
  { key: "protonmailDrafts", relativePath: path.join("data", "protonmail-drafts.json"), rootType: "array", arrayRootKeys: [], defaultValue: () => [] },
] as const;
const ASSISTANT_OVERLAY_SKILLS = ["todo", "projects", "crm", "reminders", "file-save", "repo-registry", "calendar-allowlist", "composio", "finance", "messaging", "protonmail", "betting", "dictionary", "generated-web-page", "loops", "mercury", "whoop", "web-page-design"] as const;
const ASSISTANT_OVERLAY_PROMPTS = ["email-reply-preferences", "bet-entry-preferences"] as const;
const SETUP_PROGRESS_FILE = "setup-progress.json";
const LOCAL_SETUP_CONTEXT_RELATIVE_PATH = path.join("private", "setup-context.json");
const PRIVATE_WORKSPACE_GITIGNORE = [
  "# Brain private workspace backup safety defaults",
  "# Keep secret-bearing, noisy, and local-cache paths out of private Git backups.",
  "secrets/**",
  "logs/**",
  "tmp/**",
  "cache/**",
  "caches/**",
  "state/setup-progress.json",
  "**/.cache/**",
  "**/node_modules/**",
  "**/*.log",
  "",
  "# Keep bulky private document bytes out of metadata backups.",
  "private/documents/files/**",
  "",
  "# Keep generated runtime scratch data local unless deliberately included.",
  "artifacts/tmp/**",
  "artifacts/generated/**",
  "",
].join("\n");

interface SetupInspectOptions {
  workspace: string;
  path?: string;
  config?: string;
  repo?: string;
  target?: string;
  sshHost?: string;
  sshUser?: string;
  serviceUser?: string;
  serviceName?: string;
  dryRun?: boolean;
}

interface LocalSetupContext {
  version: 1;
  target: "local" | "remote";
  workspace: string;
  workspaceRoot: string;
  updatedAt?: string;
  sshHost?: string;
  sshUser?: string;
  serviceUser?: string;
  bootstrapSshUser?: string;
  repoPath?: string;
  configPath?: string;
  secretValuesStored?: false;
}

interface RemoteSetupDefaults {
  serviceUser: string;
  serviceHome: string;
  sshHost?: string;
  sshUser: string;
  bootstrapSshUser?: string;
  workspaceRoot: string;
  workspaceParent: string;
  repoPath: string;
  configPath: string;
}

interface SetupContextGitSafety {
  insideWorkTree: boolean;
  tracked?: boolean;
  ignored?: boolean;
  safe: boolean;
  reason?: string;
}

interface SetupContextWriteResult {
  present: boolean;
  path: string;
  wrote: boolean;
  metadata?: Awaited<ReturnType<typeof fileMetadata>>;
  context?: LocalSetupContext;
  skipped?: string;
  warning?: string;
  git?: SetupContextGitSafety;
}

interface SetupResetOptions {
  workspace: string;
  path?: string;
  dryRun?: boolean;
  yes?: boolean;
}

interface SetupDefaultsOptions {
  workspace: string;
  target?: string;
  sshHost?: string;
  sshUser?: string;
  serviceUser?: string;
  path?: string;
  repo?: string;
  dryRun?: boolean;
  verbose?: boolean;
  sshAlias?: string;
  sshConfig?: string;
}

interface SetupRemoteBootstrapOptions extends SetupDefaultsOptions {
  sshHost?: string;
  sshUser?: string;
  serviceUser?: string;
  sshAlias?: string;
  sshConfig?: string;
}

interface SetupTelegramTokenScriptOptions {
  workspace: string;
  path?: string;
  config?: string;
  repo?: string;
  sshHost?: string;
  sshUser?: string;
  serviceUser?: string;
  output?: string;
  tokenFile?: string;
  adapterConfig?: string;
  serviceEnv?: string;
  secretsEnv?: string;
  binary?: string;
}

interface ConfigRef {
  workspaceId: string;
  ref: string;
  source: string;
  entrypointId?: string;
  optional?: boolean;
}

async function setupDefaultsCommand(options: SetupDefaultsOptions): Promise<CliResult> {
  const target = normalizeSetupDefaultsTarget(options.target);
  if (!target) return { ok: false, summary: "setup defaults target must be local or remote", details: { supported: ["local", "remote"] } };
  const remoteDefaults = target === "remote" ? remoteSetupDefaults(options) : undefined;
  const sshUser = remoteDefaults?.sshUser;
  const bootstrapSshUser = remoteDefaults?.bootstrapSshUser;
  const sshHost = target === "remote" ? (remoteDefaults?.sshHost ?? "ask: server IP or DNS name") : undefined;
  const serviceUser = options.serviceUser || DEFAULT_SERVICE_USER;
  const serviceHome = target === "remote" ? serviceUserHome(serviceUser) : "~";
  const workspaceRoot = remoteDefaults?.workspaceRoot ?? (options.path ?? defaultWorkspaceRootDisplay(options.workspace, serviceHome));
  const repoCheckout = remoteDefaults?.repoPath ?? "<this checkout>";
  const serviceName = `brain-${options.workspace}`;
  const decisions = [
    { decision: "Setup mode", default: target === "remote" ? "Remote Ubuntu server over SSH" : "Local private workspace" },
    ...(target === "remote" ? [
      { decision: "Remote SSH host", default: sshHost },
      { decision: "Initial remote SSH user", default: bootstrapSshUser ?? sshUser },
      { decision: "Future remote SSH user", default: sshUser },
    ] : []),
    { decision: "Source checkout", default: repoCheckout },
    { decision: "Private workspace", default: workspaceRoot },
    { decision: "Initial workspace", default: options.workspace },
  ];
  const details: Record<string, unknown> = {
    decisions,
    safety: [
      "private workspace stays outside the source checkout",
      "secrets and runtime state stay outside git",
      "setup does not write secret values",
    ],
    setupFlow: conciseSetupFlow(),
  };
  let remoteContextWrite: SetupContextWriteResult | undefined;
  if (remoteDefaults) {
    const context = remoteLocalSetupContext(options, remoteDefaults);
    remoteContextWrite = options.dryRun
      ? {
        present: false,
        path: localSetupContextPath(path.resolve(options.repo ?? process.cwd())),
        wrote: false,
        skipped: "dry run; local remote setup context was not written",
        context,
      }
      : await writeLocalSetupContext(options.repo, context);
    details.localSetupContext = setupContextWriteSummary(remoteContextWrite, options.verbose);
    details.sideEffects = remoteContextWrite.wrote
      ? "updated ignored local private/setup-context.json with non-secret remote resume metadata"
      : remoteContextWrite.skipped ?? "none";
  }
  if (options.verbose) {
    details.advanced = {
      target,
      ssh: target === "remote" ? { host: sshHost, user: sshUser, bootstrapUser: bootstrapSshUser } : undefined,
      serviceUser: target === "remote" ? serviceUser : undefined,
      serviceName: target === "remote" ? serviceName : undefined,
      paths: {
        repoCheckout,
        privateWorkspace: workspaceRoot,
        runtimeConfig: `${workspaceRoot}/config/runtime.yaml`,
        secretsEnv: `${workspaceRoot}/secrets/secrets.env`,
        state: `${workspaceRoot}/state`,
        logs: `${workspaceRoot}/logs`,
      },
      nextCommands: [
        ...(target === "remote" && bootstrapSshUser ? [`pnpm run brainctl setup remote-bootstrap --workspace ${options.workspace} --ssh-host ${sshHost ?? "<host>"} --ssh-user ${bootstrapSshUser} --service-user ${serviceUser}`] : []),
        `pnpm run brainctl setup --workspace ${options.workspace} --path ${workspaceRoot}`,
        `pnpm run brainctl setup status --config ${workspaceRoot}/config/runtime.yaml --workspace ${options.workspace}`,
      ],
    };
  }

  return {
    ok: remoteContextWrite ? remoteContextWrite.wrote || Boolean(options.dryRun) : true,
    summary: remoteContextWrite && !remoteContextWrite.wrote && !options.dryRun
      ? "remote setup defaults ready, but local setup context was not persisted safely"
      : `${target} setup defaults ready; confirm concise choices or pass --verbose for implementation details`,
    details,
  };
}

async function setupRemoteBootstrapCommand(options: SetupRemoteBootstrapOptions): Promise<CliResult> {
  if (!options.sshHost) {
    return { ok: false, summary: "remote bootstrap needs --ssh-host", details: { workspace: options.workspace, missing: ["ssh-host"], sideEffects: "none" } };
  }
  const defaults = remoteSetupDefaults(options);
  const initialSshUser = options.sshUser || defaults.bootstrapSshUser || defaults.sshUser;
  const initialDestination = remoteSshDestination(options.sshHost, initialSshUser);
  const futureDestination = remoteSshDestination(options.sshHost, defaults.sshUser);
  const bootstrapScript = renderRemoteBootstrapScript({ serviceUser: defaults.serviceUser, serviceHome: defaults.serviceHome, repoPath: defaults.repoPath, workspaceParent: defaults.workspaceParent, workspaceRoot: defaults.workspaceRoot });
  const bootstrapCommand = `ssh ${shellArg(initialDestination)} 'bash -s'`;
  const serviceValidationCommand = `ssh ${shellArg(futureDestination)} ${shellArg(remoteServiceUserValidationCommand(defaults))}`;
  const context = remoteLocalSetupContext(options, defaults);

  if (options.dryRun) {
    return {
      ok: true,
      summary: "remote bootstrap plan ready (dry run)",
      details: {
        workspace: options.workspace,
        initialSsh: { host: options.sshHost, user: initialSshUser, destination: initialDestination },
        futureSsh: { host: options.sshHost, user: defaults.sshUser, destination: futureDestination },
        serviceUser: defaults.serviceUser,
        repoPath: defaults.repoPath,
        workspaceParent: defaults.workspaceParent,
        workspaceRoot: defaults.workspaceRoot,
        bootstrapCommand,
        serviceValidationCommand,
        localSetupContext: { context },
        sshConfig: sshConfigPlan(options, defaults),
        sideEffects: "none",
      },
    };
  }

  const bootstrap = spawnSync("ssh", [initialDestination, "bash -s"], { input: bootstrapScript, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if ((bootstrap.status ?? 0) !== 0) {
    return {
      ok: false,
      summary: "remote bootstrap failed before local resume context was rewritten",
      details: {
        workspace: options.workspace,
        initialSsh: { host: options.sshHost, user: initialSshUser, destination: initialDestination },
        futureSsh: { host: options.sshHost, user: defaults.sshUser, destination: futureDestination },
        bootstrapCommand,
        exitCode: bootstrap.status,
        stdout: redactSecrets(String(bootstrap.stdout ?? "")),
        stderr: redactSecrets(String(bootstrap.stderr ?? "")),
        sideEffects: "remote bootstrap may have partially run; local setup context was not rewritten",
      },
    };
  }

  const validation = spawnSync("ssh", [futureDestination, remoteServiceUserValidationCommand(defaults)], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if ((validation.status ?? 0) !== 0) {
    return {
      ok: false,
      summary: "remote bootstrap ran, but service-user SSH validation failed",
      details: {
        workspace: options.workspace,
        initialSsh: { host: options.sshHost, user: initialSshUser, destination: initialDestination },
        futureSsh: { host: options.sshHost, user: defaults.sshUser, destination: futureDestination },
        bootstrapCommand,
        serviceValidationCommand,
        exitCode: validation.status,
        stdout: redactSecrets(String(validation.stdout ?? "")),
        stderr: redactSecrets(String(validation.stderr ?? "")),
        sideEffects: "remote bootstrap ran; local setup context was not rewritten because future service-user SSH failed",
      },
    };
  }

  const contextWrite = await writeLocalSetupContext(options.repo, context);
  const sshConfigWrite = await writeGeneratedSshConfig(options, defaults);
  const ok = contextWrite.wrote && (sshConfigWrite?.wrote ?? true);
  return {
    ok,
    summary: ok ? "remote bootstrap complete; future setup commands will use the service user" : "remote bootstrap complete, but local future-SSH metadata was not fully persisted",
    details: {
      workspace: options.workspace,
      initialSsh: { host: options.sshHost, user: initialSshUser, destination: initialDestination, scope: "one-time-bootstrap" },
      futureSsh: { host: options.sshHost, user: defaults.sshUser, destination: futureDestination },
      serviceUser: defaults.serviceUser,
      repoPath: defaults.repoPath,
      workspaceParent: defaults.workspaceParent,
      workspaceRoot: defaults.workspaceRoot,
      bootstrapCommand,
      serviceValidationCommand,
      bootstrap: { exitCode: bootstrap.status, stdout: redactSecrets(String(bootstrap.stdout ?? "")), stderr: redactSecrets(String(bootstrap.stderr ?? "")) },
      validation: { exitCode: validation.status, stdout: redactSecrets(String(validation.stdout ?? "")), stderr: redactSecrets(String(validation.stderr ?? "")) },
      localSetupContext: setupContextWriteSummary(contextWrite, true),
      sshConfig: sshConfigWrite,
      sideEffects: [
        "created/validated remote service user, sudo access, authorized_keys, checkout/workspace parent/workspace ownership",
        contextWrite.wrote ? "updated ignored local private/setup-context.json to future service-user SSH" : "local setup context was not updated",
        sshConfigWrite?.wrote ? "updated generated SSH config alias to future service-user SSH" : undefined,
      ].filter(Boolean).join("; "),
      secretValuesPrinted: false,
    },
  };
}

function renderRemoteBootstrapScript(input: { serviceUser: string; serviceHome: string; repoPath: string; workspaceParent: string; workspaceRoot: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077

service_user=${shellLiteral(input.serviceUser)}
service_home=${shellLiteral(input.serviceHome)}
repo_path=${shellLiteral(input.repoPath)}
workspace_parent=${shellLiteral(input.workspaceParent)}
workspace_root=${shellLiteral(input.workspaceRoot)}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

validate_as_service_user() {
  local label="$1"
  shift
  if ! sudo -iu "$service_user" "$@"; then
    echo "Brain remote bootstrap validation failed: service user '$service_user' cannot $label. Check ownership/mode for repo_path=$repo_path workspace_parent=$workspace_parent workspace_root=$workspace_root." >&2
    exit 1
  fi
}

if [ "$service_user" = root ]; then service_home=/root; fi
if ! id "$service_user" >/dev/null 2>&1; then
  run_root useradd --create-home --home-dir "$service_home" --shell /bin/bash "$service_user"
fi

service_group="$(id -gn "$service_user")"
run_root install -d -o "$service_user" -g "$service_group" -m 700 "$service_home/.ssh"
authorized_keys="$service_home/.ssh/authorized_keys"
if [ ! -s "$authorized_keys" ]; then
  source_keys=""
  if [ -s /root/.ssh/authorized_keys ]; then
    source_keys=/root/.ssh/authorized_keys
  elif [ -n "\${SUDO_USER:-}" ] && [ -s "$(getent passwd "$SUDO_USER" | cut -d: -f6)/.ssh/authorized_keys" ]; then
    source_keys="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.ssh/authorized_keys"
  fi
  if [ -z "$source_keys" ]; then
    echo "No existing authorized_keys found to grant service-user SSH access." >&2
    exit 1
  fi
  run_root install -o "$service_user" -g "$service_group" -m 600 "$source_keys" "$authorized_keys"
fi
run_root chown "$service_user:$service_group" "$authorized_keys"
run_root chmod 600 "$authorized_keys"

sudoers_file="/etc/sudoers.d/brain-\${service_user}"
tmp_sudoers="$(mktemp)"
printf "%s ALL=(ALL) NOPASSWD:ALL\\n" "$service_user" > "$tmp_sudoers"
run_root install -o root -g root -m 440 "$tmp_sudoers" "$sudoers_file"
rm -f "$tmp_sudoers"
run_root visudo -cf "$sudoers_file" >/dev/null

run_root install -d -o "$service_user" -g "$service_group" -m 755 "$repo_path"
run_root install -d -o "$service_user" -g "$service_group" -m 700 "$workspace_parent"
run_root install -d -o "$service_user" -g "$service_group" -m 700 "$workspace_root"
for dir in config secrets state logs tmp artifacts cache private private/documents private/documents/files; do
  mode=700
  case "$dir" in config) mode=755 ;; esac
  run_root install -d -o "$service_user" -g "$service_group" -m "$mode" "$workspace_root/$dir"
done
run_root chown "$service_user:$service_group" "$workspace_parent" "$workspace_root"
run_root chown -R "$service_user:$service_group" "$repo_path" "$workspace_root"

validate_as_service_user "read SSH authorized_keys at $authorized_keys" test -r "$authorized_keys"
validate_as_service_user "access checkout directory $repo_path" test -d "$repo_path"
validate_as_service_user "write workspace parent $workspace_parent" test -w "$workspace_parent"
validate_as_service_user "write workspace root $workspace_root" test -w "$workspace_root"
echo "Brain remote bootstrap validated for $service_user."
`;
}

function remoteServiceUserValidationCommand(defaults: RemoteSetupDefaults): string {
  const validationScript = [
    "set -euo pipefail",
    "fail() { echo \"Brain service-user SSH validation failed: $1\" >&2; exit 1; }",
    `[ "$(id -un)" = ${shellArg(defaults.sshUser)} ] || fail "expected SSH user ${defaults.sshUser}, got $(id -un)"`,
    `[ -r ${shellArg(`${defaults.serviceHome}/.ssh/authorized_keys`)} ] || fail "cannot read service-user authorized_keys at ${defaults.serviceHome}/.ssh/authorized_keys"`,
    `[ -d ${shellArg(defaults.repoPath)} ] || fail "checkout directory is missing or inaccessible: ${defaults.repoPath}"`,
    `[ -w ${shellArg(defaults.workspaceParent)} ] || fail "workspace parent is not writable by ${defaults.sshUser}: ${defaults.workspaceParent}"`,
    `[ -w ${shellArg(defaults.workspaceRoot)} ] || fail "workspace root is not writable by ${defaults.sshUser}: ${defaults.workspaceRoot}"`,
  ].join("\n");
  return `bash -lc ${shellArg(validationScript)}`;
}

function sshConfigPlan(options: SetupRemoteBootstrapOptions, defaults: RemoteSetupDefaults) {
  if (!options.sshAlias && !options.sshConfig) return undefined;
  return { path: options.sshConfig ? path.resolve(options.sshConfig) : path.join(os.homedir(), ".ssh", "config"), alias: options.sshAlias ?? options.sshHost, hostName: options.sshHost, user: defaults.sshUser };
}

async function writeGeneratedSshConfig(options: SetupRemoteBootstrapOptions, defaults: RemoteSetupDefaults): Promise<{ wrote: boolean; path?: string; alias?: string; skipped?: string } | undefined> {
  const plan = sshConfigPlan(options, defaults);
  if (!plan) return undefined;
  if (!plan.alias || !plan.hostName) return { wrote: false, path: plan.path, alias: plan.alias, skipped: "ssh alias and ssh host are required to update SSH config" };
  const begin = `# BEGIN Brain generated host ${plan.alias}`;
  const end = `# END Brain generated host ${plan.alias}`;
  const block = [begin, `Host ${plan.alias}`, `    HostName ${plan.hostName}`, `    User ${defaults.sshUser}`, end, ""].join("\n");
  await mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });
  const current = await readFile(plan.path, "utf8").catch(() => "");
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");
  const next = pattern.test(current) ? current.replace(pattern, block) : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}`;
  await writeFile(plan.path, next, { mode: 0o600 });
  await chmod(plan.path, 0o600).catch(() => undefined);
  return { wrote: true, path: plan.path, alias: plan.alias };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function conciseSetupFlow() {
  return {
    coreSteps: [
      {
        step: "essential-runtime-choices",
        prompt: "Confirm workspace, provider, entrypoint, and service target.",
      },
      {
        step: "configure-verify-codex-auth",
        prompt: "When provider is Codex, verify auth before service start or live Telegram traffic.",
      },
      {
        step: "telegram-connection",
        prompt: "Connect Telegram bot and private token ref; do not start live traffic yet.",
      },
      {
        step: "personal-workspace",
        prompt: "Create the JSON-backed assistant workspace for todos, projects, CRM, reminders, file-save metadata, overlays, tasks, and repo-registry state.",
      },
      {
        step: "private-data-repo",
        prompt: "Pull or initialize the private data/backup repo before relying on project memory.",
      },
      {
        step: "composio-accounts",
        prompt: "Connect Composio accounts if this workspace needs them.",
      },
    ],
    orderingNotes: [
      "Codex auth is an explicit step whenever the provider is Codex.",
      "Verify Codex auth before starting the service or accepting live Telegram traffic.",
      "Create JSON-backed assistant workspace paths before the first live provider turn so todos/projects/CRM/reminders and document metadata have an inspectable source.",
      "Keep markdown notes as supporting project resources only; do not migrate or convert JSON state to markdown.",
      "Keep OpenAI transcription, web publishing, backup tuning, and first-user pairing as follow-up steps unless explicitly requested now.",
    ],
  };
}

function normalizeSetupDefaultsTarget(target: string | undefined): SetupDefaultsTarget | undefined {
  if (target === undefined || target === "local" || target === "remote") return target ?? "local";
  return undefined;
}

function serviceUserHome(serviceUser: string): string {
  return serviceUser === "root" ? "/root" : `/home/${serviceUser}`;
}

function remoteSetupDefaults(options: Pick<SetupDefaultsOptions, "workspace" | "path" | "sshHost" | "sshUser" | "serviceUser">): RemoteSetupDefaults {
  const serviceUser = options.serviceUser || DEFAULT_SERVICE_USER;
  const serviceHome = serviceUserHome(serviceUser);
  const workspaceRoot = normalizeRemoteDisplayPath(options.path ?? defaultWorkspaceRootDisplay(options.workspace, serviceHome), serviceHome);
  const workspaceParent = path.posix.dirname(workspaceRoot);
  const repoPath = `${serviceHome}/brain`;
  const initialSshUser = options.sshUser || "root";
  const usesRootBootstrap = initialSshUser === "root" && serviceUser !== "root";
  return {
    serviceUser,
    serviceHome,
    sshHost: nonPromptValue(options.sshHost),
    sshUser: usesRootBootstrap ? serviceUser : initialSshUser,
    bootstrapSshUser: usesRootBootstrap ? initialSshUser : undefined,
    workspaceRoot,
    workspaceParent,
    repoPath,
    configPath: `${workspaceRoot}/config/runtime.yaml`,
  };
}

function remoteLocalSetupContext(options: Pick<SetupDefaultsOptions, "workspace">, defaults: RemoteSetupDefaults): LocalSetupContext {
  return {
    version: 1,
    target: "remote",
    workspace: options.workspace,
    workspaceRoot: defaults.workspaceRoot,
    updatedAt: new Date().toISOString(),
    sshHost: defaults.sshHost,
    sshUser: defaults.sshUser,
    serviceUser: defaults.serviceUser,
    bootstrapSshUser: defaults.bootstrapSshUser,
    repoPath: defaults.repoPath,
    configPath: defaults.configPath,
    secretValuesStored: false,
  };
}

function normalizeRemoteDisplayPath(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return `${home}/${value.slice(2)}`;
  return value;
}

function nonPromptValue(value: string | undefined): string | undefined {
  if (!value || value.startsWith("ask:") || /^<.+>$/.test(value)) return undefined;
  return value;
}

function defaultWorkspaceRoot(workspace: string): string {
  return path.join(process.env.HOME ?? ".", ".brain", workspace === DEFAULT_WORKSPACE_ID ? "workspace" : path.join("workspaces", workspace));
}

function defaultWorkspaceRootDisplay(workspace: string, home: string): string {
  return `${home}/.brain/${workspace === DEFAULT_WORKSPACE_ID ? "workspace" : `workspaces/${workspace}`}`;
}

async function setupCommand(options: SetupInspectOptions & { dryRun?: boolean; force?: boolean; replace?: boolean }): Promise<CliResult> {
  const requestedTarget = options.target ? normalizeSetupDefaultsTarget(options.target) : undefined;
  if (options.target && !requestedTarget) return { ok: false, summary: "setup target must be local or remote", details: { supported: ["local", "remote"] } };
  const preflight = await setupInspectDetails(options);
  if (preflight.resumeProbe?.target === "remote" && !requestedTarget && !options.path && !options.force && !options.replace) {
    return {
      ok: true,
      summary: "prior remote setup context found; inspect remote progress before asking first-run setup questions",
      details: {
        workspace: options.workspace,
        workspaceRoot: preflight.workspaceRoot,
        localSetupContext: preflight.localSetupContext,
        resumeProbe: preflight.resumeProbe,
        setupWizard: setupResumeWizard(preflight),
        inspection: preflight,
        sideEffects: "none",
      },
    };
  }
  if (requestedTarget === "remote") {
    const defaults = remoteSetupDefaults(options);
    const context = remoteLocalSetupContext(options, defaults);
    const contextWrite = options.dryRun
      ? {
        present: false,
        path: localSetupContextPath(path.resolve(options.repo ?? process.cwd())),
        wrote: false,
        skipped: "dry run; local remote setup context was not written",
        context,
      }
      : await writeLocalSetupContext(options.repo, context);
    return {
      ok: contextWrite.wrote || Boolean(options.dryRun),
      summary: contextWrite.wrote
        ? "remote setup context persisted; inspect remote progress before local first-run questions"
        : options.dryRun
          ? "remote setup context plan ready (dry run)"
          : "remote setup context was not persisted safely",
      details: {
        workspace: options.workspace,
        workspaceRoot: defaults.workspaceRoot,
        localSetupContext: setupContextWriteSummary(contextWrite, true),
        resumeProbe: buildSetupResumeProbe({ present: true, path: contextWrite.path, context }, defaults.workspaceRoot, options.workspace),
        inspection: preflight,
        sideEffects: contextWrite.wrote
          ? "updated ignored local private/setup-context.json with non-secret remote resume metadata"
          : "none",
      },
    };
  }
  const workspaceRoot = preflight.workspaceRoot;
  const dirs = WORKSPACE_DIRS.map((dir) => path.join(workspaceRoot, dir));
  const scaffold = options.dryRun
    ? assistantWorkspaceScaffoldPlan(workspaceRoot)
    : await ensureAssistantWorkspaceScaffold(workspaceRoot);
  if (!options.dryRun) {
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    for (const dir of dirs) await mkdir(dir, { recursive: true, mode: workspaceDirectoryMode(path.relative(workspaceRoot, dir)) });
  }
  const after = options.dryRun ? preflight : await setupInspectDetails(options);
  const setupWizard = setupResumeWizard(after);
  const setupState = options.dryRun ? after.setupState : await writeSetupProgress(after, setupWizard);
  return {
    ok: true,
    summary: options.dryRun ? "setup plan ready (dry run; no overwrite by default)" : "private workspace scaffold reconciled without writing secrets",
    details: {
      workspace: options.workspace,
      workspaceRoot,
      directories: dirs.map((dir) => path.relative(workspaceRoot, dir)),
      secrets: "not written",
      idempotency: {
        reRunnable: true,
        defaultOverwrite: false,
        destructiveChangesRequire: "--force or --replace plus a command that explicitly supports replacement",
        forceRequested: Boolean(options.force),
        replaceRequested: Boolean(options.replace),
      },
      plan: after.plan,
      assistantWorkspaceScaffold: scaffold,
      setupWizard,
      setupState,
      inspection: after,
      sideEffects: options.dryRun ? "none" : "created missing directories, reconciled JSON-backed assistant workspace files, and updated private setup progress state",
    },
  };
}

async function setupResetCommand(options: SetupResetOptions): Promise<CliResult> {
  if (!options.path) {
    return {
      ok: false,
      summary: "setup reset needs an explicit --path",
      details: {
        workspace: options.workspace,
        path: undefined,
        action: "skipped",
        skipped: "pass --path <workspace-path> so reset targets only that workspace state file",
      },
    };
  }
  const workspaceRoot = path.resolve(options.path);
  const progressPath = setupProgressPath(workspaceRoot);
  const previous = await setupProgressMetadata(progressPath);
  let action: "skipped" | "would_remove" | "removed" = "skipped";
  let skipped: string | undefined;
  if (!previous.present) {
    skipped = "setup progress file is absent";
  } else if (options.dryRun) {
    action = "would_remove";
    skipped = "dry run; no files changed";
  } else if (!options.yes) {
    skipped = "confirmation required; rerun with --yes to remove only state/setup-progress.json";
  } else {
    await rm(progressPath, { force: true });
    action = "removed";
  }
  return {
    ok: true,
    summary: action === "removed"
      ? "setup progress reset; rerun setup/status to resume fresh"
      : action === "would_remove"
        ? "setup progress reset plan ready"
        : "setup progress reset skipped",
    details: {
      workspace: options.workspace,
      path: progressPath,
      previous,
      action,
      skipped,
      scope: "state/setup-progress.json only",
      sideEffects: action === "removed" ? "removed state/setup-progress.json only" : "none",
    },
  };
}

async function setupTelegramTokenScriptCommand(options: SetupTelegramTokenScriptOptions): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const scriptDir = options.output ? path.dirname(path.resolve(options.output)) : await mkdtemp(path.join(os.tmpdir(), "brain-token-"));
  const scriptPath = path.resolve(options.output ?? path.join(scriptDir, "store-brain-telegram-token.sh"));
  const tokenFile = path.resolve(options.tokenFile ?? path.join(workspaceRoot, "secrets", "telegram-bot-token"));
  const adapterConfig = path.resolve(options.adapterConfig ?? path.join(workspaceRoot, "secrets", "telegram-main.json"));
  const serviceEnv = path.resolve(options.serviceEnv ?? path.join(workspaceRoot, "config", `brain-${options.workspace}.env`));
  const secretsEnv = path.resolve(options.secretsEnv ?? path.join(workspaceRoot, "secrets", "secrets.env"));
  const script = renderTelegramTokenStorageScript({ workspaceRoot, tokenFile, adapterConfig, serviceEnv, secretsEnv });

  await mkdir(scriptDir, { recursive: true, mode: 0o700 });
  await chmod(scriptDir, 0o700).catch(() => undefined);
  await writeFile(scriptPath, script, { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  if ((syntax.status ?? 0) !== 0) {
    return {
      ok: false,
      summary: "Telegram token script was written but failed bash syntax validation",
      details: {
        scriptPath,
        stderr: redactSecrets(String(syntax.stderr ?? "")),
        sideEffects: "wrote script only; no secret values read or stored",
        secretValuesPrinted: false,
      },
    };
  }

  return {
    ok: true,
    summary: "Telegram token storage script written and syntax checked",
    details: {
      scriptPath,
      runCommand: `bash ${shellArg(scriptPath)}`,
      workspaceRoot,
      writes: {
        tokenFile,
        adapterConfig,
        serviceEnv,
        secretsEnv,
      },
      validation: "bash -n passed",
      sideEffects: "wrote one-use private temporary script only; no secret values read or stored",
      secretValuesPrinted: false,
    },
  };
}

async function setupCodexAuthScriptCommand(options: SetupTelegramTokenScriptOptions): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const repoRoot = path.resolve(options.repo ?? process.cwd());
  const configPath = path.resolve(options.config ?? path.join(workspaceRoot, "config", "runtime.yaml"));
  const scriptDir = options.output ? path.dirname(path.resolve(options.output)) : await mkdtemp(path.join(os.tmpdir(), "brain-codex-auth-"));
  const scriptPath = path.resolve(options.output ?? path.join(scriptDir, "verify-brain-codex-auth.sh"));
  const codexBinary = options.binary ?? "codex";
  const sshRunCommand = remoteCodexAuthSshCommand({
    scriptPath,
    sshHost: options.sshHost,
    sshUser: options.sshUser,
    serviceUser: options.serviceUser,
  });
  const sshLoginCommand = remoteCodexLoginSshCommand({
    sshHost: options.sshHost,
    sshUser: options.sshUser,
    serviceUser: options.serviceUser,
    codexBinary,
    loginArgs: ["login", "--device-auth"],
  });
  const sshInteractiveLoginCommand = remoteCodexLoginSshCommand({
    sshHost: options.sshHost,
    sshUser: options.sshUser,
    serviceUser: options.serviceUser,
    codexBinary,
    loginArgs: ["login"],
  });
  const script = renderCodexAuthVerificationScript({
    workspace: options.workspace,
    workspaceRoot,
    repoRoot,
    configPath,
    codexBinary,
    sshLoginCommand,
    sshInteractiveLoginCommand,
  });

  await mkdir(scriptDir, { recursive: true, mode: 0o700 });
  await chmod(scriptDir, 0o700).catch(() => undefined);
  await writeFile(scriptPath, script, { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  if ((syntax.status ?? 0) !== 0) {
    return {
      ok: false,
      summary: "Codex auth verification script was written but failed bash syntax validation",
      details: {
        scriptPath,
        stderr: redactSecrets(String(syntax.stderr ?? "")),
        sideEffects: "wrote script only; no credential values read or stored",
        secretValuesPrinted: false,
      },
    };
  }

  return {
    ok: true,
    summary: "Codex auth verification script written and syntax checked",
    details: {
      scriptPath,
      runCommand: `bash ${shellArg(scriptPath)}`,
      sshRunCommand,
      sshLoginCommand,
      sshInteractiveLoginCommand,
      workspace: options.workspace,
      workspaceRoot,
      repoRoot,
      configPath,
      codexBinary,
      runAsUser: options.serviceUser ?? options.sshUser,
      validation: "bash -n passed",
      sideEffects: "wrote private temporary verification script only; no credential values read or stored",
      secretValuesPrinted: false,
    },
  };
}

function remoteCodexAuthSshCommand(input: { scriptPath: string; sshHost?: string; sshUser?: string; serviceUser?: string }): string | undefined {
  if (!input.sshHost) return undefined;
  const destination = remoteSshDestination(input.sshHost, input.sshUser);
  const sameUser = !input.serviceUser || !input.sshUser || input.serviceUser === input.sshUser;
  const serviceUser = input.serviceUser ?? input.sshUser ?? "";
  const remoteCommand = sameUser
    ? `bash ${shellArg(input.scriptPath)}`
    : `home=$(getent passwd ${shellArg(serviceUser)} | cut -d: -f6) && tmp=$(mktemp "$home/brain-codex-auth.XXXXXX.sh") && install -o ${shellArg(serviceUser)} -g ${shellArg(serviceUser)} -m 700 ${shellArg(input.scriptPath)} "$tmp"; rc=$?; if [ "$rc" -eq 0 ]; then sudo -iu ${shellArg(serviceUser)} bash "$tmp"; rc=$?; fi; rm -f "$tmp"; exit "$rc"`;
  return `ssh -t ${shellArg(destination)} ${shellArg(remoteCommand)}`;
}

function remoteCodexLoginSshCommand(input: { sshHost?: string; sshUser?: string; serviceUser?: string; codexBinary: string; loginArgs: string[] }): string | undefined {
  if (!input.sshHost) return undefined;
  const destination = remoteSshDestination(input.sshHost, input.sshUser);
  const sameUser = !input.serviceUser || !input.sshUser || input.serviceUser === input.sshUser;
  const serviceUser = input.serviceUser ?? input.sshUser ?? "";
  const loginCommand = [input.codexBinary, ...input.loginArgs].map(shellArg).join(" ");
  const remoteCommand = sameUser
    ? loginCommand
    : `sudo -iu ${shellArg(serviceUser)} ${loginCommand}`;
  return `ssh -t ${shellArg(destination)} ${shellArg(remoteCommand)}`;
}

function renderTelegramTokenStorageScript(input: { workspaceRoot: string; tokenFile: string; adapterConfig: string; serviceEnv: string; secretsEnv: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077

script_path="\${BASH_SOURCE[0]:-$0}"
workspace=${shellLiteral(input.workspaceRoot)}
token_file=${shellLiteral(input.tokenFile)}
adapter_config=${shellLiteral(input.adapterConfig)}
service_env=${shellLiteral(input.serviceEnv)}
secrets_env=${shellLiteral(input.secretsEnv)}

restore_tty() {
  if [ -t 0 ]; then stty echo 2>/dev/null || true; fi
}

cleanup() {
  status="$?"
  restore_tty
  if [ "$status" -eq 0 ]; then rm -f -- "$script_path"; fi
}
trap cleanup EXIT

mkdir -p "$workspace/secrets" "$workspace/config" "$workspace/state/telegram-pairing"
chmod 700 "$workspace/secrets"

printf "Telegram bot token: " >&2
if [ -t 0 ]; then stty -echo; fi
IFS= read -r token
restore_tty
printf "\\n" >&2

if [ -z "$token" ]; then
  printf "No token entered; nothing was written.\\n" >&2
  exit 1
fi
if ! printf "%s" "$token" | grep -Eq "^[0-9]+:[A-Za-z0-9_-]+$"; then
  printf "Token format did not look like a Telegram bot token; nothing was written.\\n" >&2
  exit 1
fi

printf "%s\\n" "$token" > "$token_file"
chmod 600 "$token_file"

cat > "$adapter_config" <<JSON
{
  "entrypointId": "telegram-main",
  "kind": "telegram",
  "tokenRef": "file:$token_file",
  "pollingState": "$workspace/state/telegram-offset.json",
  "pairingState": "$workspace/state/telegram-pairing",
  "adminBootstrap": "first-user"
}
JSON
chmod 600 "$adapter_config"

update_env_file() {
  file="$1"
  key="$2"
  value="$3"
  mkdir -p "$(dirname "$file")"
  tmp="$(mktemp "$file.tmp.XXXXXX")"
  if [ -f "$file" ]; then
    while IFS= read -r line; do
      case "$line" in
        "$key="*) ;;
        *) printf "%s\\n" "$line" ;;
      esac
    done < "$file" > "$tmp"
  fi
  printf "%s=%s\\n" "$key" "$value" >> "$tmp"
  install -m 600 "$tmp" "$file"
  rm -f "$tmp"
}

update_env_file "$service_env" TELEGRAM_MAIN_CONFIG "$adapter_config"
update_env_file "$service_env" TELEGRAM_BOT_TOKEN_FILE "$token_file"
update_env_file "$secrets_env" TELEGRAM_MAIN_CONFIG "$adapter_config"
update_env_file "$secrets_env" TELEGRAM_BOT_TOKEN_FILE "$token_file"

unset token
printf "Stored Telegram token in private Brain secret files. Token value was not printed.\\n" >&2
`;
}

function renderCodexAuthVerificationScript(input: {
  workspace: string;
  workspaceRoot: string;
  repoRoot: string;
  configPath: string;
  codexBinary: string;
  sshLoginCommand?: string;
  sshInteractiveLoginCommand?: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=${shellLiteral(input.repoRoot)}
config=${shellLiteral(input.configPath)}
workspace=${shellLiteral(input.workspace)}
workspace_root=${shellLiteral(input.workspaceRoot)}
codex_binary=${shellLiteral(input.codexBinary)}
local_device_login_command=${shellLiteral(`${input.codexBinary} login --device-auth`)}
local_interactive_login_command=${shellLiteral(`${input.codexBinary} login`)}
ssh_device_login_command=${shellLiteral(input.sshLoginCommand ?? "")}
ssh_interactive_login_command=${shellLiteral(input.sshInteractiveLoginCommand ?? "")}

print_login_help() {
  cat >&2 <<'HELP'
Codex auth is not verified yet.
HELP

  if [ -n "$ssh_device_login_command" ]; then
    cat >&2 <<'HELP'

Run this exact command from your local terminal to start Codex device auth on
the server as the same user that will run Brain:
HELP
    printf "  %s\\n" "$ssh_device_login_command" >&2
    if [ -n "$ssh_interactive_login_command" ]; then
      cat >&2 <<'HELP'

If device auth is not available, run this interactive login command instead:
HELP
      printf "  %s\\n" "$ssh_interactive_login_command" >&2
    fi
  else
    cat >&2 <<HELP

Run one of these on the target host as the same user that will run Brain:
  $local_device_login_command
  $local_interactive_login_command
HELP
  fi

  cat >&2 <<'HELP'

If you must use an API key or access token, use a one-use private script that
reads hidden input and pipes it to:
  codex login --with-api-key
or:
  codex login --with-access-token

Do not paste provider credentials into chat, shell history, repo files, logs, or
setup summaries. After login succeeds, rerun this verification script.
HELP
}

cd "$repo"

if ! command -v "$codex_binary" >/dev/null 2>&1; then
  printf "Codex CLI not found: %s\\n" "$codex_binary" >&2
  printf "Install Codex CLI on the target host, then rerun this script.\\n" >&2
  exit 1
fi

"$codex_binary" --version >/dev/null
if ! "$codex_binary" login status >/dev/null; then
  print_login_help
  exit 1
fi

mkdir -p "$workspace_root/tmp"
if ! tmp_probe="$(mktemp "$workspace_root/tmp/codex-tmp.XXXXXX" 2>/dev/null)"; then
  cat >&2 <<HELP
Codex auth is present, but the Brain workspace temp directory is not writable:
  $workspace_root/tmp

Run this exact command on the target host, then rerun this verification script:
  install -d -o "$(id -un)" -g "$(id -gn)" -m 700 "$workspace_root/tmp"
HELP
  exit 1
fi
rm -f "$tmp_probe"

pnpm run brainctl validate live \\
  --config "$config" \\
  --workspace "$workspace" \\
  --codex-transport exec \\
  --allow-live \\
  --run-safe

printf "Codex auth metadata verified for Brain setup. No user task was sent.\\n" >&2
`;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function setupInspectCommand(options: SetupInspectOptions): Promise<CliResult> {
  const details = await setupInspectDetails(options);
  const remoteResumeProbe = details.resumeProbe?.target === "remote" && !options.path;
  const ok = remoteResumeProbe || details.plan.missing_required.length === 0;
  const summary = remoteResumeProbe
    ? "setup status inspected; prior remote setup context found; inspect remote progress before asking first-run questions"
    : ok ? `setup status inspected; resume from ${setupResumeWizard(details).nextIncompleteStep.title}` : "setup status inspected; required pieces are missing";
  return {
    ok,
    summary,
    details: { ...details, setupWizard: setupResumeWizard(details), sideEffects: "none", secretValuesPrinted: false },
  };
}

async function setupInspectDetails(options: SetupInspectOptions) {
  const config = options.config ? await tryLoadValidConfig(options.config) : undefined;
  const workspace = config?.config?.workspaces[options.workspace];
  const repoRoot = path.resolve(options.repo ?? process.cwd());
  const localSetupContext = await readLocalSetupContext(repoRoot, options.workspace);
  const context = localSetupContext.present ? localSetupContext.context : undefined;
  const workspaceRoot = path.resolve(options.path ?? context?.workspaceRoot ?? workspace?.workspacePath ?? defaultWorkspaceRoot(options.workspace));
  const workspaceMeta = await fileMetadata(workspaceRoot);
  const directories = Object.fromEntries(await Promise.all(WORKSPACE_DIRS.map(async (dir) => [dir, await fileMetadata(path.join(workspaceRoot, dir))] as const)));
  const privateConfigCandidates = await Promise.all(["runtime.yaml", "runtime.yml", "runtime.toml", "runtime.json"].map(async (file) => {
    const fullPath = path.join(workspaceRoot, "config", file);
    return { file, metadata: await fileMetadata(fullPath) };
  }));
  const envSources = config?.config ? await workspaceEnvSources(config.config, { workspaceId: options.workspace, workspaceRoot }) : new Map();
  const secretRefs = config?.config ? await secretRefMetadata(collectConfigRefs(config.config), { envSources }) : [];
  const repo = await gitMetadata(repoRoot);
  const backup = setupBackupStatus(workspace, workspaceRoot);
  const webPublishing = setupWebPublishingStatus(workspace);
  const composio = await setupComposioStatus(workspace);
  const transcription = setupTranscriptionStatus(workspace);
  const assistantWorkspace = await assistantWorkspaceParityStatus({ workspaceRoot, workspaceId: options.workspace });
  const serviceName = options.serviceName ?? `brain-${options.workspace}`;
  const service = setupServiceStatus(serviceName, workspaceRoot);
  const plan = buildSetupPlan({
    config,
    workspace,
    workspaceMeta,
    directories,
    privateConfigCandidates,
    backup,
    webPublishing,
    composio,
    transcription,
    assistantWorkspace,
  });

  return {
    workspace: options.workspace,
    workspaceRoot,
    config: config ? {
      path: config.path,
      present: config.present,
      valid: config.ok,
      summary: config.summary,
      issues: config.issues,
    } : {
      path: undefined,
      present: false,
      valid: false,
      summary: "no config path supplied",
      issues: [],
    },
    workspacePathSource: options.path ? "cli" : context?.workspaceRoot ? "local-setup-context" : workspace?.workspacePath ? "config" : "default",
    localSetupContext,
    resumeProbe: buildSetupResumeProbe(localSetupContext, workspaceRoot, options.workspace),
    workspaceDirectory: workspaceMeta,
    directories,
    privateConfigCandidates,
    provider: workspace?.provider ?? "missing",
    serviceUser: options.serviceUser ?? DEFAULT_SERVICE_USER,
    service,
    primaryEntrypointId: workspace?.primaryEntrypointId ?? "missing",
    entrypoints: workspace ? Object.entries(workspace.enabledEntrypoints).map(([entrypointId, entrypoint]) => ({
      entrypointId,
      kind: entrypoint.kind,
      enabled: entrypoint.enabled,
      configRefPresent: Boolean(entrypoint.configRef),
    })) : [],
    secretRefs,
    git: repo,
    backup,
    webPublishing,
    composio,
    transcription,
    assistantWorkspace,
    plan,
    setupState: await readSetupProgress(workspaceRoot),
  };
}

async function readLocalSetupContext(repoRoot: string, workspace: string): Promise<{ present: boolean; path: string; context?: LocalSetupContext; warning?: string; note?: string }> {
  const contextPath = localSetupContextPath(repoRoot);
  const metadata = await fileMetadata(contextPath);
  if (!metadata.present) return { present: false, path: contextPath, note: "no local setup context pointer found" };
  try {
    const parsed = JSON.parse(await readFile(contextPath, "utf8")) as Partial<LocalSetupContext>;
    if (parsed.version !== 1 || (parsed.target !== "local" && parsed.target !== "remote") || typeof parsed.workspaceRoot !== "string") {
      return { present: true, path: contextPath, warning: "local setup context is invalid or unsupported" };
    }
    if ((parsed.workspace ?? workspace) !== workspace) {
      return { present: true, path: contextPath, warning: `local setup context is for workspace ${parsed.workspace}, not ${workspace}` };
    }
    return {
      present: true,
      path: contextPath,
      context: {
        version: 1,
        target: parsed.target,
        workspace,
        workspaceRoot: parsed.workspaceRoot,
        updatedAt: parsed.updatedAt,
        sshHost: parsed.sshHost,
        sshUser: parsed.sshUser,
        serviceUser: parsed.serviceUser,
        bootstrapSshUser: parsed.bootstrapSshUser,
        repoPath: parsed.repoPath,
        configPath: parsed.configPath,
        secretValuesStored: false,
      },
    };
  } catch (error) {
    return { present: true, path: contextPath, warning: `could not parse local setup context: ${errorMessage(error)}` };
  }
}

function localSetupContextPath(repoRoot: string): string {
  return path.join(repoRoot, LOCAL_SETUP_CONTEXT_RELATIVE_PATH);
}

async function writeLocalSetupContext(repoRootInput: string | undefined, context: LocalSetupContext): Promise<SetupContextWriteResult> {
  const repoRoot = path.resolve(repoRootInput ?? process.cwd());
  const contextPath = localSetupContextPath(repoRoot);
  const repoInfo = await stat(repoRoot).catch(() => undefined);
  if (!repoInfo?.isDirectory()) {
    return {
      present: false,
      path: contextPath,
      wrote: false,
      skipped: repoInfo ? "repository root is not a directory; local setup context was not written" : "repository root missing; local setup context was not written",
      context,
    };
  }
  const git = localSetupContextGitSafety(repoRoot);
  if (!git.safe) {
    return {
      present: false,
      path: contextPath,
      wrote: false,
      skipped: git.reason ?? "refusing to write local setup context to a git-managed path",
      context,
      git,
    };
  }
  try {
    await mkdir(path.dirname(contextPath), { recursive: true, mode: 0o700 });
    await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
    await chmod(contextPath, 0o600);
    return { present: true, path: contextPath, wrote: true, metadata: await fileMetadata(contextPath), context, git };
  } catch (error) {
    return {
      present: false,
      path: contextPath,
      wrote: false,
      skipped: `could not write local setup context: ${errorMessage(error)}`,
      context,
      git,
    };
  }
}

function localSetupContextGitSafety(repoRoot: string): SetupContextGitSafety {
  const inside = spawnSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if ((inside.status ?? 0) !== 0 || inside.stdout.trim() !== "true") {
    return { insideWorkTree: false, safe: true };
  }
  const tracked = spawnSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", LOCAL_SETUP_CONTEXT_RELATIVE_PATH], { encoding: "utf8" });
  if ((tracked.status ?? 0) === 0) {
    return {
      insideWorkTree: true,
      tracked: true,
      ignored: false,
      safe: false,
      reason: "refusing to write setup context because private/setup-context.json is tracked by git",
    };
  }
  const ignored = spawnSync("git", ["-C", repoRoot, "check-ignore", "--quiet", "--", LOCAL_SETUP_CONTEXT_RELATIVE_PATH], { encoding: "utf8" });
  if ((ignored.status ?? 0) !== 0) {
    return {
      insideWorkTree: true,
      tracked: false,
      ignored: false,
      safe: false,
      reason: "refusing to write setup context because private/setup-context.json is not ignored by git",
    };
  }
  return { insideWorkTree: true, tracked: false, ignored: true, safe: true };
}

function setupContextWriteSummary(result: SetupContextWriteResult, includeContext = false): Record<string, unknown> {
  return {
    present: result.present,
    path: result.path,
    wrote: result.wrote,
    mode: result.metadata?.mode,
    sizeBytes: result.metadata?.sizeBytes,
    skipped: result.skipped,
    warning: result.warning,
    git: result.git,
    context: includeContext ? result.context : result.context ? {
      target: result.context.target,
      workspace: result.context.workspace,
      secretValuesStored: false,
    } : undefined,
  };
}

function buildSetupResumeProbe(
  localSetupContext: Awaited<ReturnType<typeof readLocalSetupContext>>,
  workspaceRoot: string,
  workspace: string,
) {
  const context = localSetupContext.context;
  if (!context) {
    return {
      target: "unknown",
      firstAction: "check-local-default-progress",
      progressPath: setupProgressPath(workspaceRoot),
      note: "No local setup context pointer was found; inspect the default/private workspace before asking first-run questions, then ask for any prior remote target if progress is absent.",
    };
  }
  if (context.target === "remote") {
    const progressPath = setupProgressPath(context.workspaceRoot);
    const remoteRepo = context.repoPath ?? "<remote-brain-checkout>";
    const remoteStatusCommand = `cd ${shellArg(remoteRepo)} && pnpm run brainctl setup status --workspace ${shellArg(workspace)} --path ${shellArg(context.workspaceRoot)}${context.configPath ? ` --config ${shellArg(context.configPath)}` : ""}`;
    const sshDestination = context.sshHost ? remoteSshDestination(context.sshHost, context.sshUser) : undefined;
    return {
      target: "remote",
      firstAction: "inspect-remote-progress",
      progressPath,
      sshHost: context.sshHost ?? "<ssh-host>",
      sshUser: context.sshUser,
      bootstrapSshUser: context.bootstrapSshUser,
      command: sshDestination ? `ssh ${shellArg(sshDestination)} ${shellArg(remoteStatusCommand)}` : `ssh <ssh-host> ${shellArg(remoteStatusCommand)}`,
      note: "Prior setup context points at a remote workspace. Ask only for permission or a missing SSH host, then run this remote metadata check before restarting the setup wizard.",
    };
  }
  return {
    target: "local",
    firstAction: "inspect-local-progress",
    progressPath: setupProgressPath(context.workspaceRoot),
    command: `pnpm run brainctl setup status --workspace ${shellArg(workspace)} --path ${shellArg(context.workspaceRoot)}${context.configPath ? ` --config ${shellArg(context.configPath)}` : ""}`,
    note: "Prior setup context points at a local private workspace; inspect this progress before asking first-run setup questions.",
  };
}

function remoteSshDestination(host: string, user: string | undefined): string {
  if (!user || host.includes("@")) return host;
  return `${user}@${host}`;
}

function buildSetupPlan(input: {
  config?: Awaited<ReturnType<typeof tryLoadValidConfig>>;
  workspace?: WorkspaceConfig;
  workspaceMeta: Awaited<ReturnType<typeof fileMetadata>>;
  directories: Record<string, Awaited<ReturnType<typeof fileMetadata>>>;
  privateConfigCandidates: Array<{ file: string; metadata: Awaited<ReturnType<typeof fileMetadata>> }>;
  backup: ReturnType<typeof setupBackupStatus>;
  webPublishing: ReturnType<typeof setupWebPublishingStatus>;
  composio: Awaited<ReturnType<typeof setupComposioStatus>>;
  transcription: ReturnType<typeof setupTranscriptionStatus>;
  assistantWorkspace: Awaited<ReturnType<typeof assistantWorkspaceParityStatus>>;
}) {
  const configured: string[] = [];
  const missing_required: string[] = [];
  const missing_optional: string[] = [];
  const unsafe_to_overwrite: string[] = [];

  if (input.config?.ok) configured.push("runtime config valid");
  else missing_required.push(input.config?.present ? "runtime config is invalid" : "runtime config missing");

  if (input.workspace) configured.push("workspace config present");
  else missing_required.push("workspace id missing from runtime config");

  if (input.workspaceMeta.present) configured.push("workspace root exists");
  else missing_required.push("workspace root missing");

  for (const [dir, metadata] of Object.entries(input.directories)) {
    if (metadata.present) configured.push(`workspace ${dir}/ exists`);
    else missing_required.push(`workspace ${dir}/ missing`);
  }

  if (input.assistantWorkspace.assistantRepoMetadata.present && input.assistantWorkspace.scripts.every((script) => script.present)) {
    configured.push("assistant-logic native and vendored commands available for full workspace parity");
  } else {
    missing_required.push("assistant-logic package/native/vendored commands missing for workspace parity");
  }

  for (const store of input.assistantWorkspace.stateStores) {
    if (store.present && store.valid) configured.push(`assistant JSON store ready: ${store.key}`);
    else missing_required.push(`assistant JSON store missing or invalid: ${store.relativePath}`);
  }

  if (input.assistantWorkspace.instructions.ready) configured.push("workspace instruction/skill overlays scaffolded");
  else missing_required.push("workspace instruction/skill overlay scaffold missing");

  if (input.assistantWorkspace.tasks.ready) configured.push("workspace tasks scaffolded");
  else missing_required.push("workspace tasks scaffold missing");

  if (input.assistantWorkspace.fileSave.ready) configured.push("file-save private document metadata scaffolded");
  else missing_required.push("file-save private document metadata scaffold missing");

  if (input.assistantWorkspace.repoRegistry.ready) configured.push("selected repo-registry state path scaffolded");
  else missing_optional.push("selected repo-registry state path not scaffolded");

  if (input.workspace?.provider) configured.push(`provider selected: ${input.workspace.provider}`);
  else missing_required.push("provider choice missing");

  if (input.workspace?.primaryEntrypointId) configured.push(`primary entrypoint selected: ${input.workspace.primaryEntrypointId}`);
  else missing_required.push("primary entrypoint missing");

  for (const candidate of input.privateConfigCandidates) {
    if (candidate.metadata.present) unsafe_to_overwrite.push(`private config already exists: config/${candidate.file}`);
  }

  if (input.backup.strategy === "none") missing_optional.push("private Git/local snapshot backup not configured");
  else configured.push(`backup strategy configured: ${input.backup.strategy}`);

  if (!input.webPublishing.enabled) missing_optional.push("web publishing not configured/enabled");
  else configured.push("web publishing config present");

  if (!input.composio.enabled) missing_optional.push("Composio Google Calendar/chat not configured/enabled");
  else configured.push("Composio integration config present");

  if (!input.transcription.enabled) missing_optional.push("voice/audio transcription not configured/enabled");
  else if (!input.transcription.apiKeyRefPresent) missing_required.push("OpenAI transcription API key ref missing");
  else configured.push("OpenAI voice/audio transcription config present");

  return { configured, missing_required, missing_optional, unsafe_to_overwrite };
}

function setupResumeWizard(details: {
  workspaceRoot: string;
  serviceUser?: string;
  service?: ReturnType<typeof setupServiceStatus>;
  config: { present: boolean; valid: boolean };
  workspaceDirectory: Awaited<ReturnType<typeof fileMetadata>>;
  directories: Record<string, Awaited<ReturnType<typeof fileMetadata>>>;
  provider: unknown;
  primaryEntrypointId: unknown;
  entrypoints: Array<{ kind: string; enabled: boolean; configRefPresent: boolean }>;
  secretRefs: Array<Record<string, unknown>>;
  backup?: ReturnType<typeof setupBackupStatus>;
  composio?: Awaited<ReturnType<typeof setupComposioStatus>>;
  transcription?: ReturnType<typeof setupTranscriptionStatus>;
  webPublishing?: ReturnType<typeof setupWebPublishingStatus>;
  assistantWorkspace?: Awaited<ReturnType<typeof assistantWorkspaceParityStatus>>;
  setupState?: Awaited<ReturnType<typeof readSetupProgress>>;
}) {
  const workspaceReady = details.workspaceDirectory.present && WORKSPACE_DIRS.every((dir) => details.directories[dir]?.present);
  const personalWorkspaceReady = Boolean(details.assistantWorkspace?.ready)
    && ["projects", "notes", "documents", path.join("documents", "metadata")].every((dir) => details.directories[dir]?.present);
  const runtimeConfigReady = details.config.present && details.config.valid && details.provider !== "missing" && details.primaryEntrypointId !== "missing";
  const telegramEntrypoint = details.entrypoints.find((entrypoint) => entrypoint.kind === "telegram" && entrypoint.enabled);
  const telegramSecretRefPresent = Boolean(telegramEntrypoint?.configRefPresent && details.secretRefs.some((ref) => ref.source === "entrypoint.configRef" && ref.present === true));
  const backupConfigured = Boolean(details.backup && details.backup.strategy !== "none");
  const composioConnected = Boolean(details.composio?.enabled && details.composio.missing.length === 0);
  const state = details.setupState?.state;
  const codexAuthUser = state?.statuses.codexAuth.runAsUser;
  const codexAuthVerifiedByState = codexAuthMatchesServiceUser(state?.statuses.codexAuth, details.serviceUser);
  const serviceActiveForWorkspace = details.service?.active === true && details.service.workspaceMatched !== false;
  const serviceStarted = serviceActiveForWorkspace || state?.statuses.service.started === true;
  const serviceInstalled = details.service?.installed === true || state?.statuses.service.installed === true || serviceStarted;
  const steps = [
    {
      step: "telegram-connection",
      title: "Connect Telegram.",
      complete: telegramSecretRefPresent,
      evidence: telegramSecretRefPresent
        ? ["Telegram entrypoint secret ref is present by metadata only; value was not printed."]
        : ["Telegram token/private entrypoint secret metadata is missing or not inspectable."],
      botFatherSteps: botFatherSteps(),
      resumePrompt: "Create or choose the bot, store its token only as a private secret ref, and validate metadata before live polling.",
    },
    {
      step: "personal-workspace",
      title: "Create personal workspace memory.",
      complete: personalWorkspaceReady,
      evidence: personalWorkspaceReady
        ? [`Assistant JSON stores, instruction overlays, task metadata, file-save metadata, and markdown resource directories exist under ${details.workspaceRoot}.`]
        : ["Assistant JSON stores, instruction overlays, task metadata, file-save metadata, repo-registry state path, or markdown resource directories are missing; create them before the first live provider turn."],
      resumePrompt: "Create the private JSON-backed assistant workspace scaffold, then ask whether the user wants to initialize a private Git backup for workspace state.",
    },
    {
      step: "private-data-repo",
      title: "Pull or initialize private data/backup repo.",
      complete: backupConfigured,
      evidence: backupConfigured
        ? [`Backup/private data strategy configured: ${details.backup?.strategy}.`]
        : ["Private data/backup repo is not configured; choose a private-git remote to pull or initialize a private local repo."],
      resumePrompt: "Use backup plan/init after confirming the private repo path or remote; secret values remain excluded by default.",
    },
    {
      step: "composio-accounts",
      title: "Connect Composio accounts.",
      complete: composioConnected || details.composio?.enabled === false,
      evidence: composioConnected
        ? ["Composio API and connected-account refs are present by metadata only."]
        : details.composio?.enabled === false
          ? ["Composio is disabled for this workspace; skip unless the user wants calendar/chat data sources."]
          : [`Composio refs missing: ${details.composio?.missing.join(", ") || "account metadata"}.`],
      resumePrompt: "Connect Composio only if this workspace needs Google Calendar or chat data-source access.",
    },
    {
      step: "essential-runtime-choices",
      title: "Confirm essential runtime choices.",
      complete: workspaceReady && runtimeConfigReady,
      evidence: workspaceReady && runtimeConfigReady
        ? [`Workspace directories exist under ${details.workspaceRoot}.`, "Runtime config is present, valid, and selects provider/primary entrypoint."]
        : ["Workspace scaffold, runtime config, provider, or primary entrypoint is still missing/invalid."],
      resumePrompt: "Keep path/log/state details in verbose/status output unless the user asks for implementation details.",
    },
    {
      step: "workspace-scaffold",
      title: "Create private workspace scaffold.",
      complete: workspaceReady,
      evidence: workspaceReady ? [`Workspace directories exist under ${details.workspaceRoot}.`] : ["Workspace root or required directories are missing."],
    },
    {
      step: "runtime-config",
      title: "Validate runtime config.",
      complete: runtimeConfigReady,
      evidence: runtimeConfigReady ? ["Runtime config is present, valid, and selects provider/primary entrypoint."] : ["Runtime config, provider, or primary entrypoint is still missing/invalid."],
    },
    {
      step: "configure-verify-codex-auth",
      title: "Verify Codex auth before service start.",
      complete: codexAuthVerifiedByState,
      evidence: codexAuthVerifiedByState
        ? [`Private setup state says Codex auth was verified as ${codexAuthUser}; rerun a provider health check if the session may have changed.`]
        : details.provider === "codex"
          ? [codexAuthUser
              ? `Codex auth was verified as ${codexAuthUser}, but the service user is ${details.serviceUser ?? "unknown"}; verify auth as the service user before service start.`
              : "Codex is selected; credential/session verification needs an explicit private check as the service user and is not inferred from repo files."]
          : [`Selected provider is ${String(details.provider)}; verify provider auth before service start.`],
      actions: [
        "Generate a guarded helper on the target host with: pnpm run brainctl setup codex-auth-script --config <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root> --service-user <brain-service-user>",
        "Run the returned command as the same OS user that will run Brain; for systemd this is usually the non-root service user.",
        "If login is missing, the helper prints `codex login --device-auth` / `codex login` instructions and exits without marking auth verified.",
      ],
      resumePrompt: "If you already verified Codex auth in the previous session, confirm or recheck it and continue to service install/start.",
    },
    {
      step: "install-start-service",
      title: "Install and start the Brain service.",
      complete: serviceStarted,
      evidence: serviceStarted
        ? [`Service ${details.service?.serviceName ?? "Brain"} is active by systemd metadata.`]
        : serviceInstalled
          ? [`Service ${details.service?.serviceName ?? "Brain"} is installed but not active; start it after Codex auth and token metadata are verified.`]
        : ["Service installation/start is never assumed by setup status; verify Codex auth first, then review the systemd plan and require explicit confirmation."],
      resumePrompt: "If the service is already installed and running, confirm with health/status output before accepting Telegram traffic.",
    },
    {
      step: "optional-follow-ups",
      title: "Optional follow-ups.",
      complete: false,
      evidence: [
        details.transcription?.enabled ? "OpenAI transcription is configured." : "OpenAI transcription can be enabled after the base Telegram flow works.",
        details.webPublishing?.enabled ? "Web publishing is configured." : "Web publishing can be configured after the service path is stable.",
        "First-user pairing happens after the service starts with the Telegram token; raw user/chat IDs stay private.",
      ],
      resumePrompt: "Handle first-user pairing, OpenAI transcription, web publishing, or backup tuning only when requested or when the base setup is ready.",
    },
  ];
  const completedSteps = steps.filter((step) => step.complete).map((step) => ({ step: step.step, title: step.title, evidence: step.evidence }));
  const nextIncompleteStep = steps.find((step) => !step.complete) ?? {
    step: "ready-for-live",
    title: "Ready for explicit live confirmation.",
    complete: false,
    evidence: ["All inspectable setup steps are complete."],
  };
  return {
    resumable: true,
    idempotent: true,
    stateFile: details.setupState?.path ?? setupProgressPath(details.workspaceRoot),
    stateFilePresent: Boolean(details.setupState?.present),
    stateIsPrivateMetadataOnly: true,
    stateTrust: "Private setup state is used as a resume aid only; current metadata/live checks still decide whether it is safe to continue.",
    completedSteps,
    nextIncompleteStep,
    sequence: steps,
    note: "On rerun, setup inspects current state and resumes at the next incomplete step instead of restarting or overwriting defaults.",
  };
}

function setupServiceStatus(serviceName: string, workspaceRoot?: string): {
  serviceName: string;
  inspected: boolean;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  source: string;
  workspaceMatched?: boolean;
} {
  const runSystemctl = (args: string[]) => spawnSync("systemctl", args, { encoding: "utf8" });
  const show = runSystemctl(["show", `${serviceName}.service`, "--property=LoadState", "--value"]);
  if (show.error || (show.status ?? 1) !== 0) {
    return { serviceName, inspected: false, installed: false, enabled: false, active: false, source: "systemctl-unavailable" };
  }
  const loadState = String(show.stdout ?? "").trim();
  const execStart = runSystemctl(["show", `${serviceName}.service`, "--property=ExecStart", "--value"]);
  const execStartText = (execStart.status ?? 1) === 0 ? String(execStart.stdout ?? "").trim() : "";
  const workspaceMatched = workspaceRoot && execStartText.includes(workspaceRoot)
    ? true
    : workspaceRoot && /(?:^|\s)(?:ExecStart=|\{|\w+=|\/)/.test(execStartText)
      ? false
      : undefined;
  const enabled = runSystemctl(["is-enabled", `${serviceName}.service`]);
  const active = runSystemctl(["is-active", `${serviceName}.service`]);
  return {
    serviceName,
    inspected: true,
    installed: loadState === "loaded",
    enabled: (enabled.status ?? 1) === 0,
    active: (active.status ?? 1) === 0,
    source: "systemctl",
    workspaceMatched,
  };
}

interface SetupProgressState {
  version: 1;
  workspace: string;
  workspaceRoot: string;
  updatedAt: string;
  completedSteps: string[];
  statuses: {
    workspace: { configured: boolean };
    runtimeConfig: { valid: boolean };
    codexAuth: { status: "unknown" | "pending" | "verified"; metadataOnly: true; checkedAt?: string; runAsUser?: string };
    service: { installed: boolean; started: boolean; metadataOnly: true; checkedAt?: string };
    telegramToken: { configured: boolean; metadataOnly: true; source?: string; checkedAt?: string };
  };
  nextRecommendedStep: string;
  secretValuesStored: false;
}

function setupProgressPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "state", SETUP_PROGRESS_FILE);
}

async function readSetupProgress(workspaceRoot: string): Promise<{ present: boolean; path: string; state?: SetupProgressState; metadata?: Awaited<ReturnType<typeof fileMetadata>>; warning?: string }> {
  const progressPath = setupProgressPath(workspaceRoot);
  const metadata = await fileMetadata(progressPath);
  if (!metadata.present) return { present: false, path: progressPath, metadata };
  try {
    const parsed = JSON.parse(await readFile(progressPath, "utf8")) as SetupProgressState;
    return { present: true, path: progressPath, metadata, state: redactSetupProgress(parsed) };
  } catch (error) {
    return { present: true, path: progressPath, metadata, warning: `could not parse setup progress state: ${errorMessage(error)}` };
  }
}

async function writeSetupProgress(details: Awaited<ReturnType<typeof setupInspectDetails>>, wizard: ReturnType<typeof setupResumeWizard>) {
  const progressPath = setupProgressPath(details.workspaceRoot);
  const telegramSecretRef = details.secretRefs.find((ref) => ref.source === "entrypoint.configRef" && ref.present === true);
  const prior = details.setupState?.state;
  const state: SetupProgressState = {
    version: 1,
    workspace: details.workspace,
    workspaceRoot: details.workspaceRoot,
    updatedAt: new Date().toISOString(),
    completedSteps: wizard.completedSteps.map((step) => step.step),
    statuses: {
      workspace: { configured: wizard.sequence.find((step) => step.step === "workspace-scaffold")?.complete === true },
      runtimeConfig: { valid: details.config.valid },
      codexAuth: prior?.statuses.codexAuth ?? { status: "pending", metadataOnly: true },
      service: {
        installed: details.service?.installed === true || prior?.statuses.service.installed === true,
        started: details.service?.active === true || prior?.statuses.service.started === true,
        metadataOnly: true,
        checkedAt: new Date().toISOString(),
      },
      telegramToken: {
        configured: Boolean(telegramSecretRef),
        metadataOnly: true,
        source: typeof telegramSecretRef?.kind === "string" ? telegramSecretRef.kind : undefined,
        checkedAt: new Date().toISOString(),
      },
    },
    nextRecommendedStep: wizard.nextIncompleteStep.step,
    secretValuesStored: false,
  };
  await mkdir(path.dirname(progressPath), { recursive: true, mode: 0o700 });
  await writeFile(progressPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(progressPath, 0o600);
  const metadata = await fileMetadata(progressPath);
  return { present: true, path: progressPath, metadata, state: redactSetupProgress(state), wrote: true };
}

async function updateSetupProgressFromLiveValidation(
  workspaceRoot: string,
  options: { workspace: string; telegramTokenEnv?: string; telegramTokenFile?: string; codexTransport: string; allowLive?: boolean },
  results: SafeValidationResult[],
) {
  const workspaceMetadata = await fileMetadata(workspaceRoot);
  const progressPath = setupProgressPath(workspaceRoot);
  if (!workspaceMetadata.present) return { present: false, path: progressPath, wrote: false, skipped: "workspace root missing; setup progress state was not updated" };
  const prior = await readSetupProgress(workspaceRoot);
  const now = new Date().toISOString();
  const resultOk = (id: string) => results.find((result) => result.id === id)?.ok === true;
  const codexVerified = resultOk("codex-provider") && Boolean(options.allowLive) && options.codexTransport !== "stub";
  const runAsUser = os.userInfo().username;
  const telegramConfigured = resultOk("telegram-entrypoint") && telegramTokenPresent(results.find((result) => result.id === "telegram-entrypoint"));
  const priorState = prior.state;
  const statuses: SetupProgressState["statuses"] = {
    workspace: { configured: true },
    runtimeConfig: { valid: resultOk("config") },
    codexAuth: codexVerified
      ? { status: "verified", metadataOnly: true, checkedAt: now, runAsUser }
      : priorState?.statuses.codexAuth ?? { status: "pending", metadataOnly: true, checkedAt: now },
    service: priorState?.statuses.service ?? { installed: false, started: false, metadataOnly: true },
    telegramToken: telegramConfigured
      ? { configured: true, metadataOnly: true, source: options.telegramTokenEnv ? "env" : "file", checkedAt: now }
      : priorState?.statuses.telegramToken ?? { configured: false, metadataOnly: true, checkedAt: now },
  };
  const completedSteps = [
    "workspace-scaffold",
    ...(statuses.runtimeConfig.valid ? ["runtime-config"] : []),
    ...(statuses.codexAuth.status === "verified" ? ["configure-verify-codex-auth"] : []),
    ...(statuses.service.started ? ["install-start-service"] : []),
    ...(statuses.telegramToken.configured ? ["telegram-connection"] : []),
  ];
  const nextRecommendedStep = statuses.codexAuth.status !== "verified"
    ? "configure-verify-codex-auth"
    : !statuses.telegramToken.configured
      ? "telegram-connection"
      : !statuses.service.started
        ? "install-start-service"
        : "first-user-pairing";
  const state: SetupProgressState = {
    version: 1,
    workspace: priorState?.workspace ?? options.workspace,
    workspaceRoot,
    updatedAt: now,
    completedSteps,
    statuses,
    nextRecommendedStep,
    secretValuesStored: false,
  };
  await mkdir(path.dirname(progressPath), { recursive: true, mode: 0o700 });
  await writeFile(progressPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(progressPath, 0o600);
  return { present: true, path: progressPath, metadata: await fileMetadata(progressPath), state: redactSetupProgress(state), wrote: true };
}

function telegramTokenPresent(result: SafeValidationResult | undefined): boolean {
  const details = result?.details;
  if (!details || typeof details !== "object" || !("token" in details)) return false;
  const token = (details as { token?: unknown }).token;
  return Boolean(token && typeof token === "object" && "present" in token && (token as { present?: unknown }).present === true);
}

function codexAuthMatchesServiceUser(
  codexAuth: SetupProgressState["statuses"]["codexAuth"] | undefined,
  serviceUser: string | undefined,
): boolean {
  if (codexAuth?.status !== "verified") return false;
  if (!serviceUser) return Boolean(codexAuth.runAsUser);
  return codexAuth.runAsUser === serviceUser;
}

function redactSetupProgress(state: SetupProgressState): SetupProgressState {
  return {
    ...state,
    secretValuesStored: false,
    statuses: {
      ...state.statuses,
      telegramToken: {
        configured: Boolean(state.statuses.telegramToken.configured),
        metadataOnly: true,
        source: state.statuses.telegramToken.source,
        checkedAt: state.statuses.telegramToken.checkedAt,
      },
      codexAuth: {
        status: state.statuses.codexAuth.status,
        metadataOnly: true,
        checkedAt: state.statuses.codexAuth.checkedAt,
        runAsUser: state.statuses.codexAuth.runAsUser,
      },
    },
  };
}

async function tryLoadValidConfig(file: string): Promise<{ path: string; present: boolean; ok: boolean; summary: string; issues: unknown[]; config?: BrainConfig }> {
  const configPath = path.resolve(file);
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parseConfigText(configPath, raw);
    const validation = validateWorkspaceConfig(parsed);
    return {
      path: configPath,
      present: true,
      ok: validation.ok,
      summary: validation.ok ? "runtime config valid" : "runtime config invalid",
      issues: validation.issues,
      config: validation.config,
    };
  } catch (error) {
    return { path: configPath, present: false, ok: false, summary: "runtime config could not be read", issues: [{ path: configPath, message: errorMessage(error) }] };
  }
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
  const details = await secretRefMetadata(refs, { envSources: await workspaceEnvSources(validation.config) });
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

async function configuredCodexContext(options: { config?: string; workspace: string; cwd?: string }): Promise<{ ok: true; transcriptionApiKeyRef?: string; cwd: string; tmpDir?: string } | { ok: false; result: CliResult }> {
  if (!options.config) return { ok: true, cwd: options.cwd ?? process.cwd() };
  const loaded = await loadValidConfig(options.config);
  if (!loaded.ok || !loaded.config) {
    return { ok: false, result: { ok: false, summary: "cannot load runtime config for provider check", details: loaded.details } };
  }
  const workspace = loaded.config.workspaces[options.workspace];
  if (!workspace) {
      return { ok: false, result: { ok: false, summary: `workspace not found: ${options.workspace}`, details: { available: Object.keys(loaded.config.workspaces) } } };
  }
  return { ok: true, transcriptionApiKeyRef: workspace.transcription?.apiKeyRef, cwd: options.cwd ?? workspace.workspacePath ?? process.cwd(), tmpDir: path.join(workspace.workspacePath, "tmp") };
}

async function providerCheckCommand(providerId: string, options: { config?: string; workspace: string; transport?: string; binary?: string; cwd?: string; appServerUrl?: string; timeoutMs?: number }): Promise<CliResult> {
  const normalized = providerId.toLowerCase();
  const codexContext = normalized === "codex" ? await configuredCodexContext(options) : { ok: true as const, transcriptionApiKeyRef: undefined, cwd: options.cwd ?? process.cwd(), tmpDir: undefined };
  if (!codexContext.ok) return codexContext.result;
  const adapter = normalized === "codex"
    ? createCodexProvider({ transport: (options.transport as CodexTransportKind | undefined) ?? "stub", binary: options.binary, cwd: codexContext.cwd, tmpDir: codexContext.tmpDir, sandbox: "danger-full-access", approvalPolicy: "never", skipGitRepoCheck: true, appServerUrl: options.appServerUrl, timeoutMs: options.timeoutMs, appServerStartupTimeoutMs: options.timeoutMs, transcriptionApiKeyRef: codexContext.transcriptionApiKeyRef })
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

async function providerSmokeCommand(providerId: string, options: { config?: string; workspace: string; transport?: string; binary?: string; cwd?: string; appServerUrl?: string; timeoutMs?: number; prompt: string; allowLive?: boolean }): Promise<CliResult> {
  const transport = options.transport ?? "stub";
  if (transport !== "stub" && !options.allowLive) {
    return {
      ok: true,
      summary: `${providerId} provider smoke planned but not run; pass --allow-live for non-stub transports`,
      details: { provider: providerId, transport, taskStarted: false, guard: "non-stub provider turns require --allow-live" },
    };
  }
  const normalized = providerId.toLowerCase();
  const codexContext = normalized === "codex" ? await configuredCodexContext(options) : { ok: true as const, transcriptionApiKeyRef: undefined, cwd: options.cwd ?? process.cwd(), tmpDir: undefined };
  if (!codexContext.ok) return codexContext.result;
  const adapter = normalized === "codex"
    ? createCodexProvider({ transport: transport as CodexTransportKind, binary: options.binary, cwd: codexContext.cwd, tmpDir: codexContext.tmpDir, sandbox: "danger-full-access", approvalPolicy: "never", skipGitRepoCheck: true, appServerUrl: options.appServerUrl, timeoutMs: options.timeoutMs, appServerStartupTimeoutMs: options.timeoutMs, transcriptionApiKeyRef: codexContext.transcriptionApiKeyRef })
    : normalized === "claude-code" || normalized === "claude"
      ? createClaudeCodeProvider({ transport: transport as ClaudeCodeTransportKind })
      : undefined;
  if (!adapter) return { ok: false, summary: `unknown provider: ${providerId}`, details: { supported: ["codex", "claude-code"] } };
  const session = await adapter.createSession({ workspaceId: options.workspace, metadata: { check: "brainctl provider smoke" } });
  const events: ProviderTurnEvent[] = [];
  try {
    await session.start();
    for await (const event of session.sendTurn({
      id: "brainctl_provider_smoke_turn",
      sessionId: session.id,
      inboundEvent: {
        id: "brainctl_provider_smoke_event",
        kind: "message",
        workspaceId: options.workspace,
        entrypoint: { entrypointId: "brainctl", channelKind: "cli", displayName: "brainctl" },
        text: options.prompt,
        receivedAt: new Date().toISOString(),
      },
      prompt: options.prompt,
    })) events.push(event);
    const finalEvent = [...events].reverse().find((event): event is Extract<ProviderTurnEvent, { type: "final" }> => event.type === "final");
    const finalText = finalEvent?.text;
    const errors = events.filter((event) => event.type === "error").map((event) => event.message);
    return {
      ok: errors.length === 0 && Boolean(finalText || events.some((event) => event.type === "delta")),
      summary: errors.length === 0 ? `${adapter.id} provider smoke completed` : `${adapter.id} provider smoke reported errors`,
      details: {
        provider: adapter.id,
        transport,
        taskStarted: true,
        eventTypes: events.map((event) => event.type),
        finalText,
        errors,
        resumeHandle: await session.resumeHandle?.(),
      },
    };
  } catch (error) {
    return { ok: false, summary: `${adapter.id} provider smoke failed`, details: { provider: adapter.id, transport, taskStarted: true, error: errorMessage(error), eventTypes: events.map((event) => event.type) } };
  } finally {
    await session.stop().catch(() => undefined);
  }
}

async function entrypointCheckCommand(entrypointId: string, options: { workspace: string; tokenEnv?: string; tokenFile?: string; pollingState?: string; pairingState?: string }): Promise<CliResult> {
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
    const pairing = options.pairingState
      ? await telegramPairingStateMetadata(path.resolve(options.pairingState))
      : undefined;
    return {
      ok: health.ok,
      summary: "telegram entrypoint boundary check passed",
      details: { health, liveTokenRequired: false, token: token ? { present: token.present, source: token.source, redacted: token.redacted } : "not checked", polling, pairing, pollingStarted: false, webhookStarted: false },
    };
  } finally {
    await adapter.stop();
  }
}

async function telegramPairingStateMetadata(stateDir: string): Promise<Record<string, unknown>> {
  const store = new FileTelegramPairingStore(stateDir);
  const [users, chats, code] = await Promise.all([store.listUsers(), store.listChats(), store.readPairingCode()]);
  return {
    stateDir,
    users: users.length,
    chats: chats.length,
    codePresent: Boolean(code),
    rawIdentifiersPrinted: false,
  };
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

async function automationRunCommand(loopId: string, options: { file: string; workspace: string; dryRun?: boolean; dispatch?: boolean; state?: string; artifacts?: string }): Promise<CliResult> {
  const record = await readAutomationConfig(options.file);
  const harness = options.dispatch ? await createAutomationHarness(options.workspace, options) : undefined;
  const runtime = new AutomationRuntime({ workspaceId: options.workspace, loops: record.loops ?? [], monitors: record.monitors ?? [], ...(harness ?? {}) });
  const dryRun = options.dispatch ? false : options.dryRun !== false;
  const result = await runtime.runLoopOnce(loopId, { dryRun });
  await harness?.subagents.waitForIdle().catch(() => undefined);
  return {
    ok: ["dry_run", "dispatched", "executed"].includes(result.status),
    summary: result.status === "dry_run" ? "loop dry-run evaluated without cron side effects" : `loop ${result.status}`,
    details: { result, stateRoot: harness?.stateRoot, artifactRoot: harness?.artifactRoot, safeDefault: "no crontab or watcher was installed" },
  };
}

async function automationDueCommand(options: { file: string; workspace: string; now?: string; dryRun?: boolean; dispatch?: boolean; state?: string; artifacts?: string }): Promise<CliResult> {
  const record = await readAutomationConfig(options.file);
  const harness = options.dispatch ? await createAutomationHarness(options.workspace, options) : undefined;
  const runtime = new AutomationRuntime({
    workspaceId: options.workspace,
    loops: record.loops ?? [],
    monitors: record.monitors ?? [],
    ...(harness ?? {}),
    now: options.now ? () => new Date(options.now as string) : undefined,
  });
  const results = await runtime.runDueLoops({ dryRun: options.dispatch ? false : options.dryRun !== false, now: options.now ? new Date(options.now) : undefined });
  await harness?.subagents.waitForIdle().catch(() => undefined);
  return {
    ok: results.every((result) => ["dry_run", "dispatched", "executed"].includes(result.status)),
    summary: results.length === 0 ? "no loops due; no cron side effects" : "due loops evaluated without cron side effects",
    details: { results, stateRoot: harness?.stateRoot, artifactRoot: harness?.artifactRoot, safeDefault: "no crontab or watcher was installed" },
  };
}

async function automationMonitorCommand(monitorId: string, options: { file: string; workspace: string; line: string; context?: string; dryRun?: boolean; dispatch?: boolean; state?: string; artifacts?: string }): Promise<CliResult> {
  const record = await readAutomationConfig(options.file);
  const harness = options.dispatch ? await createAutomationHarness(options.workspace, options) : undefined;
  const runtime = new AutomationRuntime({ workspaceId: options.workspace, loops: record.loops ?? [], monitors: record.monitors ?? [], ...(harness ?? {}) });
  const result = await runtime.runMonitorOnce(monitorId, { line: options.line, context: options.context, dryRun: options.dispatch ? false : options.dryRun !== false });
  await harness?.subagents.waitForIdle().catch(() => undefined);
  return {
    ok: ["dry_run", "dispatched", "notified"].includes(result.status),
    summary: result.status === "dry_run" ? "monitor dry-run evaluated without watcher side effects" : `monitor ${result.status}`,
    details: { result, stateRoot: harness?.stateRoot, artifactRoot: harness?.artifactRoot, safeDefault: "no watcher or long-running monitor was installed" },
  };
}

async function createAutomationHarness(workspace: string, options: { state?: string; artifacts?: string }) {
  const paths = supervisorPaths(workspace, options);
  const store = new FileSubagentJobStore({ root: paths.stateRoot });
  const subagents = new SubagentLifecycle({
    workspaceId: workspace,
    store,
    executor: new StaticSubagentExecutor({ id: "brainctl-automation-static", outputText: "Automation fake dispatch completed." }),
    artifactRoot: paths.artifactRoot,
  });
  await subagents.init();
  return {
    stateRoot: paths.stateRoot,
    artifactRoot: paths.artifactRoot,
    subagents,
    spool: new FileAutomationSpool(paths.stateRoot),
    locks: new FileAutomationLockStore(paths.stateRoot),
    notifier: {
      async notifyAdmins(_text: string) {},
      async enqueueMain(_text: string) {},
    },
    commandRunner: {
      async run(command: string, args: string[]) {
        const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
        return { exitCode: result.status ?? (result.error ? 1 : 0), stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error?.message ?? "") };
      },
    },
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
      backup: { strategy: workspace.backup?.strategy ?? "none" },
      webPublishing: { enabled: workspace.webPublishing?.enabled ?? false, mode: workspace.webPublishing?.mode ?? "disabled" },
      composio: { enabled: workspace.integrations?.composio?.enabled ?? false },
      transcription: setupTranscriptionStatus(workspace),
    }])),
  };
}

function collectConfigRefs(config: BrainConfig): ConfigRef[] {
  const refs: ConfigRef[] = [];
  for (const [workspaceId, workspace] of Object.entries(config.workspaces)) {
    for (const [entrypointId, entrypoint] of Object.entries(workspace.enabledEntrypoints)) {
      if (entrypoint.configRef) refs.push({ workspaceId, entrypointId, ref: entrypoint.configRef, source: "entrypoint.configRef" });
    }
    const composio = workspace.integrations?.composio;
    if (composio?.apiKeyRef) refs.push({ workspaceId, ref: composio.apiKeyRef, source: "integrations.composio.apiKeyRef" });
    if (composio?.connectedAccountRef) refs.push({ workspaceId, ref: composio.connectedAccountRef, source: "integrations.composio.connectedAccountRef" });
    if (composio?.metadataRef) refs.push({ workspaceId, ref: composio.metadataRef, source: "integrations.composio.metadataRef", optional: true });
    const calendar = composio?.dataSources?.googleCalendar;
    if (calendar?.connectedAccountRef) refs.push({ workspaceId, ref: calendar.connectedAccountRef, source: "integrations.composio.dataSources.googleCalendar.connectedAccountRef" });
    if (calendar?.metadataRef) refs.push({ workspaceId, ref: calendar.metadataRef, source: "integrations.composio.dataSources.googleCalendar.metadataRef", optional: true });
    for (const ref of calendar?.requiredEnvRefs ?? []) refs.push({ workspaceId, ref: asSecretRef(ref), source: "integrations.composio.dataSources.googleCalendar.requiredEnvRefs" });
    const chat = composio?.dataSources?.chat;
    if (chat?.connectedAccountRef) refs.push({ workspaceId, ref: chat.connectedAccountRef, source: "integrations.composio.dataSources.chat.connectedAccountRef" });
    if (chat?.metadataRef) refs.push({ workspaceId, ref: chat.metadataRef, source: "integrations.composio.dataSources.chat.metadataRef", optional: true });
    for (const ref of chat?.requiredEnvRefs ?? []) refs.push({ workspaceId, ref: asSecretRef(ref), source: "integrations.composio.dataSources.chat.requiredEnvRefs" });
    if (workspace.transcription?.apiKeyRef) refs.push({ workspaceId, ref: asSecretRef(workspace.transcription.apiKeyRef), source: "transcription.apiKeyRef" });
  }
  return refs;
}

interface EnvSecretSource {
  path: string;
  metadata: Awaited<ReturnType<typeof fileMetadata>>;
  keys: Set<string>;
}

async function workspaceEnvSources(config: BrainConfig, override?: { workspaceId: string; workspaceRoot: string }): Promise<Map<string, EnvSecretSource[]>> {
  const result = new Map<string, EnvSecretSource[]>();
  await Promise.all(Object.entries(config.workspaces).map(async ([workspaceId, workspace]) => {
    const workspaceRoot = path.resolve(override?.workspaceId === workspaceId ? override.workspaceRoot : workspace.workspacePath ?? defaultWorkspaceRoot(workspaceId));
    const candidates = [
      path.join(workspaceRoot, "config", `brain-${workspaceId}.env`),
      path.join(workspaceRoot, "secrets", "secrets.env"),
    ];
    result.set(workspaceId, await Promise.all(candidates.map(readEnvSecretSource)));
  }));
  return result;
}

async function readEnvSecretSource(filePath: string): Promise<EnvSecretSource> {
  const metadata = await fileMetadata(filePath);
  const keys = new Set<string>();
  if (metadata.present) {
    try {
      const text = await readFile(filePath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (match) keys.add(match[1]);
      }
    } catch {
      // Metadata is still useful even if the env file cannot be parsed.
    }
  }
  return { path: filePath, metadata, keys };
}

async function secretRefMetadata(refs: ConfigRef[], options: { envSources?: Map<string, EnvSecretSource[]> } = {}): Promise<Array<ConfigRef & Record<string, unknown>>> {
  const details = [];
  for (const ref of refs) {
    if (ref.ref.startsWith("env:")) {
      const key = ref.ref.slice("env:".length);
      const processPresent = Boolean(process.env[key]);
      const envFile = options.envSources?.get(ref.workspaceId)?.find((source) => source.keys.has(key));
      details.push({
        ...ref,
        kind: "env",
        present: processPresent || Boolean(envFile),
        envSource: processPresent ? "process" : envFile ? "workspace-env-file" : "missing",
        envFile: envFile ? envFile.metadata : undefined,
        value: "redacted",
      });
    } else if (ref.ref.startsWith("file:")) {
      const filePath = ref.ref.slice("file:".length);
      details.push({ ...ref, kind: "file", ...(await fileMetadata(filePath)) });
    } else {
      details.push({ ...ref, kind: "opaque", present: false, note: "non-env/file refs are accepted but not inspectable by the skeleton checker", value: "redacted" });
    }
  }
  return details;
}

function maybeRef(ref: string | undefined, source: string, workspaceId = "workspace"): ConfigRef[] {
  return ref ? [{ workspaceId, ref: asSecretRef(ref), source }] : [];
}

function asSecretRef(ref: string): string {
  return /^(env|file):/.test(ref) ? ref : `env:${ref}`;
}

async function fileMetadata(filePath: string) {
  try {
    const info = await stat(filePath);
    return { present: true, path: filePath, mode: `0${(info.mode & 0o777).toString(8)}`, sizeBytes: info.size, value: "redacted" };
  } catch {
    return { present: false, path: filePath, value: "redacted" };
  }
}

async function setupProgressMetadata(filePath: string) {
  try {
    const info = await stat(filePath);
    return { present: true, mode: `0${(info.mode & 0o777).toString(8)}`, sizeBytes: info.size };
  } catch {
    return { present: false, mode: null, sizeBytes: 0 };
  }
}

async function gitMetadata(repoPath: string): Promise<Record<string, unknown>> {
  const metadata = await fileMetadata(repoPath);
  if (!metadata.present) return { present: false, path: repoPath };
  const inside = spawnSync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if ((inside.status ?? 0) !== 0 || inside.stdout.trim() !== "true") {
    return { present: false, path: repoPath, directoryPresent: true, note: "not a git worktree" };
  }
  const branch = spawnSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  const remotesRaw = spawnSync("git", ["-C", repoPath, "remote", "-v"], { encoding: "utf8" });
  const statusRaw = spawnSync("git", ["-C", repoPath, "status", "--porcelain=v1", "--branch"], { encoding: "utf8" });
  return {
    present: true,
    path: repoPath,
    branch: (branch.stdout || "").trim() || "unknown",
    remotes: parseGitRemotes(remotesRaw.stdout || ""),
    status: summarizeGitStatus(statusRaw.stdout || ""),
  };
}

function parseGitRemotes(raw: string): Array<{ name: string; url: string; purpose: string }> {
  const seen = new Set<string>();
  const remotes = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const key = `${match[1]}:${match[2]}:${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    remotes.push({ name: match[1] ?? "", url: redactRemoteUrl(match[2] ?? ""), purpose: match[3] ?? "" });
  }
  return remotes;
}

function redactRemoteUrl(url: string): string {
  return url.replace(/(https?:\/\/)([^/@]+)@/i, "$1[redacted]@");
}

function summarizeGitStatus(raw: string): Record<string, unknown> {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const branch = lines.find((line) => line.startsWith("##")) ?? "";
  const changes = lines.filter((line) => !line.startsWith("##"));
  const counts = changes.reduce<Record<string, number>>((acc, line) => {
    const code = line.slice(0, 2).trim() || "unknown";
    acc[code] = (acc[code] ?? 0) + 1;
    return acc;
  }, {});
  return {
    branch,
    clean: changes.length === 0,
    changedPaths: changes.length,
    counts,
    filenamesPrinted: false,
  };
}

function hostnameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function dnsStatusForWeb(domain: string | undefined, baseUrl: string | undefined, mode: string | undefined) {
  const host = domain ?? hostnameFromUrl(baseUrl);
  const directIp = host ? isIpHost(host) : false;
  return {
    host,
    required: Boolean(host && !directIp && mode !== "ip"),
    needed: host ? (directIp || mode === "ip" ? "not-needed-for-direct-IP" : "needed-for-domain") : "unknown-until-domain-or-ip-is-chosen",
    records: host && !directIp ? [`A/AAAA (or CNAME) for ${host} to the Brain web host`] : [],
    changed: false,
  };
}

function isIpHost(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
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
