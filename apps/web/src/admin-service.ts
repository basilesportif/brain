import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { authorizeBrainAdminRequest, isBrainAdminAuthConfigured, parseAdminAllowedEmails, type ClerkUserLookup, type VerifyClerkToken } from "./admin-auth.js";
import { envFileMetadata, readEnvKeyPresence, resolveEnvFilePath, writeMergedEnvFile } from "./env-file.js";
import { renderBrainAdminDeniedPage, renderBrainAdminPage, renderBrainAdminSignInPage } from "./admin-page.js";

const SLACK_EVENTS_BASE_URL = "https://brain.decisive-outcomes.com";
const SLACK_EVENTS_PATH = "/api/slack/events";
const SLACK_ENV_KEYS = [
  "CODEX_CHAT_SLACK_ENABLED",
  "CODEX_CHAT_BASE_URL",
  "CODEX_CHAT_SLACK_EVENTS_PATH",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
] as const;
const OPENROUTER_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "CODEX_CHAT_SUBAGENTS_BACKEND",
  "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL",
  "CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE",
  "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER",
  "CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE",
  "CODEX_CHAT_SUBAGENTS_ALLOW_PROVIDER_OVERRIDE",
  "CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES",
  "CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS",
] as const;
const DEFAULT_ENV_KEYS = [
  "CODEX_CHAT_API_ENABLED",
  ...SLACK_ENV_KEYS,
  ...OPENROUTER_ENV_KEYS,
  "TELEGRAM_BOT_TOKEN",
  "OPENAI_API_KEY",
] as const;

const SECRETISH_RE = /(SECRET|TOKEN|KEY|PASSWORD|COOKIE|SESSION|CREDENTIAL)/i;
const MAX_BODY_BYTES = 128 * 1024;
const LIVE_OPERATION_CONFIRMATION_TOKEN = "brain-admin-live-operation-confirmed-v1";
const SLACK_SETTINGS_CONFIRMATION_TOKEN = "brain-admin-slack-settings-confirmed-v1";
const OPENROUTER_SETTINGS_CONFIRMATION_TOKEN = "brain-admin-openrouter-settings-confirmed-v1";

export interface BrainAdminServiceConfig {
  enabled: boolean;
  host: string;
  port: number;
  routePath: string;
  publicBaseUrl: string;
  clerkPublishableKey: string;
  clerkSecretKey: string;
  clerkAllowedEmails: string;
  instanceName: string;
  instanceHost: string;
  instanceIp: string;
  workspacePath: string;
  assistantAgentLogicPath: string;
  repoRegistryPath: string;
  codexChatHost: string;
  codexChatIp: string;
  codexChatPath: string;
  codexChatEnvFile: string;
  codexChatConfigFile?: string;
  codexHomePath: string;
  codexChatServiceName: string;
  codexChatDeployCommand?: string;
  codexChatRestartCommand?: string;
  brainServiceName: string;
  auditLogPath: string;
  allowedEnvKeys: string[];
  operationTimeoutMs: number;
  slackEventsBaseUrl: string;
  slackEventsPath: string;
  slackAppId?: string;
}

export interface BrainAdminServiceDeps {
  verifyTokenImpl?: VerifyClerkToken;
  getUser?: ClerkUserLookup;
  runCommand?: (command: string, timeoutMs: number) => Promise<CommandResult>;
}

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function loadBrainAdminServiceConfig(env: NodeJS.ProcessEnv = process.env): BrainAdminServiceConfig {
  const allowedEnvKeys = splitCsv(env.BRAIN_CODEX_CHAT_ENV_KEYS || DEFAULT_ENV_KEYS.join(","));
  const localHostname = os.hostname();
  const localIp = defaultLocalIp();
  const codexChatPath = env.BRAIN_CODEX_CHAT_PATH || "/home/tim/pkg/tim/codex-chat";
  return {
    enabled: boolEnv(env.BRAIN_ADMIN_ENABLED, true),
    host: env.BRAIN_ADMIN_HOST || "127.0.0.1",
    port: Number.parseInt(env.BRAIN_ADMIN_PORT || "49347", 10),
    routePath: normalizeRoutePath(env.BRAIN_ADMIN_ROUTE_PATH || "/admin"),
    publicBaseUrl: (env.BRAIN_ADMIN_PUBLIC_BASE_URL || "").trim(),
    clerkPublishableKey: (env.CLERK_PUBLISHABLE_KEY || env.BRAIN_CLERK_PUBLISHABLE_KEY || "").trim(),
    clerkSecretKey: (env.CLERK_SECRET_KEY || env.BRAIN_CLERK_SECRET_KEY || "").trim(),
    clerkAllowedEmails: (env.CLERK_ALLOWED_EMAILS || env.BRAIN_CLERK_ALLOWED_EMAILS || "").trim(),
    instanceName: env.BRAIN_INSTANCE_NAME || "local-brain",
    instanceHost: env.BRAIN_INSTANCE_HOST || env.BRAIN_CODEX_CHAT_HOST || localHostname,
    instanceIp: env.BRAIN_INSTANCE_IP || env.BRAIN_CODEX_CHAT_IP || localIp,
    workspacePath: env.BRAIN_WORKSPACE_PATH || "/home/tim/.assistant-claude/workspace",
    assistantAgentLogicPath: env.BRAIN_ASSISTANT_AGENT_LOGIC_PATH || "/home/tim/pkg/tim/assistant-agent-logic",
    repoRegistryPath: env.BRAIN_REPO_REGISTRY_PATH || "/home/tim/.assistant-claude/workspace/.claude/repo-registry/index.yaml",
    codexChatHost: env.BRAIN_CODEX_CHAT_HOST || env.BRAIN_INSTANCE_HOST || localHostname,
    codexChatIp: env.BRAIN_CODEX_CHAT_IP || env.BRAIN_INSTANCE_IP || localIp,
    codexChatPath,
    codexChatEnvFile: env.BRAIN_CODEX_CHAT_ENV_FILE || "/home/tim/.config/codex-chat/env",
    codexChatConfigFile: env.BRAIN_CODEX_CHAT_CONFIG_FILE || path.join(codexChatPath, "config/codex-chat.toml"),
    codexHomePath: env.BRAIN_CODEX_HOME || env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    codexChatServiceName: env.BRAIN_CODEX_CHAT_SERVICE_NAME || "codex-chat.service",
    codexChatDeployCommand: env.BRAIN_CODEX_CHAT_DEPLOY_COMMAND || undefined,
    codexChatRestartCommand: env.BRAIN_CODEX_CHAT_RESTART_COMMAND || undefined,
    brainServiceName: env.BRAIN_SERVICE_NAME || "brain-admin.service",
    auditLogPath: env.BRAIN_ADMIN_AUDIT_LOG || "/home/tim/.brain/control-plane/audit.jsonl",
    allowedEnvKeys,
    operationTimeoutMs: Number.parseInt(env.BRAIN_ADMIN_OPERATION_TIMEOUT_MS || "120000", 10),
    slackEventsBaseUrl: (env.BRAIN_SLACK_EVENTS_BASE_URL || SLACK_EVENTS_BASE_URL).trim(),
    slackEventsPath: normalizeRoutePath(env.BRAIN_SLACK_EVENTS_PATH || SLACK_EVENTS_PATH),
    slackAppId: normalizeSlackAppId(env.BRAIN_SLACK_APP_ID || env.SLACK_APP_ID || env.CODEX_CHAT_SLACK_APP_ID || ""),
  };
}

export function createBrainAdminServer(config: BrainAdminServiceConfig = loadBrainAdminServiceConfig(), deps: BrainAdminServiceDeps = {}): http.Server {
  return http.createServer(async (request, response) => {
    try {
      await handleRequest(request, response, config, deps);
    } catch (error) {
      sendJson(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, config: BrainAdminServiceConfig, deps: BrainAdminServiceDeps): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? config.host}`);
  if (!config.enabled) return sendJson(response, 503, { error: "brain_admin_disabled" });

  if (request.method === "GET" && isAdminRoutePath(url.pathname, config.routePath)) {
    if (url.pathname !== config.routePath) return redirect(response, 308, config.routePath);
    const auth = await authorizeBrainAdminRequest(request, config, deps);
    if (!auth.ok) return handlePageAuthFailure(request, response, config, auth);
    return sendHtml(response, 200, renderBrainAdminPage(config, auth.admin.email));
  }

  if (request.method === "GET" && url.pathname === adminSignInPath(config.routePath)) {
    const redirectUrl = safeAdminReturnUrl(url.searchParams.get("redirect_url"), adminPublicUrlFromRequest(request, config));
    return sendHtml(response, 200, renderBrainAdminSignInPage(config, redirectUrl));
  }

  if (url.pathname.startsWith("/api/admin/brain/")) {
    const auth = await authorizeBrainAdminRequest(request, config, deps);
    if (!auth.ok) return sendJson(response, auth.statusCode, { error: auth.error, email: auth.admin?.email });
    return handleAdminApi(request, response, url, config, deps, auth.admin.email);
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    return sendJson(response, 200, { ok: true, service: "brain-admin", authConfigured: isBrainAdminAuthConfigured(config) });
  }

  return sendJson(response, 404, { error: "not_found" });
}

async function handleAdminApi(request: IncomingMessage, response: ServerResponse, url: URL, config: BrainAdminServiceConfig, deps: BrainAdminServiceDeps, adminEmail: string): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/admin/brain/me") {
    return sendJson(response, 200, { email: adminEmail });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/brain/health") {
    return sendJson(response, 200, await serviceHealth(config));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/brain/settings") {
    return sendJson(response, 200, await serviceSettings(config));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/brain/codex-chat/env") {
    return sendJson(response, 200, await codexChatEnvSummary(config));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/brain/codex-chat/env") {
    const payload = await readJsonBody(request);
    return handleEnvWrite(response, config, adminEmail, payload);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/brain/openrouter/settings") {
    return sendJson(response, 200, await openRouterSettingsSummary(config));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/brain/openrouter/settings") {
    const payload = await readJsonBody(request);
    return handleOpenRouterSettingsWrite(response, config, adminEmail, payload);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/brain/slack/settings") {
    return sendJson(response, 200, await slackSettingsSummary(config));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/brain/slack/settings") {
    const payload = await readJsonBody(request);
    return handleSlackSettingsWrite(response, config, adminEmail, payload);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/brain/slack/manifest") {
    return sendJson(response, 200, await renderSlackManifestForBrain(config));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/brain/slack/manifest/download") {
    const manifest = await renderSlackManifestForBrain(config);
    return sendDownload(response, "brain.slack.manifest.json", manifest.text);
  }
  if (request.method === "POST" && url.pathname === "/api/admin/brain/codex-chat/operation") {
    const payload = await readJsonBody(request);
    return handleOperation(response, config, deps, adminEmail, payload);
  }
  return sendJson(response, 404, { error: "not_found" });
}

async function serviceHealth(config: BrainAdminServiceConfig) {
  const envFile = await envFileMetadata(config.codexChatEnvFile);
  return {
    ok: isBrainAdminAuthConfigured(config),
    service: "brain-admin",
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    hostname: os.hostname(),
    instance: instanceSummary(config),
    auth: authSummary(config),
    codexChat: {
      host: config.codexChatHost,
      ip: config.codexChatIp,
      path: config.codexChatPath,
      serviceName: config.codexChatServiceName,
      envFile,
      configFile: config.codexChatConfigFile ? { path: config.codexChatConfigFile, configured: true } : { configured: false },
      codexHome: { path: config.codexHomePath },
    },
  };
}

async function serviceSettings(config: BrainAdminServiceConfig) {
  const env = await codexChatEnvSummary(config);
  return {
    routePath: config.routePath,
    publicBaseUrl: config.publicBaseUrl || null,
    instance: instanceSummary(config),
    repoRegistry: {
      ...(await repoRegistrySummary(config.repoRegistryPath)),
      sourceOfTruth: false,
      role: "read-only context only; this running Brain instance is configured by its own env/settings",
    },
    auth: authSummary(config),
    codexChat: {
      host: config.codexChatHost,
      ip: config.codexChatIp,
      path: config.codexChatPath,
      serviceName: config.codexChatServiceName,
      env,
      configFile: config.codexChatConfigFile ? { path: config.codexChatConfigFile, configured: true } : { configured: false },
      codexHome: { path: config.codexHomePath },
      deployCommandConfigured: Boolean(config.codexChatDeployCommand),
      operationCommands: operationCommandSummary(config),
      restartCommand: operationCommand(config, "restart") ? redactedCommand(operationCommand(config, "restart") ?? "") : null,
    },
    slack: await slackSettingsSummary(config),
    openRouter: await openRouterSettingsSummary(config),
  };
}

async function codexChatEnvSummary(config: BrainAdminServiceConfig) {
  return envPresenceSummary(config, config.allowedEnvKeys);
}

async function slackSettingsSummary(config: BrainAdminServiceConfig) {
  const env = await envPresenceSummary(config, SLACK_ENV_KEYS);
  return {
    publicEventsUrl: buildSlackEventsUrl(config.slackEventsBaseUrl, config.slackEventsPath),
    eventsBaseUrl: config.slackEventsBaseUrl,
    eventsPath: config.slackEventsPath,
    slackAppId: config.slackAppId ?? null,
    appSettingsUrl: buildSlackAppSettingsUrl(config.slackAppId),
    upstream: "codex-chat internal API on 127.0.0.1:49346",
    runtimeOwner: "codex-chat verifies Slack signatures and normalizes runtime events",
    values: "write-only; presence only",
    env,
  };
}


async function openRouterSettingsSummary(config: BrainAdminServiceConfig) {
  const env = await envPresenceSummary(config, OPENROUTER_ENV_KEYS);
  const codexProfile = await codexProfileMetadata(config.codexHomePath, "openrouter");
  const codexChatConfig = config.codexChatConfigFile ? await codexChatProviderConfigSummary(config.codexChatConfigFile) : { configured: false };
  return {
    values: "write-only; presence only",
    keyEnv: "OPENROUTER_API_KEY",
    recommendedCodexProfile: "openrouter",
    recommendedModelProvider: "openrouter",
    recommendedServiceTierMode: "omit",
    codexProfile,
    codexChatConfig,
    env,
    restartPath: "Use Deploy / Restart: run plan, then restart codex-chat after writing settings.",
    testDispatch: "After restart, ask codex-chat to dispatch a subagent with codexProfile=openrouter, modelProvider=openrouter, serviceTierMode=omit, and the chosen OpenRouter model slug."
  };
}

async function handleOpenRouterSettingsWrite(response: ServerResponse, config: BrainAdminServiceConfig, adminEmail: string, payload: Record<string, unknown>): Promise<void> {
  let input: OpenRouterSettingsInput;
  try {
    input = parseOpenRouterSettingsPayload(payload);
  } catch (error) {
    return sendJson(response, 400, { error: "invalid_openrouter_settings", message: error instanceof Error ? error.message : String(error) });
  }
  const confirmation = parseOpenRouterSettingsConfirmation(payload.confirmation);
  const envFile = resolveEnvFilePath(config.codexChatEnvFile);
  const configFile = config.codexChatConfigFile ?? "";
  const profilePath = codexProfilePath(config.codexHomePath, input.codexProfile);
  const writtenEnvKeys = [
    ...(input.apiKey ? ["OPENROUTER_API_KEY"] : []),
    "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL",
    "CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE",
    "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER",
    "CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE",
    "CODEX_CHAT_SUBAGENTS_ALLOW_PROVIDER_OVERRIDE",
    "CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES",
    "CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS",
    ...(input.backend ? ["CODEX_CHAT_SUBAGENTS_BACKEND"] : [])
  ];
  if (!confirmation
    || confirmation.token !== OPENROUTER_SETTINGS_CONFIRMATION_TOKEN
    || confirmation.action !== "openrouter.settings.write"
    || confirmation.envFile !== envFile
    || confirmation.profilePath !== profilePath
    || !sameStringSet(confirmation.keys, writtenEnvKeys)) {
    return sendJson(response, 400, {
      error: "confirmation_required",
      required: { token: OPENROUTER_SETTINGS_CONFIRMATION_TOKEN, action: "openrouter.settings.write", envFile, profilePath, keys: writtenEnvKeys }
    });
  }

  const updates: Record<string, string> = {
    CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL: input.model,
    CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE: input.codexProfile,
    CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER: input.modelProvider,
    CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE: input.serviceTierMode,
    CODEX_CHAT_SUBAGENTS_ALLOW_PROVIDER_OVERRIDE: "true",
    CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES: input.codexProfile,
    CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS: input.modelProvider
  };
  if (input.apiKey) updates.OPENROUTER_API_KEY = input.apiKey;
  if (input.backend) updates.CODEX_CHAT_SUBAGENTS_BACKEND = input.backend;

  await writeMergedEnvFile(config.codexChatEnvFile, updates, "Brain OpenRouter settings");
  await writeOpenRouterCodexProfile(config.codexHomePath, input);
  if (config.codexChatConfigFile) await writeCodexChatProviderConfig(config.codexChatConfigFile, input);
  await appendAudit(config, {
    action: "openrouter.settings.write",
    adminEmail,
    envFile,
    configFile: config.codexChatConfigFile ?? null,
    profilePath,
    keys: writtenEnvKeys,
    values: "write-only"
  });
  return sendJson(response, 200, {
    ok: true,
    envFile,
    configFile: config.codexChatConfigFile ?? null,
    profilePath,
    writtenKeys: writtenEnvKeys,
    values: "write-only",
    presence: await readEnvKeyPresence(config.codexChatEnvFile, writtenEnvKeys),
    apiKeyPresent: Boolean(input.apiKey) || Boolean((await readEnvKeyPresence(config.codexChatEnvFile, ["OPENROUTER_API_KEY"])).OPENROUTER_API_KEY),
    restartRequired: true
  });
}

async function envPresenceSummary(config: BrainAdminServiceConfig, keysToRead: readonly string[]) {
  const envFile = resolveEnvFilePath(config.codexChatEnvFile);
  const present = await readEnvKeyPresence(envFile, [...keysToRead]);
  const keys = keysToRead.map((key) => ({ key, present: Boolean(present[key]), secret: SECRETISH_RE.test(key), value: present[key] ? "redacted" : null }));
  return { envFile, allowedKeys: [...keysToRead], keys };
}

async function handleEnvWrite(response: ServerResponse, config: BrainAdminServiceConfig, adminEmail: string, payload: Record<string, unknown>): Promise<void> {
  const approval = typeof payload.approval === "string" ? payload.approval.trim() : "";
  if (approval !== "write env" && approval !== `write ${config.codexChatServiceName} env`) {
    return sendJson(response, 400, { error: "approval_required", expected: ["write env", `write ${config.codexChatServiceName} env`] });
  }
  const entries = parseEntries(payload.entries);
  const allowed = new Set(config.allowedEnvKeys);
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!isEnvKey(key)) return sendJson(response, 400, { error: "invalid_env_key", key });
    if (!allowed.has(key)) return sendJson(response, 403, { error: "env_key_not_allowed", key, allowedKeys: config.allowedEnvKeys });
    if (typeof value !== "string" || value.length === 0) return sendJson(response, 400, { error: "env_value_required", key });
    updates[key] = value;
  }
  if (Object.keys(updates).length === 0) return sendJson(response, 400, { error: "no_entries" });
  await writeMergedEnvFile(config.codexChatEnvFile, updates, "Brain control plane");
  await appendAudit(config, { action: "codex-chat.env.write", adminEmail, keys: Object.keys(updates), envFile: resolveEnvFilePath(config.codexChatEnvFile) });
  return sendJson(response, 200, { ok: true, envFile: resolveEnvFilePath(config.codexChatEnvFile), writtenKeys: Object.keys(updates), values: "write-only", presence: await readEnvKeyPresence(config.codexChatEnvFile, Object.keys(updates)), restartRequired: true });
}

async function handleSlackSettingsWrite(response: ServerResponse, config: BrainAdminServiceConfig, adminEmail: string, payload: Record<string, unknown>): Promise<void> {
  const entries = parseEntries(payload.entries);
  const allowed = new Set<string>(SLACK_ENV_KEYS);
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!isEnvKey(key)) return sendJson(response, 400, { error: "invalid_env_key", key });
    if (!allowed.has(key)) return sendJson(response, 403, { error: "slack_env_key_not_allowed", key, allowedKeys: [...SLACK_ENV_KEYS] });
    if (typeof value !== "string" || value.length === 0) return sendJson(response, 400, { error: "env_value_required", key });
    updates[key] = value;
  }
  const writtenKeys = Object.keys(updates);
  if (writtenKeys.length === 0) return sendJson(response, 400, { error: "no_entries" });

  const envFile = resolveEnvFilePath(config.codexChatEnvFile);
  const confirmation = parseSlackSettingsConfirmation(payload.confirmation);
  if (!confirmation
    || confirmation.token !== SLACK_SETTINGS_CONFIRMATION_TOKEN
    || confirmation.action !== "slack.settings.write"
    || confirmation.envFile !== envFile
    || !sameStringSet(confirmation.keys, writtenKeys)) {
    return sendJson(response, 400, {
      error: "confirmation_required",
      required: { token: SLACK_SETTINGS_CONFIRMATION_TOKEN, action: "slack.settings.write", envFile, keys: writtenKeys },
    });
  }

  await writeMergedEnvFile(config.codexChatEnvFile, updates, "Brain Slack settings");
  await appendAudit(config, { action: "slack.settings.write", adminEmail, keys: writtenKeys, envFile, values: "write-only" });
  return sendJson(response, 200, { ok: true, envFile, writtenKeys, values: "write-only", presence: await readEnvKeyPresence(config.codexChatEnvFile, writtenKeys), restartRequired: true });
}

async function renderSlackManifestForBrain(config: BrainAdminServiceConfig): Promise<{ requestUrl: string; eventsPath: string; renderer: string; validation?: unknown; manifest: unknown; text: string }> {
  const script = path.join(config.codexChatPath, "slack-app", "scripts", "render-manifest.mjs");
  const result = await runNodeScript(process.execPath, [script, "--base-url", config.slackEventsBaseUrl, "--events-path", config.slackEventsPath], config.operationTimeoutMs);
  if (result.status !== 0) {
    throw new Error(`Slack manifest render failed: ${redactOutput(result.stderr || result.stdout || `exit ${result.status}`)}`);
  }
  const text = result.stdout;
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const requestUrl = String(((manifest.settings as Record<string, unknown> | undefined)?.event_subscriptions as Record<string, unknown> | undefined)?.request_url ?? "");
  return {
    requestUrl,
    eventsPath: config.slackEventsPath,
    renderer: script,
    manifest,
    text,
  };
}

async function runNodeScript(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = truncate(stdout + chunk, 2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = truncate(stderr + chunk); });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

function normalizeSlackAppId(value: string): string | undefined {
  const trimmed = value.trim();
  // Slack app IDs are non-secret identifiers such as A0123456789. Reject
  // unexpected input instead of reflecting arbitrary config into an href.
  if (!trimmed) return undefined;
  return /^A[A-Z0-9]{8,}$/.test(trimmed) ? trimmed : undefined;
}

function buildSlackAppSettingsUrl(appId?: string): string {
  return appId ? `https://api.slack.com/apps/${appId}` : "https://api.slack.com/apps";
}

function buildSlackEventsUrl(baseUrl: string, eventsPath: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}${eventsPath}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function handleOperation(response: ServerResponse, config: BrainAdminServiceConfig, deps: BrainAdminServiceDeps, adminEmail: string, payload: Record<string, unknown>): Promise<void> {
  const operation = typeof payload.operation === "string" ? payload.operation.trim() : "";
  if (!["plan", "restart", "deploy"].includes(operation)) return sendJson(response, 400, { error: "unsupported_operation", supported: ["plan", "restart", "deploy"] });
  if (isSelfServiceTarget(config)) return sendJson(response, 409, { error: "refusing_to_operate_on_brain_service", serviceName: config.codexChatServiceName });

  const command = operationCommand(config, operation as "plan" | "restart" | "deploy");
  if (!command) return sendJson(response, 409, { error: "operation_not_configured", operation });
  if (operation === "plan") {
    await appendAudit(config, { action: "codex-chat.operation.plan", adminEmail, operation, command: redactedCommand(command) });
    return sendJson(response, 200, { ok: true, dryRun: true, operation, command: redactedCommand(command), sideEffects: "none" });
  }

  const confirmation = parseLiveOperationConfirmation(payload.confirmation);
  if (!confirmation
    || confirmation.token !== LIVE_OPERATION_CONFIRMATION_TOKEN
    || confirmation.operation !== operation
    || confirmation.serviceName !== config.codexChatServiceName) {
    return sendJson(response, 400, {
      error: "confirmation_required",
      required: { token: LIVE_OPERATION_CONFIRMATION_TOKEN, operation, serviceName: config.codexChatServiceName },
    });
  }

  const result = await (deps.runCommand ?? runShellCommand)(command, config.operationTimeoutMs);
  await appendAudit(config, { action: "codex-chat.operation.execute", adminEmail, operation, command: redactedCommand(command), status: result.status, signal: result.signal, timedOut: result.timedOut, freshPlan: Boolean(confirmation.freshPlan), bypassedFreshPlan: Boolean(confirmation.bypassedFreshPlan) });
  return sendJson(response, result.status === 0 ? 200 : 500, { ok: result.status === 0, operation, status: result.status, signal: result.signal, timedOut: result.timedOut, stdout: redactOutput(result.stdout), stderr: redactOutput(result.stderr) });
}



interface OpenRouterSettingsInput {
  apiKey?: string;
  model: string;
  codexProfile: string;
  modelProvider: string;
  serviceTierMode: "auto" | "always" | "omit";
  backend?: "codex_exec" | "codex_app_server";
}

function parseOpenRouterSettingsPayload(payload: Record<string, unknown>): OpenRouterSettingsInput {
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  const model = stringField(payload.model, "model", "anthropic/claude-sonnet-4.5");
  const codexProfile = stringField(payload.codexProfile, "codexProfile", "openrouter");
  const modelProvider = stringField(payload.modelProvider, "modelProvider", "openrouter");
  const serviceTierMode = stringField(payload.serviceTierMode, "serviceTierMode", "omit");
  const backendRaw = typeof payload.backend === "string" ? payload.backend.trim() : "";
  if (!/^[A-Za-z0-9._/-]+$/.test(model)) throw new Error("Invalid OpenRouter model slug");
  if (!/^[A-Za-z0-9._-]+$/.test(codexProfile)) throw new Error("Invalid Codex profile name");
  if (!/^[A-Za-z0-9._-]+$/.test(modelProvider)) throw new Error("Invalid model provider name");
  if (!["auto", "always", "omit"].includes(serviceTierMode)) throw new Error("Invalid service tier mode");
  if (backendRaw && backendRaw !== "codex_exec" && backendRaw !== "codex_app_server") throw new Error("Invalid subagent backend");
  return { apiKey: apiKey || undefined, model, codexProfile, modelProvider, serviceTierMode: serviceTierMode as "auto" | "always" | "omit", backend: backendRaw as OpenRouterSettingsInput["backend"] || undefined };
}

function stringField(value: unknown, name: string, fallback: string): string {
  const out = typeof value === "string" ? value.trim() : fallback;
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function parseOpenRouterSettingsConfirmation(value: unknown): { token?: string; action?: string; envFile?: string; profilePath?: string; keys: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    token: typeof record.token === "string" ? record.token : undefined,
    action: typeof record.action === "string" ? record.action : undefined,
    envFile: typeof record.envFile === "string" ? record.envFile : undefined,
    profilePath: typeof record.profilePath === "string" ? record.profilePath : undefined,
    keys: Array.isArray(record.keys) ? record.keys.filter((key): key is string => typeof key === "string") : [],
  };
}

function codexProfilePath(codexHomePath: string, profile: string): string {
  return path.join(resolveEnvFilePath(codexHomePath), `${profile}.config.toml`);
}

async function writeOpenRouterCodexProfile(codexHomePath: string, input: OpenRouterSettingsInput): Promise<void> {
  const filePath = codexProfilePath(codexHomePath, input.codexProfile);
  const body = [
    "# Managed by Brain control plane. No API key value is stored here.",
    `model = ${tomlString(input.model)}`,
    `model_provider = ${tomlString(input.modelProvider)}`,
    "model_reasoning_effort = \"medium\"",
    "",
    `[model_providers.${input.modelProvider}]`,
    "name = \"OpenRouter\"",
    "base_url = \"https://openrouter.ai/api/v1\"",
    "wire_api = \"chat\"",
    "env_key = \"OPENROUTER_API_KEY\"",
    "env_key_instructions = \"Set OPENROUTER_API_KEY in the codex-chat service environment.\"",
    ""
  ].join("\n");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, filePath);
  await chmod(filePath, 0o600);
}

async function writeCodexChatProviderConfig(filePath: string, input: OpenRouterSettingsInput): Promise<void> {
  const resolved = resolveEnvFilePath(filePath);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const current = await readTextIfPresent(resolved);
  let next = updateTomlSection(current, "subagents", {
    defaultModel: input.model,
    defaultCodexProfile: input.codexProfile,
    defaultModelProvider: input.modelProvider,
    serviceTierMode: input.serviceTierMode,
    allowProviderOverride: true,
    allowedCodexProfiles: [input.codexProfile],
    allowedModelProviders: [input.modelProvider],
    ...(input.backend ? { backend: input.backend } : {})
  });
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, next, { mode: 0o600 });
  await rename(tmp, resolved);
  await chmod(resolved, 0o600);
}

async function codexProfileMetadata(codexHomePath: string, profile: string): Promise<{ path: string; present: boolean; mode?: string; size?: number }> {
  const filePath = codexProfilePath(codexHomePath, profile);
  try {
    const info = await stat(filePath);
    return { path: filePath, present: true, mode: `0${(info.mode & 0o777).toString(8)}`, size: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: filePath, present: false };
    throw error;
  }
}

async function codexChatProviderConfigSummary(filePath: string): Promise<{ configured: boolean; path: string; subagents?: Record<string, unknown> }> {
  const resolved = resolveEnvFilePath(filePath);
  const text = await readTextIfPresent(resolved);
  return {
    configured: Boolean(text),
    path: resolved,
    subagents: {
      defaultModel: readTomlValue(text, "subagents", "defaultModel"),
      defaultCodexProfile: readTomlValue(text, "subagents", "defaultCodexProfile"),
      defaultModelProvider: readTomlValue(text, "subagents", "defaultModelProvider"),
      serviceTierMode: readTomlValue(text, "subagents", "serviceTierMode"),
      allowProviderOverride: readTomlValue(text, "subagents", "allowProviderOverride"),
      allowedCodexProfiles: readTomlValue(text, "subagents", "allowedCodexProfiles"),
      allowedModelProviders: readTomlValue(text, "subagents", "allowedModelProviders"),
    }
  };
}

function updateTomlSection(sourceText: string, section: string, updates: Record<string, string | boolean | string[]>): string {
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const header = `[${section}]`;
  let start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") lines.push("");
    lines.push(header);
    start = lines.length - 1;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i] ?? "")) { end = i; break; }
  }
  const updateKeys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  for (let i = start + 1; i < end; i++) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=/.exec(lines[i] ?? "");
    const key = match?.[1];
    if (!key || !updateKeys.has(key)) continue;
    lines[i] = `${key} = ${tomlValue(updates[key] ?? "")}`;
    seen.add(key);
  }
  const additions = Object.keys(updates).filter((key) => !seen.has(key)).map((key) => `${key} = ${tomlValue(updates[key] ?? "")}`);
  lines.splice(end, 0, ...additions);
  return `${lines.join("\n")}\n`;
}

function readTomlValue(sourceText: string, section: string, key: string): string | null {
  const sectionMatch = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*$`, "m").exec(sourceText);
  if (!sectionMatch) return null;
  const rest = sourceText.slice((sectionMatch.index ?? 0) + sectionMatch[0].length);
  const nextSection = rest.search(/\n\s*\[[^\]]+\]\s*/);
  const body = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  const keyMatch = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, "m").exec(body);
  return keyMatch?.[1] ?? null;
}

function tomlValue(value: string | boolean | string[]): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(tomlString).join(", ")}]`;
  return tomlString(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readTextIfPresent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function operationCommandSummary(config: BrainAdminServiceConfig): Record<"plan" | "restart" | "deploy", { configured: boolean; command: string | null }> {
  return {
    plan: { configured: true, command: redactedCommand(operationCommand(config, "plan") ?? "") },
    restart: { configured: Boolean(operationCommand(config, "restart")), command: operationCommand(config, "restart") ? redactedCommand(operationCommand(config, "restart") ?? "") : null },
    deploy: { configured: Boolean(operationCommand(config, "deploy")), command: operationCommand(config, "deploy") ? redactedCommand(operationCommand(config, "deploy") ?? "") : null },
  };
}

function parseSlackSettingsConfirmation(value: unknown): { token?: string; action?: string; envFile?: string; keys: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    token: typeof record.token === "string" ? record.token : undefined,
    action: typeof record.action === "string" ? record.action : undefined,
    envFile: typeof record.envFile === "string" ? record.envFile : undefined,
    keys: Array.isArray(record.keys) ? record.keys.filter((key): key is string => typeof key === "string") : [],
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== right.length) return false;
  return right.every((value) => leftSet.has(value));
}

function parseLiveOperationConfirmation(value: unknown): { token?: string; operation?: string; serviceName?: string; freshPlan?: boolean; bypassedFreshPlan?: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    token: typeof record.token === "string" ? record.token : undefined,
    operation: typeof record.operation === "string" ? record.operation : undefined,
    serviceName: typeof record.serviceName === "string" ? record.serviceName : undefined,
    freshPlan: record.freshPlan === true,
    bypassedFreshPlan: record.bypassedFreshPlan === true,
  };
}

function operationCommand(config: BrainAdminServiceConfig, operation: "plan" | "restart" | "deploy"): string | undefined {
  if (operation === "deploy") return config.codexChatDeployCommand;
  const restart = config.codexChatRestartCommand || `systemctl --user restart ${shellArg(config.codexChatServiceName)} || sudo systemctl restart ${shellArg(config.codexChatServiceName)}`;
  if (operation === "restart") return restart;
  return [
    `# Brain instance: ${shellArg(config.instanceName)} on ${shellArg(config.instanceHost)} (${shellArg(config.instanceIp)})`,
    `# codex-chat host/ip: ${shellArg(config.codexChatHost)} ${shellArg(config.codexChatIp)}`,
    `# codex-chat path: ${shellArg(config.codexChatPath)}`,
    `# codex-chat env file: ${shellArg(resolveEnvFilePath(config.codexChatEnvFile))}`,
    config.codexChatConfigFile ? `# codex-chat config file: ${shellArg(config.codexChatConfigFile)}` : "# codex-chat config file: not configured",
    config.codexChatDeployCommand ? `# deploy: ${config.codexChatDeployCommand}` : "# deploy: not configured; set BRAIN_CODEX_CHAT_DEPLOY_COMMAND",
    `# restart: ${restart}`,
  ].join("\n");
}

async function repoRegistrySummary(registryPath: string): Promise<{ path: string; present: boolean; brain?: unknown; codexChat?: unknown; assistantLogic?: unknown }> {
  try {
    const text = await readFile(registryPath, "utf8");
    return { path: registryPath, present: true, brain: roughRepoEntry(text, "brain"), codexChat: roughRepoEntry(text, "codex-chat"), assistantLogic: roughRepoEntry(text, "assistant-claude") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: registryPath, present: false };
    throw error;
  }
}

function roughRepoEntry(text: string, alias: string): unknown {
  const marker = `  ${alias}:`;
  const start = text.indexOf(marker);
  if (start < 0) return { present: false };
  const rest = text.slice(start + marker.length);
  const next = rest.search(/\n  [A-Za-z0-9_.-]+:\n/);
  const block = (next >= 0 ? rest.slice(0, next) : rest).split("\n");
  const pick = (name: string) => block.find((line) => line.trim().startsWith(`${name}:`))?.split(":").slice(1).join(":").trim() || null;
  return { present: true, host: pick("host"), path: pick("path"), repoName: pick("repo_name"), remoteUrl: pick("remote_url"), deployHost: pick("deploy_host"), deployPath: pick("deploy_path") };
}

async function appendAudit(config: BrainAdminServiceConfig, event: Record<string, unknown>): Promise<void> {
  const filePath = resolveEnvFilePath(config.auditLogPath);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const record = { at: new Date().toISOString(), ...event, secretValuesLogged: false };
  await appendFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function runShellCommand(command: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = truncate(stdout + chunk); });
    child.stderr.on("data", (chunk) => { stderr = truncate(stderr + chunk); });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
  return parsed as Record<string, unknown>;
}

function parseEntries(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function authSummary(config: BrainAdminServiceConfig) {
  return { configured: isBrainAdminAuthConfigured(config), publishableKeyPresent: Boolean(config.clerkPublishableKey), secretKeyPresent: Boolean(config.clerkSecretKey), allowedEmailCount: parseAdminAllowedEmails(config.clerkAllowedEmails).size, failClosed: true };
}

function handlePageAuthFailure(request: IncomingMessage, response: ServerResponse, config: BrainAdminServiceConfig, auth: { statusCode: number; error: string; admin?: { email: string } }): void {
  const signInUrl = adminSignInUrlFromRequest(request, config);
  if (auth.statusCode === 401) {
    signInUrl.searchParams.set("redirect_url", adminPublicUrlFromRequest(request, config));
    return redirect(response, 302, signInUrl.toString());
  }
  return sendHtml(response, auth.statusCode, renderBrainAdminDeniedPage(config, auth.error, signInUrl.toString(), auth.admin?.email ?? ""));
}

function adminPublicUrlFromRequest(request: IncomingMessage, config: BrainAdminServiceConfig): string {
  const base = config.publicBaseUrl.trim() || externalOriginFromRequest(request);
  return new URL(config.routePath, ensureTrailingSlash(base)).toString().replace(/\/$/, "");
}

function adminSignInUrlFromRequest(request: IncomingMessage, config: BrainAdminServiceConfig): URL {
  const base = config.publicBaseUrl.trim() || externalOriginFromRequest(request);
  return new URL(adminSignInPath(config.routePath), ensureTrailingSlash(base));
}

function externalOriginFromRequest(request: IncomingMessage): string {
  const proto = firstHeader(request.headers["x-forwarded-proto"]) || "http";
  const host = firstHeader(request.headers["x-forwarded-host"]) || firstHeader(request.headers.host) || "127.0.0.1";
  return `${proto}://${host}`;
}

function safeAdminReturnUrl(candidate: string | null, fallback: string): string {
  if (!candidate) return fallback;
  try {
    const parsed = new URL(candidate);
    const expected = new URL(fallback);
    return parsed.origin === expected.origin ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

function isAdminRoutePath(pathname: string, routePath: string): boolean {
  return pathname === routePath || pathname === `${routePath}/`;
}

function adminSignInPath(routePath: string): string {
  return `${routePath.replace(/\/+$/, "")}/auth/sign-in`;
}

function instanceSummary(config: BrainAdminServiceConfig) {
  return {
    project: "Brain",
    instanceName: config.instanceName,
    host: config.instanceHost,
    ip: config.instanceIp,
    workspacePath: config.workspacePath,
    assistantAgentLogicPath: config.assistantAgentLogicPath,
    configurationSource: "brain-admin environment/defaults",
    repoRegistrySourceOfTruth: false,
  };
}

function defaultLocalIp(): string {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return "127.0.0.1";
}

function normalizeRoutePath(value: string): string {
  const out = value.trim() || "/admin";
  return (out.startsWith("/") ? out : `/${out}`).replace(/\/+$/, "") || "/admin";
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function splitCsv(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)));
}

function isEnvKey(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function isSelfServiceTarget(config: BrainAdminServiceConfig): boolean {
  return config.codexChatServiceName === config.brainServiceName || /\bbrain(?:-|_)?admin\.service\b/.test(config.codexChatServiceName);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
}

function sendDownload(response: ServerResponse, filename: string, body: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-disposition", `attachment; filename="${filename}"`);
  response.end(body);
}

function redirect(response: ServerResponse, statusCode: number, location: string): void {
  response.statusCode = statusCode;
  response.setHeader("location", location);
  response.end();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function redactedCommand(command: string): string {
  return command
    .replace(/((?:TOKEN|SECRET|KEY|PASSWORD|COOKIE|SESSION|CREDENTIAL)[A-Z0-9_]*=)(?:"[^"]*"|\'[^\']*\'|[^\s]+)/gi, "$1<redacted>")
    .replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "<redacted-token>");
}

function redactOutput(value: string): string {
  return truncate(value)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "<redacted-openai-key>")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "<redacted-slack-token>");
}

function truncate(value: string, max = 16_000): string {
  return value.length > max ? `${value.slice(0, max)}\n<truncated>` : value;
}
