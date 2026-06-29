import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { authorizeBrainAdminRequest, parseAdminAllowedEmails } from "./admin-auth.js";
import { renderBrainAdminDeniedPage, renderBrainAdminPage, renderBrainAdminSignInPage } from "./admin-page.js";
import { createBrainAdminServer, type BrainAdminServiceConfig, type BrainAdminServiceDeps } from "./admin-service.js";
import { mergeEnvFileText } from "./env-file.js";

function config(root: string, overrides: Partial<BrainAdminServiceConfig> = {}): BrainAdminServiceConfig {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    routePath: "/admin",
    publicBaseUrl: "https://brain.example.test",
    clerkPublishableKey: "pk_test_example",
    clerkSecretKey: "sk_test_example",
    clerkAllowedEmails: "tim.galebach@gmail.com",
    instanceName: "test-brain",
    instanceHost: "brain.example.test",
    instanceIp: "203.0.113.10",
    workspacePath: path.join(root, "workspace"),
    assistantAgentLogicPath: path.join(root, "assistant-agent-logic"),
    repoRegistryPath: path.join(root, "repo-registry.yaml"),
    codexChatHost: "brain.example.test",
    codexChatIp: "203.0.113.10",
    codexChatPath: path.join(root, "codex-chat"),
    codexChatEnvFile: path.join(root, "codex-chat.env"),
    codexChatConfigFile: undefined,
    codexHomePath: path.join(root, ".codex"),
    codexChatServiceName: "codex-chat.service",
    codexChatDeployCommand: "echo deploy-ok",
    codexChatRestartCommand: "echo restart-ok",
    brainServiceName: "brain-admin.service",
    auditLogPath: path.join(root, "audit.jsonl"),
    allowedEnvKeys: ["CODEX_CHAT_BASE_URL", "SLACK_BOT_TOKEN"],
    operationTimeoutMs: 5_000,
    slackEventsBaseUrl: "https://brain.decisive-outcomes.com",
    slackEventsPath: "/api/slack/events",
    ...overrides,
  } as BrainAdminServiceConfig;
}

function authDeps(email = "Tim.Galebach@Gmail.com"): BrainAdminServiceDeps {
  return {
    verifyTokenImpl: async () => ({ sub: "user_123" }) as never,
    getUser: async () => ({ primaryEmailAddressId: "email_1", emailAddresses: [{ id: "email_1", emailAddress: email }] }),
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function withServer<T>(cfg: BrainAdminServiceConfig, deps: Parameters<typeof createBrainAdminServer>[1], fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createBrainAdminServer(cfg, deps);
  const baseUrl = await listen(server);
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function authHeaders() {
  return { authorization: "Bearer test-token" };
}

function extractJsonScript(html: string, id: string): unknown {
  const pattern = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`);
  const match = pattern.exec(html);
  assert.ok(match, `missing JSON script #${id}`);
  return JSON.parse(match[1] ?? "");
}


async function writeFileRecursive(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode: 0o755 });
}

test("brain admin auth parses allowlist and fails closed", async () => {
  assert.deepEqual(parseAdminAllowedEmails(" Tim.Galebach@Gmail.com, timgalebachukraine@gmail.com "), new Set(["tim.galebach@gmail.com", "timgalebachukraine@gmail.com"]));

  assert.deepEqual(
    await authorizeBrainAdminRequest({ headers: { authorization: "Bearer token" } } as never, { clerkPublishableKey: "pk", clerkSecretKey: "sk", clerkAllowedEmails: "" }, authDeps()),
    { ok: false, statusCode: 403, error: "admin_allowlist_empty", admin: { userId: "user_123", email: "tim.galebach@gmail.com" } },
  );
  assert.deepEqual(
    await authorizeBrainAdminRequest({ headers: { authorization: "Bearer token" } } as never, { clerkPublishableKey: "", clerkSecretKey: "sk", clerkAllowedEmails: "tim.galebach@gmail.com" }, authDeps()),
    { ok: false, statusCode: 503, error: "admin_auth_not_configured" },
  );
});

test("brain admin page and API require Clerk allowlist auth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-auth-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const noAuth = await fetch(`${baseUrl}/admin`, { redirect: "manual" });
      assert.equal(noAuth.status, 302);
      assert.match(noAuth.headers.get("location") ?? "", /^https:\/\/brain\.example\.test\/admin\/auth\/sign-in\?/);

      const denied = await fetch(`${baseUrl}/api/admin/brain/me`);
      assert.equal(denied.status, 401);

      const ok = await fetch(`${baseUrl}/api/admin/brain/me`, { headers: authHeaders() });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { email: "tim.galebach@gmail.com" });

      const page = await fetch(`${baseUrl}/admin`, { headers: authHeaders() });
      assert.equal(page.status, 200);
      const pageHtml = await page.text();
      assert.match(pageHtml, /tim\.galebach@gmail\.com/);
      assert.match(pageHtml, /Sign out \/ switch account/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin auth failures show signed-in account and switch-account action", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-denied-"));
  try {
    await withServer(config(root), authDeps("other@example.test"), async (baseUrl) => {
      const deniedPage = await fetch(`${baseUrl}/admin`, { headers: authHeaders() });
      assert.equal(deniedPage.status, 403);
      const deniedHtml = await deniedPage.text();
      assert.match(deniedHtml, /other@example\.test/);
      assert.match(deniedHtml, /Sign out/);
      assert.match(deniedHtml, /switch Clerk account/);

      const deniedApi = await fetch(`${baseUrl}/api/admin/brain/me`, { headers: authHeaders() });
      assert.equal(deniedApi.status, 403);
      assert.deepEqual(await deniedApi.json(), { error: "forbidden", email: "other@example.test" });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin auth pages embed parseable JSON config and keep account controls visible", () => {
  const cfg = config("/tmp/brain-admin-sign-in", { clerkPublishableKey: `pk_test_<unsafe>&value` });
  const signInHtml = renderBrainAdminSignInPage(cfg, "https://brain.example.test/admin?next=<unsafe>&ok=1");
  assert.deepEqual(extractJsonScript(signInHtml, "config"), { publishableKey: `pk_test_<unsafe>&value`, redirectUrl: "https://brain.example.test/admin?next=<unsafe>&ok=1" });
  assert.match(signInHtml, /Current Clerk account/);
  assert.match(signInHtml, /Sign out \/ switch account/);
  assert.match(signInHtml, /Continue to admin/);
  assert.match(signInHtml, /\/api\/admin\/brain\/me/);
  assert.match(signInHtml, /brain-admin-auto-continue/);
  assert.match(signInHtml, /Automatic continue already ran once/);
  assert.match(signInHtml, /Checking whether this account is allowlisted/);

  const deniedHtml = renderBrainAdminDeniedPage(cfg, "forbidden", "https://brain.example.test/admin/auth/sign-in", "other@example.test");
  assert.deepEqual(extractJsonScript(deniedHtml, "config"), { publishableKey: `pk_test_<unsafe>&value`, signInUrl: "https://brain.example.test/admin/auth/sign-in" });
  assert.match(deniedHtml, /other@example\.test/);
  assert.match(deniedHtml, /Sign out/);
});

test("brain admin page renders redesigned dashboard IA without secrets", () => {
  const cfg = config("/tmp/brain-admin-render", { codexChatDeployCommand: undefined });
  const html = renderBrainAdminPage(cfg, "tim.galebach@gmail.com");

  assert.deepEqual(extractJsonScript(html, "brain-admin-config"), {
    apiBase: "/api/admin/brain",
    routePath: "/admin",
    publishableKey: "pk_test_example",
    signInUrl: "/admin/auth/sign-in",
    adminEmail: "tim.galebach@gmail.com",
  });
  assert.match(html, /Brain/);
  assert.match(html, /local-brain|test-brain/);
  assert.match(html, /account-menu/);
  assert.match(html, /tim\.galebach@gmail\.com/);
  assert.match(html, /Sign out \/ switch account/);
  assert.match(html, /Overview/);
  assert.match(html, /State-aware operator console/);
  assert.match(html, /Slack setup wizard/);
  assert.match(html, /id="slack-attention"/);
  assert.match(html, /Slack setup needs attention/);
  assert.match(html, /Slack setup is incomplete/);
  assert.match(html, /Continue Slack setup/);
  assert.match(html, /Skip Slack for now/);
  assert.match(html, /Missing required setting/);
  assert.match(html, /Mission Control/);
  assert.match(html, /OpenRouter/);
  assert.match(html, /OpenRouter subagent model settings/);
  assert.match(html, /Review & write OpenRouter settings/);
  assert.match(html, /Confirm OpenRouter settings write/);
  assert.match(html, /Slack Details/);
  assert.match(html, /Manifest/);
  assert.match(html, /Runtime Config/);
  assert.match(html, /Env &amp; Config/);
  assert.match(html, /Deploy \/ Restart/);
  assert.match(html, /Audit Log/);
  assert.match(html, /Audit \/ Feedback/);
  assert.match(html, /Advanced/);
  assert.match(html, /Slack setup wizard/);
  assert.match(html, /Slack setup wizard state/);
  assert.match(html, /Configure Event Subscriptions inside Slack/);
  assert.match(html, /https:\/\/brain\.decisive-outcomes\.com\/api\/slack\/events/);
  assert.match(html, /no trailing slash/);
  assert.match(html, /I configured this inside Slack, not only in Brain/);
  assert.match(html, /Finish \/ record install metadata/);
  assert.match(html, /Required settings/);
  assert.match(html, /Public routing/);
  assert.match(html, /Slack credentials/);
  assert.match(html, /Feature flags/);
  assert.match(html, /required_missing/);
  assert.match(html, /leave blank to keep existing value/);
  assert.match(html, /View manifest JSON/);
  assert.match(html, /Draft only — codex-chat remains source of truth/);
  assert.match(html, /Confirm live operation/);
  assert.match(html, /Review & confirm/);
  assert.match(html, /Confirm Slack settings write/);
  assert.match(html, /Review & write Slack settings/);
  assert.match(html, /writes codex-chat runtime env to disk/i);
  assert.equal(html.includes('id="op-approval"'), false);
  assert.equal(html.includes('id="slack-approval"'), false);
  assert.equal(html.includes('Type exactly: write Slack settings'), false);
  assert.equal(html.includes("xoxb-super-secret"), false);
  assert.equal(html.includes("signing-secret"), false);
});

test("brain admin settings identify the concrete local instance separately from repo registry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-settings-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const settings = await fetch(`${baseUrl}/api/admin/brain/settings`, { headers: authHeaders() });
      assert.equal(settings.status, 200);
      const payload = await settings.json() as {
        instance: { project: string; host: string; ip: string; repoRegistrySourceOfTruth: boolean };
        repoRegistry: { sourceOfTruth: boolean; role: string };
        codexChat: { host: string; ip: string; path: string; serviceName: string; env: { allowedKeys: string[] }; operationCommands: Record<string, { configured: boolean; command: string | null }> };
      };
      assert.equal(payload.instance.project, "Brain");
      assert.equal(payload.instance.host, "brain.example.test");
      assert.equal(payload.instance.ip, "203.0.113.10");
      assert.equal(payload.instance.repoRegistrySourceOfTruth, false);
      assert.equal(payload.repoRegistry.sourceOfTruth, false);
      assert.match(payload.repoRegistry.role, /read-only context/);
      assert.equal(payload.codexChat.host, "brain.example.test");
      assert.equal(payload.codexChat.ip, "203.0.113.10");
      assert.equal(payload.codexChat.serviceName, "codex-chat.service");
      assert.equal(payload.codexChat.path, path.join(root, "codex-chat"));
      assert.ok(!payload.codexChat.env.allowedKeys.includes("CODEX_CHAT_ADMIN_ENABLED"));
      assert.ok(!payload.codexChat.env.allowedKeys.includes("CLERK_SECRET_KEY"));
      assert.equal(payload.codexChat.operationCommands.restart.configured, true);
      assert.match(payload.codexChat.operationCommands.restart.command ?? "", /echo restart-ok/);
      assert.equal(payload.codexChat.operationCommands.deploy.configured, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin env API writes allowlisted keys as write-only presence metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-env-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const forbidden = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ approval: "write env", entries: { NOT_ALLOWED: "x" } }),
      });
      assert.equal(forbidden.status, 403);

      const write = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ approval: "write env", entries: { SLACK_BOT_TOKEN: "xoxb-super-secret", CODEX_CHAT_BASE_URL: "https://brain.example.test" } }),
      });
      assert.equal(write.status, 200);
      const payload = await write.json() as { writtenKeys: string[]; values: string; presence: Record<string, boolean> };
      assert.deepEqual(payload.writtenKeys.sort(), ["CODEX_CHAT_BASE_URL", "SLACK_BOT_TOKEN"]);
      assert.equal(payload.values, "write-only");
      assert.equal(JSON.stringify(payload).includes("xoxb-super-secret"), false);
      assert.deepEqual(payload.presence, { SLACK_BOT_TOKEN: true, CODEX_CHAT_BASE_URL: true });

      const fileText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.match(fileText, /SLACK_BOT_TOKEN='xoxb-super-secret'/);
      assert.equal((await stat(path.join(root, "codex-chat.env"))).mode & 0o777, 0o600);

      const summary = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, { headers: authHeaders() });
      assert.equal(summary.status, 200);
      const summaryPayload = await summary.json() as { keys: Array<{ key: string; value: string | null; secret: boolean }> };
      assert.ok(summaryPayload.keys.some((entry) => entry.key === "SLACK_BOT_TOKEN" && entry.secret && entry.value === "redacted"));
      assert.equal(JSON.stringify(summaryPayload).includes("xoxb-super-secret"), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("brain admin OpenRouter settings write env, codex profile, and codex-chat config without echoing the key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-openrouter-"));
  try {
    const cfg = config(root, { codexChatConfigFile: path.join(root, "codex-chat", "config", "codex-chat.toml") });
    await mkdir(path.dirname(cfg.codexChatConfigFile ?? ""), { recursive: true });
    await writeFile(cfg.codexChatConfigFile ?? "", "version = 1\n\n[subagents]\ndefaultEffort = \"medium\"\n");
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const settings = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, { headers: authHeaders() });
      assert.equal(settings.status, 200);
      const summary = await settings.json() as { env: { envFile: string }; codexProfile: { path: string } };

      const entries = {
        apiKey: "sk-or-super-secret",
        model: "anthropic/claude-sonnet-4.5",
        codexProfile: "openrouter",
        modelProvider: "openrouter",
        serviceTierMode: "omit",
        backend: "codex_app_server"
      };
      const keys = [
        "OPENROUTER_API_KEY",
        "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL",
        "CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE",
        "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER",
        "CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE",
        "CODEX_CHAT_SUBAGENTS_ALLOW_PROVIDER_OVERRIDE",
        "CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES",
        "CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS",
        "CODEX_CHAT_SUBAGENTS_BACKEND"
      ];
      const missingConfirmation = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(entries),
      });
      assert.equal(missingConfirmation.status, 400);

      const write = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ ...entries, confirmation: { token: "brain-admin-openrouter-settings-confirmed-v1", action: "openrouter.settings.write", envFile: summary.env.envFile, profilePath: summary.codexProfile.path, keys } }),
      });
      assert.equal(write.status, 200);
      const payload = await write.json() as { writtenKeys: string[]; values: string; profilePath: string; apiKeyPresent: boolean };
      assert.deepEqual(payload.writtenKeys, keys);
      assert.equal(payload.values, "write-only");
      assert.equal(payload.apiKeyPresent, true);
      assert.equal(JSON.stringify(payload).includes("sk-or-super-secret"), false);

      const envText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.match(envText, /OPENROUTER_API_KEY='sk-or-super-secret'/);
      assert.match(envText, /CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL='anthropic\/claude-sonnet-4\.5'/);
      const profileText = await readFile(payload.profilePath, "utf8");
      assert.match(profileText, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
      assert.match(profileText, /env_key = "OPENROUTER_API_KEY"/);
      assert.equal(profileText.includes("sk-or-super-secret"), false);
      const configText = await readFile(cfg.codexChatConfigFile ?? "", "utf8");
      assert.match(configText, /defaultCodexProfile = "openrouter"/);
      assert.match(configText, /defaultModelProvider = "openrouter"/);
      assert.match(configText, /serviceTierMode = "omit"/);
      assert.match(configText, /allowedCodexProfiles = \["openrouter"\]/);
      assert.match(configText, /backend = "codex_app_server"/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin operation API keeps plan low-friction and requires explicit live confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-op-"));
  const calls: string[] = [];
  try {
    await withServer(config(root), {
      ...(authDeps()),
      runCommand: async (command) => {
        calls.push(command);
        return { status: 0, signal: null, stdout: "restart-ok\n", stderr: "", timedOut: false };
      },
    }, async (baseUrl) => {
      const missingConfirmation = await fetch(`${baseUrl}/api/admin/brain/codex-chat/operation`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ operation: "restart" }),
      });
      assert.equal(missingConfirmation.status, 400);
      assert.deepEqual(await missingConfirmation.json(), {
        error: "confirmation_required",
        required: { token: "brain-admin-live-operation-confirmed-v1", operation: "restart", serviceName: "codex-chat.service" },
      });

      const plan = await fetch(`${baseUrl}/api/admin/brain/codex-chat/operation`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ operation: "plan" }),
      });
      assert.equal(plan.status, 200);
      const planPayload = await plan.json() as { dryRun: boolean; command: string };
      assert.equal(planPayload.dryRun, true);
      assert.match(planPayload.command, /codex-chat path:/);
      assert.match(planPayload.command, /brain\.example\.test/);
      assert.deepEqual(calls, []);

      const restart = await fetch(`${baseUrl}/api/admin/brain/codex-chat/operation`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ operation: "restart", confirmation: { token: "brain-admin-live-operation-confirmed-v1", operation: "restart", serviceName: "codex-chat.service", freshPlan: true } }),
      });
      assert.equal(restart.status, 200);
      assert.deepEqual(calls, ["echo restart-ok"]);
      const audit = await readFile(path.join(root, "audit.jsonl"), "utf8");
      assert.match(audit, /codex-chat\.operation\.execute/);
      assert.equal(audit.includes("secretValuesLogged\":false"), true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("env merge preserves unrelated lines and quotes safely", () => {
  const merged = mergeEnvFileText("# keep\nFOO=bar\nSLACK_BOT_TOKEN=old\n", { SLACK_BOT_TOKEN: "xoxb-new value", CODEX_CHAT_BASE_URL: "it's fine" });
  assert.match(merged, /# keep\nFOO=bar/);
  assert.match(merged, /SLACK_BOT_TOKEN='xoxb-new value'/);
  assert.match(merged, /CODEX_CHAT_BASE_URL='it'"'"'s fine'/);
});

test("brain admin exposes explicit Slack settings as write-only presence metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-slack-settings-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const settings = await fetch(`${baseUrl}/api/admin/brain/slack/settings`, { headers: authHeaders() });
      assert.equal(settings.status, 200);
      const settingsPayload = await settings.json() as { publicEventsUrl: string; env: { allowedKeys: string[]; keys: Array<{ key: string; present: boolean; value: string | null }> } };
      assert.equal(settingsPayload.publicEventsUrl, "https://brain.decisive-outcomes.com/api/slack/events");
      assert.ok(settingsPayload.env.allowedKeys.includes("SLACK_SIGNING_SECRET"));
      assert.ok(settingsPayload.env.allowedKeys.includes("SLACK_APP_TOKEN"));

      const entries = { SLACK_SIGNING_SECRET: "signing-secret", SLACK_BOT_TOKEN: "xoxb-super-secret", CODEX_CHAT_BASE_URL: "https://brain.decisive-outcomes.com" };
      const missingConfirmation = await fetch(`${baseUrl}/api/admin/brain/slack/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      assert.equal(missingConfirmation.status, 400);
      assert.deepEqual(await missingConfirmation.json(), {
        error: "confirmation_required",
        required: { token: "brain-admin-slack-settings-confirmed-v1", action: "slack.settings.write", envFile: path.join(root, "codex-chat.env"), keys: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "CODEX_CHAT_BASE_URL"] },
      });

      const legacyApprovalOnly = await fetch(`${baseUrl}/api/admin/brain/slack/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ approval: "write Slack settings", entries }),
      });
      assert.equal(legacyApprovalOnly.status, 400);

      const write = await fetch(`${baseUrl}/api/admin/brain/slack/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ entries, confirmation: { token: "brain-admin-slack-settings-confirmed-v1", action: "slack.settings.write", envFile: path.join(root, "codex-chat.env"), keys: Object.keys(entries) } }),
      });
      assert.equal(write.status, 200);
      const payload = await write.json() as { writtenKeys: string[]; values: string; presence: Record<string, boolean> };
      assert.deepEqual(payload.writtenKeys.sort(), ["CODEX_CHAT_BASE_URL", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]);
      assert.equal(payload.values, "write-only");
      assert.equal(JSON.stringify(payload).includes("xoxb-super-secret"), false);
      assert.equal(payload.presence.SLACK_BOT_TOKEN, true);

      const fileText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.match(fileText, /SLACK_SIGNING_SECRET='signing-secret'/);
      assert.match(fileText, /CODEX_CHAT_BASE_URL='https:\/\/brain\.decisive-outcomes\.com'/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin renders Slack manifest through the codex-chat script with Brain Events URL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-slack-manifest-"));
  try {
    const script = path.join(root, "codex-chat", "slack-app", "scripts", "render-manifest.mjs");
    await writeFileRecursive(script, `#!/usr/bin/env node
const args = process.argv.slice(2);
const baseUrl = args[args.indexOf('--base-url') + 1];
const eventsPath = args[args.indexOf('--events-path') + 1];
process.stdout.write(JSON.stringify({ settings: { event_subscriptions: { request_url: baseUrl + eventsPath } } }, null, 2) + '\\n');
`);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const manifest = await fetch(`${baseUrl}/api/admin/brain/slack/manifest`, { headers: authHeaders() });
      assert.equal(manifest.status, 200);
      const payload = await manifest.json() as { requestUrl: string; text: string; renderer: string };
      assert.equal(payload.requestUrl, "https://brain.decisive-outcomes.com/api/slack/events");
      assert.equal(payload.renderer, script);
      assert.match(payload.text, /brain\.decisive-outcomes\.com\/api\/slack\/events/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
