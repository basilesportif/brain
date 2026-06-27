import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { authorizeBrainAdminRequest, isBrainAdminAuthConfigured, parseAdminAllowedEmails, type ClerkUserLookup, type VerifyClerkToken } from "./admin-auth.js";
import { envFileMetadata, readEnvKeyPresence, resolveEnvFilePath, writeMergedEnvFile } from "./env-file.js";
import { renderBrainAdminDeniedPage, renderBrainAdminPage, renderBrainAdminSignInPage } from "./admin-page.js";

const DEFAULT_ENV_KEYS = [
  "CODEX_CHAT_API_ENABLED",
  "CODEX_CHAT_ADMIN_ENABLED",
  "CODEX_CHAT_ADMIN_PUBLIC_BASE_URL",
  "CODEX_CHAT_BASE_URL",
  "CODEX_CHAT_SLACK_ENABLED",
  "CODEX_CHAT_SLACK_EVENTS_PATH",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "OPENAI_API_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_ALLOWED_EMAILS",
] as const;

const SECRETISH_RE = /(SECRET|TOKEN|KEY|PASSWORD|COOKIE|SESSION|CREDENTIAL)/i;
const MAX_BODY_BYTES = 128 * 1024;

export interface BrainAdminServiceConfig {
  enabled: boolean;
  host: string;
  port: number;
  routePath: string;
  publicBaseUrl: string;
  clerkPublishableKey: string;
  clerkSecretKey: string;
  clerkAllowedEmails: string;
  repoRegistryPath: string;
  codexChatEnvFile: string;
  codexChatConfigFile?: string;
  codexChatServiceName: string;
  codexChatDeployCommand?: string;
  codexChatRestartCommand?: string;
  brainServiceName: string;
  auditLogPath: string;
  allowedEnvKeys: string[];
  operationTimeoutMs: number;
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
  const allowedEnvKeys = splitCsv(env.BRAIN_CODEX_CHAT_ENV_KEYS || env.CODEX_CHAT_ADMIN_ALLOWED_ENV_KEYS || DEFAULT_ENV_KEYS.join(","));
  return {
    enabled: boolEnv(env.BRAIN_ADMIN_ENABLED, true),
    host: env.BRAIN_ADMIN_HOST || "127.0.0.1",
    port: Number.parseInt(env.BRAIN_ADMIN_PORT || "49347", 10),
    routePath: normalizeRoutePath(env.BRAIN_ADMIN_ROUTE_PATH || "/admin"),
    publicBaseUrl: (env.BRAIN_ADMIN_PUBLIC_BASE_URL || "").trim(),
    clerkPublishableKey: (env.CLERK_PUBLISHABLE_KEY || env.BRAIN_CLERK_PUBLISHABLE_KEY || "").trim(),
    clerkSecretKey: (env.CLERK_SECRET_KEY || env.BRAIN_CLERK_SECRET_KEY || "").trim(),
    clerkAllowedEmails: (env.CLERK_ALLOWED_EMAILS || env.BRAIN_CLERK_ALLOWED_EMAILS || "").trim(),
    repoRegistryPath: env.BRAIN_REPO_REGISTRY_PATH || "/home/tim/.assistant-claude/workspace/.claude/repo-registry/index.yaml",
    codexChatEnvFile: env.BRAIN_CODEX_CHAT_ENV_FILE || "~/.config/codex-chat/env",
    codexChatConfigFile: env.BRAIN_CODEX_CHAT_CONFIG_FILE || undefined,
    codexChatServiceName: env.BRAIN_CODEX_CHAT_SERVICE_NAME || "codex-chat.service",
    codexChatDeployCommand: env.BRAIN_CODEX_CHAT_DEPLOY_COMMAND || undefined,
    codexChatRestartCommand: env.BRAIN_CODEX_CHAT_RESTART_COMMAND || undefined,
    brainServiceName: env.BRAIN_SERVICE_NAME || "brain-admin.service",
    auditLogPath: env.BRAIN_ADMIN_AUDIT_LOG || "~/.brain/control-plane/audit.jsonl",
    allowedEnvKeys,
    operationTimeoutMs: Number.parseInt(env.BRAIN_ADMIN_OPERATION_TIMEOUT_MS || "120000", 10),
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
    return sendHtml(response, 200, renderBrainAdminPage(config));
  }

  if (request.method === "GET" && url.pathname === adminSignInPath(config.routePath)) {
    const redirectUrl = safeAdminReturnUrl(url.searchParams.get("redirect_url"), adminPublicUrlFromRequest(request, config));
    return sendHtml(response, 200, renderBrainAdminSignInPage(config, redirectUrl));
  }

  if (url.pathname.startsWith("/api/admin/brain/")) {
    const auth = await authorizeBrainAdminRequest(request, config, deps);
    if (!auth.ok) return sendJson(response, auth.statusCode, { error: auth.error });
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
    auth: authSummary(config),
    codexChat: {
      serviceName: config.codexChatServiceName,
      envFile,
      configFile: config.codexChatConfigFile ? { path: config.codexChatConfigFile, configured: true } : { configured: false },
    },
  };
}

async function serviceSettings(config: BrainAdminServiceConfig) {
  const env = await codexChatEnvSummary(config);
  return {
    routePath: config.routePath,
    publicBaseUrl: config.publicBaseUrl || null,
    repoRegistry: await repoRegistrySummary(config.repoRegistryPath),
    auth: authSummary(config),
    codexChat: {
      serviceName: config.codexChatServiceName,
      env,
      deployCommandConfigured: Boolean(config.codexChatDeployCommand),
      restartCommand: operationCommand(config, "restart") ? redactedCommand(operationCommand(config, "restart") ?? "") : null,
    },
  };
}

async function codexChatEnvSummary(config: BrainAdminServiceConfig) {
  const envFile = resolveEnvFilePath(config.codexChatEnvFile);
  const present = await readEnvKeyPresence(envFile, config.allowedEnvKeys);
  const keys = config.allowedEnvKeys.map((key) => ({ key, present: Boolean(present[key]), secret: SECRETISH_RE.test(key), value: present[key] ? "redacted" : null }));
  return { envFile, allowedKeys: config.allowedEnvKeys, keys };
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

async function handleOperation(response: ServerResponse, config: BrainAdminServiceConfig, deps: BrainAdminServiceDeps, adminEmail: string, payload: Record<string, unknown>): Promise<void> {
  const operation = typeof payload.operation === "string" ? payload.operation.trim() : "";
  if (!["plan", "restart", "deploy"].includes(operation)) return sendJson(response, 400, { error: "unsupported_operation", supported: ["plan", "restart", "deploy"] });
  const expectedApproval = `${operation} ${config.codexChatServiceName}`;
  const approval = typeof payload.approval === "string" ? payload.approval.trim() : "";
  if (approval !== expectedApproval) return sendJson(response, 400, { error: "approval_required", expected: expectedApproval });
  if (isSelfServiceTarget(config)) return sendJson(response, 409, { error: "refusing_to_operate_on_brain_service", serviceName: config.codexChatServiceName });

  const command = operationCommand(config, operation as "plan" | "restart" | "deploy");
  if (!command) return sendJson(response, 409, { error: "operation_not_configured", operation });
  if (operation === "plan") {
    await appendAudit(config, { action: "codex-chat.operation.plan", adminEmail, operation, command: redactedCommand(command) });
    return sendJson(response, 200, { ok: true, dryRun: true, operation, command: redactedCommand(command), sideEffects: "none" });
  }

  const result = await (deps.runCommand ?? runShellCommand)(command, config.operationTimeoutMs);
  await appendAudit(config, { action: "codex-chat.operation.execute", adminEmail, operation, command: redactedCommand(command), status: result.status, signal: result.signal, timedOut: result.timedOut });
  return sendJson(response, result.status === 0 ? 200 : 500, { ok: result.status === 0, operation, status: result.status, signal: result.signal, timedOut: result.timedOut, stdout: redactOutput(result.stdout), stderr: redactOutput(result.stderr) });
}

function operationCommand(config: BrainAdminServiceConfig, operation: "plan" | "restart" | "deploy"): string | undefined {
  if (operation === "deploy") return config.codexChatDeployCommand;
  const restart = config.codexChatRestartCommand || `systemctl --user restart ${shellArg(config.codexChatServiceName)} || sudo systemctl restart ${shellArg(config.codexChatServiceName)}`;
  if (operation === "restart") return restart;
  return [
    `# codex-chat env file: ${shellArg(resolveEnvFilePath(config.codexChatEnvFile))}`,
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

function handlePageAuthFailure(request: IncomingMessage, response: ServerResponse, config: BrainAdminServiceConfig, auth: { statusCode: number; error: string }): void {
  const signInUrl = adminSignInUrlFromRequest(request, config);
  if (auth.statusCode === 401) {
    signInUrl.searchParams.set("redirect_url", adminPublicUrlFromRequest(request, config));
    return redirect(response, 302, signInUrl.toString());
  }
  return sendHtml(response, auth.statusCode, renderBrainAdminDeniedPage(auth.error, signInUrl.toString()));
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
  return command.replace(/(TOKEN|SECRET|KEY|PASSWORD)=([^\s]+)/gi, "$1=<redacted>");
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
