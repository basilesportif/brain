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
import { AutomationRuntime, BrainRuntime, BrainSupervisor, EchoProviderAdapter, EmployeeLifecycle, FakeProviderAdapter, FileAutomationLockStore, FileAutomationSpool, FileEmployeeStore, FileSubagentJobStore, ProviderEmployeeRuntime, ProviderSubagentExecutor, RuntimeCommandInterceptor, RuntimeEntrypointBridge, StaticSubagentExecutor, SubagentLifecycle, createGuardedLiveValidationPlan, createOperationsPlan, formatAssistantCommandOutput, parseBrainDirectives, renderSystemdService, type AssistantWorkspaceCommandPort, type BrainSupervisorLogRecord, type OperationsPlan, type ProviderAdapter, type ProviderTurnEvent, type RuntimeLogEntry, type SubagentExecutor } from "@brain/runtime-core";
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
const DEFAULT_MAIN_LOOP_MODEL = "gpt-5.5";
const DEFAULT_MAIN_LOOP_EFFORT = "medium";

type SetupDefaultsTarget = "local" | "remote";

program
  .name("brainctl")
  .description("Operator CLI for Brain control-plane setup/deployment. Production assistant runtime belongs to codex-chat.")
  .version("0.0.0");

program.command("setup")
  .description("Create a private workspace directory scaffold without writing secrets.")
  .argument("[mode]", "optional mode: defaults, remote-bootstrap, inspect, status, reset, telegram-token-script, composio-api-key-script, or codex-auth-script")
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
  .option("--codex-chat-env <path>", "private codex-chat service env file to receive TELEGRAM_BOT_TOKEN from operator input")
  .option("--secrets-env <path>", "private secrets env file for generated token storage script")
  .option("--composio-env <path>", "private workspace .env file for generated Composio API key storage script")
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
    if (mode === "composio-api-key-script") {
      return exitWith(await setupComposioApiKeyScriptCommand(options));
    }
    if (mode === "codex-auth-script") {
      return exitWith(await setupCodexAuthScriptCommand(options));
    }
    if (mode) return exitWith({ ok: false, summary: `unknown setup mode: ${mode}`, details: { supported: ["defaults", "remote-bootstrap", "inspect", "status", "reset", "telegram-token-script", "composio-api-key-script", "codex-auth-script"] } });
    return exitWith(await setupCommand(options));
  });

program.command("doctor")
  .description("Run skeleton health checks for config, pack, private boundaries, and toolchain.")
  .option("--config <path>", "runtime YAML/TOML/JSON config", "examples/config/runtime.yaml")
  .option("--pack <path>", "assistant pack directory", "assistant-packs/core")
  .action(async (options) => exitWith(await doctorCommand(options)));

program.command("start")
  .description("Lab-only Brain supervisor seam. Production assistant service deployment must use `brainctl stack ...` to run codex-chat.")
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
  .option("--telegram-polling", "deprecated/disabled: Brain must not own live Telegram polling; deploy codex-chat.service")
  .option("--telegram-max-polls <n>", "maximum Telegram polls before stopping", parseNumberOption)
  .option("--polling-state <path>", "Telegram polling offset state path")
  .option("--telegram-pairing", "use optional one-time /pair code bootstrap instead of default first-user pairing")
  .option("--telegram-pairing-state <dir>", "directory for Telegram paired identity state")
  .option("--telegram-max-admin-pairs <n>", "maximum distinct Telegram admin user/chat pairs for first-user pairing", parseNumberOption)
  .option("--telegram-downloads", "download Telegram attachments to the private artifact directory before provider turns")
  .option("--telegram-download-dir <path>", "directory for downloaded Telegram attachments")
  .option("--telegram-transcription-command <cmd>", "private command used to transcribe local voice/audio/video files; receives file path as argv[1]")
  .option("--employee-runtime", "enable provider-backed Employee sessions for employee start/steer commands")
  .option("--automation-file <path>", "optional loops/monitors YAML/JSON file for service-level loop status")
  .action(async (options) => exitWith(await startCommand(options)));

program.command("run")
  .description("Run the lab Brain supervisor in the foreground. Do not use as a production assistant service; deploy codex-chat with `brainctl stack ...`.")
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
  .option("--telegram-polling", "deprecated/disabled: Brain must not own live Telegram polling; deploy codex-chat.service")
  .option("--telegram-max-polls <n>", "maximum Telegram polls before stopping", parseNumberOption)
  .option("--polling-state <path>", "Telegram polling offset state path")
  .option("--telegram-pairing", "use optional one-time /pair code bootstrap instead of default first-user pairing")
  .option("--telegram-pairing-state <dir>", "directory for Telegram paired identity state")
  .option("--telegram-max-admin-pairs <n>", "maximum distinct Telegram admin user/chat pairs for first-user pairing", parseNumberOption)
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
  .description("Render the deprecated/lab Brain supervisor unit without installing it. Production uses stack/systemd codex-chat plans.")
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

const stack = program.command("stack").description("Control-plane inspection and no-network plans for the servant runtime stack");
stack.command("status")
  .description("Resolve codex-chat, assistant-agent-logic, assistant-agent-data/workspace, service metadata, and remote deployment metadata without contacting hosts.")
  .option("--registry <path>", "repo-registry index.yaml path")
  .option("--repo <path>", "Brain control-plane checkout path used to find ignored setup context", process.cwd())
  .option("--setup-context <path>", "explicit setup-context.json path")
  .option("--metadata-file <path>", "local/offline deployment metadata file to read instead of the canonical remote path")
  .option("--workspace <id>", "workspace id", DEFAULT_WORKSPACE_ID)
  .option("--environment <name>", "codex-chat app environment", "production")
  .action(async (options) => exitWith(await stackStatusCommand(options)));
stack.command("plan")
  .description("Render a no-network setup/deploy plan for codex-chat + assistant-agent-logic + assistant-agent-data.")
  .option("--registry <path>", "repo-registry index.yaml path")
  .option("--repo <path>", "Brain control-plane checkout path used to find ignored setup context", process.cwd())
  .option("--setup-context <path>", "explicit setup-context.json path")
  .option("--metadata-file <path>", "local/offline deployment metadata file to read instead of the canonical remote path")
  .option("--workspace <id>", "workspace id", DEFAULT_WORKSPACE_ID)
  .option("--environment <name>", "codex-chat app environment", "production")
  .action(async (options) => exitWith(await stackPlanCommand(options)));
stack.command("apply")
  .description("Apply the servant stack with explicit approval gates. Defaults to dry-run and supports mock/local/ssh executors.")
  .option("--registry <path>", "repo-registry index.yaml path")
  .option("--repo <path>", "Brain control-plane checkout path used to find ignored setup context", process.cwd())
  .option("--setup-context <path>", "explicit setup-context.json path")
  .option("--metadata-file <path>", "local/offline deployment metadata file to write/read for tests or local-only control planes")
  .option("--workspace <id>", "workspace id", DEFAULT_WORKSPACE_ID)
  .option("--environment <name>", "codex-chat app environment", "production")
  .option("--executor <kind>", "executor kind: dry-run, mock, local, or ssh", "dry-run")
  .option("--dry-run", "force dry-run planning even when approval flags are supplied")
  .option("--approve", "approve non-secret git/build/metadata execution for this run")
  .option("--approve-data", "approve assistant-agent-data clone/init/validation actions")
  .option("--approve-config", "approve writing codex-chat config/env templates with secret placeholders only")
  .option("--approve-service", "approve systemd service install/start actions")
  .option("--approve-health", "approve live/read-only health verification actions")
  .option("--now <iso>", "timestamp to record in deployment metadata")
  .action(async (options) => exitWith(await stackApplyCommand(options)));

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

const workspaceCommands = program.command("workspace").description("Legacy/lab Brain assistant workspace helpers; production uses assistant-agent-logic plus assistant-agent-data");
workspaceCommands.command("scaffold")
  .description("Create the legacy/lab Brain assistant workspace scaffold without overwriting stores or secrets.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path")
  .option("--assistant-repo <path>", "deprecated; ignored because Brain uses the native @brain/assistant-logic package")
  .option("--dry-run", "show planned scaffold paths without writing files")
  .action(async (options) => exitWith(await workspaceScaffoldCommand(options)));
workspaceCommands.command("status")
  .description("Inspect legacy/lab Brain assistant workspace parity metadata, including vendored live-integration scripts.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path")
  .option("--assistant-repo <path>", "deprecated; ignored because Brain uses the native @brain/assistant-logic package")
  .action(async (options) => exitWith(await workspaceStatusCommand(options)));
workspaceCommands.command("commands")
  .description("List legacy/lab Brain assistant-logic commands, including native stores and vendored live integrations.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path")
  .option("--assistant-repo <path>", "deprecated; ignored because Brain uses the native @brain/assistant-logic package")
  .action(async (options) => exitWith(await workspaceCommandsCommand(options)));
workspaceCommands.command("run")
  .description("Run a legacy/lab Brain assistant-logic command with ASSISTANT_WORKSPACE and private roots set.")
  .option("--workspace <id>", "workspace id", "personal")
  .option("--path <path>", "private workspace path")
  .option("--assistant-repo <path>", "deprecated; ignored because Brain uses the native @brain/assistant-logic package")
  .argument("<script>", "script basename or scripts/<name>.js")
  .argument("[scriptArgs...]", "arguments for the assistant-logic CLI command; use -- before command flags")
  .allowUnknownOption(true)
  .action(async (script: string, scriptArgs: string[], options) => exitWith(await workspaceRunCommand(script, scriptArgs, options)));

const composio = program.command("composio").description("Optional Composio setup/status checks for Gmail and Google Calendar data sources");
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
  telegramMaxAdminPairs?: number;
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
  if (options.telegramPolling) return disabledBrainLiveTelegramPollingResult();
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
        telegramMaxAdminPairs: telegramMaxAdminPairsOption(options),
        telegramTranscription: publicTelegramTranscriptionRuntime(telegramTranscriptionRuntime(selection.runtime, options)),
        automationFile: options.automationFile ? path.resolve(options.automationFile) : undefined,
        deployment: "not performed",
      },
    };
  }
  return runCommand(options);
}

async function runCommand(options: SupervisorRunCommandOptions): Promise<CliResult> {
  if (options.telegramPolling) return disabledBrainLiveTelegramPollingResult();
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
    assistantCommands: createCliAssistantCommandPort(options.workspace, workspace.workspacePath),
    logs: logReader,
    health: { health: () => supervisor?.health() ?? { ok: false, detail: "supervisor not constructed" } },
    mainLoop: { model: DEFAULT_MAIN_LOOP_MODEL, effort: DEFAULT_MAIN_LOOP_EFFORT },
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

function disabledBrainLiveTelegramPollingResult(): CliResult {
  return {
    ok: false,
    summary: "Brain live Telegram polling is disabled; deploy/start codex-chat.service instead",
    details: {
      replacement: "pnpm run brainctl stack plan --environment <env>; pnpm run brainctl stack apply --approve --approve-service --approve-health ...",
      policy: [
        "Brain is the deployment/control-plane coordinator only.",
        "The live assistant runtime is codex-chat.service.",
        "assistant-agent-logic remains the canonical assistant-domain logic checkout.",
        "Keeping Brain polling disabled prevents double polling and stale domain behavior.",
      ],
      sideEffects: "none",
      secretValuesPrinted: false,
    },
  };
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
    summary: "deprecated lab Brain runtime operations plan rendered without deployment side effects; use stack plan/apply for codex-chat production",
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
    summary: "deprecated lab Brain runtime systemd unit rendered without installing or restarting services; use stack plan/apply for codex-chat production",
    details: {
      unitPath: plan.unitPath,
      serviceName: plan.serviceName,
      serviceUser: plan.serviceUser,
      unit: renderSystemdService(plan),
      productionReplacement: "pnpm run brainctl stack plan --environment <env>; pnpm run brainctl stack apply --approve ... deploys codex-chat.service",
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
    summary: "deprecated lab Brain runtime operations readiness validated without deployment side effects; use stack status for codex-chat production",
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

interface StackCommandOptions {
  registry?: string;
  repo?: string;
  setupContext?: string;
  metadataFile?: string;
  workspace: string;
  environment: string;
}

type StackExecutorKind = "dry-run" | "mock" | "local" | "ssh";
type StackApprovalGate = "apply" | "data" | "config" | "service" | "health";

interface StackApplyOptions extends StackCommandOptions {
  executor?: string;
  dryRun?: boolean;
  approve?: boolean;
  approveData?: boolean;
  approveConfig?: boolean;
  approveService?: boolean;
  approveHealth?: boolean;
  now?: string;
}

interface RepoRegistryIndex {
  version?: unknown;
  controller_root?: unknown;
  repos?: Record<string, RepoRegistryRepo>;
}

interface RepoRegistryRepo {
  alias?: unknown;
  host?: unknown;
  path?: unknown;
  repo_name?: unknown;
  default_branch?: unknown;
  current_branch?: unknown;
  remote_url?: unknown;
  deploy_host?: unknown;
  deploy_path?: unknown;
  apps?: unknown;
  ops?: unknown;
}

interface StackRepoResolution {
  role: "control-plane" | "servant-runtime" | "assistant-logic" | "assistant-data";
  alias: string;
  repoName: string;
  host: string;
  path: string;
  branch?: string;
  requestedRef?: string;
  remoteUrl?: string;
  source: string;
  registryKey?: string;
  present: boolean;
}

interface DeploymentRepoRef {
  role: StackRepoResolution["role"];
  repoName: string;
  host: string;
  path: string;
  requestedRef?: string;
  resolvedSha?: string;
  verified: boolean;
}

interface StackStatusDetails {
  workspaceId: string;
  role: string;
  dryRun: true;
  networkAccess: false;
  sideEffects: "none";
  secretValuesPrinted: false;
  registry: {
    path: string;
    present: boolean;
    version?: unknown;
    controllerRoot?: string;
    issues: string[];
  };
  setupContext: Awaited<ReturnType<typeof readStackSetupContext>>;
  controlPlane: StackRepoResolution;
  servantRuntime: StackRepoResolution & {
    appEnvironment: string;
    deploy: {
      host?: string;
      path?: string;
      sshIdentity?: string;
      runtimeUser?: string;
      serviceName?: string;
      envFile?: string;
      configPath?: string;
      envVars: string[];
      expectedTelegramBot?: TelegramBotIdentity;
      healthChecks: Array<{ kind: string; command: string }>;
    };
  };
  assistantLogic: StackRepoResolution;
  assistantData: StackRepoResolution & {
    workspacePath?: string;
    promptRequired: boolean;
    migrationPlaceholder: string;
  };
  servicePaths: {
    deployHost?: string;
    sshIdentity?: string;
    deployPath?: string;
    serviceName?: string;
    envFile?: string;
    configPath?: string;
    setupContextConfigPath?: string;
  };
  secretMetadataChecks: Array<Record<string, unknown>>;
  deploymentMetadata: StackDeploymentMetadataStatus;
  repoBoundaries: ReturnType<typeof analyzeStackRepoBoundaries>;
  missing: string[];
}

interface TelegramBotIdentity {
  id?: string;
  username?: string;
}

interface StackDeploymentMetadataStatus {
  canonical: {
    sourceOfTruth: "remote-brain-workspace" | "local-brain-workspace";
    host?: string;
    sshIdentity?: string;
    workspaceRoot: string;
    path: string;
    relativePath: string;
    schema: {
      kind: typeof DEPLOYMENT_METADATA_KIND;
      version: typeof DEPLOYMENT_METADATA_VERSION;
    };
    note: string;
  };
  localReadOverride?: string;
  read: {
    attempted: boolean;
    present: boolean;
    path: string;
    metadata?: Awaited<ReturnType<typeof fileMetadata>>;
    validation: DeploymentMetadataValidation;
    plannedReadCommand?: string;
  };
  deployments: Array<{
    id: string;
    stack: string;
    workspace: string;
    environment: string;
    status: string;
    updatedAt: string;
    serviceName?: string;
    deployHost?: string;
  }>;
  secretValuesStored: false;
  localProjectNotesAreSecondary: true;
}

interface DeploymentMetadataValidation {
  ok: boolean;
  issues: string[];
}

interface DeploymentMetadataStore {
  version: 1;
  kind: typeof DEPLOYMENT_METADATA_KIND;
  updatedAt: string;
  canonical: {
    sourceOfTruth: "remote-brain-workspace" | "local-brain-workspace";
    workspaceRoot: string;
    path: string;
    relativePath: string;
  };
  deployments: DeploymentMetadataRecord[];
  secretValuesStored: false;
}

interface DeploymentMetadataRecord {
  id: string;
  stack: "codex-chat";
  workspace: string;
  environment: string;
  status: "planned" | "blocked" | "partially_applied" | "applied" | "healthy" | "failed";
  updatedAt: string;
  source: "brainctl stack apply";
  controlPlane: Pick<StackRepoResolution, "host" | "path" | "repoName">;
  servantRuntime: {
    repoName: string;
    sourceHost: string;
    sourcePath: string;
    deployHost?: string;
    deployPath?: string;
    branch?: string;
    requestedRef?: string;
    resolvedSha?: string;
    deployResolvedSha?: string;
    remoteUrl?: string;
    serviceName?: string;
    runtimeUser?: string;
  };
  assistantLogic: Pick<StackRepoResolution, "host" | "path" | "repoName" | "branch" | "requestedRef" | "remoteUrl"> & {
    resolvedSha?: string;
  };
  assistantData: Pick<StackRepoResolution, "host" | "path" | "repoName" | "branch" | "remoteUrl"> & {
    promptRequired: boolean;
    migrationStatus: "placeholder";
  };
  config: {
    configPath?: string;
    envFile?: string;
    envVars: Array<{ name: string; value: "redacted"; metadataOnly: true }>;
    renderedConfigPreview: string;
    renderedEnvPreview: string;
  };
  health: {
    status: "not_run" | "planned" | "passed" | "failed";
    checks: Array<{ kind: string; command: string }>;
  };
  approvals: Record<StackApprovalGate, boolean>;
  executor: {
    requested: StackExecutorKind;
    effective: StackExecutorKind;
    dryRun: boolean;
    networkAccess: boolean;
  };
  lastPlan: {
    actionCount: number;
    approvedActionCount: number;
    executedActionCount: number;
    failedActionCount: number;
  };
  repositories: DeploymentRepoRef[];
  secretValuesStored: false;
}

interface StackExecutorAction {
  id: string;
  title: string;
  phase: "preflight" | "git" | "assistant-data" | "config" | "state" | "systemd" | "health" | "metadata";
  executor: "local" | "ssh" | "operator-prompt" | "metadata-file";
  requiredGate: StackApprovalGate;
  hostIdentity?: string;
  command?: string;
  displayCommand?: string;
  writesMetadata?: boolean;
  metadataOnly?: boolean;
  repoUpdate?: Pick<DeploymentRepoRef, "role" | "repoName" | "host" | "path" | "requestedRef">;
  secretValuesPrinted: false;
  approved: boolean;
  sideEffectsIfExecuted: string;
}

const DEFAULT_REPO_REGISTRY_INDEX = "/home/tim/.assistant-claude/workspace/.claude/repo-registry/index.yaml";
const DEPLOYMENT_METADATA_VERSION = 1 as const;
const DEPLOYMENT_METADATA_KIND = "brain.control-plane.deployments" as const;
const DEPLOYMENT_METADATA_RELATIVE_PATH = "state/control-plane/deployments.json";
const STACK_REQUIRED_ALIASES = {
  codexChat: ["codex-chat"],
  assistantLogic: ["assistant-agent-logic", "assistant-claude"],
  assistantData: ["assistant-agent-data", "assistant-data"],
} as const;

async function stackStatusCommand(options: StackCommandOptions): Promise<CliResult> {
  const status = await resolveStackStatus(options);
  return {
    ok: status.missing.length === 0 && status.repoBoundaries.ok,
    summary: status.missing.length === 0 && status.repoBoundaries.ok
      ? "servant runtime stack resolved from repo registry without network side effects"
      : "servant runtime stack resolution needs attention before planning",
    details: status,
  };
}

async function stackPlanCommand(options: StackCommandOptions): Promise<CliResult> {
  const status = await resolveStackStatus(options);
  const plan = renderStackNoNetworkPlan(status);
  return {
    ok: status.missing.length === 0 && status.repoBoundaries.ok,
    summary: status.missing.length === 0 && status.repoBoundaries.ok
      ? "servant runtime setup/deploy plan rendered without network or mutation"
      : "servant runtime setup/deploy plan rendered with unresolved prerequisites",
    details: {
      status,
      plan,
      dryRun: true,
      networkAccess: false,
      sideEffects: "none",
      secretValuesPrinted: false,
    },
  };
}

async function stackApplyCommand(options: StackApplyOptions): Promise<CliResult> {
  const executor = normalizeStackExecutor(options.executor);
  if (!executor) {
    return { ok: false, summary: "stack apply executor must be dry-run, mock, local, or ssh", details: { supported: ["dry-run", "mock", "local", "ssh"] } };
  }
  const status = await resolveStackStatus(options);
  const approvals = stackApprovals(options);
  const dryRun = Boolean(options.dryRun || !approvals.apply || executor === "dry-run");
  const effectiveExecutor: StackExecutorKind = dryRun ? "dry-run" : executor;
  const plan = renderStackNoNetworkPlan(status);
  const actions = renderStackExecutorActions(status, approvals);
  const canApply = status.missing.length === 0 && status.repoBoundaries.ok;
  const blockedReason = canApply ? undefined : "unresolved stack status prerequisites or repo-boundary violations";

  const actionResults: Array<Record<string, unknown>> = [];
  if (!dryRun && canApply) {
    for (const action of actions) {
      const result = await executeStackAction(action, {
        executor: effectiveExecutor,
        metadataFile: options.metadataFile,
      });
      actionResults.push(result);
    }
  } else {
    for (const action of actions) {
      actionResults.push({
        id: action.id,
        phase: action.phase,
        status: action.approved && canApply ? "planned" : "skipped",
        reason: !canApply ? blockedReason : action.approved ? "dry-run default; no executor side effects" : `approval gate not enabled: ${action.requiredGate}`,
        command: action.displayCommand,
        secretValuesPrinted: false,
      });
    }
  }

  let metadataWrite: Record<string, unknown> | undefined;
  if (!dryRun && canApply) {
    const record = stackDeploymentRecord(status, {
      approvals,
      requestedExecutor: executor,
      effectiveExecutor,
      dryRun,
      actionCount: actions.length,
      approvedActionCount: actions.filter((action) => action.approved).length,
      executedActionCount: actionResults.filter((result) => result.status === "succeeded" || result.status === "mocked").length,
      failedActionCount: actionResults.filter((result) => result.status === "failed").length,
      now: options.now,
      healthApproved: approvals.health,
      repositories: collectResolvedRepoRefs(actionResults, status),
    });
    metadataWrite = await writeStackDeploymentMetadata(status, record, { executor: effectiveExecutor, metadataFile: options.metadataFile });
  }

  const failedActions = actionResults.filter((result) => result.status === "failed");
  const summary = dryRun
    ? "stack apply plan ready (dry run; pass --approve with an executor to run)"
    : failedActions.length > 0 || metadataWrite?.ok === false
      ? "stack apply attempted with failures; deployment metadata records the attempted status where possible"
      : "stack apply completed through approved executor gates";
  return {
    ok: canApply && (dryRun || (failedActions.length === 0 && metadataWrite?.ok !== false)),
    summary,
    details: {
      status,
      plan,
      executor: {
        requested: executor,
        effective: effectiveExecutor,
        dryRun,
        networkAccess: !dryRun && effectiveExecutor === "ssh",
      },
      approvalGates: stackApprovalGateDetails(approvals),
      actions,
      actionResults,
      metadataWrite,
      sideEffects: dryRun ? "none" : effectiveExecutor === "mock" ? "mock executor plus local/offline metadata write only" : "approved executor actions only",
      secretValuesPrinted: false,
      blockedReason,
    },
  };
}

async function resolveStackStatus(options: StackCommandOptions): Promise<StackStatusDetails> {
  const repoRoot = path.resolve(options.repo ?? process.cwd());
  const registryPath = path.resolve(options.registry ?? process.env.BRAIN_REPO_REGISTRY ?? DEFAULT_REPO_REGISTRY_INDEX);
  const registry = await loadRepoRegistry(registryPath);
  const setupContext = await readStackSetupContext(options.setupContext ? path.resolve(options.setupContext) : localSetupContextPath(repoRoot), options.workspace);
  const codexChat = findRegistryRepo(registry.index, STACK_REQUIRED_ALIASES.codexChat, "codex-chat");
  const assistantLogic = findRegistryRepo(registry.index, STACK_REQUIRED_ALIASES.assistantLogic, "assistant-agent-logic");
  const assistantData = findRegistryRepo(registry.index, STACK_REQUIRED_ALIASES.assistantData, "assistant-agent-data");
  const codexEnvironment = codexChat.repo ? registryAppEnvironment(codexChat.repo, "codex-chat", options.environment) : undefined;
  const codexDeploy = asRecord(codexEnvironment?.environment?.deploy);
  const codexSource = asRecord(codexEnvironment?.environment?.source);
  const deployHost = asString(codexDeploy?.host) ?? asString(codexChat.repo?.deploy_host) ?? setupContext.context?.sshHost;
  const deployPath = asString(codexDeploy?.path) ?? asString(codexChat.repo?.deploy_path) ?? asString(codexChat.repo?.path);
  const runtimeUser = asString(codexDeploy?.runtime_user);
  const sshIdentity = asString(codexDeploy?.ssh_identity) ?? sshIdentityFromHost(deployHost, runtimeUser) ?? sshIdentityFromSetupContext(setupContext.context);
  const serviceName = asString(codexDeploy?.service);
  const envFile = asString(codexDeploy?.env_file);
  const configPath = asString(codexDeploy?.config_path) ?? asString(codexDeploy?.config);
  const envVars = asStringArray(codexDeploy?.env_vars);
  const expectedTelegramBot = readExpectedTelegramBot(codexDeploy, codexEnvironment?.environment);
  const healthChecks = readStackHealthChecks(codexEnvironment?.environment);
  const controlPlane = stackRepoFromLocalBrain(repoRoot);
  const servantRuntime = {
    ...stackRepoFromRegistry("servant-runtime" as const, codexChat, codexSource),
    appEnvironment: codexEnvironment?.name ?? options.environment,
    deploy: {
      host: deployHost,
      path: deployPath,
      sshIdentity,
      runtimeUser,
      serviceName,
      envFile,
      configPath,
      envVars,
      expectedTelegramBot,
      healthChecks,
    },
  };
  const assistantLogicResolution = stackRepoWithEnvironmentOverride(
    stackRepoFromRegistry("assistant-logic" as const, assistantLogic),
    asRecord(codexEnvironment?.environment?.assistant_logic) ?? asRecord(codexDeploy?.assistant_logic),
    "codex-chat environment assistant_logic",
  );
  const assistantDataOverride = asRecord(codexEnvironment?.environment?.assistant_data) ?? asRecord(codexDeploy?.assistant_data);
  const assistantDataBase = stackRepoWithEnvironmentOverride(
    stackRepoFromRegistry("assistant-data" as const, assistantData),
    assistantDataOverride,
    "codex-chat environment assistant_data",
  );
  const remoteWorkspaceHost = setupContext.context?.target === "remote" ? sshIdentityFromSetupContext(setupContext.context) : undefined;
  const remoteWorkspaceRoot = setupContext.context?.target === "remote" ? setupContext.context.workspaceRoot : undefined;
  const assistantDataPath = asString(assistantDataOverride?.path) ?? remoteWorkspaceRoot ?? assistantDataBase.path;
  const assistantDataHost = asString(assistantDataOverride?.host) ?? remoteWorkspaceHost ?? assistantDataBase.host;
  const assistantDataResolution = {
    ...assistantDataBase,
    host: assistantDataHost,
    path: assistantDataPath,
    workspacePath: assistantDataPath,
    source: remoteWorkspaceRoot && !assistantDataOverride
      ? `${assistantDataBase.source}; remote setup context workspaceRoot`
      : assistantDataBase.source,
    promptRequired: true,
    migrationPlaceholder: "Prompt the operator to confirm/pull/init the assistant-agent-data workspace; do not auto-migrate private data in this phase.",
  };
  const servicePaths = {
    deployHost,
    sshIdentity,
    deployPath,
    serviceName,
    envFile,
    configPath,
    setupContextConfigPath: setupContext.context?.configPath,
  };
  const secretMetadataChecks = stackSecretMetadataChecks(envVars, envFile, sshIdentity, expectedTelegramBot);
  const deploymentMetadata = await readStackDeploymentMetadataStatus({
    workspace: options.workspace,
    setupContext,
    metadataFile: options.metadataFile,
  });
  const repoBoundaries = analyzeStackRepoBoundaries([controlPlane, servantRuntime, assistantLogicResolution, assistantDataResolution]);
  const missing = [
    ...registry.issues,
    ...(!codexChat.repo ? ["repo registry entry missing: codex-chat"] : []),
    ...(!assistantLogic.repo ? ["repo registry entry missing: assistant-agent-logic (or assistant-claude alias)"] : []),
    ...(!assistantData.repo ? ["repo registry entry missing: assistant-agent-data"] : []),
    ...(!deployHost ? ["codex-chat deploy host missing from registry/setup context"] : []),
    ...(!deployPath ? ["codex-chat deploy path missing from registry"] : []),
    ...(!serviceName ? ["codex-chat service name missing from registry"] : []),
    ...(!envFile ? ["codex-chat env file path missing from registry"] : []),
    ...(!deploymentMetadata.read.validation.ok ? deploymentMetadata.read.validation.issues.map((issue) => `deployment metadata store invalid: ${issue}`) : []),
    ...repoBoundaries.issues,
  ];

  return {
    workspaceId: options.workspace,
    role: "Brain control plane manages the codex-chat servant runtime stack; Brain's own runtime remains experimental/lab.",
    dryRun: true,
    networkAccess: false,
    sideEffects: "none",
    secretValuesPrinted: false,
    registry: {
      path: registry.path,
      present: registry.present,
      version: registry.index?.version,
      controllerRoot: asString(registry.index?.controller_root),
      issues: registry.issues,
    },
    setupContext,
    controlPlane,
    servantRuntime,
    assistantLogic: assistantLogicResolution,
    assistantData: assistantDataResolution,
    servicePaths,
    secretMetadataChecks,
    deploymentMetadata,
    repoBoundaries,
    missing,
  };
}

function normalizeStackExecutor(value: string | undefined): StackExecutorKind | undefined {
  const normalized = (value ?? "dry-run").trim();
  return normalized === "dry-run" || normalized === "mock" || normalized === "local" || normalized === "ssh" ? normalized : undefined;
}

function stackApprovals(options: StackApplyOptions): Record<StackApprovalGate, boolean> {
  return {
    apply: Boolean(options.approve),
    data: Boolean(options.approve && options.approveData),
    config: Boolean(options.approve && options.approveConfig),
    service: Boolean(options.approve && options.approveService),
    health: Boolean(options.approve && options.approveHealth),
  };
}

function stackApprovalGateDetails(approvals: Record<StackApprovalGate, boolean>): Array<Record<string, unknown>> {
  return [
    { gate: "apply", approved: approvals.apply, unlocks: ["repo preflight", "git clone/update", "build", "deployment metadata write"], requiredFlag: "--approve" },
    { gate: "data", approved: approvals.data, unlocks: ["assistant-agent-data clone/init/validation placeholders"], requiredFlag: "--approve --approve-data" },
    { gate: "config", approved: approvals.config, unlocks: ["codex-chat config/env template writes without secret values"], requiredFlag: "--approve --approve-config" },
    { gate: "service", approved: approvals.service, unlocks: ["systemd service install/enable/start"], requiredFlag: "--approve --approve-service" },
    { gate: "health", approved: approvals.health, unlocks: ["live health verification commands"], requiredFlag: "--approve --approve-health" },
  ];
}

async function readStackDeploymentMetadataStatus(input: {
  workspace: string;
  setupContext: Awaited<ReturnType<typeof readStackSetupContext>>;
  metadataFile?: string;
}): Promise<StackDeploymentMetadataStatus> {
  const context = input.setupContext.context;
  const workspaceRoot = context?.workspaceRoot ?? defaultWorkspaceRoot(input.workspace);
  const canonicalPath = deploymentMetadataPath(workspaceRoot);
  const canonicalSourceOfTruth = context?.target === "remote" ? "remote-brain-workspace" as const : "local-brain-workspace" as const;
  const canonicalHost = context?.target === "remote" ? context.sshHost : undefined;
  const canonicalSshIdentity = context?.target === "remote" ? sshIdentityFromSetupContext(context) : undefined;
  const localPath = input.metadataFile ? path.resolve(input.metadataFile) : canonicalSourceOfTruth === "local-brain-workspace" ? path.resolve(canonicalPath) : undefined;
  const plannedReadCommand = canonicalSourceOfTruth === "remote-brain-workspace"
    ? remotePlanCommand(canonicalSshIdentity, `test -r ${shellPathArg(canonicalPath)} && python3 -m json.tool ${shellPathArg(canonicalPath)} >/dev/null`)
    : `test -r ${shellPathArg(canonicalPath)} && python3 -m json.tool ${shellPathArg(canonicalPath)} >/dev/null`;
  if (!localPath) {
    return {
      canonical: {
        sourceOfTruth: canonicalSourceOfTruth,
        host: canonicalHost,
        sshIdentity: canonicalSshIdentity,
        workspaceRoot,
        path: canonicalPath,
        relativePath: DEPLOYMENT_METADATA_RELATIVE_PATH,
        schema: { kind: DEPLOYMENT_METADATA_KIND, version: DEPLOYMENT_METADATA_VERSION },
        note: "Deployment metadata is canonical on the Brain/control-plane host under the private workspace state; repo-registry/local notes are secondary link maps.",
      },
      read: {
        attempted: false,
        present: false,
        path: canonicalPath,
        validation: { ok: true, issues: [] },
        plannedReadCommand,
      },
      deployments: [],
      secretValuesStored: false,
      localProjectNotesAreSecondary: true,
    };
  }

  const metadata = await fileMetadata(localPath);
  if (!metadata.present) {
    return {
      canonical: {
        sourceOfTruth: canonicalSourceOfTruth,
        host: canonicalHost,
        sshIdentity: canonicalSshIdentity,
        workspaceRoot,
        path: canonicalPath,
        relativePath: DEPLOYMENT_METADATA_RELATIVE_PATH,
        schema: { kind: DEPLOYMENT_METADATA_KIND, version: DEPLOYMENT_METADATA_VERSION },
        note: "Deployment metadata is canonical on the Brain/control-plane host under the private workspace state; repo-registry/local notes are secondary link maps.",
      },
      localReadOverride: input.metadataFile ? localPath : undefined,
      read: {
        attempted: true,
        present: false,
        path: localPath,
        metadata,
        validation: { ok: true, issues: [] },
        plannedReadCommand,
      },
      deployments: [],
      secretValuesStored: false,
      localProjectNotesAreSecondary: true,
    };
  }

  try {
    const parsed = JSON.parse(await readFile(localPath, "utf8")) as unknown;
    const validation = validateDeploymentMetadataStore(parsed);
    const store = validation.ok ? parsed as DeploymentMetadataStore : undefined;
    return {
      canonical: {
        sourceOfTruth: canonicalSourceOfTruth,
        host: canonicalHost,
        sshIdentity: canonicalSshIdentity,
        workspaceRoot,
        path: canonicalPath,
        relativePath: DEPLOYMENT_METADATA_RELATIVE_PATH,
        schema: { kind: DEPLOYMENT_METADATA_KIND, version: DEPLOYMENT_METADATA_VERSION },
        note: "Deployment metadata is canonical on the Brain/control-plane host under the private workspace state; repo-registry/local notes are secondary link maps.",
      },
      localReadOverride: input.metadataFile ? localPath : undefined,
      read: {
        attempted: true,
        present: true,
        path: localPath,
        metadata,
        validation,
        plannedReadCommand,
      },
      deployments: (store?.deployments ?? []).map((deployment) => ({
        id: deployment.id,
        stack: deployment.stack,
        workspace: deployment.workspace,
        environment: deployment.environment,
        status: deployment.status,
        updatedAt: deployment.updatedAt,
        serviceName: deployment.servantRuntime.serviceName,
        deployHost: deployment.servantRuntime.deployHost,
      })),
      secretValuesStored: false,
      localProjectNotesAreSecondary: true,
    };
  } catch (error) {
    return {
      canonical: {
        sourceOfTruth: canonicalSourceOfTruth,
        host: canonicalHost,
        sshIdentity: canonicalSshIdentity,
        workspaceRoot,
        path: canonicalPath,
        relativePath: DEPLOYMENT_METADATA_RELATIVE_PATH,
        schema: { kind: DEPLOYMENT_METADATA_KIND, version: DEPLOYMENT_METADATA_VERSION },
        note: "Deployment metadata is canonical on the Brain/control-plane host under the private workspace state; repo-registry/local notes are secondary link maps.",
      },
      localReadOverride: input.metadataFile ? localPath : undefined,
      read: {
        attempted: true,
        present: true,
        path: localPath,
        metadata,
        validation: { ok: false, issues: [`could not parse deployment metadata JSON: ${errorMessage(error)}`] },
        plannedReadCommand,
      },
      deployments: [],
      secretValuesStored: false,
      localProjectNotesAreSecondary: true,
    };
  }
}

function deploymentMetadataPath(workspaceRoot: string): string {
  return path.posix.join(workspaceRoot.replaceAll("\\", "/"), DEPLOYMENT_METADATA_RELATIVE_PATH);
}

function validateDeploymentMetadataStore(value: unknown): DeploymentMetadataValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["store is not an object"] };
  if (value.version !== DEPLOYMENT_METADATA_VERSION) issues.push(`version must be ${DEPLOYMENT_METADATA_VERSION}`);
  if (value.kind !== DEPLOYMENT_METADATA_KIND) issues.push(`kind must be ${DEPLOYMENT_METADATA_KIND}`);
  if (value.secretValuesStored !== false) issues.push("secretValuesStored must be false");
  if (!isRecord(value.canonical)) issues.push("canonical must be an object");
  if (!Array.isArray(value.deployments)) issues.push("deployments must be an array");
  const seen = new Set<string>();
  for (const [index, deployment] of (Array.isArray(value.deployments) ? value.deployments : []).entries()) {
    if (!isRecord(deployment)) {
      issues.push(`deployments[${index}] must be an object`);
      continue;
    }
    const id = asString(deployment.id);
    if (!id) issues.push(`deployments[${index}].id is required`);
    else if (seen.has(id)) issues.push(`duplicate deployment id: ${id}`);
    else seen.add(id);
    if (deployment.stack !== "codex-chat") issues.push(`deployments[${index}].stack must be codex-chat`);
    if (!["planned", "blocked", "partially_applied", "applied", "healthy", "failed"].includes(asString(deployment.status) ?? "")) {
      issues.push(`deployments[${index}].status is unsupported`);
    }
    if (deployment.secretValuesStored !== false) issues.push(`deployments[${index}].secretValuesStored must be false`);
    const config = asRecord(deployment.config);
    const envVars = Array.isArray(config?.envVars) ? config.envVars : [];
    for (const [envIndex, envVar] of envVars.entries()) {
      const envRecord = asRecord(envVar);
      if (envRecord?.value !== "redacted" || envRecord.metadataOnly !== true) {
        issues.push(`deployments[${index}].config.envVars[${envIndex}] must be metadata-only/redacted`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

async function loadRepoRegistry(registryPath: string): Promise<{ path: string; present: boolean; index?: RepoRegistryIndex; issues: string[] }> {
  try {
    const raw = await readFile(registryPath, "utf8");
    const parsed = YAML.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { path: registryPath, present: true, issues: ["repo registry index is not an object"] };
    }
    const index = parsed as RepoRegistryIndex;
    if (!index.repos || typeof index.repos !== "object" || Array.isArray(index.repos)) {
      return { path: registryPath, present: true, index, issues: ["repo registry index has no repos map"] };
    }
    return { path: registryPath, present: true, index, issues: [] };
  } catch (error) {
    return { path: registryPath, present: false, issues: [`repo registry index could not be read: ${errorMessage(error)}`] };
  }
}

async function readStackSetupContext(contextPath: string, workspace: string): Promise<{ present: boolean; path: string; context?: LocalSetupContext; warning?: string; note?: string; metadata?: Awaited<ReturnType<typeof fileMetadata>> }> {
  const metadata = await fileMetadata(contextPath);
  if (!metadata.present) return { present: false, path: contextPath, metadata, note: "no setup context found; registry deploy metadata remains authoritative" };
  try {
    const parsed = JSON.parse(await readFile(contextPath, "utf8")) as Partial<LocalSetupContext>;
    if (parsed.version !== 1 || (parsed.target !== "local" && parsed.target !== "remote") || typeof parsed.workspaceRoot !== "string") {
      return { present: true, path: contextPath, metadata, warning: "setup context is invalid or unsupported" };
    }
    if ((parsed.workspace ?? workspace) !== workspace) {
      return { present: true, path: contextPath, metadata, warning: `setup context is for workspace ${parsed.workspace}, not ${workspace}` };
    }
    return {
      present: true,
      path: contextPath,
      metadata,
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
    return { present: true, path: contextPath, metadata, warning: `could not parse setup context: ${errorMessage(error)}` };
  }
}

function findRegistryRepo(index: RepoRegistryIndex | undefined, aliases: readonly string[], repoName: string): { key?: string; repo?: RepoRegistryRepo } {
  const repos = index?.repos;
  if (!repos) return {};
  for (const alias of aliases) {
    const repo = repos[alias];
    if (repo) return { key: alias, repo };
  }
  for (const [key, repo] of Object.entries(repos)) {
    if (asString(repo.repo_name) === repoName || aliases.includes(asString(repo.alias) ?? "")) return { key, repo };
  }
  return {};
}

function stackRepoFromLocalBrain(repoRoot: string): StackRepoResolution {
  return {
    role: "control-plane",
    alias: "brain",
    repoName: "brain",
    host: "local",
    path: repoRoot,
    source: "current checkout",
    present: true,
  };
}

function stackRepoFromRegistry<R extends StackRepoResolution["role"]>(role: R, resolved: { key?: string; repo?: RepoRegistryRepo }, sourceOverride?: Record<string, unknown>): StackRepoResolution {
  const repo = resolved.repo;
  const opsSource = asRecord(asRecord(asRecord(repo?.ops)?.repository)?.source);
  const host = asString(sourceOverride?.host) ?? asString(opsSource?.host) ?? asString(repo?.host) ?? "missing";
  const repoPath = asString(sourceOverride?.path) ?? asString(opsSource?.path) ?? asString(repo?.path) ?? "missing";
  const requestedRef = asString(sourceOverride?.ref) ?? asString(sourceOverride?.branch) ?? asString(opsSource?.ref) ?? asString(opsSource?.branch) ?? asString(repo?.current_branch) ?? asString(repo?.default_branch);
  const branch = requestedRef;
  const remoteUrl = redactRemoteUrl(asString(sourceOverride?.remote_url) ?? asString(opsSource?.remote_url) ?? asString(repo?.remote_url) ?? "");
  return {
    role,
    alias: asString(repo?.alias) ?? resolved.key ?? "missing",
    repoName: asString(repo?.repo_name) ?? resolved.key ?? "missing",
    host,
    path: repoPath,
    branch,
    requestedRef,
    remoteUrl: remoteUrl || undefined,
    source: resolved.repo ? "repo-registry" : "missing",
    registryKey: resolved.key,
    present: Boolean(resolved.repo),
  };
}

function stackRepoWithEnvironmentOverride(repo: StackRepoResolution, override: Record<string, unknown> | undefined, source: string): StackRepoResolution {
  if (!override) return repo;
  const requestedRef = asString(override.ref) ?? asString(override.branch) ?? repo.requestedRef ?? repo.branch;
  const remoteUrl = redactRemoteUrl(asString(override.remote_url) ?? repo.remoteUrl ?? "");
  return {
    ...repo,
    host: asString(override.host) ?? repo.host,
    path: asString(override.path) ?? repo.path,
    branch: requestedRef,
    requestedRef,
    remoteUrl: remoteUrl || undefined,
    source: `${repo.source}; ${source}`,
  };
}

function registryAppEnvironment(repo: RepoRegistryRepo, appName: string, environment: string): { name: string; app?: Record<string, unknown>; environment?: Record<string, unknown> } | undefined {
  const apps = asRecord(repo.apps);
  const app = asRecord(apps?.[appName]) ?? Object.values(apps ?? {}).map(asRecord).find(Boolean);
  const environments = asRecord(app?.environments);
  const env = asRecord(environments?.[environment]) ?? Object.values(environments ?? {}).map(asRecord).find(Boolean);
  const envName = asRecord(environments?.[environment]) ? environment : Object.keys(environments ?? {})[0] ?? environment;
  return app || env ? { name: envName, app, environment: env } : undefined;
}

function readStackHealthChecks(environment: Record<string, unknown> | undefined): Array<{ kind: string; command: string }> {
  const checks = Array.isArray(environment?.health_checks) ? environment.health_checks : [];
  return checks.flatMap((check) => {
    const record = asRecord(check);
    const command = asString(record?.command);
    if (!command) return [];
    return [{ kind: asString(record?.kind) ?? "command", command }];
  });
}

function readExpectedTelegramBot(deploy: Record<string, unknown> | undefined, environment: Record<string, unknown> | undefined): TelegramBotIdentity | undefined {
  const candidate = asRecord(deploy?.expected_telegram_bot)
    ?? asRecord(environment?.expected_telegram_bot)
    ?? asRecord(deploy?.telegram_bot)
    ?? asRecord(environment?.telegram_bot);
  const idValue = candidate?.id;
  const id = typeof idValue === "number" ? String(idValue) : asString(idValue);
  const username = asString(candidate?.username)?.replace(/^@/, "");
  return id || username ? { id, username } : undefined;
}

function stackSecretMetadataChecks(envVars: string[], envFile: string | undefined, sshIdentity: string | undefined, expectedTelegramBot?: TelegramBotIdentity): Array<Record<string, unknown>> {
  if (!envFile && envVars.length === 0) return [];
  return [
    ...(envFile ? [{
      source: "codex-chat.env_file",
      kind: "file",
      path: envFile,
      metadataOnly: true,
      value: "redacted",
      plannedCheck: remotePlanCommand(sshIdentity, `test -r ${shellPathArg(envFile)} && stat -c '%a %U %s' ${shellPathArg(envFile)}`),
    }] : []),
    ...envVars.map((name) => ({
      source: "codex-chat.env_vars",
      kind: "env",
      name,
      metadataOnly: true,
      value: "redacted",
      plannedCheck: envFile
        ? remotePlanCommand(sshIdentity, `grep -qE '^${escapeShellRegex(name)}=' ${shellPathArg(envFile)}`)
        : "pending env file selection; check presence without printing values",
    })),
    ...(envFile && expectedTelegramBot ? [{
      source: "codex-chat.telegram_bot_identity",
      kind: "telegram-getMe",
      envFile,
      expected: expectedTelegramBot,
      metadataOnly: true,
      value: "redacted",
      plannedCheck: remotePlanCommand(sshIdentity, renderTelegramBotIdentityGuardShell({ envFile, expected: expectedTelegramBot })),
    }] : []),
  ];
}

function renderCodexChatEnvPreview(status: StackStatusDetails): string {
  const envVars = status.servantRuntime.deploy.envVars;
  return [
    "# codex-chat service environment template rendered by Brain.",
    "# Fill secret values on the remote server only; Brain never stores or prints them.",
    ...envVars.map((name) => `${name}=<redacted:set-on-server>`),
    "",
  ].join("\n");
}

function renderCodexChatConfigPreview(status: StackStatusDetails): string {
  const codexChatRoot = status.servantRuntime.deploy.path ?? status.servantRuntime.path;
  const workspaceRoot = codexChatWorkspaceRoot(status);
  const controlPlaneRoot = status.setupContext.context?.repoPath ?? status.controlPlane.path;
  const stateDir = path.posix.join(workspaceRoot, "state", "codex-chat");
  const artifactDir = path.posix.join(workspaceRoot, "artifacts", "subagents");
  const runDir = path.posix.join(workspaceRoot, "state", "run");
  const addDirs = [
    controlPlaneRoot,
    codexChatRoot,
    status.assistantLogic.path,
    workspaceRoot,
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  return [
    "# codex-chat TOML rendered by Brain control plane.",
    "# Secret values stay in the service environment or host secret store, never in deployment metadata.",
    "version = 1",
    "",
    "[service]",
    "name = \"codex-chat\"",
    `workspace = ${tomlString(workspaceRoot)}`,
    `stateDir = ${tomlString(stateDir)}`,
    "logLevel = \"info\"",
    "timezone = \"Etc/UTC\"",
    `ipcSocket = ${tomlString(path.posix.join(runDir, "codex-chat.sock"))}`,
    "",
    "[codex]",
    "binary = \"codex\"",
    "transport = \"app-server\"",
    "model = \"gpt-5.5\"",
    "effort = \"medium\"",
    "sandbox = \"danger-full-access\"",
    "approvalPolicy = \"never\"",
    "extraConfig = [\"model_reasoning_effort=\\\"medium\\\"\"]",
    `addDirs = [${addDirs.map(tomlString).join(", ")}]`,
    "",
    "[telegram]",
    "mode = \"polling\"",
    "botTokenEnv = \"TELEGRAM_BOT_TOKEN\"",
    "parseMode = \"plain\"",
    "pairingEnabledOnEmptyAllowlist = true",
    "downloadMaxBytes = 52428800",
    "sendProgressUpdates = true",
    "opsChatId = 0",
    "",
    "[telegram.allowlist]",
    "userIds = []",
    "chatIds = []",
    "adminUserIds = []",
    "",
    "[behavior]",
    `dir = ${tomlString(path.posix.join(codexChatRoot, "behavior"))}`,
    "entrypoint = \"AGENTS.md\"",
    "reloadOnSighup = true",
    "",
    "[subagents]",
    "enabled = true",
    "backend = \"codex_exec\"",
    "maxConcurrent = 5",
    "defaultEffort = \"medium\"",
    "defaultTimeoutSec = 1800",
    "maxTimeoutSec = 7200",
    `artifactDir = ${tomlString(artifactDir)}`,
    `childSocketDir = ${tomlString(path.posix.join(runDir, "subagents"))}`,
    "cleanupArtifacts = true",
    "",
    "[employees]",
    "enabled = false",
    `rootDir = ${tomlString(path.posix.join(workspaceRoot, "data", "employees"))}`,
    `socketDir = ${tomlString(path.posix.join(runDir, "employees"))}`,
    "",
    "[loops]",
    "enabled = false",
    `path = ${tomlString(path.posix.join(workspaceRoot, "config", "loops.json"))}`,
    "namespace = \"codex-chat\"",
    "runnerCommand = \"codex-chat loop run\"",
    "",
    "[monitors]",
    "enabled = false",
    `path = ${tomlString(path.posix.join(workspaceRoot, "config", "monitors.json"))}`,
    "",
    "[files]",
    `dir = ${tomlString(path.posix.join(workspaceRoot, "documents", "files"))}`,
    `artifactDir = ${tomlString(path.posix.join(workspaceRoot, "artifacts"))}`,
    `allowedSendRoots = [${[workspaceRoot, path.posix.join(workspaceRoot, "artifacts"), codexChatRoot].map(tomlString).join(", ")}]`,
    "",
    "[transcription]",
    "enabled = false",
    "provider = \"openai\"",
    "model = \"gpt-4o-mini-transcribe\"",
    "apiKeyEnv = \"OPENAI_API_KEY\"",
    "",
    "[security]",
    "redactSecretsInLogs = true",
    "requireLocalFileForSend = true",
    "allowShellActionsFromDirectives = false",
  ].join("\n");
}

function codexChatWorkspaceRoot(status: StackStatusDetails): string {
  return status.setupContext.context?.workspaceRoot ?? status.assistantData.workspacePath ?? status.assistantData.path;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderSystemdServicePreview(status: StackStatusDetails): string {
  const serviceName = status.servantRuntime.deploy.serviceName ?? "codex-chat.service";
  const workingDirectory = status.servantRuntime.deploy.path ?? status.servantRuntime.path;
  const runtimeUser = status.servantRuntime.deploy.runtimeUser ?? DEFAULT_SERVICE_USER;
  const envFile = status.servantRuntime.deploy.envFile;
  const configPath = status.servantRuntime.deploy.configPath ?? status.servicePaths.setupContextConfigPath ?? path.posix.join(workingDirectory, "config", "codex-chat.toml");
  return [
    "[Unit]",
    "Description=codex-chat Telegram/Codex runtime (deployed by Brain control plane)",
    "Conflicts=brain-personal.service",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `User=${runtimeUser}`,
    `WorkingDirectory=${workingDirectory}`,
    ...(envFile ? [`EnvironmentFile=${envFile}`] : []),
    `ExecStart=/usr/bin/env node dist/main.js --config ${configPath} start`,
    "Restart=on-failure",
    "RestartSec=5s",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function renderStackExecutorActions(status: StackStatusDetails, approvals: Record<StackApprovalGate, boolean>): StackExecutorAction[] {
  const servant = status.servantRuntime;
  const logic = status.assistantLogic;
  const data = status.assistantData;
  const deploy = servant.deploy;
  const deployPath = deploy.path ?? servant.path;
  const sourceIdentity = sshIdentityFromHost(servant.host, undefined);
  const deployIdentity = deploy.sshIdentity ?? sshIdentityFromHost(deploy.host, deploy.runtimeUser);
  const logicIdentity = sshIdentityFromHost(logic.host, undefined);
  const dataIdentity = sshIdentityFromHost(data.host, undefined);
  const serviceName = deploy.serviceName ?? "codex-chat.service";
  const envFile = deploy.envFile;
  const configPath = deploy.configPath ?? status.servicePaths.setupContextConfigPath;
  const workspaceRoot = codexChatWorkspaceRoot(status);
  const configPreview = renderCodexChatConfigPreview(status);
  const envPreview = renderCodexChatEnvPreview(status);
  const systemdPreview = renderSystemdServicePreview(status);
  const action = (input: Omit<StackExecutorAction, "approved" | "displayCommand" | "secretValuesPrinted">): StackExecutorAction => ({
    ...input,
    approved: approvals[input.requiredGate],
    displayCommand: input.command ? remotePlanCommand(input.hostIdentity, input.command) : undefined,
    secretValuesPrinted: false,
  });
  return [
    action({
      id: "repo-boundary-preflight",
      title: "Validate repository boundaries before execution.",
      phase: "preflight",
      executor: "local",
      requiredGate: "apply",
      command: "true # repo-boundary preflight already resolved by brainctl stack status",
      metadataOnly: true,
      sideEffectsIfExecuted: "no filesystem/network changes",
    }),
    action({
      id: "clone-update-codex-chat-source",
      title: "Clone/update codex-chat source checkout and verify resolved SHA.",
      phase: "git",
      executor: sourceIdentity ? "ssh" : "local",
      requiredGate: "apply",
      hostIdentity: sourceIdentity,
      command: renderGitCloneOrUpdateShell({ path: servant.path, remoteUrl: servant.remoteUrl, branch: servant.requestedRef ?? servant.branch, role: "servant-runtime" }),
      repoUpdate: { role: "servant-runtime", repoName: servant.repoName, host: servant.host, path: servant.path, requestedRef: servant.requestedRef ?? servant.branch },
      sideEffectsIfExecuted: "would clone/fetch/update codex-chat source checkout to the configured ref and print resolved SHA",
    }),
    ...(deployPath !== servant.path ? [action({
      id: "clone-update-codex-chat-deploy",
      title: "Clone/update codex-chat deploy checkout.",
      phase: "git",
      executor: deployIdentity ? "ssh" : "local",
      requiredGate: "apply",
      hostIdentity: deployIdentity,
      command: renderGitCloneOrUpdateShell({ path: deployPath, remoteUrl: servant.remoteUrl, branch: servant.requestedRef ?? servant.branch, role: "servant-runtime" }),
      repoUpdate: { role: "servant-runtime", repoName: servant.repoName, host: deploy.host ?? servant.host, path: deployPath, requestedRef: servant.requestedRef ?? servant.branch },
      sideEffectsIfExecuted: "would clone/fetch/update codex-chat deploy checkout to the configured ref and print resolved SHA",
    })] : []),
    action({
      id: "build-codex-chat",
      title: "Install dependencies and build codex-chat.",
      phase: "git",
      executor: deployIdentity ? "ssh" : "local",
      requiredGate: "apply",
      hostIdentity: deployIdentity,
      command: `cd ${shellPathArg(deployPath)} && pnpm install --frozen-lockfile && pnpm run build`,
      sideEffectsIfExecuted: "would install dependencies and build codex-chat",
    }),
    action({
      id: "clone-update-assistant-agent-logic",
      title: "Clone/update assistant-agent-logic separately.",
      phase: "git",
      executor: logicIdentity ? "ssh" : "local",
      requiredGate: "apply",
      hostIdentity: logicIdentity,
      command: renderGitCloneOrUpdateShell({ path: logic.path, remoteUrl: logic.remoteUrl, branch: logic.requestedRef ?? logic.branch, role: "assistant-logic" }),
      repoUpdate: { role: "assistant-logic", repoName: logic.repoName, host: logic.host, path: logic.path, requestedRef: logic.requestedRef ?? logic.branch },
      sideEffectsIfExecuted: "would clone/fetch/update assistant-agent-logic to the configured ref and print resolved SHA; never vendored into Brain or codex-chat",
    }),
    action({
      id: "validate-assistant-agent-logic",
      title: "Validate assistant-agent-logic checkout metadata.",
      phase: "git",
      executor: logicIdentity ? "ssh" : "local",
      requiredGate: "apply",
      hostIdentity: logicIdentity,
      command: `test -d ${shellPathArg(`${logic.path}/.git`)} && git -C ${shellPathArg(logic.path)} status --short --branch`,
      metadataOnly: true,
      sideEffectsIfExecuted: "git metadata validation only",
    }),
    action({
      id: "assistant-agent-data-prompt",
      title: "Prompt/validate assistant-agent-data before private data use.",
      phase: "assistant-data",
      executor: "operator-prompt",
      requiredGate: "data",
      command: `printf '%s\\n' ${shellArg("Choose pull existing private repo, initialize new private repo, or validate current assistant-agent-data workspace; migration remains explicit/manual.")}`,
      sideEffectsIfExecuted: "operator-approved private data decision only",
    }),
    action({
      id: "assistant-agent-data-clone-or-init-placeholder",
      title: "Clone/init assistant-agent-data placeholder.",
      phase: "assistant-data",
      executor: dataIdentity ? "ssh" : "local",
      requiredGate: "data",
      hostIdentity: dataIdentity,
      command: data.remoteUrl
        ? renderGitCloneOrUpdateShell({ path: data.path, remoteUrl: data.remoteUrl, branch: data.requestedRef ?? data.branch, role: "assistant-data" })
        : `mkdir -p ${shellPathArg(data.path)} && test -d ${shellPathArg(`${data.path}/.git`)} || git -C ${shellPathArg(data.path)} init -b ${shellArg(data.branch ?? "main")}`,
      sideEffectsIfExecuted: "would clone or initialize assistant-agent-data only after data approval; migration placeholder only",
    }),
    ...(configPath ? [action({
      id: "render-codex-chat-config-env",
      title: "Render codex-chat config and env template without secret values.",
      phase: "config",
      executor: deployIdentity ? "ssh" : "local",
      requiredGate: "config",
      hostIdentity: deployIdentity,
      command: renderConfigEnvWriteShell({ configPath, configPreview, envFile, envPreview }),
      sideEffectsIfExecuted: "would write codex-chat config and env template placeholders only; no secret values",
    })] : []),
    action({
      id: "migrate-telegram-pairing-state",
      title: "Migrate legacy Brain Telegram pairing/admin state into codex-chat state.",
      phase: "state",
      executor: deployIdentity ? "ssh" : "local",
      requiredGate: "service",
      hostIdentity: deployIdentity,
      command: renderTelegramPairingMigrationShell({ workspaceRoot }),
      sideEffectsIfExecuted: "would copy existing Telegram paired/admin identities into codex-chat state, back up previous state, remove stale bootstrap pairing codes, and print metadata only",
    }),
    action({
      id: "install-codex-chat-systemd",
      title: "Install/enable/restart codex-chat systemd service.",
      phase: "systemd",
      executor: deployIdentity ? "ssh" : "local",
      requiredGate: "service",
      hostIdentity: deployIdentity,
      command: renderSystemdInstallShell({ serviceName, unit: systemdPreview, envFile, expectedTelegramBot: deploy.expectedTelegramBot }),
      sideEffectsIfExecuted: deploy.expectedTelegramBot
        ? "would verify Telegram bot identity from remote env file, stop/disable legacy brain-personal.service, then install service unit, reload systemd, enable and restart codex-chat"
        : "would stop/disable legacy brain-personal.service, then install service unit, reload systemd, enable and restart codex-chat",
    }),
    ...((deploy.healthChecks.length > 0 ? deploy.healthChecks : [{ kind: "systemd", command: `systemctl status ${shellArg(serviceName)} --no-pager` }]).map((check, index) => action({
      id: `health-check-${index + 1}`,
      title: `Run health check: ${check.kind}`,
      phase: "health",
      executor: deployIdentity ? "ssh" : "local",
      requiredGate: "health",
      hostIdentity: deployIdentity,
      command: check.command,
      metadataOnly: true,
      sideEffectsIfExecuted: "read-only health verification",
    }))),
    action({
      id: "record-deployment-metadata",
      title: "Record deployment metadata in canonical Brain workspace/control-plane state.",
      phase: "metadata",
      executor: "metadata-file",
      requiredGate: "apply",
      writesMetadata: true,
      command: `merge deployment record into ${status.deploymentMetadata.canonical.path}`,
      sideEffectsIfExecuted: "writes deployment metadata with redacted secret refs only",
    }),
  ];
}

function renderGitCloneOrUpdateShell(input: { path: string; remoteUrl?: string; branch?: string; role?: StackRepoResolution["role"] }): string {
  const requestedRef = input.branch ?? "main";
  const repoPath = shellPathArg(input.path);
  const refArg = shellArg(requestedRef);
  const role = input.role ?? "servant-runtime";
  const marker = `BRAIN_REPO_SHA role=${role} path=${input.path} requestedRef=${requestedRef} resolvedSha=`;
  if (!input.remoteUrl) {
    return [
      "set -euo pipefail",
      `test -d ${repoPath}/.git`,
      `git -C ${repoPath} fetch --all --tags --prune`,
      `if git -C ${repoPath} rev-parse --verify --quiet ${shellArg(`origin/${requestedRef}^{commit}`)} >/dev/null; then git -C ${repoPath} checkout -B ${refArg} ${shellArg(`origin/${requestedRef}`)}; else git -C ${repoPath} checkout --detach ${refArg}; fi`,
      `sha=$(git -C ${repoPath} rev-parse HEAD)`,
      `printf '%s%s\\n' ${shellArg(marker)} "$sha"`,
    ].join("\n");
  }
  return [
    "set -euo pipefail",
    `if [ -d ${repoPath}/.git ]; then`,
    `  git -C ${repoPath} remote set-url origin ${shellArg(input.remoteUrl)}`,
    "else",
    `  mkdir -p ${shellPathArg(path.posix.dirname(input.path))}`,
    `  git clone ${shellArg(input.remoteUrl)} ${repoPath}`,
    "fi",
    `git -C ${repoPath} fetch origin --tags --prune`,
    `if git -C ${repoPath} rev-parse --verify --quiet ${shellArg(`origin/${requestedRef}^{commit}`)} >/dev/null; then`,
    `  git -C ${repoPath} checkout -B ${refArg} ${shellArg(`origin/${requestedRef}`)}`,
    "else",
    `  git -C ${repoPath} checkout --detach ${refArg}`,
    "fi",
    `sha=$(git -C ${repoPath} rev-parse HEAD)`,
    `printf '%s%s\\n' ${shellArg(marker)} "$sha"`,
  ].join("\n");
}

function renderConfigEnvWriteShell(input: { configPath: string; configPreview: string; envFile?: string; envPreview: string }): string {
  const configDir = path.posix.dirname(input.configPath);
  const commands = [
    "set -e",
    `mkdir -p ${shellPathArg(configDir)}`,
    `umask 077`,
    `cat > ${shellPathArg(input.configPath)} <<'BRAIN_CODEX_CHAT_CONFIG'\n${input.configPreview}\nBRAIN_CODEX_CHAT_CONFIG`,
  ];
  if (input.envFile) {
    commands.splice(1, 0, `mkdir -p ${shellPathArg(path.posix.dirname(input.envFile))}`);
    commands.push(`if [ ! -f ${shellPathArg(input.envFile)} ]; then\n  umask 077\n  cat > ${shellPathArg(input.envFile)} <<'BRAIN_CODEX_CHAT_ENV'\n${input.envPreview}\nBRAIN_CODEX_CHAT_ENV\nfi`);
  }
  return commands.join("\n");
}

function renderTelegramBotIdentityGuardShell(input: { envFile: string; expected: TelegramBotIdentity }): string {
  return [
    "set -euo pipefail",
    `BRAIN_CODEX_CHAT_ENV=${shellArg(input.envFile)} BRAIN_EXPECTED_BOT_ID=${shellArg(input.expected.id ?? "")} BRAIN_EXPECTED_BOT_USERNAME=${shellArg(input.expected.username ?? "")} node <<'BRAIN_TELEGRAM_BOT_GUARD'`,
    "const fs = require('fs');",
    "const envFile = process.env.BRAIN_CODEX_CHAT_ENV;",
    "const expectedId = process.env.BRAIN_EXPECTED_BOT_ID || undefined;",
    "const expectedUsername = (process.env.BRAIN_EXPECTED_BOT_USERNAME || '').replace(/^@/, '') || undefined;",
    "const fail = (message) => { console.error(message); process.exit(1); };",
    "const text = fs.readFileSync(envFile, 'utf8');",
    "let token;",
    "for (const rawLine of text.split(/\\r?\\n/)) {",
    "  const line = rawLine.trim();",
    "  if (!line || line.startsWith('#')) continue;",
    "  const match = /^TELEGRAM_BOT_TOKEN\\s*=\\s*(.*)$/.exec(line);",
    "  if (!match) continue;",
    "  let value = match[1].trim();",
    "  if ((value.startsWith(\"'\") && value.endsWith(\"'\")) || (value.startsWith('\"') && value.endsWith('\"'))) value = value.slice(1, -1);",
    "  token = value;",
    "}",
    "if (!token || token.includes('<redacted')) fail('codex-chat env file is missing a real TELEGRAM_BOT_TOKEN');",
    "if (typeof fetch !== 'function') fail('node fetch API is unavailable; cannot verify Telegram bot identity');",
    "(async () => {",
    "  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);",
    "  const body = await response.json().catch(() => ({}));",
    "  if (!response.ok || body.ok !== true) fail('Telegram getMe failed for codex-chat env token');",
    "  const bot = body.result || {};",
    "  const actualId = String(bot.id || '');",
    "  const actualUsername = String(bot.username || '');",
    "  if (expectedId && actualId !== expectedId) fail('Telegram bot id mismatch (raw ids redacted)');",
    "  if (expectedUsername && actualUsername !== expectedUsername) fail(`Telegram bot username mismatch: expected ${expectedUsername}, got ${actualUsername || 'unknown'}`);",
    "  console.error(`Verified Telegram bot identity: @${actualUsername} (id verified, raw id redacted)`);",
    "})().catch((error) => fail(error && error.message ? error.message : String(error)));",
    "BRAIN_TELEGRAM_BOT_GUARD",
  ].join("\n");
}

function renderTelegramPairingMigrationShell(input: { workspaceRoot: string }): string {
  const legacyStateDir = path.posix.join(input.workspaceRoot, "state", "telegram-pairing");
  const codexStateDir = path.posix.join(input.workspaceRoot, "state", "codex-chat");
  return [
    "set -euo pipefail",
    `BRAIN_LEGACY_TELEGRAM_PAIRING_STATE=${shellArg(legacyStateDir)} BRAIN_CODEX_CHAT_STATE=${shellArg(codexStateDir)} node <<'BRAIN_TELEGRAM_PAIRING_MIGRATION'`,
    "const fs = require('fs');",
    "const path = require('path');",
    "const legacyDir = process.env.BRAIN_LEGACY_TELEGRAM_PAIRING_STATE;",
    "const codexDir = process.env.BRAIN_CODEX_CHAT_STATE;",
    "const now = new Date().toISOString();",
    "const readJson = (file, fallback) => {",
    "  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }",
    "  catch { return fallback; }",
    "};",
    "const asId = (value) => {",
    "  if (typeof value === 'number' && Number.isFinite(value)) return value;",
    "  if (typeof value === 'string' && /^-?\\d+$/.test(value.trim())) return Number(value);",
    "  return undefined;",
    "};",
    "const backup = () => {",
    "  if (!fs.existsSync(codexDir)) return undefined;",
    "  const backupDir = path.join(codexDir, 'migration-backups', `telegram-pairing-${now.replace(/[:.]/g, '-')}`);",
    "  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });",
    "  for (const rel of ['telegram_users.json', 'telegram_chats.json', path.join('data', 'pairing_code.txt')]) {",
    "    const src = path.join(codexDir, rel);",
    "    if (!fs.existsSync(src)) continue;",
    "    const dst = path.join(backupDir, rel.replace(/[\\\\/]/g, '__'));",
    "    fs.copyFileSync(src, dst);",
    "    fs.chmodSync(dst, 0o600);",
    "  }",
    "  return backupDir;",
    "};",
    "const mergeUsers = (target, records, source) => {",
    "  let added = 0;",
    "  for (const record of Array.isArray(records) ? records : []) {",
    "    if (!record || typeof record !== 'object') continue;",
    "    const userId = asId(record.userId);",
    "    if (userId === undefined) continue;",
    "    const key = String(userId);",
    "    const existing = target.get(key);",
    "    const next = { userId, isAdmin: record.isAdmin !== false, pairedAt: typeof record.pairedAt === 'string' ? record.pairedAt : now, source };",
    "    if (existing) existing.isAdmin = existing.isAdmin || next.isAdmin;",
    "    else { target.set(key, next); added += 1; }",
    "  }",
    "  return added;",
    "};",
    "const mergeChats = (target, records, source) => {",
    "  let added = 0;",
    "  for (const record of Array.isArray(records) ? records : []) {",
    "    if (!record || typeof record !== 'object') continue;",
    "    const chatId = asId(record.chatId);",
    "    if (chatId === undefined) continue;",
    "    const key = String(chatId);",
    "    if (!target.has(key)) {",
    "      target.set(key, { chatId, pairedAt: typeof record.pairedAt === 'string' ? record.pairedAt : now, source });",
    "      added += 1;",
    "    }",
    "  }",
    "  return added;",
    "};",
    "fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });",
    "fs.mkdirSync(path.join(codexDir, 'data'), { recursive: true, mode: 0o700 });",
    "const backupDir = backup();",
    "const users = new Map();",
    "const chats = new Map();",
    "mergeUsers(users, readJson(path.join(codexDir, 'telegram_users.json'), []), 'codex-chat-existing');",
    "mergeChats(chats, readJson(path.join(codexDir, 'telegram_chats.json'), []), 'codex-chat-existing');",
    "const legacyUsers = readJson(path.join(legacyDir, 'telegram_users.json'), []);",
    "const legacyChats = readJson(path.join(legacyDir, 'telegram_chats.json'), []);",
    "const legacyAdmins = readJson(path.join(legacyDir, 'telegram_admins.json'), {});",
    "const adminPairs = Array.isArray(legacyAdmins.admins) ? legacyAdmins.admins : [];",
    "const addedUsers = mergeUsers(users, legacyUsers, 'brain-legacy-pairing') + mergeUsers(users, adminPairs, 'brain-legacy-admins');",
    "const addedChats = mergeChats(chats, legacyChats, 'brain-legacy-pairing') + mergeChats(chats, adminPairs, 'brain-legacy-admins');",
    "const writeJson = (rel, value) => {",
    "  const file = path.join(codexDir, rel);",
    "  const tmp = `${file}.tmp`;",
    "  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\\n`, { mode: 0o600 });",
    "  fs.renameSync(tmp, file);",
    "  fs.chmodSync(file, 0o600);",
    "};",
    "writeJson('telegram_users.json', Array.from(users.values()));",
    "writeJson('telegram_chats.json', Array.from(chats.values()));",
    "const pairingCode = path.join(codexDir, 'data', 'pairing_code.txt');",
    "let pairingCodeRemoved = false;",
    "if ((users.size > 0 || chats.size > 0) && fs.existsSync(pairingCode)) {",
    "  fs.rmSync(pairingCode, { force: true });",
    "  pairingCodeRemoved = true;",
    "}",
    "console.error(`BRAIN_PAIRING_MIGRATION legacyUsers=${Array.isArray(legacyUsers) ? legacyUsers.length : 0} legacyChats=${Array.isArray(legacyChats) ? legacyChats.length : 0} legacyAdminPairs=${adminPairs.length} addedUsers=${addedUsers} addedChats=${addedChats} finalUsers=${users.size} finalChats=${chats.size} pairingCodeRemoved=${pairingCodeRemoved} backup=${backupDir ? 'created' : 'not-needed'} rawIdentifiersPrinted=false`);",
    "BRAIN_TELEGRAM_PAIRING_MIGRATION",
  ].join("\n");
}

function renderSystemdInstallShell(input: { serviceName: string; unit: string; envFile?: string; expectedTelegramBot?: TelegramBotIdentity }): string {
  return [
    ...(input.envFile && input.expectedTelegramBot ? [renderTelegramBotIdentityGuardShell({ envFile: input.envFile, expected: input.expectedTelegramBot })] : []),
    "sudo systemctl disable --now brain-personal.service >/dev/null 2>&1 || true",
    "sudo systemctl reset-failed brain-personal.service >/dev/null 2>&1 || true",
    `cat <<'BRAIN_CODEX_CHAT_SERVICE' | sudo tee ${shellPathArg(`/etc/systemd/system/${input.serviceName}`)} >/dev/null`,
    input.unit.trimEnd(),
    "BRAIN_CODEX_CHAT_SERVICE",
    `sudo systemctl daemon-reload && sudo systemctl enable ${shellArg(input.serviceName)} && sudo systemctl restart ${shellArg(input.serviceName)}`,
  ].join("\n");
}

function renderStackNoNetworkPlan(status: StackStatusDetails) {
  const servant = status.servantRuntime;
  const logic = status.assistantLogic;
  const data = status.assistantData;
  const deploy = servant.deploy;
  const sourceIdentity = sshIdentityFromHost(servant.host, undefined);
  const deployIdentity = deploy.sshIdentity;
  const serviceName = deploy.serviceName ?? "codex-chat.service";
  return {
    goal: "Deploy/manage the codex-chat servant runtime stack from Brain as a control-plane orchestrator while keeping repositories separate.",
    mode: "dry-run/no-network",
    steps: [
      {
        id: "resolve-repo-registry",
        title: "Resolve registry and setup context.",
        status: status.missing.length === 0 ? "ready" : "needs-attention",
        inputs: [status.registry.path, status.setupContext.path],
        sideEffects: "none",
        commandsExecuted: [],
      },
      {
        id: "repo-boundary-preflight",
        title: "Assert repo boundaries before any setup/deploy work.",
        status: status.repoBoundaries.ok ? "ready" : "blocked",
        policy: status.repoBoundaries.policy,
        issues: status.repoBoundaries.issues,
        sideEffects: "none",
      },
      {
        id: "clone-update-codex-chat",
        title: "Clone or fetch/update codex-chat servant runtime checkout, then verify the resolved SHA.",
        target: { host: servant.host, path: servant.path, deployHost: deploy.host, deployPath: deploy.path, branch: servant.branch, requestedRef: servant.requestedRef, remoteUrl: servant.remoteUrl },
        commands: [
          renderGitCloneOrUpdateCommand({ hostIdentity: sourceIdentity, path: servant.path, remoteUrl: servant.remoteUrl, branch: servant.requestedRef ?? servant.branch, role: "servant-runtime" }),
          deploy.path && deploy.path !== servant.path
            ? renderGitCloneOrUpdateCommand({ hostIdentity: deployIdentity, path: deploy.path, remoteUrl: servant.remoteUrl, branch: servant.requestedRef ?? servant.branch, role: "servant-runtime" })
            : undefined,
        ].filter(isString),
        sideEffectsIfExecuted: "would clone/fetch/update codex-chat to the configured latest ref and print resolved SHA; not executed by this command",
      },
      {
        id: "clone-update-assistant-agent-logic",
        title: "Clone or fetch/update assistant-agent-logic as a separate repository, then verify the resolved SHA.",
        target: { host: logic.host, path: logic.path, branch: logic.branch, requestedRef: logic.requestedRef, remoteUrl: logic.remoteUrl },
        commands: [
          renderGitCloneOrUpdateCommand({ hostIdentity: sshIdentityFromHost(logic.host, undefined), path: logic.path, remoteUrl: logic.remoteUrl, branch: logic.requestedRef ?? logic.branch, role: "assistant-logic" }),
        ],
        boundary: "Do not vendor, copy, subtree, or merge assistant-agent-logic into Brain or codex-chat.",
        sideEffectsIfExecuted: "would clone/fetch/update assistant-agent-logic to the configured latest ref and print resolved SHA; not executed by this command",
      },
      {
        id: "assistant-data-workspace",
        title: "Prompt and validate assistant-agent-data/private workspace.",
        target: { host: data.host, path: data.path, branch: data.branch, remoteUrl: data.remoteUrl },
        prompts: [
          "Confirm the assistant-agent-data repository/workspace path and remote before relying on private memory.",
          "Choose pull existing private repo, initialize new private repo, or validate current workspace metadata.",
          "If legacy private data exists elsewhere, create an explicit migration plan; this phase does not auto-migrate or print private filenames/values.",
        ],
        validationPlaceholders: [
          "Check .git presence, branch, and remote metadata only.",
          "Check expected workspace directories/stores by metadata only.",
          "Check secret/env files by existence/mode/size only; never cat or echo values.",
        ],
        migrationPlaceholder: data.migrationPlaceholder,
        sideEffectsIfExecuted: "operator-approved private data pull/init/validation only; not executed by this command",
      },
      {
        id: "render-codex-chat-config-env",
        title: "Render codex-chat service config/env from registry and setup context.",
        target: { envFile: deploy.envFile, configPath: deploy.configPath ?? status.servicePaths.setupContextConfigPath },
        envVars: deploy.envVars.map((name) => ({ name, value: "redacted", metadataOnly: true })),
        expectedTelegramBot: deploy.expectedTelegramBot,
        secretMetadataChecks: status.secretMetadataChecks,
        renderedConfigPreview: renderCodexChatConfigPreview(status),
        renderedEnvPreview: renderCodexChatEnvPreview(status),
        templates: [
          "codex-chat service env template with secret placeholders only",
          "codex-chat runtime config template/path binding when configured",
        ],
        sideEffectsIfExecuted: "would write private env/config files only after explicit operator confirmation; not executed by this command",
      },
      {
        id: "migrate-telegram-pairing-state",
        title: "Preserve Telegram paired/admin identities when moving from brain-personal to codex-chat.",
        target: {
          host: deploy.host,
          sshIdentity: deployIdentity,
          legacyStateDir: path.posix.join(codexChatWorkspaceRoot(status), "state", "telegram-pairing"),
          codexChatStateDir: path.posix.join(codexChatWorkspaceRoot(status), "state", "codex-chat"),
        },
        commands: [
          remotePlanCommand(deployIdentity, "merge state/telegram-pairing users/chats/admins into state/codex-chat and remove stale pairing_code.txt when identities exist"),
        ],
        sideEffectsIfExecuted: "would preserve existing Telegram access metadata without printing raw user/chat IDs; not executed by this command",
      },
      {
        id: "install-start-codex-chat-service",
        title: "Install, enable, and restart the codex-chat servant service.",
        target: { host: deploy.host, sshIdentity: deployIdentity, path: deploy.path, serviceName, runtimeUser: deploy.runtimeUser },
        commands: [
          remotePlanCommand(deployIdentity, `cd ${shellPathArg(deploy.path ?? servant.path)} && pnpm install --frozen-lockfile && pnpm run build`),
          remotePlanCommand(deployIdentity, `sudo systemctl disable --now brain-personal.service >/dev/null 2>&1 || true`),
          remotePlanCommand(deployIdentity, `sudo systemctl daemon-reload && sudo systemctl enable ${shellArg(serviceName)} && sudo systemctl restart ${shellArg(serviceName)}`),
          remotePlanCommand(deployIdentity, `systemctl is-active ${shellArg(serviceName)} --quiet`),
        ],
        sideEffectsIfExecuted: "would install dependencies/build, stop legacy Brain polling if present, and restart systemd service; not executed by this command",
      },
      {
        id: "record-deployment-metadata",
        title: "Record/list deployment metadata on the Brain/control-plane host.",
        target: status.deploymentMetadata.canonical,
        schema: status.deploymentMetadata.canonical.schema,
        deployments: status.deploymentMetadata.deployments,
        plannedReadCommand: status.deploymentMetadata.read.plannedReadCommand,
        sideEffectsIfExecuted: "would merge a redacted deployment record into the canonical remote metadata store only after explicit apply approval",
      },
      {
        id: "health-check-codex-chat",
        title: "Run codex-chat servant runtime health checks.",
        target: { host: deploy.host, sshIdentity: deployIdentity, serviceName },
        commands: deploy.healthChecks.length > 0
          ? deploy.healthChecks.map((check) => remotePlanCommand(deployIdentity, check.command))
          : [remotePlanCommand(deployIdentity, `systemctl status ${shellArg(serviceName)} --no-pager`)],
        sideEffectsIfExecuted: "health/readiness checks only; not executed by this command",
      },
    ],
    execution: {
      dryRunDefault: true,
      approvalRequired: true,
      executors: ["dry-run", "mock", "local", "ssh"],
      approvalGates: stackApprovalGateDetails({ apply: false, data: false, config: false, service: false, health: false }),
      metadataStore: status.deploymentMetadata.canonical,
      actions: renderStackExecutorActions(status, { apply: false, data: false, config: false, service: false, health: false }),
    },
    forbidden: [
      "Do not deploy or mutate remote servers from stack status/plan.",
      "Do not vendor or merge codex-chat, assistant-agent-logic, or assistant-agent-data into Brain.",
      "Do not silently reuse stale local checkouts; stack apply must fetch/update configured refs and record resolved SHAs for codex-chat and assistant-agent-logic.",
      "Do not print secret values; inspect env/secret files by metadata only.",
    ],
  };
}

async function executeStackAction(action: StackExecutorAction, input: { executor: StackExecutorKind; metadataFile?: string }): Promise<Record<string, unknown>> {
  if (!action.approved) {
    return {
      id: action.id,
      phase: action.phase,
      status: "skipped",
      reason: `approval gate not enabled: ${action.requiredGate}`,
      command: action.displayCommand,
      secretValuesPrinted: false,
    };
  }
  if (action.writesMetadata) {
    return {
      id: action.id,
      phase: action.phase,
      status: "handled-by-metadata-writer",
      command: action.command,
      secretValuesPrinted: false,
    };
  }
  if (input.executor === "mock") {
    return {
      id: action.id,
      phase: action.phase,
      status: "mocked",
      executor: "mock",
      command: action.displayCommand,
      repoUpdate: action.repoUpdate ? { ...action.repoUpdate, verified: false, note: "mock executor did not resolve a SHA" } : undefined,
      sideEffects: "none (mocked)",
      secretValuesPrinted: false,
    };
  }
  if (!action.command) {
    return {
      id: action.id,
      phase: action.phase,
      status: "succeeded",
      executor: input.executor,
      sideEffects: action.sideEffectsIfExecuted,
      secretValuesPrinted: false,
    };
  }
  if (action.executor === "ssh" && input.executor !== "ssh") {
    return {
      id: action.id,
      phase: action.phase,
      status: "failed",
      reason: "remote action requires --executor ssh",
      command: action.displayCommand,
      secretValuesPrinted: false,
    };
  }
  const result = action.executor === "ssh" && action.hostIdentity
    ? spawnSync("ssh", [action.hostIdentity, action.command], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })
    : spawnSync("bash", ["-lc", action.command], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const stdout = String(result.stdout ?? "");
  const repoUpdate = action.repoUpdate ? repoUpdateFromActionStdout(action.repoUpdate, stdout) : undefined;
  return {
    id: action.id,
    phase: action.phase,
    status: (result.status ?? 1) === 0 ? "succeeded" : "failed",
    exitCode: result.status,
    command: action.displayCommand,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(String(result.stderr ?? "")),
    repoUpdate,
    secretValuesPrinted: false,
  };
}

function repoUpdateFromActionStdout(input: NonNullable<StackExecutorAction["repoUpdate"]>, stdout: string): DeploymentRepoRef {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("BRAIN_REPO_SHA "));
  const fields: Record<string, string> = {};
  for (const part of (line ?? "").replace(/^BRAIN_REPO_SHA\s+/, "").split(/\s+/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    fields[part.slice(0, index)] = part.slice(index + 1);
  }
  const resolvedSha = fields.resolvedSha;
  return {
    ...input,
    resolvedSha: resolvedSha && /^[0-9a-f]{40}$/i.test(resolvedSha) ? resolvedSha : undefined,
    verified: Boolean(resolvedSha && /^[0-9a-f]{40}$/i.test(resolvedSha)),
  };
}

function collectResolvedRepoRefs(actionResults: Array<Record<string, unknown>>, status: StackStatusDetails): DeploymentRepoRef[] {
  const fallback = (repo: StackRepoResolution, pathOverride?: string, hostOverride?: string): DeploymentRepoRef => ({
    role: repo.role,
    repoName: repo.repoName,
    host: hostOverride ?? repo.host,
    path: pathOverride ?? repo.path,
    requestedRef: repo.requestedRef ?? repo.branch,
    verified: false,
  });
  const refs: DeploymentRepoRef[] = actionResults
    .map((result) => asRecord(result.repoUpdate))
    .filter((repo): repo is Record<string, unknown> => Boolean(repo))
    .map((repo) => ({
      role: asString(repo.role) as StackRepoResolution["role"],
      repoName: asString(repo.repoName) ?? "missing",
      host: asString(repo.host) ?? "missing",
      path: asString(repo.path) ?? "missing",
      requestedRef: asString(repo.requestedRef),
      resolvedSha: asString(repo.resolvedSha),
      verified: repo.verified === true,
    }));
  const ensure = (candidate: DeploymentRepoRef) => refs.some((ref) => ref.role === candidate.role && ref.path === candidate.path)
    ? refs
    : refs.push(candidate);
  ensure(fallback(status.servantRuntime));
  const deployPath = status.servantRuntime.deploy.path;
  if (deployPath && deployPath !== status.servantRuntime.path) ensure(fallback(status.servantRuntime, deployPath, status.servantRuntime.deploy.host));
  ensure(fallback(status.assistantLogic));
  return refs.sort((a, b) => `${a.role}:${a.path}`.localeCompare(`${b.role}:${b.path}`));
}

function stackDeploymentRecord(status: StackStatusDetails, input: {
  approvals: Record<StackApprovalGate, boolean>;
  requestedExecutor: StackExecutorKind;
  effectiveExecutor: StackExecutorKind;
  dryRun: boolean;
  actionCount: number;
  approvedActionCount: number;
  executedActionCount: number;
  failedActionCount: number;
  now?: string;
  healthApproved: boolean;
  repositories: DeploymentRepoRef[];
}): DeploymentMetadataRecord {
  const updatedAt = input.now ?? new Date().toISOString();
  const stackStatus: DeploymentMetadataRecord["status"] = input.failedActionCount > 0
    ? "failed"
    : input.dryRun
      ? "planned"
      : input.approvals.health
        ? "healthy"
        : input.approvals.service
          ? "applied"
          : "partially_applied";
  return {
    id: deploymentRecordId(status),
    stack: "codex-chat",
    workspace: status.workspaceId,
    environment: status.servantRuntime.appEnvironment,
    status: stackStatus,
    updatedAt,
    source: "brainctl stack apply",
    controlPlane: {
      host: status.setupContext.context?.target === "remote"
        ? sshIdentityFromSetupContext(status.setupContext.context) ?? status.setupContext.context.sshHost ?? status.controlPlane.host
        : status.controlPlane.host,
      path: status.setupContext.context?.repoPath ?? status.controlPlane.path,
      repoName: status.controlPlane.repoName,
    },
    servantRuntime: {
      repoName: status.servantRuntime.repoName,
      sourceHost: status.servantRuntime.host,
      sourcePath: status.servantRuntime.path,
      deployHost: status.servantRuntime.deploy.host,
      deployPath: status.servantRuntime.deploy.path,
      branch: status.servantRuntime.branch,
      requestedRef: status.servantRuntime.requestedRef ?? status.servantRuntime.branch,
      resolvedSha: input.repositories.find((repo) => repo.role === "servant-runtime" && repo.path === status.servantRuntime.path)?.resolvedSha,
      deployResolvedSha: input.repositories.find((repo) => repo.role === "servant-runtime" && repo.path === status.servantRuntime.deploy.path)?.resolvedSha,
      remoteUrl: status.servantRuntime.remoteUrl,
      serviceName: status.servantRuntime.deploy.serviceName,
      runtimeUser: status.servantRuntime.deploy.runtimeUser,
    },
    assistantLogic: {
      host: status.assistantLogic.host,
      path: status.assistantLogic.path,
      repoName: status.assistantLogic.repoName,
      branch: status.assistantLogic.branch,
      requestedRef: status.assistantLogic.requestedRef ?? status.assistantLogic.branch,
      resolvedSha: input.repositories.find((repo) => repo.role === "assistant-logic")?.resolvedSha,
      remoteUrl: status.assistantLogic.remoteUrl,
    },
    assistantData: {
      host: status.assistantData.host,
      path: status.assistantData.path,
      repoName: status.assistantData.repoName,
      branch: status.assistantData.branch,
      remoteUrl: status.assistantData.remoteUrl,
      promptRequired: status.assistantData.promptRequired,
      migrationStatus: "placeholder",
    },
    config: {
      configPath: status.servantRuntime.deploy.configPath ?? status.servicePaths.setupContextConfigPath,
      envFile: status.servantRuntime.deploy.envFile,
      envVars: status.servantRuntime.deploy.envVars.map((name) => ({ name, value: "redacted", metadataOnly: true })),
      renderedConfigPreview: renderCodexChatConfigPreview(status),
      renderedEnvPreview: renderCodexChatEnvPreview(status),
    },
    health: {
      status: input.failedActionCount > 0 ? "failed" : input.healthApproved && !input.dryRun ? "passed" : input.healthApproved ? "planned" : "not_run",
      checks: status.servantRuntime.deploy.healthChecks,
    },
    approvals: input.approvals,
    executor: {
      requested: input.requestedExecutor,
      effective: input.effectiveExecutor,
      dryRun: input.dryRun,
      networkAccess: !input.dryRun && input.effectiveExecutor === "ssh",
    },
    lastPlan: {
      actionCount: input.actionCount,
      approvedActionCount: input.approvedActionCount,
      executedActionCount: input.executedActionCount,
      failedActionCount: input.failedActionCount,
    },
    repositories: input.repositories,
    secretValuesStored: false,
  };
}

function deploymentRecordId(status: StackStatusDetails): string {
  return `${status.workspaceId}:${status.servantRuntime.appEnvironment}:codex-chat`;
}

async function writeStackDeploymentMetadata(status: StackStatusDetails, record: DeploymentMetadataRecord, input: { executor: StackExecutorKind; metadataFile?: string }): Promise<Record<string, unknown>> {
  const canonical = status.deploymentMetadata.canonical;
  if (input.executor === "mock" || input.executor === "local") {
    const localPath = input.metadataFile
      ? path.resolve(input.metadataFile)
      : canonical.sourceOfTruth === "local-brain-workspace"
        ? path.resolve(canonical.path)
        : undefined;
    if (!localPath) {
      return {
        ok: false,
        path: canonical.path,
        error: "local/mock metadata writes for a remote canonical store require --metadata-file",
        secretValuesStored: false,
      };
    }
    const store = await mergeDeploymentMetadataStore(localPath, canonical, record);
    return {
      ok: store.validation.ok,
      executor: input.executor,
      path: localPath,
      canonicalPath: canonical.path,
      deployments: store.store?.deployments.map((deployment) => ({ id: deployment.id, status: deployment.status, updatedAt: deployment.updatedAt })) ?? [],
      validation: store.validation,
      secretValuesStored: false,
    };
  }

  if (input.executor === "ssh") {
    const command = renderRemoteMetadataMergeShell(canonical.path, canonical, record);
    const result = canonical.sshIdentity
      ? spawnSync("ssh", [canonical.sshIdentity, command], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })
      : spawnSync("bash", ["-lc", command], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return {
      ok: (result.status ?? 1) === 0,
      executor: input.executor,
      path: canonical.path,
      command: remotePlanCommand(canonical.sshIdentity, command),
      exitCode: result.status,
      stdout: redactSecrets(String(result.stdout ?? "")),
      stderr: redactSecrets(String(result.stderr ?? "")),
      secretValuesStored: false,
    };
  }

  return { ok: false, error: "metadata writer was called in dry-run mode", secretValuesStored: false };
}

async function mergeDeploymentMetadataStore(filePath: string, canonical: StackDeploymentMetadataStatus["canonical"], record: DeploymentMetadataRecord): Promise<{ store?: DeploymentMetadataStore; validation: DeploymentMetadataValidation }> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let store: DeploymentMetadataStore = {
    version: DEPLOYMENT_METADATA_VERSION,
    kind: DEPLOYMENT_METADATA_KIND,
    updatedAt: record.updatedAt,
    canonical: {
      sourceOfTruth: canonical.sourceOfTruth,
      workspaceRoot: canonical.workspaceRoot,
      path: canonical.path,
      relativePath: canonical.relativePath,
    },
    deployments: [],
    secretValuesStored: false,
  };
  const existing = await fileMetadata(filePath);
  if (existing.present) {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      const validation = validateDeploymentMetadataStore(parsed);
      if (!validation.ok) return { validation };
      store = parsed as DeploymentMetadataStore;
    } catch (error) {
      return { validation: { ok: false, issues: [`could not parse existing deployment metadata: ${errorMessage(error)}`] } };
    }
  }
  store.updatedAt = record.updatedAt;
  store.canonical = {
    sourceOfTruth: canonical.sourceOfTruth,
    workspaceRoot: canonical.workspaceRoot,
    path: canonical.path,
    relativePath: canonical.relativePath,
  };
  store.secretValuesStored = false;
  store.deployments = [...store.deployments.filter((deployment) => deployment.id !== record.id), record]
    .sort((a, b) => a.id.localeCompare(b.id));
  const validation = validateDeploymentMetadataStore(store);
  if (!validation.ok) return { store, validation };
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return { store, validation };
}

function renderRemoteMetadataMergeShell(metadataPath: string, canonical: StackDeploymentMetadataStatus["canonical"], record: DeploymentMetadataRecord): string {
  const script = [
    "import json, pathlib",
    `p = pathlib.Path(${JSON.stringify(metadataPath)})`,
    "p.parent.mkdir(parents=True, exist_ok=True)",
    `incoming = json.loads(${JSON.stringify(JSON.stringify(record))})`,
    `canonical = json.loads(${JSON.stringify(JSON.stringify({
      sourceOfTruth: canonical.sourceOfTruth,
      workspaceRoot: canonical.workspaceRoot,
      path: canonical.path,
      relativePath: canonical.relativePath,
    }))})`,
    `base = {"version": ${DEPLOYMENT_METADATA_VERSION}, "kind": ${JSON.stringify(DEPLOYMENT_METADATA_KIND)}, "updatedAt": incoming["updatedAt"], "canonical": canonical, "deployments": [], "secretValuesStored": False}`,
    "try:",
    "    current = json.loads(p.read_text()) if p.exists() else base",
    "except Exception:",
    "    current = base",
    "deployments = [d for d in current.get('deployments', []) if isinstance(d, dict) and d.get('id') != incoming['id']]",
    "deployments.append(incoming)",
    "deployments.sort(key=lambda d: d.get('id', ''))",
    "current.update(base)",
    "current['deployments'] = deployments",
    "p.write_text(json.dumps(current, indent=2, sort_keys=False) + '\\n')",
    "p.chmod(0o600)",
    `print(json.dumps({"ok": True, "path": ${JSON.stringify(metadataPath)}, "deployment": incoming["id"]}))`,
  ].join("\n");
  return `umask 077 && python3 - <<'BRAIN_DEPLOYMENT_METADATA'\n${script}\nBRAIN_DEPLOYMENT_METADATA`;
}

function analyzeStackRepoBoundaries(repos: Array<Pick<StackRepoResolution, "role" | "host" | "path" | "present">>) {
  const issues: string[] = [];
  const present = repos.filter((repo) => repo.present);
  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      const a = present[i]!;
      const b = present[j]!;
      if (!sameRegistryHost(a.host, b.host)) continue;
      const relation = registryPathRelation(a.path, b.path);
      if (relation === "same") {
        issues.push(`${a.role} and ${b.role} resolve to the same checkout path on ${a.host}: ${a.path}`);
      } else if (relation === "a-in-b") {
        issues.push(`${a.role} path is nested inside ${b.role} on ${a.host}: ${a.path}`);
      } else if (relation === "b-in-a") {
        issues.push(`${b.role} path is nested inside ${a.role} on ${a.host}: ${b.path}`);
      }
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    policy: [
      "Brain is the control-plane/setup orchestrator.",
      "codex-chat is the servant runtime checkout.",
      "assistant-agent-logic remains a separate logic repository.",
      "assistant-agent-data/workspace remains a separate private data repository/workspace.",
      "Registry links/metadata are references, not vendored source.",
      "Deployment/update fetches configured refs for codex-chat and assistant-agent-logic and records requested refs plus resolved SHAs.",
    ],
  };
}

function registryPathRelation(aPath: string, bPath: string): "same" | "a-in-b" | "b-in-a" | "separate" {
  const a = normalizeRegistryPath(aPath);
  const b = normalizeRegistryPath(bPath);
  if (!a || !b || a === "missing" || b === "missing") return "separate";
  if (a === b) return "same";
  const aInB = a.startsWith(`${b.endsWith("/") ? b : `${b}/`}`);
  const bInA = b.startsWith(`${a.endsWith("/") ? a : `${a}/`}`);
  if (aInB) return "a-in-b";
  if (bInA) return "b-in-a";
  return "separate";
}

function normalizeRegistryPath(value: string): string {
  if (!value) return "";
  const normalized = value.startsWith("~/") ? `/~/${value.slice(2)}` : value;
  return path.posix.normalize(normalized.replaceAll("\\", "/"));
}

function sameRegistryHost(a: string, b: string): boolean {
  return normalizeRegistryHost(a) === normalizeRegistryHost(b);
}

function normalizeRegistryHost(value: string): string {
  return !value || value === "local" ? "local" : value;
}

function renderGitCloneOrUpdateCommand(input: { hostIdentity?: string; path: string; remoteUrl?: string; branch?: string; role?: StackRepoResolution["role"] }): string {
  return remotePlanCommand(input.hostIdentity, renderGitCloneOrUpdateShell(input));
}

function remotePlanCommand(identity: string | undefined, command: string): string {
  return identity ? `ssh ${shellArg(identity)} ${shellArg(command)}` : command;
}

function shellPathArg(value: string): string {
  if (value === "~") return "\"$HOME\"";
  if (value.startsWith("~/")) return `"$HOME/${value.slice(2).replace(/["\\`]/g, "\\$&")}"`;
  return shellArg(value);
}

function sshIdentityFromHost(host: string | undefined, runtimeUser: string | undefined): string | undefined {
  if (!host || host === "local" || host === "missing") return undefined;
  if (host.includes("@")) return host;
  return runtimeUser ? `${runtimeUser}@${host}` : host;
}

function sshIdentityFromSetupContext(context: LocalSetupContext | undefined): string | undefined {
  if (!context?.sshHost) return undefined;
  return remoteSshDestination(context.sshHost, context.sshUser ?? context.serviceUser);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function escapeShellRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
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
  const workspaceRoot = path.resolve(workspace?.workspacePath ?? defaultWorkspaceRoot(options.workspace));
  const envSources = config.config ? await workspaceEnvSources(config.config, { workspaceId: options.workspace, workspaceRoot }) : undefined;
  const status = await setupComposioStatus(workspace, {
    apiKeyRef: options.apiKeyRef,
    connectedAccountRef: options.connectedAccountRef,
  }, { workspaceId: options.workspace, workspaceRoot, envSources });
  return {
    ok: true,
    summary: mode === "setup" ? "Composio setup prompts rendered without using credentials" : "Composio status inspected without printing credentials",
    details: {
      workspace: options.workspace,
      config: config.ok ? { path: path.resolve(options.config), valid: true } : config,
      ...status,
      prompts: [
        "Do you want optional Gmail access through Composio?",
        "Do you want optional Google Calendar access through Composio?",
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
      ? "legacy/lab assistant workspace scaffold plan ready (dry run)"
      : "legacy/lab assistant workspace scaffold reconciled without overwriting stores or secrets",
    details: {
      workspace: options.workspace,
      workspaceRoot,
      scaffold,
      status,
      sideEffects: options.dryRun ? "none" : "created missing legacy/lab assistant JSON workspace directories/files only; existing stores were not overwritten",
    },
  };
}

async function workspaceStatusCommand(options: { workspace: string; path?: string; assistantRepo?: string }): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const status = await assistantWorkspaceParityStatus({ workspaceRoot, workspaceId: options.workspace, deprecatedAssistantRepo: options.assistantRepo });
  return {
    ok: status.ready,
    summary: status.ready
      ? "legacy/lab assistant-logic workspace parity paths and vendored commands are ready"
      : "legacy/lab assistant-logic workspace parity paths or vendored commands are missing or invalid",
    details: { workspace: options.workspace, workspaceRoot, status, productionAuthority: "assistant-agent-logic checkout plus assistant-agent-data/workspace, not Brain lab stores", sideEffects: "none" },
  };
}

async function workspaceCommandsCommand(options: { workspace: string; path?: string; assistantRepo?: string }): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const assistantLogicRoot = assistantLogicPackageRoot();
  const commands = assistantWorkspaceCommandCatalog(workspaceRoot, assistantLogicRoot);
  const scriptMetadata = await assistantCommandScriptMetadata(assistantLogicRoot, commands.flatMap((group) => group.scripts));
  return {
    ok: scriptMetadata.every((item) => item.present),
    summary: "legacy/lab assistant-logic workspace command catalog rendered",
    details: {
      workspace: options.workspace,
      workspaceRoot,
      assistantLogicRoot,
      assistantLogicSource: "legacy-lab-in-repo:@brain/assistant-logic",
      productionAuthority: "separate assistant-agent-logic checkout resolved by stack/repo-registry",
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
      ? `legacy/lab ${resolved.kind} assistant-logic command completed: ${resolved.script}`
      : `legacy/lab ${resolved.kind} assistant-logic command failed: ${resolved.script}`,
    details: {
      workspace: options.workspace,
      workspaceRoot,
      assistantLogicRoot,
      assistantLogicSource: "legacy-lab-in-repo:@brain/assistant-logic",
      productionAuthority: "separate assistant-agent-logic checkout resolved by stack/repo-registry",
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
        ? "legacy/lab native assistant-logic CLI controlled the JSON workspace state"
        : "legacy/lab assistant-agent-logic snapshot script controlled workspace state or account integrations using private configuration",
    },
  };
}

function createCliAssistantCommandPort(workspace: string, workspaceRoot: string): AssistantWorkspaceCommandPort {
  return {
    async run(script: string, args: string[] = []) {
      const result = await workspaceRunCommand(script, args, { workspace, path: workspaceRoot });
      const details = isRecord(result.details) ? result.details : {};
      return {
        ok: result.ok,
        userFacingText: typeof details.userFacingText === "string" ? details.userFacingText : undefined,
        error: result.ok ? undefined : result.summary,
        stderr: typeof details.stderr === "string" ? details.stderr : undefined,
        stdout: details.stdout,
      };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
      integration: "legacy-lab-assistant-agent-logic-snapshot",
      state: path.join(workspaceRoot, "data", "bets.json"),
      scripts: ["bet-add.js", "bet-list.js", "bet-result.js", "bet-summary.js", "bet-delete.js"],
      examples: [
        runner("bet-add.js", '--date 2026-05-26 --market moneyline --side home --home "Home" --away "Away" --odds -110 --units 1'),
        runner("bet-summary.js", ""),
      ],
    },
    {
      area: "gmail-email",
      integration: "legacy-lab-composio-gmail-snapshot",
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
      integration: "legacy-lab-composio-google-calendar-snapshot",
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
      integration: "legacy-lab-composio-connection-snapshot",
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
      integration: "legacy-lab-protonmail-bridge-snapshot",
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
      integration: "legacy-lab-finance-snapshot",
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
      integration: "legacy-lab-whoop-snapshot",
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
      integration: "legacy-lab-telegram-mtproto-snapshot",
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
      integration: "legacy-lab-assistant-agent-logic-utilities",
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
    "These are legacy/lab overlays only. Production assistant guidance belongs in the external assistant-agent-logic checkout and private assistant workspace.",
    "",
    "Do not use overlays to redefine commands, storage paths, JSON formats, approval requirements, or safety rules.",
    "",
    "Brain ships legacy/lab native TypeScript commands for todo, projects, CRM, reminders, and file-save smoke checks.",
    "Brain also includes a legacy/lab snapshot of assistant-agent-logic integration commands for Composio/Gmail/Calendar, ProtonMail, finance/Mercury/Plaid, Whoop, Telegram user-client messaging, betting, dictionary, generated web pages, and loop utilities; production uses the separate assistant-agent-logic checkout.",
    "Keep personal account IDs, OAuth/API tokens, Telegram sessions, ProtonMail Bridge credentials, and finance/Whoop secrets in this private workspace, not in the Brain repo.",
    "See `docs/assistant-logic-integration-audit.md` and `docs/migration.md` for the integrated/status table and private data migration guidance.",
    "",
  ].join("\n");
}

function renderSkillOverlayPlaceholder(skill: string): string {
  return [
    `# Workspace Overlay: ${titleCase(skill)}`,
    "",
    "Add only user-specific lab preferences here.",
    "Production assistant skills belong in the external assistant-agent-logic checkout, not Brain.",
    "",
    "Do not restate or override shared commands, storage paths, JSON formats, approval requirements, or safety rules.",
    "",
  ].join("\n");
}

function renderPromptOverlayPlaceholder(prompt: string): string {
  return [
    `# Workspace Overlay: ${titleCase(prompt)}`,
    "",
    "Add only user-specific lab prompt preferences here.",
    "Production assistant prompts belong in the external assistant-agent-logic checkout, not Brain.",
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
    "This directory may hold user-specific repo-registry controller state for the Brain control plane and external assistant-agent-logic checkout.",
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

async function setupComposioStatus(
  workspace: WorkspaceConfig | undefined,
  overrides: { apiKeyRef?: string; connectedAccountRef?: string } = {},
  context: { workspaceId?: string; workspaceRoot?: string; envSources?: Map<string, EnvSecretSource[]> } = {},
) {
  const config = workspace?.integrations?.composio;
  const workspaceId = context.workspaceId ?? "workspace";
  const workspaceRoot = path.resolve(context.workspaceRoot ?? workspace?.workspacePath ?? defaultWorkspaceRoot(workspaceId));
  const apiKeyRef = overrides.apiKeyRef ?? config?.apiKeyRef;
  const connectedAccountRef = overrides.connectedAccountRef ?? config?.connectedAccountRef;
  const googleCalendar = config?.dataSources?.googleCalendar;
  const gmail = config?.dataSources?.gmail ?? config?.dataSources?.chat;
  const legacyChat = config?.dataSources?.chat;
  const refs: ConfigRef[] = [
    ...maybeRef(apiKeyRef, "integrations.composio.apiKeyRef", workspace ? workspaceId : "cli"),
    ...maybeRef(connectedAccountRef, "integrations.composio.connectedAccountRef", workspace ? workspaceId : "cli"),
    ...maybeRef(config?.metadataRef, "integrations.composio.metadataRef", workspaceId),
    ...maybeRef(googleCalendar?.connectedAccountRef, "integrations.composio.dataSources.googleCalendar.connectedAccountRef", workspaceId),
    ...maybeRef(googleCalendar?.metadataRef, "integrations.composio.dataSources.googleCalendar.metadataRef", workspaceId),
    ...(googleCalendar?.requiredEnvRefs ?? []).map((ref) => ({ workspaceId, ref: asSecretRef(ref), source: "integrations.composio.dataSources.googleCalendar.requiredEnvRefs" })),
    ...maybeRef(gmail?.connectedAccountRef, "integrations.composio.dataSources.gmail.connectedAccountRef", workspaceId),
    ...maybeRef(gmail?.metadataRef, "integrations.composio.dataSources.gmail.metadataRef", workspaceId),
    ...(gmail?.requiredEnvRefs ?? []).map((ref) => ({ workspaceId, ref: asSecretRef(ref), source: "integrations.composio.dataSources.gmail.requiredEnvRefs" })),
  ];
  const envSources = context.envSources ?? new Map([[workspaceId, await Promise.all([
    readEnvSecretSource(path.join(workspaceRoot, ".env")),
    readEnvSecretSource(path.join(workspaceRoot, "config", `brain-${workspaceId}.env`)),
    readEnvSecretSource(path.join(workspaceRoot, "secrets", "secrets.env")),
  ])]]);
  const refMetadata = await secretRefMetadata(refs, { envSources });
  const privateConfig = await composioPrivateConfigMetadata(workspaceRoot);
  const refPresent = (source: string) => refMetadata.some((ref) => ref.source === source && ref.present === true);
  const apiKeyPresent = Boolean(apiKeyRef && refPresent("integrations.composio.apiKeyRef")) || privateConfig.workspaceEnv.keys.includes("COMPOSIO_API_KEY");
  const googleCalendarReady = privateConfig.composioYaml.googleCalendarAccounts > 0 || refPresent("integrations.composio.dataSources.googleCalendar.connectedAccountRef") || refPresent("integrations.composio.connectedAccountRef");
  const gmailReady = privateConfig.composioYaml.gmailAccounts > 0 || refPresent("integrations.composio.dataSources.gmail.connectedAccountRef") || refPresent("integrations.composio.connectedAccountRef");
  const missing = [];
  const enabled = config?.enabled ?? Boolean(overrides.apiKeyRef || overrides.connectedAccountRef);
  if (enabled && !apiKeyPresent) missing.push("Composio API key");
  if (enabled && !connectedAccountRef && !privateConfig.composioYaml.present) missing.push("Composio connected account metadata ref");
  if (googleCalendar?.enabled && !googleCalendarReady) missing.push("Google Calendar connected account");
  if (gmail?.enabled && !gmailReady) missing.push("Gmail connected account");
  const nextMissing = [
    ...(!apiKeyPresent ? ["Composio API key"] : []),
    ...(!googleCalendarReady ? ["Google Calendar connected account"] : []),
    ...(!gmailReady ? ["Gmail connected account"] : []),
  ];
  const ready = nextMissing.length === 0;
  return {
    enabled,
    ready,
    apiKeyRefPresent: Boolean(apiKeyRef),
    apiKeyPresent,
    connectedAccountRefPresent: Boolean(connectedAccountRef),
    dataSources: {
      googleCalendar: { enabled: googleCalendar?.enabled ?? false, ready: googleCalendarReady, connectedAccountRefPresent: Boolean(googleCalendar?.connectedAccountRef ?? connectedAccountRef), metadataRefPresent: Boolean(googleCalendar?.metadataRef) },
      gmail: { enabled: gmail?.enabled ?? false, ready: gmailReady, connectedAccountRefPresent: Boolean(gmail?.connectedAccountRef ?? connectedAccountRef), metadataRefPresent: Boolean(gmail?.metadataRef) },
      legacyChat: legacyChat ? { enabled: legacyChat.enabled, mapsTo: "gmail" } : undefined,
    },
    privateConfig,
    refs: refMetadata,
    missing,
    nextDataSourceFlow: {
      status: ready ? "ready" : "needs-user-input",
      missing: nextMissing,
      urls: [
        { label: "Composio API keys", url: "https://app.composio.dev/settings" },
        { label: "Composio connected accounts", url: "https://app.composio.dev/connected_accounts" },
      ],
      accountInfoNeeded: [
        "Composio API key (enter only through the one-use helper; do not paste it into chat/logs).",
        "Google Calendar OAuth connection for Tim; after OAuth, record the returned connected account id plus a non-secret email label.",
        "Gmail OAuth connection for each Gmail inbox Tim wants Brain to read/send; after OAuth, record each returned connected account id plus a non-secret email label.",
      ],
      commands: {
        generateApiKeyHelper: `pnpm run brainctl setup composio-api-key-script --workspace ${shellArg(workspaceId)} --path ${shellArg(workspaceRoot)}`,
        checkStatus: `pnpm run brainctl composio status --workspace ${shellArg(workspaceId)} --config ${shellArg(path.join(workspaceRoot, "config", "runtime.yaml"))}`,
        generateGoogleCalendarOauth: `pnpm run brainctl workspace run --path ${shellArg(workspaceRoot)} composio-connect.js -- --generate --app google_calendar --user-id <tim-email-or-label>`,
        generateGmailOauth: `pnpm run brainctl workspace run --path ${shellArg(workspaceRoot)} composio-connect.js -- --generate --app gmail --user-id <tim-email-or-label>`,
      },
      assistantLogic: {
        source: "in-repo:@brain/assistant-logic",
        setupSkill: "packages/assistant-logic/config/skills/setup-composio-connect.md",
        accountConfigPath: path.join(workspaceRoot, "composio.yaml"),
        apiKeyEnvPath: path.join(workspaceRoot, ".env"),
        valuesPrinted: false,
      },
    },
  };
}

async function composioPrivateConfigMetadata(workspaceRoot: string) {
  const workspaceEnvPath = path.join(workspaceRoot, ".env");
  const composioPath = path.join(workspaceRoot, "composio.yaml");
  const workspaceEnvSource = await readEnvSecretSource(workspaceEnvPath);
  const composioMetadata = await fileMetadata(composioPath);
  let googleCalendarAccounts = 0;
  let gmailAccounts = 0;
  let calendarAliases = 0;
  let parseError: string | undefined;
  if (composioMetadata.present) {
    try {
      const parsed = YAML.parse(await readFile(composioPath, "utf8")) as unknown;
      const accounts = asRecord(asRecord(parsed)?.accounts);
      const calendar = asRecord(accounts?.google_calendar);
      const calendarId = asString(calendar?.id);
      googleCalendarAccounts = calendarId && /^ca_/.test(calendarId) && calendarId !== "ca_XXXX" ? 1 : 0;
      const gmail = Array.isArray(accounts?.gmail) ? accounts.gmail : [];
      gmailAccounts = gmail.filter((entry) => {
        const id = asString(asRecord(entry)?.id);
        return id && /^ca_/.test(id) && id !== "ca_XXXX";
      }).length;
      calendarAliases = Object.keys(asRecord(asRecord(parsed)?.calendars) ?? {}).length;
    } catch (error) {
      parseError = errorMessage(error);
    }
  }
  return {
    workspaceEnv: {
      path: workspaceEnvPath,
      metadata: workspaceEnvSource.metadata,
      keys: [...workspaceEnvSource.keys].sort(),
      valuesPrinted: false,
    },
    composioYaml: {
      ...composioMetadata,
      path: composioPath,
      googleCalendarAccounts,
      gmailAccounts,
      calendarAliases,
      accountIdsPrinted: false,
      accountEmailsPrinted: false,
      parseError,
    },
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
  const ledgerReconciliation = options.runSafe && ok
    ? await reconcileDeploymentLedgerAfterValidation(config.config, options, safeResults, setupStateUpdate)
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
      ledgerReconciliation,
      plan,
      results: safeResults,
      sideEffects: options.runSafe ? "safe local checks, private setup progress metadata update, and stale deployment-ledger blocker reconciliation when current health clears it" : "none",
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
      title: "Connect Gmail and Google Calendar through Composio.",
      prompt: "After the base Telegram/Codex service is ready, connect Gmail and Google Calendar through Composio if this workspace should use those data sources.",
      actions: [
        `Generate the one-use API key helper with: pnpm run brainctl setup composio-api-key-script --workspace ${shellArg(options.workspace)} --path <workspace>`,
        "Tim gets the key from https://app.composio.dev/settings and enters it only into the helper TTY prompt.",
        "Then generate short-lived OAuth links with composio-connect.js for `google_calendar` and `gmail`; store only connected-account metadata in private workspace files.",
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
        `Generate a guarded helper with: pnpm run brainctl setup codex-auth-script --config ${shellArg(options.config)} --workspace ${shellArg(options.workspace)} --repo <repo-root> --service-user <codex-chat-service-user>`,
        "Run the returned command as the same OS user that will run codex-chat; for systemd this is usually the non-root service user.",
        "If a credential is needed, store it only in a private server env file or secret store, then verify by metadata/health check without printing the value.",
        `Run a guarded provider check for the chosen transport before accepting live user traffic.`,
      ],
      requiresConfirmation: "Writing credentials requires an explicit private target; live provider checks require explicit --allow-live.",
    },
    {
      step: "install-start-service",
      title: "Install and start the codex-chat service.",
      actions: [
        `Review the servant stack plan with: pnpm run brainctl stack plan --workspace ${shellArg(options.workspace)}`,
        "Install/enable systemd only after the user confirms codex-chat.service, the codex-chat checkout, assistant-agent-logic checkout, assistant-agent-data workspace, and private env/config refs.",
        "Start codex-chat only after Telegram token storage, private data setup, and Codex auth are verified for the service user.",
      ],
      requiresConfirmation: "Privileged systemd installation, enablement, and service start require explicit user confirmation.",
    },
    {
      step: "first-user-pairing",
      title: "Optional follow-up: first-user pairing.",
      actions: [
        "After the service is running with the private Telegram token, send the bot messages from the intended admin chat(s).",
        "By default up to two distinct user/chat pairs become paired admin state and are persisted only in private Brain state.",
        "Use --telegram-max-admin-pairs 1 when deliberately preserving a single-admin deployment.",
        "If a token was ever pasted into a repo, chat, or log, revoke it in @BotFather with /revoke before starting live polling.",
      ],
    },
    {
      step: "openai-transcription",
      title: "Optional: confirm OpenAI voice/audio transcription.",
      actions: [
        "Ask whether Telegram voice/audio transcription should be enabled for this workspace.",
        "If yes, store OPENAI_API_KEY only in the private codex-chat service env/secret store, set transcription.enabled=true with apiKeyEnv=OPENAI_API_KEY, and verify only redacted metadata.",
        "If no, keep transcription disabled and make the disabled voice-message behavior explicit.",
      ],
    },
    {
      step: "optional-follow-ups",
      title: "Optional follow-ups.",
      actions: [
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
    "Store the returned token only through a one-use private temp script that prompts for hidden input and writes to the private codex-chat service env file or configured env/secret store.",
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
    "Prefer generating the secret-entry helper with: pnpm run brainctl setup telegram-token-script --path <workspace> --codex-chat-env <codex-chat-env-file>; then run the returned bash /.../store-brain-telegram-token.sh command on the target host.",
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
    model: DEFAULT_MAIN_LOOP_MODEL,
    effort: DEFAULT_MAIN_LOOP_EFFORT,
    binary: options.binary,
    cwd: providerCwdForWorkspace(selection.workspace, options.cwd),
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
      maxAdminPairs: telegramMaxAdminPairsOption(options),
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

function telegramMaxAdminPairsOption(options: Pick<SupervisorRunCommandOptions, "telegramMaxAdminPairs">): number {
  const max = options.telegramMaxAdminPairs ?? 2;
  return Number.isSafeInteger(max) && max > 0 ? max : 1;
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
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted-api-key]")
    .replace(/\b(comp_[A-Za-z0-9_-]{12,})\b/g, "[redacted-composio-api-key]");
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
  ".env",
  ".env.*",
  "!.env.example",
  "*.env",
  "*.env.*",
  "!*.env.example",
  "config/*.env",
  "config/*.env.*",
  "secrets/**",
  "logs/**",
  "tmp/**",
  "cache/**",
  "caches/**",
  "state/setup-progress.json",
  "state/telegram-offset.json",
  "state/telegram-pairing/**",
  "state/jobs/**",
  "state/events/**",
  "**/.cache/**",
  "**/node_modules/**",
  "**/*.log",
  "",
  "# Keep bulky private document bytes out of metadata backups.",
  "private/documents/files/**",
  "",
  "# Keep generated runtime scratch data local unless deliberately included.",
  "artifacts/**",
  "!artifacts/metadata/**",
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

interface SetupSecretScriptOptions {
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
  codexChatEnv?: string;
  secretsEnv?: string;
  composioEnv?: string;
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
  const serviceName = "codex-chat.service";
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
        `pnpm run brainctl stack status --workspace ${options.workspace}`,
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
        prompt: "Confirm codex-chat checkout, assistant-agent-logic checkout, assistant-agent-data workspace, provider, entrypoint, and service target.",
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
        prompt: "Create or validate the assistant-agent-data workspace; Brain records paths/metadata only and does not own assistant domain state.",
      },
      {
        step: "private-data-repo",
        prompt: "Pull or initialize the private assistant-agent-data/backup repo before relying on project memory.",
      },
      {
        step: "openai-transcription",
        prompt: "Optionally confirm whether Telegram voice/audio transcription should use OpenAI; if yes, store only a private OPENAI_API_KEY ref before enabling it.",
      },
      {
        step: "composio-accounts",
        prompt: "After the base workspace/service are healthy, connect Gmail and Google Calendar through Composio with a one-use API-key helper and OAuth links.",
      },
    ],
    orderingNotes: [
      "Codex auth is an explicit step whenever the provider is Codex.",
      "Verify Codex auth before starting the service or accepting live Telegram traffic.",
      "Validate assistant-agent-data workspace paths before the first live provider turn; domain state remains owned by assistant-agent-logic/data, not Brain.",
      "Keep markdown notes and JSON stores in assistant-agent-data as private state; do not migrate them into Brain.",
      "Prompt the user to optionally confirm OpenAI voice/audio transcription during setup; enable it only after a private OpenAI key ref is present.",
      "Keep web publishing, backup tuning, and first-user pairing as follow-up steps unless explicitly requested now.",
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
      assistantWorkspaceScaffold: {
        deprecatedLabOnly: true,
        skipped: "production setup does not scaffold Brain's legacy assistant-domain JSON stores; deploy codex-chat with the separate assistant-agent-logic checkout and assistant-agent-data/private workspace",
        command: `pnpm run brainctl workspace scaffold --path ${shellArg(workspaceRoot)} # lab compatibility only`,
      },
      setupWizard,
      setupState,
      inspection: after,
      sideEffects: options.dryRun ? "none" : "created missing generic private workspace directories and updated private setup progress state; did not create Brain legacy assistant-domain stores",
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

async function setupTelegramTokenScriptCommand(options: SetupSecretScriptOptions): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const scriptDir = options.output ? path.dirname(path.resolve(options.output)) : await mkdtemp(path.join(os.tmpdir(), "brain-token-"));
  const scriptPath = path.resolve(options.output ?? path.join(scriptDir, "store-brain-telegram-token.sh"));
  const tokenFile = path.resolve(options.tokenFile ?? path.join(workspaceRoot, "secrets", "telegram-bot-token"));
  const adapterConfig = path.resolve(options.adapterConfig ?? path.join(workspaceRoot, "secrets", "telegram-main.json"));
  const serviceEnv = path.resolve(options.serviceEnv ?? path.join(workspaceRoot, "config", `brain-${options.workspace}.env`));
  const codexChatEnv = path.resolve(options.codexChatEnv ?? path.join(workspaceRoot, "config", "codex-chat.env"));
  const secretsEnv = path.resolve(options.secretsEnv ?? path.join(workspaceRoot, "secrets", "secrets.env"));
  const script = renderTelegramTokenStorageScript({ workspaceRoot, tokenFile, adapterConfig, serviceEnv, codexChatEnv, secretsEnv });

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
        codexChatEnv,
        secretsEnv,
      },
      validation: "bash -n passed",
      sideEffects: "wrote one-use private temporary script only; no secret values read or stored",
      secretValuesPrinted: false,
    },
  };
}

async function setupComposioApiKeyScriptCommand(options: SetupSecretScriptOptions): Promise<CliResult> {
  const workspaceRoot = path.resolve(options.path ?? defaultWorkspaceRoot(options.workspace));
  const defaultScriptParent = path.join(workspaceRoot, "tmp");
  if (!options.output) {
    await mkdir(defaultScriptParent, { recursive: true, mode: 0o700 });
    await chmod(defaultScriptParent, 0o700).catch(() => undefined);
  }
  const scriptDir = options.output ? path.dirname(path.resolve(options.output)) : await mkdtemp(path.join(defaultScriptParent, "brain-composio-key-"));
  const scriptPath = path.resolve(options.output ?? path.join(scriptDir, "store-brain-composio-api-key.sh"));
  const workspaceEnv = path.resolve(options.composioEnv ?? path.join(workspaceRoot, ".env"));
  const script = renderComposioApiKeyStorageScript({ workspaceRoot, workspaceEnv });
  const sshRunCommand = remoteOneUseScriptSshCommand({
    scriptPath,
    sshHost: options.sshHost,
    sshUser: options.sshUser,
    serviceUser: options.serviceUser,
    label: "brain-composio-key",
  });

  await mkdir(scriptDir, { recursive: true, mode: 0o700 });
  await chmod(scriptDir, 0o700).catch(() => undefined);
  await writeFile(scriptPath, script, { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  if ((syntax.status ?? 0) !== 0) {
    return {
      ok: false,
      summary: "Composio API key script was written but failed bash syntax validation",
      details: {
        scriptPath,
        stderr: redactSecrets(String(syntax.stderr ?? "")),
        sideEffects: "wrote script only; no API key value read or stored",
        secretValuesPrinted: false,
      },
    };
  }

  return {
    ok: true,
    summary: "Composio API key storage script written and syntax checked",
    details: {
      scriptPath,
      runCommand: `bash ${shellArg(scriptPath)}`,
      sshRunCommand,
      workspaceRoot,
      writes: {
        workspaceEnv,
        envKey: "COMPOSIO_API_KEY",
      },
      validation: "bash -n passed",
      sideEffects: "wrote one-use private temporary script only; no API key value read or stored",
      secretValuesPrinted: false,
      nextCommands: {
        verifyMetadata: `pnpm run brainctl composio status --workspace ${shellArg(options.workspace)} --config ${shellArg(path.join(workspaceRoot, "config", "runtime.yaml"))}`,
        generateGoogleCalendarOauth: `pnpm run brainctl workspace run --path ${shellArg(workspaceRoot)} composio-connect.js -- --generate --app google_calendar --user-id <tim-email-or-label>`,
        generateGmailOauth: `pnpm run brainctl workspace run --path ${shellArg(workspaceRoot)} composio-connect.js -- --generate --app gmail --user-id <tim-email-or-label>`,
      },
    },
  };
}

async function setupCodexAuthScriptCommand(options: SetupSecretScriptOptions): Promise<CliResult> {
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

function remoteOneUseScriptSshCommand(input: { scriptPath: string; sshHost?: string; sshUser?: string; serviceUser?: string; label: string }): string | undefined {
  if (!input.sshHost) return undefined;
  const destination = remoteSshDestination(input.sshHost, input.sshUser);
  const sameUser = !input.serviceUser || !input.sshUser || input.serviceUser === input.sshUser;
  const serviceUser = input.serviceUser ?? input.sshUser ?? "";
  const remoteCommand = sameUser
    ? `bash ${shellArg(input.scriptPath)}`
    : `home=$(getent passwd ${shellArg(serviceUser)} | cut -d: -f6) && tmp=$(mktemp "$home/${input.label}.XXXXXX.sh") && install -o ${shellArg(serviceUser)} -g ${shellArg(serviceUser)} -m 700 ${shellArg(input.scriptPath)} "$tmp"; rc=$?; if [ "$rc" -eq 0 ]; then sudo -iu ${shellArg(serviceUser)} bash "$tmp"; rc=$?; fi; rm -f "$tmp"; exit "$rc"`;
  return `ssh -t ${shellArg(destination)} ${shellArg(remoteCommand)}`;
}

function renderTelegramTokenStorageScript(input: { workspaceRoot: string; tokenFile: string; adapterConfig: string; serviceEnv: string; codexChatEnv?: string; secretsEnv: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077

script_path="\${BASH_SOURCE[0]:-$0}"
workspace=${shellLiteral(input.workspaceRoot)}
token_file=${shellLiteral(input.tokenFile)}
adapter_config=${shellLiteral(input.adapterConfig)}
service_env=${shellLiteral(input.serviceEnv)}
codex_chat_env=${shellLiteral(input.codexChatEnv ?? "")}
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
  "adminBootstrap": "first-user",
  "maxAdminPairs": 2
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
if [ -n "$codex_chat_env" ]; then
  update_env_file "$codex_chat_env" TELEGRAM_BOT_TOKEN "$token"
fi

unset token
printf "Stored Telegram token in private service secret/env files. Token value was not printed.\\n" >&2
`;
}

function renderComposioApiKeyStorageScript(input: { workspaceRoot: string; workspaceEnv: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077

script_path="\${BASH_SOURCE[0]:-$0}"
workspace=${shellLiteral(input.workspaceRoot)}
workspace_env=${shellLiteral(input.workspaceEnv)}

restore_tty() {
  if [ -t 0 ]; then stty echo 2>/dev/null || true; fi
}

cleanup() {
  status="$?"
  restore_tty
  if [ "$status" -eq 0 ]; then rm -f -- "$script_path"; fi
}
trap cleanup EXIT

mkdir -p "$workspace" "$workspace/tmp" "$(dirname "$workspace_env")"
chmod 700 "$workspace" "$workspace/tmp"

printf "Composio API key: " >&2
if [ -t 0 ]; then stty -echo; fi
IFS= read -r api_key
restore_tty
printf "\\n" >&2

if [ -z "$api_key" ]; then
  printf "No API key entered; nothing was written.\\n" >&2
  exit 1
fi
if ! printf "%s" "$api_key" | grep -Eq "^[^[:space:]]{12,}$"; then
  printf "API key format was not accepted; nothing was written.\\n" >&2
  exit 1
fi

dotenv_quote() {
  printf "'"
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

update_env_file() {
  file="$1"
  key="$2"
  value="$3"
  mkdir -p "$(dirname "$file")"
  tmp="$(mktemp "$file.tmp.XXXXXX")"
  if [ -f "$file" ]; then
    while IFS= read -r line; do
      case "$line" in
        "$key="*|"export $key="*) ;;
        *) printf "%s\\n" "$line" ;;
      esac
    done < "$file" > "$tmp"
  fi
  printf "%s=%s\\n" "$key" "$value" >> "$tmp"
  install -m 600 "$tmp" "$file"
  rm -f "$tmp"
}

quoted_key="$(dotenv_quote "$api_key")"
update_env_file "$workspace_env" COMPOSIO_API_KEY "$quoted_key"
chmod 600 "$workspace_env"

unset api_key quoted_key
printf "Stored Composio API key in the private assistant workspace .env. Key value was not printed.\\n" >&2
printf "Next: run metadata-only Composio status, then use assistant-agent-logic OAuth helpers if needed.\\n" >&2
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
the server as the same user that will run codex-chat:
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

Run one of these on the target host as the same user that will run codex-chat:
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
  const composio = await setupComposioStatus(workspace, {}, { workspaceId: options.workspace, workspaceRoot, envSources });
  const transcription = setupTranscriptionStatus(workspace);
  const assistantWorkspace = await assistantWorkspaceParityStatus({ workspaceRoot, workspaceId: options.workspace });
  const serviceName = normalizeSystemdServiceName(options.serviceName ?? "codex-chat.service");
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

  if (input.assistantWorkspace.ready) {
    configured.push("legacy/lab Brain assistant workspace scaffold present (not production authority)");
  } else {
    missing_optional.push("legacy/lab Brain assistant workspace scaffold absent; production uses assistant-agent-logic plus assistant-agent-data/workspace");
  }

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

  if (input.composio.ready) configured.push("Composio Gmail/Google Calendar data sources ready by metadata");
  else missing_optional.push(`Composio Gmail/Google Calendar setup incomplete: ${input.composio.nextDataSourceFlow.missing.join(", ") || "not enabled"}`);

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
  const privateWorkspaceReady = workspaceReady;
  const legacyLabWorkspaceReady = Boolean(details.assistantWorkspace?.ready)
    && ["projects", "notes", "documents", path.join("documents", "metadata")].every((dir) => details.directories[dir]?.present);
  const runtimeConfigReady = details.config.present && details.config.valid && details.provider !== "missing" && details.primaryEntrypointId !== "missing";
  const telegramEntrypoint = details.entrypoints.find((entrypoint) => entrypoint.kind === "telegram" && entrypoint.enabled);
  const telegramSecretRefPresent = Boolean(telegramEntrypoint?.configRefPresent && details.secretRefs.some((ref) => ref.source === "entrypoint.configRef" && ref.present === true));
  const backupConfigured = Boolean(details.backup && details.backup.strategy !== "none");
  const composioReady = Boolean(details.composio?.ready);
  const state = details.setupState?.state;
  const codexAuthUser = state?.statuses.codexAuth.runAsUser;
  const codexAuthVerifiedByState = codexAuthMatchesServiceUser(state?.statuses.codexAuth, details.serviceUser);
  const serviceActiveForWorkspace = details.service?.active === true && details.service.workspaceMatched !== false;
  const serviceStarted = serviceActiveForWorkspace || state?.statuses.service.started === true;
  const serviceInstalled = details.service?.installed === true || state?.statuses.service.installed === true || serviceStarted;
  const baseRuntimeReadyForDataSources = privateWorkspaceReady && backupConfigured && telegramSecretRefPresent && runtimeConfigReady && codexAuthVerifiedByState && serviceStarted;
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
      title: "Validate private assistant-data/workspace root.",
      complete: privateWorkspaceReady,
      evidence: privateWorkspaceReady
        ? [`Generic private workspace directories exist under ${details.workspaceRoot}; assistant-agent-data/domain state remains separate from Brain source.`]
        : ["Generic private workspace directories are missing; create them before configuring codex-chat state/artifacts."],
      legacyLabWorkspace: { present: legacyLabWorkspaceReady, authority: "lab-only; not production domain source" },
      resumePrompt: "Validate the assistant-agent-data/private workspace path and initialize or pull private data only through the stack data gate or explicit user approval.",
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
      title: "Connect Gmail and Google Calendar through Composio.",
      complete: composioReady || (!baseRuntimeReadyForDataSources && details.composio?.enabled === false),
      evidence: composioReady
        ? ["Composio API key plus Gmail and Google Calendar connected-account metadata are present by metadata only; values were not printed."]
        : baseRuntimeReadyForDataSources
          ? [`Base workspace/service are ready; next data-source inputs needed: ${details.composio?.nextDataSourceFlow.missing.join(", ") || "Composio account metadata"}.`]
          : details.composio?.enabled === false
            ? ["Composio is disabled for this workspace; skip until the base Telegram/Codex service is ready or the user asks for Gmail/Calendar."]
            : [`Composio refs missing: ${details.composio?.missing.join(", ") || "account metadata"}.`],
      actions: [
        details.composio?.nextDataSourceFlow.commands.generateApiKeyHelper ?? "Generate the Composio API key helper with brainctl setup composio-api-key-script.",
        details.composio?.nextDataSourceFlow.commands.generateGoogleCalendarOauth ?? "Generate a Google Calendar OAuth link with composio-connect.js.",
        details.composio?.nextDataSourceFlow.commands.generateGmailOauth ?? "Generate a Gmail OAuth link with composio-connect.js.",
      ],
      resumePrompt: "Prompt Tim for only the Composio API key via the one-use helper, then use Composio OAuth links for Google Calendar and Gmail connected accounts.",
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
        "Generate a guarded helper on the target host with: pnpm run brainctl setup codex-auth-script --config <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root> --service-user <codex-chat-service-user>",
        "Run the returned command as the same OS user that will run codex-chat; for systemd this is usually the non-root service user.",
        "If login is missing, the helper prints `codex login --device-auth` / `codex login` instructions and exits without marking auth verified.",
      ],
      resumePrompt: "If you already verified Codex auth in the previous session, confirm or recheck it and continue to service install/start.",
    },
    {
      step: "install-start-service",
      title: "Install and start the codex-chat service.",
      complete: serviceStarted,
      evidence: serviceStarted
        ? [`Service ${details.service?.serviceName ?? "codex-chat"} is active by systemd metadata.`]
        : serviceInstalled
          ? [`Service ${details.service?.serviceName ?? "codex-chat"} is installed but not active; start it after Codex auth and token metadata are verified.`]
        : ["codex-chat service installation/start is never assumed by setup status; verify Codex auth first, then review the stack/systemd plan and require explicit confirmation."],
      resumePrompt: "If the service is already installed and running, confirm with health/status output before accepting Telegram traffic.",
    },
    {
      step: "openai-transcription",
      title: "Optional: confirm OpenAI voice/audio transcription.",
      complete: Boolean(details.transcription?.enabled && details.transcription?.apiKeyRefPresent),
      evidence: [
        details.transcription?.enabled ? "OpenAI transcription is configured." : "OpenAI transcription is disabled until the user opts in.",
        details.transcription?.apiKeyRefPresent ? "OpenAI transcription API key ref is present; value remains private." : "OpenAI transcription API key ref is missing or not selected.",
      ],
      actions: [
        "Ask whether voice/audio transcription should be enabled for Telegram.",
        "If enabled, store OPENAI_API_KEY only in the private codex-chat service env/secret store and verify redacted metadata before restarting codex-chat.",
      ],
      resumePrompt: "Ask the user to opt in or out of OpenAI transcription; do not silently enable it without a private key ref.",
    },
    {
      step: "optional-follow-ups",
      title: "Optional follow-ups.",
      complete: false,
      evidence: [
        details.webPublishing?.enabled ? "Web publishing is configured." : "Web publishing can be configured after the service path is stable.",
        "First-user pairing happens after the service starts with the Telegram token; up to two raw user/chat pairs stay private and pairing closes after the cap.",
      ],
      resumePrompt: "Handle first-user pairing, web publishing, or backup tuning only when requested or when the base setup is ready.",
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
  const unitName = normalizeSystemdServiceName(serviceName);
  const show = runSystemctl(["show", unitName, "--property=LoadState", "--value"]);
  if (show.error || (show.status ?? 1) !== 0) {
    return { serviceName: unitName, inspected: false, installed: false, enabled: false, active: false, source: "systemctl-unavailable" };
  }
  const loadState = String(show.stdout ?? "").trim();
  const execStart = runSystemctl(["show", unitName, "--property=ExecStart", "--value"]);
  const execStartText = (execStart.status ?? 1) === 0 ? String(execStart.stdout ?? "").trim() : "";
  const workspaceMatched = workspaceRoot && execStartText.includes(workspaceRoot)
    ? true
    : workspaceRoot && /(?:^|\s)(?:ExecStart=|\{|\w+=|\/)/.test(execStartText)
      ? false
      : undefined;
  const enabled = runSystemctl(["is-enabled", unitName]);
  const active = runSystemctl(["is-active", unitName]);
  return {
    serviceName: unitName,
    inspected: true,
    installed: loadState === "loaded",
    enabled: (enabled.status ?? 1) === 0,
    active: (active.status ?? 1) === 0,
    source: "systemctl",
    workspaceMatched,
  };
}

function normalizeSystemdServiceName(serviceName: string): string {
  return serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`;
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

async function reconcileDeploymentLedgerAfterValidation(
  config: BrainConfig,
  options: { workspace: string },
  results: SafeValidationResult[],
  setupStateUpdate: Awaited<ReturnType<typeof updateSetupProgressFromLiveValidation>> | undefined,
): Promise<Record<string, unknown>> {
  const workspace = config.workspaces[options.workspace];
  const workspaceRoot = path.resolve(workspace?.workspacePath ?? defaultWorkspaceRoot(options.workspace));
  const ledgerPath = deploymentMetadataPath(workspaceRoot);
  const metadata = await fileMetadata(ledgerPath);
  if (!metadata.present) {
    return { inspected: true, path: ledgerPath, present: false, wrote: false, skipped: "deployment ledger missing", secretValuesPrinted: false };
  }

  const resultOk = (id: string) => results.find((result) => result.id === id)?.ok === true;
  const state = setupStateUpdate?.state;
  const service = setupServiceStatus(`brain-${options.workspace}`, workspaceRoot);
  const configHealthy = resultOk("config");
  const secretsHealthy = resultOk("secrets");
  const runtimeHealthy = resultOk("runtime-smoke");
  const authHealthy = state?.statuses.codexAuth.status === "verified" || resultOk("codex-provider");
  const telegramHealthy = state?.statuses.telegramToken.configured === true || telegramTokenPresent(results.find((result) => result.id === "telegram-entrypoint"));
  const serviceHealthy = service.active === true && service.workspaceMatched !== false;
  const blockersCleared = configHealthy && secretsHealthy && runtimeHealthy && authHealthy && telegramHealthy && serviceHealthy;

  let store: Record<string, unknown>;
  try {
    store = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { inspected: true, path: ledgerPath, present: true, wrote: false, error: `could not parse deployment ledger: ${errorMessage(error)}`, secretValuesPrinted: false };
  }

  const deployments = Array.isArray(store.deployments) ? store.deployments.filter(isRecord) : [];
  const stale = deployments.filter(deploymentHasAuthSecretBlocker);
  if (stale.length === 0) {
    return { inspected: true, path: ledgerPath, present: true, wrote: false, staleBlockersFound: 0, blockersCleared, service, secretValuesPrinted: false };
  }
  if (!blockersCleared) {
    return {
      inspected: true,
      path: ledgerPath,
      present: true,
      wrote: false,
      staleBlockersFound: stale.length,
      skipped: "current config/secrets/auth/telegram/service health has not cleared the stale blocker",
      health: { configHealthy, secretsHealthy, runtimeHealthy, authHealthy, telegramHealthy, serviceHealthy },
      service,
      secretValuesPrinted: false,
    };
  }

  const now = new Date().toISOString();
  const updatedIds: string[] = [];
  for (const deployment of stale) {
    const id = asString(deployment.id);
    if (id) updatedIds.push(id);
    deployment.status = "healthy";
    deployment.updatedAt = now;
    deployment.secretValuesStored = false;
    deployment.health = {
      ...(asRecord(deployment.health) ?? {}),
      status: "passed",
      reconciledAt: now,
      source: "brainctl validate live",
    };
    removeAuthSecretBlockerFields(deployment);
  }
  store.version = DEPLOYMENT_METADATA_VERSION;
  store.kind = DEPLOYMENT_METADATA_KIND;
  store.updatedAt = now;
  store.secretValuesStored = false;
  store.deployments = deployments;
  await writeFile(ledgerPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(ledgerPath, 0o600);
  return {
    inspected: true,
    path: ledgerPath,
    present: true,
    wrote: true,
    staleBlockersFound: stale.length,
    updatedDeployments: updatedIds,
    removedBlocker: "blocked_on_user_auth_or_secret",
    status: "healthy",
    service,
    metadata: await fileMetadata(ledgerPath),
    secretValuesPrinted: false,
  };
}

function deploymentHasAuthSecretBlocker(deployment: Record<string, unknown>): boolean {
  const needle = "blocked_on_user_auth_or_secret";
  const values = [
    deployment.status,
    deployment.blocker,
    deployment.blockedReason,
    deployment.blockerReason,
    deployment.reason,
    deployment.nextAction,
    deployment.nextRecommendedStep,
    ...(Array.isArray(deployment.blockers) ? deployment.blockers : []),
  ];
  return values.some((value) => typeof value === "string" && value.includes(needle));
}

function removeAuthSecretBlockerFields(deployment: Record<string, unknown>): void {
  const needle = "blocked_on_user_auth_or_secret";
  for (const key of ["blocker", "blockedReason", "blockerReason", "reason", "nextAction", "nextRecommendedStep"]) {
    if (typeof deployment[key] === "string" && deployment[key].includes(needle)) delete deployment[key];
  }
  if (Array.isArray(deployment.blockers)) {
    const remaining = deployment.blockers.filter((value) => !(typeof value === "string" && value.includes(needle)));
    if (remaining.length > 0) deployment.blockers = remaining;
    else delete deployment.blockers;
  }
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
  return { ok: true, transcriptionApiKeyRef: workspace.transcription?.apiKeyRef, cwd: providerCwdForWorkspace(workspace, options.cwd), tmpDir: path.join(workspace.workspacePath, "tmp") };
}

function providerCwdForWorkspace(workspace: WorkspaceConfig, override?: string): string {
  return path.resolve(override ?? workspace.runtimeContext?.controlPlaneRoot ?? workspace.workspacePath ?? process.cwd());
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
  const [users, chats, identities, code] = await Promise.all([store.listUsers(), store.listChats(), store.listIdentities(), store.readPairingCode()]);
  return {
    stateDir,
    adminPairs: identities.filter((identity) => identity.isAdmin !== false).length,
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
    const gmail = composio?.dataSources?.gmail;
    if (gmail?.connectedAccountRef) refs.push({ workspaceId, ref: gmail.connectedAccountRef, source: "integrations.composio.dataSources.gmail.connectedAccountRef" });
    if (gmail?.metadataRef) refs.push({ workspaceId, ref: gmail.metadataRef, source: "integrations.composio.dataSources.gmail.metadataRef", optional: true });
    for (const ref of gmail?.requiredEnvRefs ?? []) refs.push({ workspaceId, ref: asSecretRef(ref), source: "integrations.composio.dataSources.gmail.requiredEnvRefs" });
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
      path.join(workspaceRoot, ".env"),
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
