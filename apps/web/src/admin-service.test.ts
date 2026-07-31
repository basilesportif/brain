import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { authorizeBrainAdminRequest, parseAdminAllowedEmails } from "./admin-auth.js";
import { ADMIN_SPA_ROUTE_PATH, ADMIN_V2_REDIRECT_ROUTE_PATH } from "./admin-routes.js";
import { createBrainAdminServer, initializeBrainAdminCapabilityStore, loadBrainAdminServiceConfig, readFileTail, type BrainAdminServiceConfig, type BrainAdminServiceDeps } from "./admin-service.js";
import { fakeIpcToken, startFakeCodexChatIpc, type FakeCodexChatIpcServer } from "./codex-chat-ipc.test-helpers.js";
import { mergeEnvFileText } from "./env-file.js";
import { LIVE_CAPABILITY_STORE_JSON } from "./capability-store.fixture.js";
import { evaluateAuthorization, parseCapabilityStore } from "./capability-store.js";
import { assertValidStore, CapabilityWriteError, commitMutation, effectiveCapabilityAdmins, migrateCapabilityStore, planMigration } from "./capability-store-write.js";

const TEST_ADMIN_EMAIL = "tim@example.com";
const SECOND_ADMIN_EMAIL = "tim-ukraine@example.com";
const OTHER_ADMIN_EMAIL = "other@example.com";
const FAKE_SLACK_BOT_TOKEN = ["xoxb", "super", "secret"].join("-");
const FAKE_SLACK_BOT_TOKEN_WITH_SPACE = ["xoxb", "new value"].join("-");
const FAKE_SLACK_SIGNING_SECRET = ["signing", "secret"].join("-");
const FAKE_OPENROUTER_API_KEY = ["sk", "or", "super", "secret"].join("-");
const FAKE_CUSTOM_API_TOKEN = ["custom", "api", "secret"].join("-");

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

function config(root: string, overrides: Partial<BrainAdminServiceConfig> = {}): BrainAdminServiceConfig {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    routePath: ADMIN_SPA_ROUTE_PATH,
    publicBaseUrl: "https://brain.example.test",
    clerkPublishableKey: ["pk", "test", "example"].join("_"),
    clerkSecretKey: ["sk", "test", "example"].join("_"),
    clerkAllowedEmails: TEST_ADMIN_EMAIL,
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
    codexChatIpcSocket: path.join(root, "codex-chat", "data", "run", "codex-chat.sock"),
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
    slackAppId: undefined,
    slackSetupStatePath: path.join(root, "slack-setup.json"),
    capabilityStorePath: path.join(root, "capabilities.json"),
    capabilityAuditLogPath: path.join(root, "capability-audit.jsonl"),
    capabilityDecisionsDir: path.join(root, "codex-chat", "data", "state", "capability_decisions"),
    adminUiDir: path.join(root, "ui-dist"),
    ...overrides,
  } as BrainAdminServiceConfig;
}

function authDeps(email = "Tim@Example.Com"): BrainAdminServiceDeps {
  return {
    verifyTokenImpl: async () => ({ sub: "user_123" }) as never,
    getUser: async () => ({ primaryEmailAddressId: "email_1", emailAddresses: [{ id: "email_1", emailAddress: email }] }),
  };
}

test("brain admin derives its default audit log beside the configured capability store", () => {
  const capabilityStorePath = "/home/brain/.brain/control-plane/capabilities.json";
  const loaded = loadBrainAdminServiceConfig({ BRAIN_CAPABILITY_STORE_PATH: capabilityStorePath });
  assert.equal(loaded.capabilityStorePath, capabilityStorePath);
  assert.equal(loaded.auditLogPath, "/home/brain/.brain/control-plane/audit.jsonl");
  assert.equal(loaded.capabilityAuditLogPath, "/home/brain/.brain/control-plane/capability-audit.jsonl");
  assert.doesNotMatch(loaded.auditLogPath, /\/home\/tim/);
});

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

function envWritePayload(cfg: BrainAdminServiceConfig, entries: Record<string, string>): Record<string, unknown> {
  return {
    entries,
    confirmation: {
      token: "brain-admin-codex-chat-env-confirmed-v1",
      action: "codex-chat.env.write",
      envFile: cfg.codexChatEnvFile,
      keys: Object.keys(entries),
    },
  };
}

function openRouterProfilePath(summary: { profilePath: string; profileTargets?: Array<{ codexProfile: string; profilePath: string }> }, profile: string): string {
  const target = summary.profileTargets?.find((entry) => entry.codexProfile === profile);
  assert.ok(target, `missing server-provided profile path for ${profile}`);
  return target.profilePath;
}

async function writeFileRecursive(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode: 0o755 });
}

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const originalWarn = console.warn;
  const originalError = console.error;
  const chunks: string[] = [];
  const capture = (...args: unknown[]) => {
    chunks.push(args.map(formatConsoleArg).join(" "));
  };
  console.warn = capture;
  console.error = capture;
  try {
    return { result: await fn(), output: chunks.join("\n") };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

test("brain admin auth parses allowlist and fails closed", async () => {
  assert.deepEqual(parseAdminAllowedEmails(` Tim@Example.Com, ${SECOND_ADMIN_EMAIL} `), new Set([TEST_ADMIN_EMAIL, SECOND_ADMIN_EMAIL]));

  assert.deepEqual(
    await authorizeBrainAdminRequest({ headers: { authorization: "Bearer token" } } as never, { clerkPublishableKey: "pk", clerkSecretKey: "sk", clerkAllowedEmails: "" }, authDeps()),
    { ok: false, statusCode: 403, error: "admin_allowlist_empty", admin: { userId: "user_123", email: TEST_ADMIN_EMAIL } },
  );
  assert.deepEqual(
    await authorizeBrainAdminRequest({ headers: { authorization: "Bearer token" } } as never, { clerkPublishableKey: "", clerkSecretKey: "sk", clerkAllowedEmails: TEST_ADMIN_EMAIL }, authDeps()),
    { ok: false, statusCode: 503, error: "admin_auth_not_configured" },
  );
});

test("brain admin config derives and overrides the codex-chat IPC socket path", () => {
  const codexChatPath = path.join("/srv", "codex-chat");
  const derived = loadBrainAdminServiceConfig({ BRAIN_CODEX_CHAT_PATH: codexChatPath } as NodeJS.ProcessEnv);
  assert.equal(derived.codexChatIpcSocket, path.join(codexChatPath, "data", "run", "codex-chat.sock"));
  assert.equal(derived.routePath, "/admin");

  const override = path.join("/tmp", "synthetic-codex-chat.sock");
  const explicit = loadBrainAdminServiceConfig({ BRAIN_CODEX_CHAT_PATH: codexChatPath, BRAIN_CODEX_CHAT_IPC_SOCKET: override } as NodeJS.ProcessEnv);
  assert.equal(explicit.codexChatIpcSocket, override);

  const customRoutes = loadBrainAdminServiceConfig({ BRAIN_ADMIN_ROUTE_PATH: "ops/admin", BRAIN_SLACK_EVENTS_PATH: "   " } as NodeJS.ProcessEnv);
  assert.equal(customRoutes.routePath, "/ops/admin");
  assert.equal(customRoutes.slackEventsPath, "/api/slack/events");
});

test("brain admin startup normalizes stale grants to enforcing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-cap-startup-"));
  try {
    const cfg = config(root);
    const staleStore = JSON.parse(LIVE_CAPABILITY_STORE_JSON) as { grants: Array<Record<string, unknown>> };
    staleStore.grants = staleStore.grants.map((grant) => ({ ...grant, enforcement: "non_enforcing" }));
    const planned = planMigration(staleStore as never).changes;
    await writeFile(cfg.capabilityStorePath, `${JSON.stringify(staleStore, null, 2)}\n`);

    await initializeBrainAdminCapabilityStore(cfg);

    const normalized = JSON.parse(await readFile(cfg.capabilityStorePath, "utf8")) as { grants: Array<{ enforcement?: string }> };
    assert.ok(normalized.grants.length > 0);
    assert.equal(normalized.grants.every((grant) => grant.enforcement === "enforcing"), true);
    await stat(`${cfg.capabilityStorePath}.lkg.json`);
    const audit = (await readFile(cfg.capabilityAuditLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "capability.store.startup_normalized");
    assert.deepEqual(audit[0].convertedGrantIds, planned.convertedGrantIds);
    assert.deepEqual(audit[0].enforcementTransitions, planned.enforcementTransitions);

    const bytesAfterFirstStartup = await readFile(cfg.capabilityStorePath);
    const backupsAfterFirstStartup = (await readdir(root)).filter((name) => name.startsWith("capabilities.json.") && name.endsWith(".bak")).sort();
    await initializeBrainAdminCapabilityStore(cfg);
    assert.ok(bytesAfterFirstStartup.equals(await readFile(cfg.capabilityStorePath)), "second startup must not rewrite an already-normalized store");
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("capabilities.json.") && name.endsWith(".bak")).sort(), backupsAfterFirstStartup);
    assert.equal((await readFile(cfg.capabilityAuditLogPath, "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin startup keeps serving when the capability store is invalid", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-cap-invalid-"));
  try {
    const cfg = config(root);
    await writeFile(cfg.capabilityStorePath, "{not valid json\n");
    const before = await readFile(cfg.capabilityStorePath);
    const { output } = await captureConsole(() => initializeBrainAdminCapabilityStore(cfg));
    assert.match(output, /capability.store.startup_init_failed/);
    assert.ok(before.equals(await readFile(cfg.capabilityStorePath)), "invalid store must be byte-identical after startup init failure");
    await assert.rejects(() => stat(`${cfg.capabilityStorePath}.lkg.json`), { code: "ENOENT" });

    await withServer(cfg, authDeps(), async (baseUrl) => {
      const health = await fetch(`${baseUrl}/healthz`);
      assert.equal(health.status, 200);
      const users = await fetch(`${baseUrl}/api/admin/brain/users`, { headers: authHeaders() });
      assert.equal(users.status, 503);
      assert.deepEqual(await users.json(), { error: "capability_store_unavailable", reason: "brain_store_unavailable" });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin startup seeds a missing capability store from the first allowed admin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-cap-seed-"));
  try {
    const cfg = config(root, { clerkAllowedEmails: ` ${SECOND_ADMIN_EMAIL}, ${TEST_ADMIN_EMAIL} ` });
    await initializeBrainAdminCapabilityStore(cfg);
    const store = JSON.parse(await readFile(cfg.capabilityStorePath, "utf8")) as {
      people: Array<{ id: string; primarySubjectId: string; identityIds: string[] }>;
      externalIdentities: Array<{ provider: string; providerUserId: string; personId: string; status: string }>;
      subjects: Array<{ id: string; personId: string; status: string }>;
      grants: Array<{ subjectId: string; capabilityId: string; enforcement: string; status: string }>;
    };
    assert.equal(store.people.length, 1);
    assert.equal(store.people[0].id.startsWith("person_admin_"), true);
    assert.equal(store.people[0].id, store.externalIdentities[0].personId);
    assert.deepEqual(store.externalIdentities.map((identity) => identity.provider), ["clerk"]);
    assert.deepEqual(store.externalIdentities.map((identity) => identity.providerUserId), [SECOND_ADMIN_EMAIL]);
    assert.equal(store.subjects.length, 1);
    assert.equal(store.subjects[0].id, store.people[0].primarySubjectId);
    assert.equal(store.grants.every((grant) => grant.status === "active" && grant.enforcement === "enforcing"), true);
    assert.equal(JSON.stringify(store).includes("person_tim"), false);
    assert.equal(JSON.stringify(store).includes("T00000000"), false);
    await stat(`${cfg.capabilityStorePath}.lkg.json`);

    await withServer(cfg, authDeps(SECOND_ADMIN_EMAIL), async (baseUrl) => {
      const check = await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", {
        subjectId: store.people[0].primarySubjectId,
        operation: "capability.catalog.read",
        resource: {},
      });
      assert.equal(check.status, 200);
      assert.equal(check.payload.allowed, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin startup creates an empty missing capability store without an allowlist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-cap-seed-empty-"));
  try {
    const cfg = config(root, { clerkAllowedEmails: "" });
    const { output } = await captureConsole(() => initializeBrainAdminCapabilityStore(cfg));
    assert.match(output, /capability.store.seeded_empty/);
    const store = JSON.parse(await readFile(cfg.capabilityStorePath, "utf8")) as { people: unknown[]; externalIdentities: unknown[]; subjects: unknown[]; grants: unknown[] };
    assert.deepEqual(store.people, []);
    assert.deepEqual(store.externalIdentities, []);
    assert.deepEqual(store.subjects, []);
    assert.deepEqual(store.grants, []);
    await stat(`${cfg.capabilityStorePath}.lkg.json`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin startup normalizes a zero-admin store without treating it as self-lockout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-cap-zero-admin-"));
  try {
    const cfg = config(root);
    await writeJson(cfg.capabilityStorePath, {
      schemaVersion: 2,
      people: [],
      externalIdentities: [],
      subjects: [{ id: "person:orphan", kind: "person", status: "active" }],
      grants: [{ id: "g_orphan", subjectId: "person:orphan", capabilityId: "projects.read", grantKind: "capability", resource: { selectors: {} }, actions: ["read"], status: "active", enforcement: "non_enforcing" }],
    });
    await initializeBrainAdminCapabilityStore(cfg);
    const store = parseCapabilityStore(await readFile(cfg.capabilityStorePath, "utf8"));
    assert.equal(store.grants?.find((grant) => grant.id === "g_orphan")?.enforcement, "enforcing");
    assert.deepEqual(
      (store.grants ?? []).filter((grant) => typeof grant.source === "object" && grant.source?.kind === "startup_seed").map((grant) => grant.capabilityId).sort(),
      ["audit.capability.read", "capability.catalog.read", "capability.grant.propose"],
    );
    assert.equal(effectiveCapabilityAdmins(store).size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin API requires Clerk allowlist auth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-auth-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/api/admin/brain/me`);
      assert.equal(denied.status, 401);

      const ok = await fetch(`${baseUrl}/api/admin/brain/me`, { headers: authHeaders() });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { email: TEST_ADMIN_EMAIL });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin API auth failures include the signed-in forbidden account", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-denied-"));
  try {
    await withServer(config(root), authDeps(OTHER_ADMIN_EMAIL), async (baseUrl) => {
      const deniedApi = await fetch(`${baseUrl}/api/admin/brain/me`, { headers: authHeaders() });
      assert.equal(deniedApi.status, 403);
      assert.deepEqual(await deniedApi.json(), { error: "forbidden", email: OTHER_ADMIN_EMAIL });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("brain admin settings report live capability enforcement posture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-settings-capabilities-"));
  try {
    const cfg = config(root, { codexChatConfigFile: path.join(root, "codex-chat", "config", "codex-chat.toml") });
    await writeJson(path.join(root, "capabilities.json"), validCapabilityStore());
    await mkdir(path.dirname(cfg.codexChatConfigFile ?? ""), { recursive: true });
    await writeFile(cfg.codexChatConfigFile ?? "", "version = 1\n\n[brain]\nenforcementEnabled = true\n");
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const settings = await fetch(`${baseUrl}/api/admin/brain/settings`, { headers: authHeaders() });
      assert.equal(settings.status, 200);
      const payload = await settings.json() as {
        capabilities: { writesEnabled: boolean; enforcementEnabled: boolean; storePresent: boolean; storeValid: boolean; role: string };
      };
      assert.equal(payload.capabilities.writesEnabled, true);
      assert.equal(payload.capabilities.enforcementEnabled, true);
      assert.equal(payload.capabilities.storePresent, true);
      assert.equal(payload.capabilities.storeValid, true);
      assert.match(payload.capabilities.role, /live enforced/);
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
        body: JSON.stringify({ approval: "write env", entries: { SLACK_BOT_TOKEN: FAKE_SLACK_BOT_TOKEN, CODEX_CHAT_BASE_URL: "https://brain.example.test" } }),
      });
      assert.equal(write.status, 200);
      const payload = await write.json() as { writtenKeys: string[]; values: string; presence: Record<string, boolean> };
      assert.deepEqual(payload.writtenKeys.sort(), ["CODEX_CHAT_BASE_URL", "SLACK_BOT_TOKEN"]);
      assert.equal(payload.values, "write-only");
      assert.equal(JSON.stringify(payload).includes(FAKE_SLACK_BOT_TOKEN), false);
      assert.deepEqual(payload.presence, { SLACK_BOT_TOKEN: true, CODEX_CHAT_BASE_URL: true });

      const fileText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.equal(fileText.includes(`SLACK_BOT_TOKEN='${FAKE_SLACK_BOT_TOKEN}'`), true);
      assert.equal((await stat(path.join(root, "codex-chat.env"))).mode & 0o777, 0o600);

      const summary = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, { headers: authHeaders() });
      assert.equal(summary.status, 200);
      const summaryPayload = await summary.json() as { keys: Array<{ key: string; value: string | null; secret: boolean }> };
      assert.ok(summaryPayload.keys.some((entry) => entry.key === "SLACK_BOT_TOKEN" && entry.secret && entry.value === "redacted"));
      assert.equal(JSON.stringify(summaryPayload).includes(FAKE_SLACK_BOT_TOKEN), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin env write handlers persist through codex-chat IPC", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-ipc-handlers-"));
  const fakeBotToken = ["xoxb", "synthetic", "bot"].join("-");
  const fakeSigningSecret = ["signing", "synthetic", "secret"].join("-");
  const fakeOpenRouterKey = ["sk", "or", "synthetic"].join("-");
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    const cfg = config(root);
    ipc = await startFakeCodexChatIpc(root, { persistEnvFile: cfg.codexChatEnvFile });
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const mainSummaryResponse = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, { headers: authHeaders() });
      assert.equal(mainSummaryResponse.status, 200);
      const mainSummary = await mainSummaryResponse.json() as { env: { envFile: string }; confirmationKeys: string[] };
      const mainWrite = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          preset: "openrouter-glm-5.2",
          confirmation: {
            token: "brain-admin-main-loop-model-confirmed-v2",
            action: "codex-chat.main-loop-model.write",
            envFile: mainSummary.env.envFile,
            preset: "openrouter-glm-5.2",
            keys: mainSummary.confirmationKeys,
          },
        }),
      });
      assert.equal(mainWrite.status, 200);
      assert.equal((await mainWrite.json() as { configWritePath: string }).configWritePath, "ipc");

      const openRouterSummaryResponse = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, { headers: authHeaders() });
      assert.equal(openRouterSummaryResponse.status, 200);
      const openRouterSummary = await openRouterSummaryResponse.json() as { env: { envFile: string }; profilePath: string; confirmationKeys: string[] };
      const openRouterWrite = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: fakeOpenRouterKey,
          model: "anthropic/claude-sonnet-4.5",
          codexProfile: "openrouter",
          modelProvider: "openrouter",
          serviceTierMode: "omit",
          backend: "codex_app_server",
          confirmation: {
            token: "brain-admin-openrouter-settings-confirmed-v1",
            action: "openrouter.settings.write",
            envFile: openRouterSummary.env.envFile,
            codexProfile: "openrouter",
            profilePath: openRouterProfilePath(openRouterSummary, "openrouter"),
            keys: openRouterSummary.confirmationKeys,
          },
        }),
      });
      assert.equal(openRouterWrite.status, 200);
      assert.equal((await openRouterWrite.json() as { configWritePath: string }).configWritePath, "ipc");

      const envWrite = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(envWritePayload(cfg, { CODEX_CHAT_BASE_URL: "https://brain.example.com", SLACK_BOT_TOKEN: fakeBotToken })),
      });
      assert.equal(envWrite.status, 200);
      const envPayload = await envWrite.json() as { configWritePath: string; presence: Record<string, boolean> };
      assert.equal(envPayload.configWritePath, "ipc");
      assert.deepEqual(envPayload.presence, { CODEX_CHAT_BASE_URL: true, SLACK_BOT_TOKEN: true });

      const slackEntries = { SLACK_SIGNING_SECRET: fakeSigningSecret, SLACK_BOT_TOKEN: fakeBotToken, CODEX_CHAT_BASE_URL: "https://brain.example.com" };
      const slackWrite = await fetch(`${baseUrl}/api/admin/brain/slack/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          entries: slackEntries,
          confirmation: {
            token: "brain-admin-slack-settings-confirmed-v1",
            action: "slack.settings.write",
            envFile: cfg.codexChatEnvFile,
            keys: Object.keys(slackEntries),
          },
        }),
      });
      assert.equal(slackWrite.status, 200);
      assert.equal((await slackWrite.json() as { configWritePath: string }).configWritePath, "ipc");

      assert.equal(ipc?.requests.length, 4);
      assert.deepEqual(ipc?.requests.map((request) => request.type), ["set_config", "set_config", "set_config", "set_config"]);
      assert.equal(ipc?.requests.some((request) => request.brainSubjectIdPresent), false);
      assert.ok(ipc?.requests.some((request) => request.keys.includes("OPENROUTER_API_KEY")));
      const envText = await readFile(cfg.codexChatEnvFile, "utf8");
      assert.match(envText, /CODEX_CHAT_BASE_URL='https:\/\/brain\.example\.com'/);
      assert.match(envText, /OPENROUTER_API_KEY=/);
      assert.equal(JSON.stringify({ envPayload }).includes(fakeBotToken), false);
      assert.equal(JSON.stringify({ envPayload }).includes(fakeOpenRouterKey), false);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin derives IPC response presence from submitted entries, not the fallback env file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-ipc-presence-"));
  const fakeBotToken = ["xoxb", "synthetic", "presence"].join("-");
  const fakeOpenRouterKey = ["sk", "or", "presence"].join("-");
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    const cfg = config(root);
    ipc = await startFakeCodexChatIpc(root);
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const envWrite = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(envWritePayload(cfg, { CODEX_CHAT_BASE_URL: "https://brain.example.com", SLACK_BOT_TOKEN: fakeBotToken })),
      });
      assert.equal(envWrite.status, 200);
      const envPayload = await envWrite.json() as { configWritePath: string; presence: Record<string, boolean> };
      assert.equal(envPayload.configWritePath, "ipc");
      assert.deepEqual(envPayload.presence, { CODEX_CHAT_BASE_URL: true, SLACK_BOT_TOKEN: true });

      const settings = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, { headers: authHeaders() });
      const summary = await settings.json() as { env: { envFile: string }; profilePath: string; confirmationKeys: string[] };
      const openRouterWrite = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: fakeOpenRouterKey,
          model: "anthropic/claude-sonnet-4.5",
          codexProfile: "openrouter",
          modelProvider: "openrouter",
          serviceTierMode: "omit",
          confirmation: {
            token: "brain-admin-openrouter-settings-confirmed-v1",
            action: "openrouter.settings.write",
            envFile: summary.env.envFile,
            codexProfile: "openrouter",
            profilePath: openRouterProfilePath(summary, "openrouter"),
            keys: summary.confirmationKeys,
          },
        }),
      });
      assert.equal(openRouterWrite.status, 200);
      const openRouterPayload = await openRouterWrite.json() as { apiKeyPresent: boolean; presence: Record<string, boolean> };
      assert.equal(openRouterPayload.apiKeyPresent, true);
      assert.equal(openRouterPayload.presence.OPENROUTER_API_KEY, true);
      assert.equal(JSON.stringify(openRouterPayload).includes(fakeOpenRouterKey), false);
    });
    await assert.rejects(stat(cfg.codexChatEnvFile), { code: "ENOENT" });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin maps codex-chat IPC field errors to validation errors without fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-ipc-field-errors-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    const cfg = config(root);
    await writeFile(cfg.codexChatEnvFile, "CODEX_CHAT_BASE_URL='https://old.example.com'\n", { mode: 0o600 });
    ipc = await startFakeCodexChatIpc(root, { fieldErrors: { CODEX_CHAT_BASE_URL: "unknown configuration key", CODEX_CHAT_API_ENABLED: "value must be a string", CODEX_CHAT_CODEX_MODEL: "value may not contain control characters" } });
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const write = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(envWritePayload(cfg, { CODEX_CHAT_BASE_URL: "https://brain.example.com" })),
      });
      assert.equal(write.status, 400);
      const payload = await write.json() as { error: string; fieldErrors: Array<{ key: string; code: string; message: string }> };
      assert.equal(payload.error, "validation_failed");
      assert.ok(payload.fieldErrors.some((fieldError) => fieldError.key === "CODEX_CHAT_BASE_URL" && fieldError.code === "unknown_key" && fieldError.message === "unknown configuration key"));
      assert.ok(payload.fieldErrors.some((fieldError) => fieldError.key === "CODEX_CHAT_API_ENABLED" && fieldError.code === "invalid_type"));
      assert.ok(payload.fieldErrors.some((fieldError) => fieldError.key === "CODEX_CHAT_CODEX_MODEL" && fieldError.code === "invalid_format"));
      assert.equal(await readFile(cfg.codexChatEnvFile, "utf8"), "CODEX_CHAT_BASE_URL='https://old.example.com'\n");
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin falls back to bootstrap env-file writes only when IPC is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-ipc-fallback-"));
  const fakeBotToken = ["xoxb", "synthetic", "fallback"].join("-");
  try {
    const cfg = config(root);
    const runDir = path.dirname(cfg.codexChatIpcSocket);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "ipc.token"), `${fakeIpcToken("client")}\n`, { mode: 0o600 });
    const { output } = await captureConsole(async () => {
      await withServer(cfg, authDeps(), async (baseUrl) => {
        const write = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify(envWritePayload(cfg, { CODEX_CHAT_BASE_URL: "https://brain.example.com", SLACK_BOT_TOKEN: fakeBotToken })),
        });
        assert.equal(write.status, 200);
        const payload = await write.json() as { configWritePath: string; presence: Record<string, boolean> };
        assert.equal(payload.configWritePath, "bootstrap_fallback");
        assert.deepEqual(payload.presence, { CODEX_CHAT_BASE_URL: true, SLACK_BOT_TOKEN: true });
      });
    });
    const envText = await readFile(cfg.codexChatEnvFile, "utf8");
    assert.match(envText, /CODEX_CHAT_BASE_URL='https:\/\/brain\.example\.com'/);
    assert.match(envText, /SLACK_BOT_TOKEN=/);
    assert.match(output, /bootstrap env-file fallback/);
    assert.equal(output.includes(fakeBotToken), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin reports ambiguous IPC failure and leaves OpenRouter TOML unwritten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-ipc-ambiguous-"));
  const fakeOpenRouterKey = ["sk", "or", "ambiguous"].join("-");
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    const cfg = config(root);
    ipc = await startFakeCodexChatIpc(root, { destroyAfterRead: true });
    const { output } = await captureConsole(async () => {
      await withServer(cfg, authDeps(), async (baseUrl) => {
        const settings = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, { headers: authHeaders() });
        const summary = await settings.json() as { env: { envFile: string }; profilePath: string; confirmationKeys: string[] };
        const write = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: fakeOpenRouterKey,
            model: "anthropic/claude-sonnet-4.5",
            codexProfile: "openrouter",
            modelProvider: "openrouter",
            serviceTierMode: "omit",
            confirmation: {
              token: "brain-admin-openrouter-settings-confirmed-v1",
              action: "openrouter.settings.write",
              envFile: summary.env.envFile,
              codexProfile: "openrouter",
              profilePath: openRouterProfilePath(summary, "openrouter"),
              keys: summary.confirmationKeys,
            },
          }),
        });
        assert.equal(write.status, 502);
        const payload = await write.json() as { message: string; mayHaveApplied: boolean; retry?: string };
        assert.equal(payload.mayHaveApplied, true);
        assert.match(payload.message, /may have applied/);
        assert.match(payload.retry ?? "", /Retry/);
        assert.equal(JSON.stringify(payload).includes(fakeOpenRouterKey), false);
      });
    });
    await assert.rejects(stat(path.join(cfg.codexHomePath, "openrouter.config.toml")), { code: "ENOENT" });
    assert.equal(output.includes(fakeOpenRouterKey), false);
    assert.match(output, /CONNECTION_CLOSED|TIMEOUT/);
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin does not fall back to disk when IPC auth fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-ipc-auth-fail-"));
  const fakeBotToken = ["xoxb", "synthetic", "authfail"].join("-");
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    const cfg = config(root);
    const originalEnv = "CODEX_CHAT_BASE_URL='https://old.example.com'\n";
    await writeFile(cfg.codexChatEnvFile, originalEnv, { mode: 0o600 });
    ipc = await startFakeCodexChatIpc(root, { expectedToken: fakeIpcToken("server"), persistEnvFile: cfg.codexChatEnvFile });
    const { output } = await captureConsole(async () => {
      await withServer(cfg, authDeps(), async (baseUrl) => {
        const write = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify(envWritePayload(cfg, { CODEX_CHAT_BASE_URL: "https://brain.example.com", SLACK_BOT_TOKEN: fakeBotToken })),
        });
        assert.equal(write.status, 502);
        const payload = await write.json() as { error: string; message: string; configWritePath: string; mayHaveApplied: boolean };
        assert.equal(payload.error, "codex_chat_config_write_failed");
        assert.equal(payload.configWritePath, "ipc");
        assert.equal(payload.mayHaveApplied, false);
        assert.match(payload.message, /authorization failed/);
      });
    });
    assert.equal(await readFile(cfg.codexChatEnvFile, "utf8"), originalEnv);
    assert.equal(output.includes(fakeBotToken), false);
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});



test("brain admin main-loop model switch governs provider and effort selectors while keeping subagent settings separate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-main-model-"));
  try {
    const cfg = config(root, { codexChatConfigFile: path.join(root, "codex-chat", "config", "codex-chat.toml") });
    await mkdir(path.dirname(cfg.codexChatConfigFile ?? ""), { recursive: true });
    await writeFile(cfg.codexChatConfigFile ?? "", `version = 1\n\n[codex]\nmodel = "gpt-5.6-luna"\neffort = "xhigh"\nprofile = ""\nserviceTier = "fast"\n\n[mainAgent]\nprovider = "claude_agent_sdk"\n\n[mainAgent.claude]\nmodel = "claude-sonnet-5"\neffort = "high"\n\n[subagents]\ndefaultModel = "gpt-5.6-luna"\ndefaultCodexProfile = ""\n`);
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const summaryResponse = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, { headers: authHeaders() });
      assert.equal(summaryResponse.status, 200);
      const summary = await summaryResponse.json() as {
        env: { envFile: string };
        confirmationKeys: string[];
        confirmation: { token: string };
        configFile: { mainAgent: { provider: string; claude: { model: string; effort: string } } };
        selectors: Array<{ name: string; source: string }>;
        effective: { provider: string; model: string; effort: string; profile: string; modelProvider: string; serviceTierMode: string; claudeModel: string; claudeEffort: string };
        activePreset: string;
        presets: Array<{ id: string; updates: Record<string, string> }>;
        openRouter: { apiKeyPresent: boolean };
      };
      assert.equal(summary.effective.provider, "claude_agent_sdk");
      assert.equal(summary.selectors.find((selector) => selector.name === "provider")?.source, "config");
      assert.equal(summary.configFile.mainAgent.provider, "claude_agent_sdk");
      assert.equal(summary.configFile.mainAgent.claude.model, "claude-sonnet-5");
      assert.equal(summary.configFile.mainAgent.claude.effort, "high");
      assert.equal(summary.activePreset, "claude-sonnet-main");
      assert.equal(summary.openRouter.apiKeyPresent, false);

      const keys = [
        "CODEX_CHAT_CODEX_MODEL",
        "CODEX_CHAT_CODEX_PROFILE",
        "CODEX_CHAT_CODEX_MODEL_PROVIDER",
        "CODEX_CHAT_CODEX_SERVICE_TIER",
        "CODEX_CHAT_CODEX_SERVICE_TIER_MODE",
        "CODEX_CHAT_CODEX_EFFORT",
        "CODEX_CHAT_MAIN_PROVIDER",
        "CODEX_CHAT_MAIN_CLAUDE_MODEL",
        "CODEX_CHAT_MAIN_CLAUDE_EFFORT",
      ];
      assert.deepEqual(summary.confirmationKeys, keys);
      assert.equal(summary.confirmation.token, "brain-admin-main-loop-model-confirmed-v2");
      const rollbackPreset = summary.presets.find((preset) => preset.id === "codex-openai-default");
      assert.equal(rollbackPreset?.updates.CODEX_CHAT_CODEX_MODEL, "gpt-5.6-luna");
      assert.equal(rollbackPreset?.updates.CODEX_CHAT_CODEX_EFFORT, "xhigh");
      assert.equal(rollbackPreset?.updates.CODEX_CHAT_MAIN_PROVIDER, "codex");
      const claudePreset = summary.presets.find((preset) => preset.id === "claude-sonnet-main");
      assert.equal(claudePreset?.updates.CODEX_CHAT_MAIN_PROVIDER, "claude_agent_sdk");
      assert.equal(claudePreset?.updates.CODEX_CHAT_MAIN_CLAUDE_MODEL, "claude-sonnet-5");
      assert.equal(claudePreset?.updates.CODEX_CHAT_MAIN_CLAUDE_EFFORT, "high");
      const missingConfirmation = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ preset: "openrouter-glm-5.2" }),
      });
      assert.equal(missingConfirmation.status, 400);

      const writeGlm = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ preset: "openrouter-glm-5.2", confirmation: { token: "brain-admin-main-loop-model-confirmed-v2", action: "codex-chat.main-loop-model.write", envFile: summary.env.envFile, preset: "openrouter-glm-5.2", keys } }),
      });
      assert.equal(writeGlm.status, 200);
      const payload = await writeGlm.json() as { writtenKeys: string[]; restartRequired: boolean; scope: string; summary: { activePreset: string } };
      assert.deepEqual(payload.writtenKeys, keys);
      assert.equal(payload.restartRequired, true);
      assert.equal(payload.scope, "main-loop-only; subagent settings unchanged");
      assert.equal(payload.summary.activePreset, "openrouter-glm-5.2");

      const envText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.match(envText, /CODEX_CHAT_CODEX_MODEL='z-ai\/glm-5\.2'/);
      assert.match(envText, /CODEX_CHAT_CODEX_PROFILE='openrouter'/);
      assert.match(envText, /CODEX_CHAT_CODEX_MODEL_PROVIDER='openrouter'/);
      assert.match(envText, /CODEX_CHAT_CODEX_SERVICE_TIER_MODE='omit'/);
      assert.match(envText, /CODEX_CHAT_CODEX_EFFORT='xhigh'/);
      assert.match(envText, /CODEX_CHAT_MAIN_PROVIDER='codex'/);
      assert.doesNotMatch(envText, /CODEX_CHAT_MAIN_CLAUDE_MODEL=/);
      assert.doesNotMatch(envText, /CODEX_CHAT_MAIN_CLAUDE_EFFORT=/);
      assert.equal(envText.includes("CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL"), false);
      assert.equal(envText.includes("OPENROUTER_API_KEY"), false);

      const writeClaude = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ preset: "claude-sonnet-main", confirmation: { token: "brain-admin-main-loop-model-confirmed-v2", action: "codex-chat.main-loop-model.write", envFile: summary.env.envFile, preset: "claude-sonnet-main", keys } }),
      });
      assert.equal(writeClaude.status, 200);
      const claudePayload = await writeClaude.json() as { summary: { effective: { provider: string; claudeModel: string; claudeEffort: string }; selectors: Array<{ name: string; source: string }> } };
      assert.equal(claudePayload.summary.effective.provider, "claude_agent_sdk");
      assert.equal(claudePayload.summary.effective.claudeModel, "claude-sonnet-5");
      assert.equal(claudePayload.summary.effective.claudeEffort, "high");
      assert.equal(claudePayload.summary.selectors.find((selector) => selector.name === "provider")?.source, "env");

      const rollback = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ preset: "codex-openai-default", confirmation: { token: "brain-admin-main-loop-model-confirmed-v2", action: "codex-chat.main-loop-model.write", envFile: summary.env.envFile, preset: "codex-openai-default", keys } }),
      });
      assert.equal(rollback.status, 200);
      const rollbackText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.match(rollbackText, /CODEX_CHAT_CODEX_MODEL='gpt-5\.6-luna'/);
      assert.match(rollbackText, /CODEX_CHAT_CODEX_EFFORT='xhigh'/);
      assert.match(rollbackText, /CODEX_CHAT_MAIN_PROVIDER='codex'/);
      assert.doesNotMatch(rollbackText, /CODEX_CHAT_CODEX_PROFILE=/);
      assert.doesNotMatch(rollbackText, /CODEX_CHAT_CODEX_MODEL_PROVIDER=/);
      assert.doesNotMatch(rollbackText, /CODEX_CHAT_MAIN_CLAUDE_MODEL=/);
      assert.doesNotMatch(rollbackText, /CODEX_CHAT_MAIN_CLAUDE_EFFORT=/);
      assert.match(rollbackText, /CODEX_CHAT_CODEX_SERVICE_TIER_MODE='auto'/);

      const configText = await readFile(cfg.codexChatConfigFile ?? "", "utf8");
      assert.match(configText, /\[subagents\]/);
      assert.doesNotMatch(configText, /defaultModel = "z-ai\/glm-5\.2"/);
      const audit = await readFile(path.join(root, "audit.jsonl"), "utf8");
      assert.match(audit, /codex-chat\.main_loop_model\.write/);
      assert.match(audit, /main-loop-only/);
      assert.equal(audit.includes("OPENROUTER_API_KEY"), false);
      assert.equal(audit.includes(FAKE_OPENROUTER_API_KEY.split("-").slice(0, 2).join("-")), false);
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
      const summary = await settings.json() as { env: { envFile: string }; profilePath: string; confirmationKeys: string[] };

      const entries = {
        apiKey: FAKE_OPENROUTER_API_KEY,
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

      const tamperedProfile = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          ...entries,
          codexProfile: "openrouter-prod",
          confirmation: {
            token: "brain-admin-openrouter-settings-confirmed-v1",
            action: "openrouter.settings.write",
            envFile: summary.env.envFile,
            codexProfile: "openrouter",
            profilePath: openRouterProfilePath(summary, "openrouter"),
            keys,
          },
        }),
      });
      assert.equal(tamperedProfile.status, 400);
      assert.equal((await tamperedProfile.json() as { error: string }).error, "confirmation_required");

      const write = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ ...entries, confirmation: { token: "brain-admin-openrouter-settings-confirmed-v1", action: "openrouter.settings.write", envFile: summary.env.envFile, codexProfile: entries.codexProfile, profilePath: openRouterProfilePath(summary, entries.codexProfile), keys } }),
      });
      assert.equal(write.status, 200);
      const payload = await write.json() as { writtenKeys: string[]; values: string; profilePath: string; apiKeyPresent: boolean };
      assert.deepEqual(payload.writtenKeys, keys);
      assert.equal(payload.values, "write-only");
      assert.equal(payload.apiKeyPresent, true);
      assert.equal(JSON.stringify(payload).includes(FAKE_OPENROUTER_API_KEY), false);

      const envText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.equal(envText.includes(`OPENROUTER_API_KEY='${FAKE_OPENROUTER_API_KEY}'`), true);
      assert.match(envText, /CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL='anthropic\/claude-sonnet-4\.5'/);
      const profileText = await readFile(payload.profilePath, "utf8");
      assert.match(profileText, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
      assert.match(profileText, /env_key = "OPENROUTER_API_KEY"/);
      assert.equal(profileText.includes(FAKE_OPENROUTER_API_KEY), false);
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

test("brain admin OpenRouter write accepts a changed codexProfile when the confirmation pins the write target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-openrouter-profile-"));
  try {
    const cfg = config(root);
    await writeFile(path.join(root, "codex-chat.env"), "CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES='openrouter-alt'\n");
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const settings = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, { headers: authHeaders() });
      assert.equal(settings.status, 200);
      // The summary serves exact profile targets; clients echo one of those
      // absolute paths instead of deriving filesystem paths locally.
      const summary = await settings.json() as { env: { envFile: string }; profilePath: string; profileTargets: Array<{ codexProfile: string; profilePath: string }>; confirmationKeys: string[]; current: { codexProfile: string } };
      assert.equal(summary.current.codexProfile, "openrouter");
      assert.match(summary.profilePath, /openrouter\.config\.toml$/);
      assert.ok(summary.profileTargets.some((target) => target.codexProfile === "openrouter-alt" && /openrouter-alt\.config\.toml$/.test(target.profilePath)));

      // Edit the profile field to a NEW value while confirming the computed write
      // target for that new profile.
      const write = await fetch(`${baseUrl}/api/admin/brain/openrouter/settings`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          model: "z-ai/glm-5.2",
          codexProfile: "openrouter-alt",
          modelProvider: "openrouter",
          serviceTierMode: "omit",
          confirmation: {
            token: "brain-admin-openrouter-settings-confirmed-v1",
            action: "openrouter.settings.write",
            envFile: summary.env.envFile,
            codexProfile: "openrouter-alt",
            profilePath: openRouterProfilePath(summary, "openrouter-alt"),
            keys: summary.confirmationKeys,
          },
        }),
      });
      assert.equal(write.status, 200);
      const payload = await write.json() as { profilePath: string; writtenKeys: string[] };
      // The profile file actually written reflects the NEW profile name.
      assert.match(payload.profilePath, /openrouter-alt\.config\.toml$/);
      const envText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.match(envText, /CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE='openrouter-alt'/);
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

test("brain admin operation API returns command failures as ok:false payloads, not HTTP failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-op-fail-"));
  const fakeAppToken = ["xapp", "1", "A00SYNTH", "9999", "appsecret"].join("-");
  try {
    await withServer(config(root), {
      ...(authDeps()),
      runCommand: async () => ({ status: 7, signal: null, stdout: "", stderr: `restart failed ${fakeAppToken} Bearer abc`, timedOut: false }),
    }, async (baseUrl) => {
      const restart = await fetch(`${baseUrl}/api/admin/brain/codex-chat/operation`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ operation: "restart", confirmation: { token: "brain-admin-live-operation-confirmed-v1", operation: "restart", serviceName: "codex-chat.service" } }),
      });
      assert.equal(restart.status, 200);
      const payload = await restart.json() as { ok: boolean; status: number; stderr: string };
      assert.equal(payload.ok, false);
      assert.equal(payload.status, 7);
      assert.equal(payload.stderr.includes(fakeAppToken), false);
      assert.equal(payload.stderr.includes("Bearer abc"), false);
      assert.match(payload.stderr, /redacted-slack-token/);
      assert.match(payload.stderr, /Bearer \[redacted\]/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("env merge preserves unrelated lines and quotes safely", () => {
  const merged = mergeEnvFileText("# keep\nFOO=bar\nSLACK_BOT_TOKEN=old\n", { SLACK_BOT_TOKEN: FAKE_SLACK_BOT_TOKEN_WITH_SPACE, CODEX_CHAT_BASE_URL: "it's fine" });
  assert.match(merged, /# keep\nFOO=bar/);
  assert.equal(merged.includes(`SLACK_BOT_TOKEN='${FAKE_SLACK_BOT_TOKEN_WITH_SPACE}'`), true);
  assert.match(merged, /CODEX_CHAT_BASE_URL='it'"'"'s fine'/);
});

test("env merge clears empty-string updates by deleting lines", () => {
  const merged = mergeEnvFileText("FOO=keep\nCODEX_CHAT_CODEX_PROFILE='openrouter'\nCODEX_CHAT_CODEX_MODEL_PROVIDER='openrouter'\n", {
    CODEX_CHAT_CODEX_PROFILE: "",
    CODEX_CHAT_CODEX_MODEL_PROVIDER: "",
  });
  assert.equal(merged, "FOO=keep\n");
});

test("brain admin exposes explicit Slack settings as write-only presence metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-slack-settings-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const settings = await fetch(`${baseUrl}/api/admin/brain/slack/settings`, { headers: authHeaders() });
      assert.equal(settings.status, 200);
      const settingsPayload = await settings.json() as { publicEventsUrl: string; appSettingsUrl: string; slackAppId: string | null; env: { allowedKeys: string[]; keys: Array<{ key: string; present: boolean; value: string | null }> } };
      assert.equal(settingsPayload.publicEventsUrl, "https://brain.decisive-outcomes.com/api/slack/events");
      assert.equal(settingsPayload.slackAppId, null);
      assert.equal(settingsPayload.appSettingsUrl, "https://api.slack.com/apps");
      assert.ok(settingsPayload.env.allowedKeys.includes("SLACK_SIGNING_SECRET"));
      assert.ok(settingsPayload.env.allowedKeys.includes("SLACK_APP_TOKEN"));

      const entries = { SLACK_SIGNING_SECRET: FAKE_SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN: FAKE_SLACK_BOT_TOKEN, CODEX_CHAT_BASE_URL: "https://brain.decisive-outcomes.com" };
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
      assert.equal(JSON.stringify(payload).includes(FAKE_SLACK_BOT_TOKEN), false);
      assert.equal(payload.presence.SLACK_BOT_TOKEN, true);

      const fileText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.equal(fileText.includes(`SLACK_SIGNING_SECRET='${FAKE_SLACK_SIGNING_SECRET}'`), true);
      assert.match(fileText, /CODEX_CHAT_BASE_URL='https:\/\/brain\.decisive-outcomes\.com'/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin exposes read-only Slack telemetry without leaking message bodies or tokens", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-slack-telemetry-"));
  try {
    const summaryPath = path.join(root, "codex-chat", "data", "state", "slack_telemetry", "summary.json");
    const observedAt = new Date().toISOString();
    await writeFileRecursive(summaryPath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: observedAt,
      counters: { "inbound.accepted": 1, "outbound.success": 1 },
      lastInboundEvent: {
        observedAt,
        direction: "inbound",
        outcome: "accepted",
        eventType: "app_mention",
        channelId: "C123",
        userId: "U123",
        textLength: 42,
        text: "do not expose this message body",
        token: FAKE_SLACK_BOT_TOKEN,
      },
      lastAcceptedEvent: {
        observedAt,
        direction: "inbound",
        outcome: "accepted",
        eventType: "app_mention",
        channelId: "C123",
        userId: "U123",
      },
      lastOutboundSuccess: {
        observedAt,
        direction: "outbound",
        outcome: "success",
        channelId: "C123",
        threadTs: "1782000000.000100",
        outboundResultCount: 1,
        reason: `Bearer ${FAKE_SLACK_BOT_TOKEN}`,
      },
    }),);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const telemetry = await fetch(`${baseUrl}/api/admin/brain/slack/telemetry`, { headers: authHeaders() });
      assert.equal(telemetry.status, 200);
      const payload = await telemetry.json() as {
        available: boolean;
        path: string;
        health: { state: string };
        lastInboundEvent?: { channelId?: string; userId?: string; text?: string; token?: string };
        lastOutboundSuccess?: { reason?: string };
      };
      assert.equal(payload.available, true);
      assert.equal(payload.path, summaryPath);
      assert.equal(payload.health.state, "observing");
      assert.equal(payload.lastInboundEvent?.channelId, "C123");
      assert.equal(payload.lastInboundEvent?.userId, "U123");
      assert.equal("text" in (payload.lastInboundEvent ?? {}), false);
      assert.equal("token" in (payload.lastInboundEvent ?? {}), false);
      assert.equal(payload.lastOutboundSuccess?.reason, "Bearer [redacted-slack-token]");
      const serialized = JSON.stringify(payload);
      assert.equal(serialized.includes("do not expose this message body"), false);
      assert.equal(serialized.includes(FAKE_SLACK_BOT_TOKEN), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("brain admin links directly to Slack app settings when a non-secret app id is configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-slack-app-id-"));
  try {
    await withServer(config(root, { slackAppId: "A0123456789" }), authDeps(), async (baseUrl) => {
      const settings = await fetch(`${baseUrl}/api/admin/brain/slack/settings`, { headers: authHeaders() });
      assert.equal(settings.status, 200);
      const payload = await settings.json() as { appSettingsUrl: string; slackAppId: string | null };
      assert.equal(payload.slackAppId, "A0123456789");
      assert.equal(payload.appSettingsUrl, "https://api.slack.com/apps/A0123456789");
      assert.equal(JSON.stringify(payload).includes("xox"), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function healthyTelemetry(observedAt: string): unknown {
  return {
    schemaVersion: 1,
    updatedAt: observedAt,
    counters: { "inbound.accepted": 1, "outbound.success": 1 },
    lastAcceptedEvent: { observedAt, direction: "inbound", outcome: "accepted", eventType: "app_mention", channelId: "C1", userId: "U1" },
    lastOutboundSuccess: { observedAt, direction: "outbound", outcome: "success", channelId: "C1", threadTs: "1782000000.000100", outboundResultCount: 1 },
  };
}

function validCapabilityStore(): unknown {
  return { schemaVersion: 2, grants: [], subjects: [{ id: "person:person_tim", kind: "person" }], externalIdentities: [] };
}

test("brain admin status endpoint reports healthy components server-side", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-ok-"));
  try {
    const observedAt = new Date().toISOString();
    await writeFile(path.join(root, "codex-chat.env"), `SLACK_SIGNING_SECRET='${FAKE_SLACK_SIGNING_SECRET}'\nSLACK_BOT_TOKEN='${FAKE_SLACK_BOT_TOKEN}'\nCODEX_CHAT_BASE_URL='https://brain.example.test'\n`);
    await writeJson(path.join(root, "slack-setup.json"), { schemaVersion: 1, setupComplete: true });
    await writeFileRecursive(path.join(root, "codex-chat", "data", "state", "slack_telemetry", "summary.json"), JSON.stringify(healthyTelemetry(observedAt)));
    await writeJson(path.join(root, "capabilities.json"), validCapabilityStore());
    const day = observedAt.slice(0, 10);
    await writeFileRecursive(path.join(root, "codex-chat", "data", "state", "capability_decisions", `${day}.jsonl`),
      `${JSON.stringify({ allowed: false, checkedAt: observedAt })}\n${JSON.stringify({ allowed: false, checkedAt: observedAt })}\n${JSON.stringify({ allowed: true, checkedAt: observedAt })}\n`);
    // Use the relative default so decision-dir resolution under codex-chat's state dir is exercised.
    await withServer(config(root, { capabilityDecisionsDir: "capability_decisions" }), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string; lastChecked: string; action?: { label: string; route: string } }> };
      const by = Object.fromEntries(payload.components.map((component) => [component.id, component]));
      assert.deepEqual(payload.components.map((component) => component.id), ["brain", "slack", "model", "service", "capability_enforcement"]);
      for (const component of payload.components) assert.match(component.lastChecked, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(by.brain.state, "ok");
      assert.equal(by.slack.state, "ok");
      assert.equal(by.model.state, "ok");
      assert.equal(by.service.state, "ok");
      assert.equal(by.capability_enforcement.state, "ok");
      assert.match(by.capability_enforcement.message, /Enforcement on/);
      assert.match(by.capability_enforcement.message, /2 denials in the last hour/);
      assert.equal(by.capability_enforcement.action?.route, "/operations");
      assert.equal(JSON.stringify(payload).includes(FAKE_SLACK_BOT_TOKEN), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin settings count recent capability denials across full day files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-denial-count-full-"));
  try {
    const checkedAt = new Date().toISOString();
    await writeJson(path.join(root, "capabilities.json"), validCapabilityStore());
    const day = checkedAt.slice(0, 10);
    const denialLines = Array.from({ length: 3 }, (_, index) => JSON.stringify({ allowed: false, checkedAt, reason: `synthetic-denial-${index}` }));
    const paddingLines = Array.from({ length: 4_500 }, (_, index) => JSON.stringify({ allowed: true, checkedAt, padding: `${index}`.padEnd(80, "x") }));
    const decisionPath = path.join(root, "codex-chat", "data", "state", "capability_decisions", `${day}.jsonl`);
    await writeFileRecursive(decisionPath, `${[...denialLines, ...paddingLines].join("\n")}\n`);
    assert.ok((await stat(decisionPath)).size > 256 * 1024);

    await withServer(config(root, { capabilityDecisionsDir: "capability_decisions" }), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/settings`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as { capabilities: { recentDenials: number } };
      assert.equal(payload.capabilities.recentDenials, 3);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin status endpoint reports unhealthy components server-side", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-bad-"));
  try {
    // Slack secrets missing; main-loop on OpenRouter preset with no key; capability store missing while enforcing; last restart failed.
    await writeFile(path.join(root, "codex-chat.env"), "CODEX_CHAT_CODEX_MODEL='z-ai/glm-5.2'\nCODEX_CHAT_CODEX_PROFILE='openrouter'\nCODEX_CHAT_CODEX_MODEL_PROVIDER='openrouter'\nCODEX_CHAT_CODEX_SERVICE_TIER_MODE='omit'\n");
    await writeFile(path.join(root, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), action: "codex-chat.operation.execute", operation: "restart", status: 1 })}\n`);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string; action?: { label: string; route: string } }> };
      const by = Object.fromEntries(payload.components.map((component) => [component.id, component]));
      assert.equal(by.slack.state, "error");
      assert.match(by.slack.message, /missing/);
      assert.equal(by.slack.action?.route, "/setup");
      assert.equal(by.model.state, "error");
      assert.match(by.model.message, /OpenRouter/);
      assert.equal(by.service.state, "error");
      assert.match(by.service.message, /failed/);
      assert.equal(by.capability_enforcement.state, "error");
      assert.match(by.capability_enforcement.message, /missing/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin status reports enforcement disabled from codex-chat config override", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-enforce-off-"));
  try {
    const cfg = config(root, { codexChatConfigFile: path.join(root, "codex-chat", "config", "codex-chat.toml") });
    await mkdir(path.dirname(cfg.codexChatConfigFile ?? ""), { recursive: true });
    await writeFile(cfg.codexChatConfigFile ?? "", "version = 1\n\n[brain]\nenforcementEnabled = false\n");
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string }> };
      const enforcement = payload.components.find((component) => component.id === "capability_enforcement");
      assert.equal(enforcement?.state, "warn");
      assert.match(enforcement?.message ?? "", /disabled/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin status reports enforcement disabled from a top-level dotted config override", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-enforce-dotted-"));
  try {
    const cfg = config(root, { codexChatConfigFile: path.join(root, "codex-chat", "config", "codex-chat.toml") });
    await mkdir(path.dirname(cfg.codexChatConfigFile ?? ""), { recursive: true });
    // Dotted top-level form (valid to codex-chat's real TOML parser).
    await writeFile(cfg.codexChatConfigFile ?? "", "version = 1\nbrain.enforcementEnabled = false\n");
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string }> };
      const enforcement = payload.components.find((component) => component.id === "capability_enforcement");
      assert.equal(enforcement?.state, "warn");
      assert.match(enforcement?.message ?? "", /disabled/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin status flags a custom main-loop model that needs OpenRouter without a key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-custom-openrouter-"));
  try {
    // Custom config (not a known preset) but the effective provider is openrouter, with no OPENROUTER_API_KEY.
    await writeFile(path.join(root, "codex-chat.env"), "CODEX_CHAT_CODEX_MODEL='some-custom-model'\nCODEX_CHAT_CODEX_MODEL_PROVIDER='openrouter'\n");
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string; action?: { label: string; route: string } }> };
      const model = payload.components.find((component) => component.id === "model");
      assert.equal(model?.state, "error");
      assert.match(model?.message ?? "", /OpenRouter/);
      assert.equal(model?.action?.label, "Fix model settings");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin status stays 200 when one component builder throws", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-component-error-"));
  try {
    // Point codexChatEnvFile at a directory so env reads fail with a non-ENOENT error (EISDIR).
    const envDir = path.join(root, "codex-chat-env-dir");
    await mkdir(envDir, { recursive: true });
    await withServer(config(root, { codexChatEnvFile: envDir }), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string }> };
      const by = Object.fromEntries(payload.components.map((component) => [component.id, component]));
      // The brain component does not touch the env file and stays intact.
      assert.equal(by.brain.state, "ok");
      // The slack component reads the env file and degrades to error, not a 500.
      assert.equal(by.slack.state, "error");
      assert.match(by.slack.message, /Status check failed/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin status reports an unreadable capability store distinctly from an invalid one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-store-unreadable-"));
  try {
    // Store path is a directory: stat succeeds (present) but reading fails (EISDIR).
    await mkdir(path.join(root, "capabilities.json"), { recursive: true });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string }> };
      const enforcement = payload.components.find((component) => component.id === "capability_enforcement");
      assert.equal(enforcement?.state, "error");
      assert.match(enforcement?.message ?? "", /unreadable/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin status resolves a ~-home capability decisions dir override", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-decisions-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = root;
    const observedAt = new Date().toISOString();
    await writeFile(path.join(root, "codex-chat.env"), `SLACK_SIGNING_SECRET='${FAKE_SLACK_SIGNING_SECRET}'\nSLACK_BOT_TOKEN='${FAKE_SLACK_BOT_TOKEN}'\n`);
    await writeJson(path.join(root, "slack-setup.json"), { schemaVersion: 1, setupComplete: true });
    await writeJson(path.join(root, "capabilities.json"), validCapabilityStore());
    const day = observedAt.slice(0, 10);
    // "~/decisions" must expand to <HOME>/decisions, not join under codex-chat's state dir.
    await writeFileRecursive(path.join(root, "decisions", `${day}.jsonl`),
      `${JSON.stringify({ allowed: false, checkedAt: observedAt })}\n`);
    await withServer(config(root, { capabilityDecisionsDir: "~/decisions" }), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string }> };
      const enforcement = payload.components.find((component) => component.id === "capability_enforcement");
      assert.equal(enforcement?.state, "ok");
      assert.match(enforcement?.message ?? "", /1 denial in the last hour/);
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin status treats a successful deploy as clearing the pending restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-status-deploy-restart-"));
  try {
    await writeFile(path.join(root, "codex-chat.env"), `SLACK_SIGNING_SECRET='${FAKE_SLACK_SIGNING_SECRET}'\nSLACK_BOT_TOKEN='${FAKE_SLACK_BOT_TOKEN}'\n`);
    await writeJson(path.join(root, "slack-setup.json"), { schemaVersion: 1, setupComplete: true });
    await writeJson(path.join(root, "capabilities.json"), validCapabilityStore());
    // Config write happened, then a successful deploy (which restarts the service) after it.
    const writeAt = new Date(Date.now() - 60_000).toISOString();
    const deployAt = new Date().toISOString();
    await writeFile(path.join(root, "audit.jsonl"),
      `${JSON.stringify({ at: writeAt, action: "codex-chat.env.write" })}\n${JSON.stringify({ at: deployAt, action: "codex-chat.operation.execute", operation: "deploy", status: 0 })}\n`);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() });
      const payload = await res.json() as { components: Array<{ id: string; state: string; message: string }> };
      const service = payload.components.find((component) => component.id === "service");
      assert.equal(service?.state, "ok");
      assert.match(service?.message ?? "", /deploy/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin slack setup state persists completion and derives per-step done state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-slack-setup-"));
  try {
    const observedAt = new Date().toISOString();
    await writeFile(path.join(root, "codex-chat.env"), `SLACK_SIGNING_SECRET='${FAKE_SLACK_SIGNING_SECRET}'\nSLACK_BOT_TOKEN='${FAKE_SLACK_BOT_TOKEN}'\n`);
    await writeFileRecursive(path.join(root, "codex-chat", "data", "state", "slack_telemetry", "summary.json"), JSON.stringify(healthyTelemetry(observedAt)));
    await withServer(config(root, { slackAppId: "A0123456789" }), authDeps(), async (baseUrl) => {
      const initial = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, { headers: authHeaders() });
      assert.equal(initial.status, 200);
      const initialPayload = await initial.json() as { setupComplete: boolean; steps: Array<{ id: string; done: boolean }>; verification: { lastAcceptedEvent: boolean } };
      assert.equal(initialPayload.setupComplete, false);
      const steps = Object.fromEntries(initialPayload.steps.map((step) => [step.id, step.done]));
      assert.equal(steps.public_url, true);
      assert.equal(steps.secrets, true);
      assert.equal(steps.install_app, true);
      assert.equal(steps.event_subscriptions, true);
      assert.equal(steps.restart, false);
      assert.equal(initialPayload.verification.lastAcceptedEvent, true);
      assert.equal(JSON.stringify(initialPayload).includes(FAKE_SLACK_BOT_TOKEN), false);

      const invalid = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(invalid.status, 400);

      const complete = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ complete: true }),
      });
      assert.equal(complete.status, 200);
      const completePayload = await complete.json() as { setup: { setupComplete: boolean; completedBy?: string; steps: Array<{ id: string; done: boolean }> } };
      assert.equal(completePayload.setup.setupComplete, true);
      assert.equal(completePayload.setup.completedBy, TEST_ADMIN_EMAIL);
      assert.equal(completePayload.setup.steps.find((step) => step.id === "restart")?.done, true);
      assert.equal((await stat(path.join(root, "slack-setup.json"))).mode & 0o777, 0o600);

      const reconfigure = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ complete: false }),
      });
      assert.equal(reconfigure.status, 200);
      const after = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, { headers: authHeaders() });
      const afterPayload = await after.json() as { setupComplete: boolean; completedBy?: string; lastCompletedAt?: string; lastCompletedBy?: string };
      assert.equal(afterPayload.setupComplete, false);
      // C1 (finding 9): marking setup incomplete preserves the prior completion
      // provenance as last-completed instead of erasing who/when it was completed.
      assert.equal(afterPayload.completedBy, undefined);
      assert.equal(afterPayload.lastCompletedBy, completePayload.setup.completedBy);
      assert.ok(afterPayload.lastCompletedAt, "last completion timestamp retained");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin env schema exposes grouped metadata including an other group for unrecognized keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-env-schema-"));
  try {
    await writeFile(path.join(root, "codex-chat.env"), `SLACK_BOT_TOKEN='${FAKE_SLACK_BOT_TOKEN}'\nSOME_CUSTOM_FLAG='1'\nCUSTOM_API_TOKEN='${FAKE_CUSTOM_API_TOKEN}'\n`);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/env/schema`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      // Plan §6.4: the endpoint returns the bare schema array (no wrapper object).
      const payload = await res.json() as Array<{ key: string; group: string; required: boolean; secret: boolean; writable: boolean; description: string; kind: string; enumValues?: string[] }>;
      assert.ok(Array.isArray(payload));
      const by = Object.fromEntries(payload.map((entry) => [entry.key, entry]));
      assert.equal(by.SLACK_BOT_TOKEN.group, "slack");
      assert.equal(by.SLACK_BOT_TOKEN.secret, true);
      assert.equal(by.SLACK_BOT_TOKEN.required, true);
      assert.equal(by.CODEX_CHAT_BASE_URL.group, "slack");
      assert.equal(by.CODEX_CHAT_CODEX_MODEL.group, "model");
      assert.equal(by.CODEX_CHAT_CODEX_EFFORT.group, "model");
      assert.deepEqual(by.CODEX_CHAT_MAIN_PROVIDER.enumValues, ["codex", "claude_agent_sdk"]);
      assert.equal(by.CODEX_CHAT_MAIN_CLAUDE_MODEL.kind, "string");
      assert.deepEqual(by.CODEX_CHAT_MAIN_CLAUDE_EFFORT.enumValues, ["low", "medium", "high", "xhigh"]);
      assert.match(by.CODEX_CHAT_MAIN_PROVIDER.description, /OAuth.*restart.*Employees must remain disabled/);
      assert.equal(by.OPENROUTER_API_KEY.group, "openrouter");
      assert.equal(by.CODEX_CHAT_API_ENABLED.group, "feature_flags");
      // `writable` reflects the service's env-write allowlist (config allows only
      // CODEX_CHAT_BASE_URL + SLACK_BOT_TOKEN here), so the UI can render
      // non-writable rows read-only instead of offering an input the server 403s.
      assert.equal(by.SLACK_BOT_TOKEN.writable, true);
      assert.equal(by.CODEX_CHAT_BASE_URL.writable, true);
      assert.equal(by.CODEX_CHAT_CODEX_MODEL.writable, false);
      // Unrecognized keys present in the env file surface under the other group.
      assert.equal(by.SOME_CUSTOM_FLAG.group, "other");
      // A non-allowlisted key (recognized or not) is marked writable:false.
      assert.equal(by.SOME_CUSTOM_FLAG.writable, false);
      assert.equal(by.CUSTOM_API_TOKEN.group, "other");
      assert.equal(by.CUSTOM_API_TOKEN.secret, true);
      assert.equal(by.CUSTOM_API_TOKEN.writable, false);
      assert.equal(JSON.stringify(payload).includes(FAKE_SLACK_BOT_TOKEN), false);
      assert.equal(JSON.stringify(payload).includes(FAKE_CUSTOM_API_TOKEN), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin env write gates on pinned confirmation or legacy phrase and validates against the schema", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-env-validate-"));
  const fakeBotToken = ["xoxb", "super", "secret"].join("-");
  try {
    const cfg = config(root);
    await withServer(cfg, authDeps(), async (baseUrl) => {
      // Plan §6.4 / §8 step 4: a one-click write from any client — no structured
      // confirmation and no approval phrase — must be refused (never a silent secret
      // overwrite), even for otherwise-valid, allowlisted keys.
      const noConfirmation = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ entries: { CODEX_CHAT_BASE_URL: "https://brain.example.test", SLACK_BOT_TOKEN: fakeBotToken } }),
      });
      assert.equal(noConfirmation.status, 400);
      assert.equal((await noConfirmation.json() as { error: string }).error, "confirmation_required");

      const bareBoolean = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true, entries: { CODEX_CHAT_BASE_URL: "https://brain.example.test", SLACK_BOT_TOKEN: fakeBotToken } }),
      });
      assert.equal(bareBoolean.status, 400);
      assert.equal((await bareBoolean.json() as { error: string }).error, "confirmation_required");

      // The React console echoes the server-served token/action/envFile/key set.
      const confirmedWrite = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(envWritePayload(cfg, { CODEX_CHAT_BASE_URL: "https://brain.example.test", SLACK_BOT_TOKEN: fakeBotToken })),
      });
      assert.equal(confirmedWrite.status, 200);
      assert.deepEqual((await confirmedWrite.json() as { writtenKeys: string[] }).writtenKeys.sort(), ["CODEX_CHAT_BASE_URL", "SLACK_BOT_TOKEN"]);

      // The legacy approval phrase remains accepted for low-friction env writes.
      const phraseWrite = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ approval: "write env", entries: { CODEX_CHAT_BASE_URL: "https://brain.example.test" } }),
      });
      assert.equal(phraseWrite.status, 200);

      // Schema validation still returns field-level errors (bad URL format).
      const invalid = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(envWritePayload(cfg, { CODEX_CHAT_BASE_URL: "not-a-url" })),
      });
      assert.equal(invalid.status, 400);
      const invalidPayload = await invalid.json() as { error: string; fieldErrors: Array<{ key: string; code: string }> };
      assert.equal(invalidPayload.error, "validation_failed");
      assert.ok(invalidPayload.fieldErrors.some((fieldError) => fieldError.key === "CODEX_CHAT_BASE_URL" && fieldError.code === "invalid_format"));

      // Empty required value is a field-level error.
      const empty = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(envWritePayload(cfg, { CODEX_CHAT_BASE_URL: "" })),
      });
      assert.equal(empty.status, 400);
      assert.ok((await empty.json() as { fieldErrors: Array<{ key: string; code: string }> }).fieldErrors.some((fieldError) => fieldError.code === "required"));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admin routing cutover serves the SPA at /admin, redirects /admin-v2, and keeps legacy/API routes separate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-spa-"));
  try {
    // 503 when the build output is absent (adminUiDir points at a missing dir).
    // The absolute build path must NOT leak into this unauthenticated response.
    const missingDir = path.join(root, "missing-ui");
    await withServer(config(root, { adminUiDir: missingDir }), authDeps(), async (baseUrl) => {
      const unbuilt = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}/`);
      assert.equal(unbuilt.status, 503);
      const unbuiltBody = await unbuilt.text();
      assert.match(unbuiltBody, /not built/i);
      assert.match(unbuiltBody, /\/admin/);
      assert.equal(unbuiltBody.includes("/admin-legacy"), false);
      assert.equal(unbuiltBody.includes(missingDir), false);
    });

    // With a build present: index injection, asset serving, SPA fallback, traversal block.
    const uiDir = path.join(root, "ui-dist");
    await mkdir(path.join(uiDir, "assets"), { recursive: true });
    await writeFile(path.join(uiDir, "index.html"), "<!doctype html><html><head><title>Brain</title><script type=\"module\" src=\"/admin/assets/app.js\"></script></head><body><div id=\"root\"></div></body></html>");
    await writeFile(path.join(uiDir, "assets", "app.js"), "export const brand = 'brain';\n");
    // A secret-looking file outside the build dir must never be reachable via traversal or symlink.
    await writeFile(path.join(root, "secret.txt"), "TOP-SECRET-VALUE");
    // A symlink INSIDE the build dir pointing outside it must not be served.
    await symlink(path.join(root, "secret.txt"), path.join(uiDir, "leak.txt"));

    await withServer(config(root, { adminUiDir: uiDir, clerkPublishableKey: "pk_test_admin_spa" }), authDeps(), async (baseUrl) => {
      // The old parallel mount is redirect-only, preserving the path suffix and query string.
      const oldRoute = await fetch(`${baseUrl}${ADMIN_V2_REDIRECT_ROUTE_PATH}/users?tab=grants`, { redirect: "manual" });
      assert.equal(oldRoute.status, 308);
      assert.equal(oldRoute.headers.get("location"), `${ADMIN_SPA_ROUTE_PATH}/users?tab=grants`);
      const oldPostRoute = await fetch(`${baseUrl}${ADMIN_V2_REDIRECT_ROUTE_PATH}/users`, { method: "POST", redirect: "manual" });
      assert.equal(oldPostRoute.status, 308);
      assert.equal(oldPostRoute.headers.get("location"), `${ADMIN_SPA_ROUTE_PATH}/users`);

      // Root shell: 200 HTML with the injected non-secret bootstrap config, no-store.
      const shell = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}/`);
      assert.equal(shell.status, 200);
      assert.match(shell.headers.get("cache-control") ?? "", /no-store/);
      const shellHtml = await shell.text();
      assert.match(shellHtml, /window\.__BRAIN_UI_CONFIG__/);
      assert.match(shellHtml, /pk_test_admin_spa/);
      assert.match(shellHtml, /"signInUrl":"\/admin"/);
      assert.match(shellHtml, /"routePath":"\/admin"/);
      assert.match(shellHtml, /id="root"/);

      const headShell = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}`, { method: "HEAD" });
      assert.equal(headShell.status, 200);
      assert.match(headShell.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(await headShell.text(), "");

      // A direct request to index.html goes through the injected, no-store shell
      // path — never the raw file with a long public cache (plan §6.6 / fix).
      const directIndex = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}/index.html`);
      assert.equal(directIndex.status, 200);
      assert.match(directIndex.headers.get("cache-control") ?? "", /no-store/);
      assert.match(await directIndex.text(), /window\.__BRAIN_UI_CONFIG__/);

      // Deep link to an SPA route with no matching file → index.html fallback.
      const deep = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}/users`);
      assert.equal(deep.status, 200);
      assert.match(await deep.text(), /window\.__BRAIN_UI_CONFIG__/);

      // `/admin/auth/sign-in` is client-side Clerk now, so it is also an SPA shell.
      const spaSignIn = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}/auth/sign-in`);
      assert.equal(spaSignIn.status, 200);
      assert.match(await spaSignIn.text(), /window\.__BRAIN_UI_CONFIG__/);

      // The old server-rendered console is gone; no legacy path falls into the SPA.
      const legacyGone = await fetch(`${baseUrl}/admin-legacy`, { headers: authHeaders() });
      assert.equal(legacyGone.status, 404);
      assert.equal((legacyGone.headers.get("content-type") ?? "").includes("application/json"), true);
      assert.equal((await legacyGone.text()).includes("window.__BRAIN_UI_CONFIG__"), false);

      // Admin API routes stay JSON/auth-gated and never fall through to the SPA shell.
      const api = await fetch(`${baseUrl}/api/admin/brain/me`, { headers: authHeaders() });
      assert.equal(api.status, 200);
      assert.deepEqual(await api.json(), { email: TEST_ADMIN_EMAIL });

      // Hashed asset served with a JS content type, real bytes, and a long cache.
      const asset = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}/assets/app.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", /javascript/);
      assert.match(asset.headers.get("cache-control") ?? "", /max-age=86400/);
      assert.match(await asset.text(), /brand = 'brain'/);

      // Path traversal must not escape the build dir.
      const traversal = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}/..%2f..%2fsecret.txt`);
      assert.notEqual(traversal.status, 200);
      assert.equal((await traversal.text()).includes("TOP-SECRET-VALUE"), false);

      // A symlink inside the build dir pointing outside it must not be served.
      const symlinked = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}/leak.txt`);
      assert.equal((await symlinked.text()).includes("TOP-SECRET-VALUE"), false);
    });

    await withServer(config(root, { adminUiDir: uiDir, routePath: "/ops/admin", clerkPublishableKey: "pk_test_admin_spa" }), authDeps(), async (baseUrl) => {
      const oldRoute = await fetch(`${baseUrl}${ADMIN_V2_REDIRECT_ROUTE_PATH}/users?tab=grants`, { redirect: "manual" });
      assert.equal(oldRoute.status, 308);
      assert.equal(oldRoute.headers.get("location"), "/ops/admin/users?tab=grants");

      const customShell = await fetch(`${baseUrl}/ops/admin/users`);
      assert.equal(customShell.status, 200);
      const customHtml = await customShell.text();
      assert.match(customHtml, /window\.__BRAIN_UI_CONFIG__/);
      assert.match(customHtml, /"routePath":"\/ops\/admin"/);
      assert.match(customHtml, /"signInUrl":"\/ops\/admin"/);
      assert.match(customHtml, /src="\/ops\/admin\/assets\/app\.js"/);

      const oldDefaultMount = await fetch(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}`);
      assert.equal(oldDefaultMount.status, 404);
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

      const download = await fetch(`${baseUrl}/api/admin/brain/slack/manifest/download`, { headers: authHeaders() });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-disposition"), 'attachment; filename="brain.slack.manifest.json"');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- §6.5 capability READ endpoints -----------------------------------------

// SYNTHETIC capability decisions modeled on the codex-chat decision shape
// (allowed + denied, across telegram and slack actors). Identifiers mirror the
// synthetic fixture store so the dry-run endpoint reproduces each outcome
// against the same store content the enforcer evaluates. No real Telegram/Slack
// identifiers appear here.
const REAL_DECISIONS = [
  {
    name: "allowed_telegram", allowed: true,
    actorId: "telegram:user:900000001", operation: "telegram.event.receive", action: "receive",
    resource: { source: "telegram", surfaceKind: "telegram", chatId: "900000001", messageId: "10001", conversationSessionId: "session_alpha01", actorId: "telegram:user:900000001" },
  },
  {
    name: "allowed_slack", allowed: true,
    actorId: "slack:team:T00SYNTH01:user:U00SYNTHAA", operation: "slack.event.receive", action: "receive",
    resource: { source: "slack", surfaceKind: "slack", teamId: "T00SYNTH01", channelId: "C00SYNTH01", threadTs: "1700000001.000100", messageTs: "1700000001.000100", messageId: "1700000001.000100", conversationSessionId: "session_beta01", actorId: "slack:team:T00SYNTH01:user:U00SYNTHAA" },
  },
  {
    name: "denied_slack_unlinked", allowed: false,
    actorId: "slack:team:T00SYNTH01:user:U00SYNTHBB", operation: "slack.event.receive", action: "receive",
    resource: { source: "slack", surfaceKind: "slack", teamId: "T00SYNTH01", channelId: "C00SYNTH01", threadTs: "1700000002.000200", messageTs: "1700000002.000200", messageId: "1700000002.000200", conversationSessionId: "session_gamma01", actorId: "slack:team:T00SYNTH01:user:U00SYNTHBB" },
  },
  {
    name: "denied_telegram_system", allowed: false,
    actorId: "telegram:system", operation: "system.callback.enqueue", action: "enqueue",
    resource: { source: "subagent", surfaceKind: "telegram", chatId: "900000001", messageId: "10002", conversationSessionId: "session_alpha01", actorId: "telegram:system" },
  },
];

async function writeLiveStore(root: string): Promise<void> {
  await writeFile(path.join(root, "capabilities.json"), LIVE_CAPABILITY_STORE_JSON);
}

function pendingSlackStore(): unknown {
  return {
    schemaVersion: 2,
    people: [
      { id: "person_linked", displayName: "Linked Synthetic", status: "active", personType: "human", primarySubjectId: "person:linked", identityIds: ["identity_slack_T00SYNTH01_U00SYNTHLINK"], subjectIds: ["person:linked"] },
      { id: "person_global", displayName: "Global Synthetic", status: "active", personType: "human", primarySubjectId: "person:global", identityIds: ["identity_slack_global_U00SYNTHGLOB"], subjectIds: ["person:global"] },
      { id: "person_suspended_subject", displayName: "Suspended Subject Synthetic", status: "active", personType: "human", primarySubjectId: "person:suspended_subject", identityIds: ["identity_slack_T00SYNTH01_U00SYNTHSUSP"], subjectIds: ["person:suspended_subject"] },
    ],
    externalIdentities: [
      { id: "identity_slack_T00SYNTH01_U00SYNTHLINK", provider: "slack", providerUserId: "U00SYNTHLINK", providerTeamId: "T00SYNTH01", personId: "person_linked", status: "linked" },
      { id: "identity_slack_global_U00SYNTHGLOB", provider: "slack", providerUserId: "U00SYNTHGLOB", personId: "person_global", status: "linked" },
      { id: "identity_slack_T00SYNTH01_U00SYNTHOBS", provider: "slack", providerUserId: "U00SYNTHOBS", providerTeamId: "T00SYNTH01", status: "observed_unlinked" },
      { id: "identity_slack_T00SYNTH01_U00SYNTHSUSP", provider: "slack", providerUserId: "U00SYNTHSUSP", providerTeamId: "T00SYNTH01", personId: "person_suspended_subject", status: "linked" },
    ],
    identityProofs: [],
    subjects: [
      { id: "person:linked", personId: "person_linked", kind: "person", status: "active" },
      { id: "person:global", personId: "person_global", kind: "person", status: "active" },
      { id: "person:suspended_subject", personId: "person_suspended_subject", kind: "person", status: "suspended" },
    ],
    grants: [],
  };
}

async function writeDecisionDay(root: string, day: string, records: unknown[]): Promise<void> {
  await writeFileRecursive(
    path.join(root, "codex-chat", "data", "state", "capability_decisions", `${day}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

const SYNTHETIC_REGISTRY = {
  registryVersion: 7,
  capabilities: [
    { id: "output.text.send", family: "output", description: "Send text output.", selectorKeys: ["surfaceKind", "channelId"], riskTier: "medium" },
    { id: "runtime.admin", family: "runtime", description: "Administer runtime.", selectorKeys: ["surfaceKind"], riskTier: "high", deprecated: true },
  ],
};

const RUNTIME_SELECTOR_KEYS = ["source", "surfaceKind", "teamId", "channelId", "threadTs", "messageTs", "chatId", "messageId", "conversationSessionId", "actorId", "targetId", "targetPolicy", "outputType"];

function runtimeSelectors(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...Object.fromEntries(RUNTIME_SELECTOR_KEYS.map((key) => [key, "*"])), ...overrides };
}

const ONBOARD_REGISTRY = {
  registryVersion: 8,
  capabilities: [
    { id: "slack.event.receive", family: "events", description: "Receive Slack events.", selectorKeys: RUNTIME_SELECTOR_KEYS, riskTier: "low" },
    { id: "assistant.run", family: "assistant", description: "Run assistant.", selectorKeys: RUNTIME_SELECTOR_KEYS, riskTier: "medium" },
    { id: "output.text.send", family: "output", description: "Send text output.", selectorKeys: RUNTIME_SELECTOR_KEYS, riskTier: "medium" },
  ],
};

function fullSlackEventResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "slack",
    surfaceKind: "slack",
    teamId: "T00SYNTH01",
    channelId: "C00SYNTH01",
    threadTs: "1700000001.000100",
    messageTs: "1700000001.000100",
    messageId: "1700000001.000100",
    conversationSessionId: "session_synth01",
    actorId: "slack:team:T00SYNTH01:user:U00SYNTH01",
    ...overrides,
  };
}

function fullRuntimeResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...fullSlackEventResource(),
    chatId: "chat_synth01",
    targetId: "target_synth01",
    targetPolicy: "default",
    outputType: "text",
    ...overrides,
  };
}

function registryCatalogStore(): unknown {
  return {
    schemaVersion: 2,
    people: [],
    externalIdentities: [],
    subjects: [{ id: "person:test", kind: "person", status: "active" }],
    grantBundles: [],
    grants: [
      { id: "g_output", subjectId: "person:test", capabilityId: "output.text.send", grantKind: "capability", resource: { selectors: { surfaceKind: "*" } }, actions: ["*"], status: "active", enforcement: "enforcing" },
      { id: "g_drift", subjectId: "person:test", capabilityId: "madeup.capability", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
    ],
  };
}

test("brain capability catalog endpoint serves vocabulary from the codex-chat registry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-catalog-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeJson(path.join(root, "capabilities.json"), registryCatalogStore());
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/capabilities/catalog`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as {
        storeAvailable: boolean;
        registryAvailable: boolean;
        registryVersion: number | null;
        registryCapabilityCount: number;
        groups: Array<{ id: string; status: string; synthetic?: boolean; childCount: number; presentChildCount: number; children: Array<{ id: string; present: boolean; description?: string; selectorKeys: string[]; riskTier?: string; deprecated?: boolean; grantable: boolean; registryKnown: boolean; provenance: string }> }>;
        counts: { groups: number; uncategorized: number };
      };
      assert.equal(payload.storeAvailable, true);
      assert.equal(payload.registryAvailable, true);
      assert.equal(payload.registryVersion, 7);
      assert.equal(payload.registryCapabilityCount, SYNTHETIC_REGISTRY.capabilities.length);
      const groupIds = payload.groups.map((group) => group.id);
      assert.deepEqual(groupIds.slice(0, 2), ["output", "runtime"]);
      assert.ok(groupIds.includes("crm"), "curated crm group present alongside registry groups");
      assert.ok(groupIds.includes("projects"), "curated projects group present alongside registry groups");
      assert.equal(groupIds.at(-1), "other");
      const byId = Object.fromEntries(payload.groups.map((group) => [group.id, group]));
      // Registry entries carry metadata from codex-chat.
      assert.equal(byId.output.children.find((child) => child.id === "output.text.send")?.present, true);
      assert.equal(byId.output.children.find((child) => child.id === "output.text.send")?.description, "Send text output.");
      assert.deepEqual(byId.output.children.find((child) => child.id === "output.text.send")?.selectorKeys, ["surfaceKind", "channelId"]);
      assert.equal(byId.output.children.find((child) => child.id === "output.text.send")?.riskTier, "medium");
      assert.equal(byId.output.children.find((child) => child.id === "output.text.send")?.provenance, "registry");
      assert.equal(byId.crm.children.find((child) => child.id === "crm.contact.read")?.provenance, "curated");
      assert.deepEqual(byId.crm.children.find((child) => child.id === "crm.contact.read")?.selectorKeys, ["scope", "contactId", "businessId", "correspondenceId"]);
      assert.equal(byId.runtime.children.find((child) => child.id === "runtime.admin")?.deprecated, true);
      assert.equal(byId.runtime.children.find((child) => child.id === "runtime.admin")?.grantable, false);
      // Store ids absent from the registry surface as synthetic drift, not hidden.
      assert.equal(byId.other.synthetic, true);
      const drift = byId.other.children.find((child) => child.id === "madeup.capability");
      assert.equal(drift?.present, true);
      assert.equal(drift?.registryKnown, false);
      assert.equal(drift?.provenance, "store");
      assert.equal(drift?.grantable, true);
      assert.equal(payload.counts.uncategorized, 1);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain capability catalog degrades to store ids when the registry socket is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-catalog-degraded-"));
  try {
    await writeJson(path.join(root, "capabilities.json"), registryCatalogStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/capabilities/catalog`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as {
        registryAvailable: boolean;
        registryVersion: number | null;
        groups: Array<{ id: string; synthetic?: boolean; children: Array<{ id: string; riskTier?: string; description?: string; selectorKeys: string[] }> }>;
        counts: { uncategorized: number };
      };
      assert.equal(payload.registryAvailable, false);
      assert.equal(payload.registryVersion, null);
      assert.equal(payload.counts.uncategorized, 1);
      assert.ok(payload.groups.some((group) => group.id === "projects"), "curated vocabulary remains visible without registry");
      assert.equal(payload.groups.at(-1)?.id, "other");
      const output = payload.groups.find((group) => group.id === "output");
      assert.deepEqual(output?.children.find((child) => child.id === "output.text.send")?.selectorKeys, RUNTIME_SELECTOR_KEYS);
      assert.equal(output?.children.find((child) => child.id === "output.text.send")?.description, undefined);
      assert.equal(output?.children.find((child) => child.id === "output.text.send")?.riskTier, undefined);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain capability registry failures are not cached across recovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-registry-recovery-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeJson(path.join(root, "capabilities.json"), registryCatalogStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const down = await fetch(`${baseUrl}/api/admin/brain/capabilities/catalog`, { headers: authHeaders() });
      assert.equal(down.status, 200);
      assert.equal(((await down.json()) as any).registryAvailable, false);

      ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY });
      const recovered = await fetch(`${baseUrl}/api/admin/brain/capabilities/catalog`, { headers: authHeaders() });
      assert.equal(recovered.status, 200);
      const payload = await recovered.json() as { registryAvailable: boolean; registryVersion: number | null };
      assert.equal(payload.registryAvailable, true);
      assert.equal(payload.registryVersion, SYNTHETIC_REGISTRY.registryVersion);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain capability registry concurrent callers share one in-flight fetch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-registry-singleflight-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeJson(path.join(root, "capabilities.json"), registryCatalogStore());
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY, responseDelayMs: 50 });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const [catalog, users, status] = await Promise.all([
        fetch(`${baseUrl}/api/admin/brain/capabilities/catalog`, { headers: authHeaders() }),
        fetch(`${baseUrl}/api/admin/brain/users`, { headers: authHeaders() }),
        fetch(`${baseUrl}/api/admin/brain/status`, { headers: authHeaders() }),
      ]);
      assert.equal(catalog.status, 200);
      assert.equal(users.status, 200);
      assert.equal(status.status, 200);
      assert.equal(ipc?.requests.filter((request) => request.type === "get_capability_registry").length, 1);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain users endpoint summarizes people, identities, grants, and system subjects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-users-"));
  try {
    await writeLiveStore(root);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/users`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as {
        storeAvailable: boolean;
        registryAvailable: boolean;
        registryVersion: number | null;
        registryCapabilityCount: number;
        people: Array<{ id: string; displayName: string; identities: Array<{ provider: string; externalId: string; linkedAt?: string }>; grants: { total: number; grantedGroupCount: number; totalGroupCount: number; byGroup: Array<{ id: string; granted: boolean }> } }>;
        systemSubjects: Array<{ id: string; grants: { total: number; capabilityIds: string[] } }>;
        counts: { people: number; systemSubjects: number };
      };
      assert.equal(payload.storeAvailable, true);
      assert.equal(payload.registryAvailable, false);
      assert.equal(payload.registryVersion, null);
      assert.equal(payload.registryCapabilityCount, 0);
      assert.equal(payload.counts.people, 1);
      const tim = payload.people.find((person) => person.id === "person_alpha");
      assert.ok(tim, "person_alpha present");
      // Two linked identities (telegram + slack); the observed-unlinked slack
      // identity has no personId and must not attach to this person.
      assert.deepEqual(tim.identities.map((identity) => identity.provider).sort(), ["slack", "telegram"]);
      for (const identity of tim.identities) assert.ok(identity.linkedAt, "identity linked date present");
      assert.ok(tim.grants.total > 0);
      assert.ok(tim.grants.grantedGroupCount > 0);
      assert.equal(tim.grants.byGroup.find((group) => group.id === "projects")?.granted, true);
      // System subjects are separated from people.
      const runtime = payload.systemSubjects.find((subject) => subject.id === "system:codex-chat-runtime");
      assert.ok(runtime, "system subject present");
      assert.ok(runtime.grants.capabilityIds.includes("system.callback.enqueue"));
      assert.equal(payload.people.some((person) => person.id.startsWith("system:")), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain catalog and users endpoints fail closed with 503 when the store is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-nostore-"));
  try {
    // No capabilities.json written: the store is unavailable.
    await withServer(config(root), authDeps(), async (baseUrl) => {
      for (const route of ["capabilities/catalog", "users"]) {
        const res = await fetch(`${baseUrl}/api/admin/brain/${route}`, { headers: authHeaders() });
        assert.equal(res.status, 503, `${route} should 503 when the store is unavailable`);
        const payload = await res.json() as { error: string; reason: string };
        assert.equal(payload.error, "capability_store_unavailable");
        // The store path is never echoed in the surfaced reason.
        assert.equal(payload.reason, "brain_store_unavailable");
        assert.equal(JSON.stringify(payload).includes(root), false);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function disabledSubjectStore(): unknown {
  return {
    schemaVersion: 2,
    people: [{ id: "p_dis", displayName: "Disabled Subject Owner", status: "active", personType: "human", primarySubjectId: "person:dis", subjectIds: ["person:dis", "identity:dis_off"] }],
    externalIdentities: [],
    subjects: [
      { id: "person:dis", kind: "person", personId: "p_dis", status: "active" },
      { id: "identity:dis_off", kind: "external_identity", personId: "p_dis", status: "disabled" },
    ],
    grantBundles: [],
    grants: [
      // Enforcing grant on a DISABLED subject: the authorizer never resolves it,
      // so it must not count as in force.
      { id: "g_disabled", subjectId: "identity:dis_off", capabilityId: "projects.read", grantKind: "capability", actions: ["read"], resource: { selectors: { projectId: "*" } }, status: "active", enforcement: "enforcing" },
      // Enforcing grant on the ACTIVE subject for a capability id the catalog does
      // not map to any group: must surface under "other".
      { id: "g_other", subjectId: "person:dis", capabilityId: "madeup.capability", grantKind: "capability", actions: ["read"], resource: { selectors: {} }, status: "active", enforcement: "enforcing" },
    ],
  };
}

test("brain users endpoint excludes disabled subjects and surfaces unmapped grants under 'other'", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-users-disabled-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeJson(path.join(root, "capabilities.json"), disabledSubjectStore());
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: { registryVersion: 1, capabilities: SYNTHETIC_REGISTRY.capabilities.slice(0, 1) } });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const catalogRes = await fetch(`${baseUrl}/api/admin/brain/capabilities/catalog`, { headers: authHeaders() });
      assert.equal(catalogRes.status, 200);
      const catalog = await catalogRes.json() as { groups: Array<{ id: string; synthetic?: boolean }> };
      assert.equal(catalog.groups.find((group) => group.id === "other")?.synthetic, true);

      const res = await fetch(`${baseUrl}/api/admin/brain/users`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as {
        people: Array<{
          id: string;
          activeSubjectIds: string[];
          disabledSubjects: Array<{ id: string; status?: string; grantCount: number; inForce: number }>;
          grants: { inForce: number; byGroup: Array<{ id: string; granted: boolean; grantedChildCount: number }> };
        }>;
      };
      const person = payload.people.find((p) => p.id === "p_dis");
      assert.ok(person, "p_dis present");
      // The active subject resolves; the disabled subject does not.
      assert.deepEqual(person.activeSubjectIds, ["person:dis"]);
      // The disabled subject's enforcing projects grant is not in force.
      const projects = person.grants.byGroup.find((g) => g.id === "projects");
      assert.equal(projects?.granted, false);
      assert.equal(projects?.grantedChildCount, 0);
      const disabled = person.disabledSubjects.find((s) => s.id === "identity:dis_off");
      assert.ok(disabled, "disabled subject surfaced");
      assert.equal(disabled.status, "disabled");
      assert.equal(disabled.grantCount, 1);
      assert.equal(disabled.inForce, 0);
      // The active subject's grant on an unmapped capability id shows under "other".
      const other = person.grants.byGroup.find((g) => g.id === "other");
      assert.ok(other, "'other' group present");
      assert.equal(other.granted, true);
      assert.equal(person.grants.inForce, 1);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain dry-run check reproduces real codex-chat decisions against the enforced store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-check-real-"));
  try {
    await writeLiveStore(root);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      for (const decision of REAL_DECISIONS) {
        const res = await fetch(`${baseUrl}/api/admin/brain/capabilities/check`, {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ actorId: decision.actorId, operation: decision.operation, action: decision.action, resource: decision.resource }),
        });
        assert.equal(res.status, 200);
        const payload = await res.json() as { allowed: boolean; reason: string; subjectId: string };
        assert.equal(payload.allowed, decision.allowed, `${decision.name}: expected allowed=${decision.allowed}, got ${payload.allowed} (${payload.reason})`);
        assert.equal(payload.subjectId, decision.actorId);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain pending users endpoint groups recent unlinked Slack denials and excludes linked identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-pending-users-"));
  try {
    await writeJson(path.join(root, "capabilities.json"), pendingSlackStore());
    const denied = (day: string, minute: string, userId: string, channelId: string, actorDisplayName?: string) => ({
      checkedAt: `${day}T10:${minute}:00.000Z`,
      actorId: `slack:team:T00SYNTH01:user:${userId}`,
      actorDisplayName,
      operation: "slack.event.receive",
      action: "receive",
      allowed: false,
      reason: "actor_not_linked_to_brain_subject",
      resourceSummary: { teamId: "T00SYNTH01", channelId },
    });
    await writeDecisionDay(root, "2026-06-30", [denied("2026-06-30", "01", "U00SYNTHOLD", "C00SYNTHOLD", "Older Synthetic")]);
    for (const day of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]) {
      await writeDecisionDay(root, day, [{ checkedAt: `${day}T10:00:00.000Z`, actorId: "telegram:system", allowed: false, reason: "actor_not_linked_to_brain_subject", resourceSummary: {} }]);
    }
    await writeDecisionDay(root, "2026-07-06", [
      denied("2026-07-06", "02", "U00SYNTH01", "C00SYNTH01", "First Synthetic"),
      denied("2026-07-06", "03", "U00SYNTHLINK", "C00SYNTH01", "Already Linked"),
      { ...denied("2026-07-06", "04", "U00SYNTHGLOB", "C00SYNTH02", "Teamless Match"), actorId: "slack:team:T00SYNTH02:user:U00SYNTHGLOB", resourceSummary: { teamId: "T00SYNTH02", channelId: "C00SYNTH02" } },
    ]);
    await writeDecisionDay(root, "2026-07-07", [
      denied("2026-07-07", "05", "U00SYNTH01", "C00SYNTH02", "Newest Synthetic"),
      { ...denied("2026-07-07", "06", "U00SYNTHOBS", "C00SYNTH03", "Observed Synthetic"), reason: "identity_inactive:observed_unlinked" },
      { ...denied("2026-07-07", "07", "U00SYNTHALLOW", "C00SYNTH04"), allowed: true },
      denied("2026-07-07", "08", "U00SYNTHSUSP", "C00SYNTH05", "Suspended Synthetic"),
      { ...denied("2026-07-07", "09", "U00SYNTH01", "C00SYNTH06"), actorDisplayName: undefined },
      { ...denied("2026-07-07", "10", "U00SYNTHSUSPENDED", "C00SYNTH07"), reason: "person_inactive:suspended" },
    ]);

    await withServer(config(root, { capabilityDecisionsDir: "capability_decisions" }), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/users/pending`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as { storeHash: string; people: any[]; counts: { people: number } };
      assert.match(payload.storeHash, /^[a-f0-9]{64}$/);
      assert.equal(payload.counts.people, 3);
      assert.deepEqual(payload.people.map((person) => person.userId), ["U00SYNTH01", "U00SYNTHSUSP", "U00SYNTHOBS"]);
      const pending = payload.people.find((person) => person.userId === "U00SYNTH01");
      assert.equal(pending.displayName, "Newest Synthetic");
      assert.deepEqual(pending.channelIds, ["C00SYNTH01", "C00SYNTH02", "C00SYNTH06"]);
      assert.equal(pending.count, 3);
      assert.equal(pending.firstSeen, "2026-07-06T10:02:00.000Z");
      assert.equal(pending.lastSeen, "2026-07-07T10:09:00.000Z");
      assert.equal(pending.lastReason, "actor_not_linked_to_brain_subject");
      assert.equal(payload.people.find((person) => person.userId === "U00SYNTHOBS").lastReason, "identity_inactive:observed_unlinked");
      assert.equal(payload.people.find((person) => person.userId === "U00SYNTHSUSP").lastReason, "actor_not_linked_to_brain_subject");
      assert.equal(payload.people.some((person) => person.userId === "U00SYNTHOLD"), false, "eighth-oldest daily file ignored");
      assert.equal(payload.people.some((person) => person.userId === "U00SYNTHLINK"), false, "exact linked identity excluded");
      assert.equal(payload.people.some((person) => person.userId === "U00SYNTHGLOB"), false, "teamless linked identity excludes any team");
      assert.equal(payload.people.some((person) => person.userId === "U00SYNTHSUSPENDED"), false, "person_inactive denials are not pending onboarding");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain pending users endpoint fails closed when the capability store is unreadable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-pending-no-store-"));
  try {
    await writeDecisionDay(root, "2026-07-07", [{
      checkedAt: "2026-07-07T10:00:00.000Z",
      actorId: "slack:team:T00SYNTH01:user:U00SYNTH01",
      allowed: false,
      reason: "actor_not_linked_to_brain_subject",
      resourceSummary: { teamId: "T00SYNTH01", channelId: "C00SYNTH01" },
    }]);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/users/pending`, { headers: authHeaders() });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "capability_store_unavailable", reason: "brain_store_unavailable" });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function craftedStore(): unknown {
  return {
    schemaVersion: 2,
    people: [{ id: "p_test", status: "active", primarySubjectId: "person:test", subjectIds: ["person:test"] }],
    externalIdentities: [],
    subjects: [{ id: "person:test", kind: "person", personId: "p_test" }],
    grantBundles: [],
    grants: [
      { id: "g_ok", subjectId: "person:test", capabilityId: "projects.read", grantKind: "capability", actions: ["read"], resource: { selectors: { projectId: "*" } }, status: "active", enforcement: "enforcing" },
      { id: "g_expired", subjectId: "person:test", capabilityId: "calendar.event.read", grantKind: "capability", actions: ["read"], resource: { selectors: { calendarId: "*" } }, status: "active", enforcement: "enforcing", expiresAt: "2020-01-01T00:00:00.000Z" },
      { id: "g_nonenf", subjectId: "person:test", capabilityId: "crm.contact.read", grantKind: "capability", actions: ["read"], resource: { selectors: { contactId: "*" } }, status: "active", enforcement: "non_enforcing" },
    ],
  };
}

test("brain dry-run check covers allow, deny, expired, missing-selector, and non-enforcing cases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-check-crafted-"));
  try {
    await writeJson(path.join(root, "capabilities.json"), craftedStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
      async function check(body: unknown): Promise<{ allowed: boolean; reason: string }> {
        const res = await fetch(`${baseUrl}/api/admin/brain/capabilities/check`, {
          method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify(body),
        });
        assert.equal(res.status, 200);
        return await res.json() as { allowed: boolean; reason: string };
      }
      // allow: enforcing grant matches capability + covered selector.
      assert.equal((await check({ subjectId: "person:test", operation: "projects.read", resource: { projectId: "p1" } })).allowed, true);
      // deny: no grant for this capability.
      assert.equal((await check({ subjectId: "person:test", operation: "todos.item.read", resource: { listId: "l1" } })).allowed, false);
      // expired grant is denied.
      assert.equal((await check({ subjectId: "person:test", operation: "calendar.event.read", resource: { calendarId: "c1" } })).allowed, false);
      // missing selector coverage: resource carries a concrete key the grant does not select.
      assert.equal((await check({ subjectId: "person:test", operation: "projects.read", resource: { projectId: "p1", repoAlias: "brain" } })).allowed, false);
      // non-enforcing grant is denied (matches codex-chat authorize()).
      assert.equal((await check({ subjectId: "person:test", operation: "crm.contact.read", resource: { contactId: "c1" } })).allowed, false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain dry-run check requires operation and a subject/actor and fails closed without a store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-check-guard-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const missingOp = await fetch(`${baseUrl}/api/admin/brain/capabilities/check`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ subjectId: "person:test" }) });
      assert.equal(missingOp.status, 400);
      const missingActor = await fetch(`${baseUrl}/api/admin/brain/capabilities/check`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ operation: "projects.read" }) });
      assert.equal(missingActor.status, 400);
      // A missing resource is rejected: the runtime always sends a concrete
      // resource, and defaulting to {} would neuter strict selector coverage.
      const missingResource = await fetch(`${baseUrl}/api/admin/brain/capabilities/check`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ subjectId: "person:test", operation: "projects.read" }) });
      assert.equal(missingResource.status, 400);
      assert.equal((await missingResource.json() as { error: string }).error, "resource_required");
      // No store on disk: fail-closed deny, not a silent allow.
      const noStore = await fetch(`${baseUrl}/api/admin/brain/capabilities/check`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ subjectId: "person:test", operation: "projects.read", resource: {} }) });
      assert.equal(noStore.status, 200);
      const payload = await noStore.json() as { allowed: boolean; reason: string };
      assert.equal(payload.allowed, false);
      assert.equal(payload.reason, "brain_store_unavailable");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain audit endpoint merges, filters, paginates, and never echoes secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-audit-"));
  try {
    const day = "2026-07-05";
    const t = (n: number) => `2026-07-05T10:0${n}:00.000Z`;
    // Brain admin (operations) audit JSONL.
    await writeFile(path.join(root, "audit.jsonl"),
      `${JSON.stringify({ at: t(0), action: "codex-chat.operation.execute", operation: "restart", status: 0, adminEmail: "tim@example.test" })}\n` +
      `${JSON.stringify({ at: t(1), action: "codex-chat.env.write", keys: ["SLACK_BOT_TOKEN"], adminEmail: "tim@example.test" })}\n`);
    // codex-chat capability decision records (with a token planted in a reason
    // and a resource field to prove scrubbing).
    const decisionsDir = path.join(root, "codex-chat", "data", "state", "capability_decisions");
    // Fake Slack tokens are assembled at runtime so no secret-shaped literal
    // appears in the source (GitHub push protection matches the raw pattern).
    const fakeBotToken = ["xoxb", "1111111111", "supersecrettoken"].join("-");
    const fakeBotToken2 = ["xoxb", "2222222222", "anothersecret"].join("-");
    const fakeAppToken = ["xapp", "1", "A00SYNTH", "9999", "appsecret"].join("-");
    await writeFileRecursive(path.join(decisionsDir, `${day}.jsonl`),
      `${JSON.stringify({ checkedAt: t(2), actorId: "telegram:user:900000001", operation: "telegram.event.receive", action: "receive", allowed: true, resourceSummary: { chatId: "900000001" } })}\n` +
      `${JSON.stringify({ checkedAt: t(3), actorId: "slack:team:T:user:U", operation: "slack.event.receive", action: "receive", allowed: false, reason: `denied token ${fakeBotToken} and app ${fakeAppToken}`, resourceSummary: { note: fakeBotToken2, channelId: "C1" } })}\n` +
      `${JSON.stringify({ checkedAt: t(4), actorId: "telegram:system", operation: "system.callback.enqueue", action: "enqueue", allowed: false, reason: "actor_not_linked_to_brain_subject", resourceSummary: {} })}\n`);
    await withServer(config(root, { capabilityDecisionsDir: decisionsDir }), authDeps(), async (baseUrl) => {
      async function audit(query: string): Promise<{ rows: Array<{ type: string; actor: string; operation: string; result: string; target: string; reason?: string }>; total: number; nextCursor: string | null }> {
        const res = await fetch(`${baseUrl}/api/admin/brain/audit${query}`, { headers: authHeaders() });
        assert.equal(res.status, 200);
        return await res.json() as never;
      }
      // Merged feed, newest first.
      const all = await audit("");
      assert.equal(all.total, 5);
      assert.equal(all.rows[0].operation, "system.callback.enqueue");
      assert.ok(all.rows.some((row) => row.type === "operations"));
      assert.ok(all.rows.some((row) => row.type === "capability"));
      // Type filter.
      const capOnly = await audit("?type=capability");
      assert.equal(capOnly.total, 3);
      assert.ok(capOnly.rows.every((row) => row.type === "capability"));
      const opsOnly = await audit("?type=operations");
      assert.equal(opsOnly.total, 2);
      // Outcome filter (denial-centric default emphasis is a filter here).
      const denied = await audit("?outcome=denied");
      assert.equal(denied.total, 2);
      assert.ok(denied.rows.every((row) => row.result === "denied"));
      // Actor filter.
      const tg = await audit("?actor=telegram");
      assert.ok(tg.rows.every((row) => row.actor.includes("telegram")));
      // Pagination via opaque cursor.
      const page1 = await audit("?limit=2");
      assert.equal(page1.rows.length, 2);
      assert.ok(page1.nextCursor);
      // A newer record arriving between page-1 and page-2 must not shift page 2
      // (anchored pagination): no duplicate, no skip.
      await appendFile(path.join(decisionsDir, `${day}.jsonl`),
        `${JSON.stringify({ checkedAt: t(5), actorId: "telegram:user:900000001", operation: "runtime.status.read", action: "read", allowed: true, resourceSummary: {} })}\n`);
      const page2 = await audit(`?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`);
      assert.ok(page2.rows.length >= 1);
      assert.notEqual(page1.rows[0].operation, page2.rows[0].operation);
      const pagedOps = [...page1.rows, ...page2.rows].map((row) => row.operation);
      // The newer record is excluded from the anchored page; no page-1 row repeats on page 2.
      assert.equal(pagedOps.includes("runtime.status.read"), false);
      assert.equal(new Set(pagedOps).size, pagedOps.length);
      // Restarting from page 1 surfaces the newer record.
      const restart = await audit("?type=capability&limit=10");
      assert.ok(restart.rows.some((row) => row.operation === "runtime.status.read"));
      // Secret non-echo across the whole response.
      const raw = JSON.stringify(await audit(""));
      assert.equal(raw.includes(fakeBotToken), false);
      assert.equal(raw.includes(fakeBotToken2), false);
      // xapp app-level tokens are scrubbed too.
      assert.equal(raw.includes(fakeAppToken), false);
      assert.match(raw, /redacted-slack-token/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readFileTail loops short reads and never stringifies unread buffer bytes", async () => {
  const source = Buffer.from("alpha\nbeta\ngamma\n", "utf8");
  let closed = false;
  const text = await readFileTail("mock-audit.jsonl", source.length, async () => ({
    stat: async () => ({ size: source.length }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      buffer.fill(0x58, offset, offset + length);
      const bytesRead = Math.min(3, length, Math.max(0, source.length - position));
      if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
    close: async () => { closed = true; },
  }));
  assert.equal(text, source.toString("utf8"));
  assert.equal(text.includes("X"), false);
  assert.equal(closed, true);
});

// --- §6.5 WRITES: mutations, impact preview, refusal rails, migration --------

async function jsonRequest(baseUrl: string, method: string, route: string, body?: unknown): Promise<{ status: number; payload: any }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...authHeaders(), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, payload: await res.json() };
}

// A minimal single-admin store: one person with a linked Telegram identity whose
// primary subject holds the sole capability-admin grant. Used for self-lockout.
function soleAdminStore(): string {
  return JSON.stringify({
    schemaVersion: 2,
    people: [{ id: "person_admin", displayName: "Admin", status: "active", personType: "human", primarySubjectId: "person:person_admin", identityIds: ["identity_telegram_900000009"], subjectIds: ["person:person_admin"] }],
    externalIdentities: [{ id: "identity_telegram_900000009", provider: "telegram", providerUserId: "900000009", personId: "person_admin", status: "linked" }],
    identityProofs: [],
    subjects: [{ id: "person:person_admin", personId: "person_admin", kind: "person", status: "active" }],
    grants: [{ id: "grant_admin_capadmin", subjectId: "person:person_admin", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" }],
  });
}

// A placeholder-laden store modeled on the plan §2 seed placeholders that the
// migration must remove; plus one non-enforcing grant to convert. The linked
// telegram identity 900000001 (7 zeros, not the exact zeroed placeholder token)
// and person:person_alpha are REAL and must be retained. person_alpha holds a
// capability-admin grant so the migrated store keeps an effective admin (the
// migration self-lockout rail). system:codex-chat-runtime is NOT a zeroed-seed
// placeholder and holds two ACTIVE enforcing grants the running assistant
// depends on: both the subject and those grants must survive migration.
function placeholderStore(): string {
  return JSON.stringify({
    schemaVersion: 2,
    people: [{ id: "person_alpha", displayName: "Alpha", status: "active", personType: "human", primarySubjectId: "person:person_alpha", identityIds: ["identity_telegram_900000001", "identity_addable_x"], subjectIds: ["person:person_alpha"] }],
    externalIdentities: [
      { id: "identity_telegram_900000001", provider: "telegram", providerUserId: "900000001", personId: "person_alpha", status: "linked" },
      { id: "identity_addable_x", provider: "slack", providerUserId: "U00000000", providerTeamId: "T00000000", status: "addable_placeholder" },
    ],
    identityProofs: [],
    subjects: [
      { id: "person:person_alpha", personId: "person_alpha", kind: "person", status: "active" },
      { id: "slack:workspace:T00000000", kind: "slack_workspace" },
      { id: "slack:user:T00000000:U00000000", kind: "slack_user" },
      { id: "slack:channel:T00000000:C00000000", kind: "slack_channel" },
      { id: "system:codex-chat-runtime", kind: "system" },
    ],
    grants: [
      { id: "g_real", subjectId: "person:person_alpha", capabilityId: "projects.read", grantKind: "capability", resource: { selectors: {} }, actions: ["read"], status: "active", enforcement: "non_enforcing" },
      { id: "g_admin", subjectId: "person:person_alpha", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
      { id: "g_example", subjectId: "slack:channel:T00000000:C00000000", capabilityId: "slack.channel.read", grantKind: "capability", resource: { selectors: {} }, actions: ["read"], status: "example", enforcement: "non_enforcing" },
      { id: "g_runtime", subjectId: "system:codex-chat-runtime", capabilityId: "system.callback.enqueue", grantKind: "capability", resource: { selectors: {} }, actions: ["enqueue"], status: "active", enforcement: "enforcing" },
      { id: "g_runtime_deliver", subjectId: "system:codex-chat-runtime", capabilityId: "subagents.result.deliver", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
    ],
  });
}

test("brain capability writes round-trip create/link/grant/revoke visible in reads and dry-run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-writes-"));
  try {
    await writeLiveStore(root);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      // Create a person.
      const created = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Beta Operator" });
      assert.equal(created.status, 200);
      const personId = created.payload.detail.personId as string;
      assert.match(personId, /^person_/);

      // Link a Telegram identity (synthetic id).
      const linked = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/identities`, { provider: "telegram", externalId: "900000123" });
      assert.equal(linked.status, 200);
      assert.equal(linked.payload.detail.identityId, "identity_telegram_900000123");

      // Grant a catalog GROUP (expands to children server-side).
      const grantGroup = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { groupId: "crm" });
      assert.equal(grantGroup.status, 200);
      assert.equal(grantGroup.payload.detail.expandedFromGroup, true);
      assert.ok(grantGroup.payload.detail.grantIds.length >= 3);
      // Impact preview shows the newly-allowed crm operations on the telegram surface.
      assert.ok(grantGroup.payload.impact.summary.newlyAllowedCount > 0);

      // Grant an INDIVIDUAL capability.
      const grantOne = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "todos.item.read" });
      assert.equal(grantOne.status, 200);
      assert.equal(grantOne.payload.detail.expandedFromGroup, false);
      assert.equal(grantOne.payload.detail.grantIds.length, 1);

      // GET /users reflects the new person, identity, and granted groups.
      const users = (await (await fetch(`${baseUrl}/api/admin/brain/users`, { headers: authHeaders() })).json()) as any;
      const beta = users.people.find((p: any) => p.id === personId);
      assert.ok(beta, "created person present");
      assert.deepEqual(beta.identities.map((i: any) => i.provider), ["telegram"]);
      assert.equal(beta.grants.byGroup.find((g: any) => g.id === "crm")?.granted, true);
      assert.equal(beta.grants.byGroup.find((g: any) => g.id === "todos")?.granted, true);

      // Dry-run authorize confirms the grant takes effect for the linked surface.
      const check = await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", { actorId: "telegram:user:900000123", operation: "crm.contact.read", resource: {} });
      assert.equal(check.payload.allowed, true);

      // Revoke one crm grant (status change, not deletion) and confirm denial.
      const grantId = grantGroup.payload.detail.grantIds[0] as string;
      const capabilityId = grantGroup.payload.detail.grantedCapabilityIds[0] as string;
      const revoke = await jsonRequest(baseUrl, "DELETE", `/api/admin/brain/users/${personId}/grants/${grantId}`);
      assert.equal(revoke.status, 200);
      assert.equal(revoke.payload.impact.summary.newlyDeniedCount > 0, true);
      const afterRevoke = await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", { actorId: "telegram:user:900000123", operation: capabilityId, resource: {} });
      assert.equal(afterRevoke.payload.allowed, false);
      // History preserved: the grant row survives with status revoked.
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      const revokedGrant = stored.grants.find((g: any) => g.id === grantId);
      assert.ok(revokedGrant, "revoked grant row retained");
      assert.equal(revokedGrant.status, "revoked");
      assert.ok(revokedGrant.revokedAt);

      // Unlink the identity denies that surface entirely.
      const unlink = await jsonRequest(baseUrl, "DELETE", `/api/admin/brain/users/${personId}/identities/identity_telegram_900000123`);
      assert.equal(unlink.status, 200);
      const afterUnlink = await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", { actorId: "telegram:user:900000123", operation: "todos.item.read", resource: {} });
      assert.equal(afterUnlink.payload.allowed, false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function teamlessSlackIdentityStore(): unknown {
  return {
    schemaVersion: 2,
    people: [
      { id: "person_existing", displayName: "Existing Slack", status: "active", personType: "human", primarySubjectId: "person:existing", identityIds: ["identity_slack_teamless_U00SYNTHWILD"], subjectIds: ["person:existing"] },
      { id: "person_target", displayName: "Target Slack", status: "active", personType: "human", primarySubjectId: "person:target", identityIds: [], subjectIds: ["person:target"] },
    ],
    externalIdentities: [
      { id: "identity_slack_teamless_U00SYNTHWILD", provider: "slack", providerUserId: "U00SYNTHWILD", personId: "person_existing", status: "linked" },
    ],
    identityProofs: [],
    subjects: [
      { id: "person:existing", personId: "person_existing", kind: "person", status: "active" },
      { id: "person:target", personId: "person_target", kind: "person", status: "active" },
    ],
    grants: [],
  };
}

test("brain link_identity rejects team-scoped Slack links shadowed by a teamless identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-link-teamless-"));
  try {
    const storePath = path.join(root, "capabilities.json");
    await writeJson(storePath, teamlessSlackIdentityStore());
    const before = await readFile(storePath);
    await assert.rejects(
      () => commitMutation(storePath, { kind: "link_identity", personId: "person_target", provider: "slack", externalId: "U00SYNTHWILD", teamId: "T00SYNTH01", adminEmail: TEST_ADMIN_EMAIL }),
      (error: unknown) =>
        error instanceof CapabilityWriteError &&
        error.code === "identity_conflict" &&
        error.details?.existingPersonId === "person_existing",
    );
    assert.ok(before.equals(await readFile(storePath)), "conflicting link wrote nothing");

    const ok = await commitMutation(storePath, { kind: "link_identity", personId: "person_target", provider: "slack", externalId: "U00SYNTHOK", teamId: "T00SYNTH01", adminEmail: TEST_ADMIN_EMAIL });
    assert.equal(ok.outcome.changed, true);
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    assert.ok(stored.externalIdentities.some((identity: any) => identity.id === "identity_slack_T00SYNTH01_U00SYNTHOK" && identity.personId === "person_target"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function onboardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: "Slack Pending Person",
    identity: { provider: "slack", externalId: "U00SYNTHON", teamId: "T00SYNTH01" },
    grants: [
      { capabilityId: "slack.event.receive", selectors: { teamId: "T00SYNTH01" } },
      { capabilityId: "assistant.run", selectors: { teamId: "T00SYNTH01" } },
      { capabilityId: "output.text.send", selectors: { surfaceKind: "slack", teamId: "T00SYNTH01" } },
    ],
    ...overrides,
  };
}

test("brain team-scoped Slack receive grant authorizes full runtime Slack event resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-slack-scoped-grant-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeLiveStore(root);
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: ONBOARD_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const created = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Slack Scoped Person" });
      const personId = created.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/identities`, { provider: "slack", externalId: "U00SYNTH01", teamId: "T00SYNTH01" });

      const grant = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "slack.event.receive", selectors: { teamId: "T00SYNTH01" } });
      assert.equal(grant.status, 200);

      const store = parseCapabilityStore(await readFile(path.join(root, "capabilities.json"), "utf8"));
      const written = store.grants?.find((row) => row.id === grant.payload.detail.grantIds[0]);
      assert.deepEqual(written?.resource?.selectors, runtimeSelectors({ teamId: "T00SYNTH01" }));

      const actor = { id: "slack:team:T00SYNTH01:user:U00SYNTH01", surfaceKind: "slack", surfaceUserId: "U00SYNTH01", teamId: "T00SYNTH01" };
      const allowed = evaluateAuthorization(store, {
        actor,
        requirement: { operation: "slack.event.receive", action: "receive", resource: fullSlackEventResource() },
      });
      assert.equal(allowed.allowed, true);

      const wrongTeam = evaluateAuthorization(store, {
        actor,
        requirement: { operation: "slack.event.receive", action: "receive", resource: fullSlackEventResource({ teamId: "T00SYNTH02" }) },
      });
      assert.equal(wrongTeam.allowed, false);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain onboard_person creates a person, Slack identity, and initial grants atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-onboard-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeLiveStore(root);
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: ONBOARD_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const onboard = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/onboard", onboardPayload());
      assert.equal(onboard.status, 200);
      assert.equal(onboard.payload.changed, true);
      assert.equal(onboard.payload.detail.provider, "slack");
      assert.equal(onboard.payload.detail.identityId, "identity_slack_T00SYNTH01_U00SYNTHON");
      assert.equal(onboard.payload.detail.grantIds.length, 3);
      assert.deepEqual([...onboard.payload.detail.grantedCapabilityIds].sort(), ["assistant.run", "output.text.send", "slack.event.receive"]);

      const personId = onboard.payload.detail.personId as string;
      const subjectId = onboard.payload.detail.subjectId as string;
      const stored = parseCapabilityStore(await readFile(path.join(root, "capabilities.json"), "utf8"));
      const person = stored.people?.find((row) => row.id === personId);
      assert.equal(person?.displayName, "Slack Pending Person");
      assert.ok(person?.identityIds?.includes("identity_slack_T00SYNTH01_U00SYNTHON"));
      const identity = stored.externalIdentities?.find((row) => row.id === "identity_slack_T00SYNTH01_U00SYNTHON");
      assert.equal(identity?.personId, personId);
      assert.equal(identity?.providerTeamId, "T00SYNTH01");
      const writtenGrants = (stored.grants ?? []).filter((grant) => onboard.payload.detail.grantIds.includes(grant.id));
      assert.equal(writtenGrants.length, 3);
      assert.ok(writtenGrants.every((grant) => grant.subjectId === subjectId && grant.status === "active" && grant.enforcement === "enforcing"));
      assert.deepEqual(writtenGrants.find((grant) => grant.capabilityId === "slack.event.receive")?.resource?.selectors, runtimeSelectors({ teamId: "T00SYNTH01" }));
      assert.deepEqual(writtenGrants.find((grant) => grant.capabilityId === "assistant.run")?.resource?.selectors, runtimeSelectors({ teamId: "T00SYNTH01" }));
      assert.deepEqual(writtenGrants.find((grant) => grant.capabilityId === "output.text.send")?.resource?.selectors, runtimeSelectors({ surfaceKind: "slack", teamId: "T00SYNTH01" }));

      const actor = { id: "slack:team:T00SYNTH01:user:U00SYNTHON", surfaceKind: "slack", surfaceUserId: "U00SYNTHON", teamId: "T00SYNTH01" };
      assert.equal(evaluateAuthorization(stored, { actor, requirement: { operation: "slack.event.receive", action: "receive", resource: fullSlackEventResource({ actorId: "slack:team:T00SYNTH01:user:U00SYNTHON" }) } }).allowed, true);
      assert.equal(evaluateAuthorization(stored, { actor, requirement: { operation: "assistant.run", action: "run", resource: fullRuntimeResource({ actorId: "slack:team:T00SYNTH01:user:U00SYNTHON" }) } }).allowed, true);
      assert.equal(evaluateAuthorization(stored, { actor, requirement: { operation: "output.text.send", action: "send", resource: fullRuntimeResource({ actorId: "slack:team:T00SYNTH01:user:U00SYNTHON" }) } }).allowed, true);
      assert.equal(evaluateAuthorization(stored, { actor, requirement: { operation: "output.text.send", action: "send", resource: fullRuntimeResource({ actorId: "slack:team:T00SYNTH01:user:U00SYNTHON", surfaceKind: "telegram" }) } }).allowed, false);

      const outputCheck = await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", {
        actorId: "slack:team:T00SYNTH01:user:U00SYNTHON",
        operation: "output.text.send",
        resource: { surfaceKind: "slack", teamId: "T00SYNTH01" },
      });
      assert.equal(outputCheck.payload.allowed, true);
      const telegramShapedOutput = await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", {
        actorId: "slack:team:T00SYNTH01:user:U00SYNTHON",
        operation: "output.text.send",
        resource: { surfaceKind: "telegram", teamId: "T00SYNTH01" },
      });
      assert.equal(telegramShapedOutput.payload.allowed, false);

      const auditLines = (await readFile(path.join(root, "capability-audit.jsonl"), "utf8")).split(/\n/).filter((line) => line.trim());
      const auditEvents = auditLines.map((line) => JSON.parse(line));
      assert.equal(auditEvents.filter((event: any) => event.action === "onboard_person").length, 1);
      assert.equal(auditEvents.some((event: any) => event.action === "person.created"), false);
      const onboardAudit = auditEvents.find((event: any) => event.action === "onboard_person");
      assert.equal(onboardAudit.displayName, "Slack Pending Person");
      assert.equal(onboardAudit.externalId, "U00SYNTHON");
      assert.equal(onboardAudit.teamId, "T00SYNTH01");
      assert.deepEqual([...onboardAudit.capabilityIds].sort(), ["assistant.run", "output.text.send", "slack.event.receive"]);
      assert.equal(onboardAudit.grantIds.length, 3);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain onboard_person duplicate identity rejects the whole mutation without writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-onboard-dup-"));
  try {
    const store = JSON.parse(LIVE_CAPABILITY_STORE_JSON);
    store.externalIdentities.push({ id: "identity_slack_T00SYNTH01_U00SYNTHDUP", provider: "slack", providerUserId: "U00SYNTHDUP", providerTeamId: "T00SYNTH01", personId: "person_alpha", status: "linked" });
    store.people[0].identityIds.push("identity_slack_T00SYNTH01_U00SYNTHDUP");
    await writeJson(path.join(root, "capabilities.json"), store);
    const before = await readFile(path.join(root, "capabilities.json"));
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const duplicate = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/onboard", onboardPayload({ identity: { provider: "slack", externalId: "U00SYNTHDUP", teamId: "T00SYNTH01" } }));
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.payload.error, "identity_conflict");
      assert.ok(before.equals(await readFile(path.join(root, "capabilities.json"))), "store bytes unchanged");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain onboard_person bad capability rejects the whole mutation without writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-onboard-bad-cap-"));
  try {
    await writeLiveStore(root);
    const before = await readFile(path.join(root, "capabilities.json"));
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const bad = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/onboard", onboardPayload({ grants: [{ capabilityId: "not.in.registry" }] }));
      assert.equal(bad.status, 400);
      assert.equal(bad.payload.error, "unknown_capability");
      assert.ok(before.equals(await readFile(path.join(root, "capabilities.json"))), "store bytes unchanged");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain onboard_person preview returns impact without writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-onboard-preview-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeLiveStore(root);
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: ONBOARD_REGISTRY });
    const before = await readFile(path.join(root, "capabilities.json"));
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const preview = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/onboard?preview=true", onboardPayload({ identity: { provider: "slack", externalId: "U00SYNTHPRE", teamId: "T00SYNTH01" } }));
      assert.equal(preview.status, 200);
      assert.equal(preview.payload.preview, true);
      assert.equal(preview.payload.detail.grantIds.length, 3);
      assert.ok(preview.payload.impact.summary.newlyAllowedCount > 0);
      assert.ok(before.equals(await readFile(path.join(root, "capabilities.json"))), "preview did not write");
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain onboard_person commit is hash-pinned and 409s a stale preview hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-onboard-hash-"));
  try {
    await writeLiveStore(root);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const payload = onboardPayload({
        identity: { provider: "slack", externalId: "U00SYNTHHASH", teamId: "T00SYNTH01" },
        grants: [{ capabilityId: "slack.event.receive" }],
      });
      const preview = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/onboard?preview=true", payload);
      assert.equal(preview.status, 200);
      const staleHash = preview.payload.storeHash as string;
      const drift = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Hash Drift Person" });
      assert.equal(drift.status, 200);
      assert.notEqual(drift.payload.storeHash, staleHash);

      const conflict = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/onboard", { ...payload, expectedStoreHash: staleHash });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.payload.error, "store_conflict");
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.equal(stored.externalIdentities.some((identity: any) => identity.id === "identity_slack_T00SYNTH01_U00SYNTHHASH"), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain capability preview returns diffs without writing (store byte-identical)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-preview-"));
  try {
    await writeLiveStore(root);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const created = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Preview Person" });
      const personId = created.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/identities`, { provider: "telegram", externalId: "900000200" });

      const before = await readFile(path.join(root, "capabilities.json"));
      const preview = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants?preview=true`, { groupId: "calendar" });
      assert.equal(preview.status, 200);
      assert.equal(preview.payload.preview, true);
      assert.ok(preview.payload.impact.summary.newlyAllowedCount > 0);
      // Body-flag form also previews without writing.
      const preview2 = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "calendar.event.read", preview: true });
      assert.equal(preview2.payload.preview, true);

      const after = await readFile(path.join(root, "capabilities.json"));
      assert.ok(before.equals(after), "store bytes unchanged after preview");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain capability write refuses self-lockout, concurrent modification, and unreachable store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-refuse-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      // Store unreachable (no file yet) => 503, never a silent success.
      const noStore = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "X" });
      assert.equal(noStore.status, 503);
      assert.equal(noStore.payload.error, "capability_store_unavailable");

      await writeFile(path.join(root, "capabilities.json"), soleAdminStore());

      // Self-lockout: revoking the sole capability-admin grant is refused.
      const lockGrant = await jsonRequest(baseUrl, "DELETE", "/api/admin/brain/users/person_admin/grants/grant_admin_capadmin");
      assert.equal(lockGrant.status, 422);
      assert.equal(lockGrant.payload.error, "self_lockout");

      // Self-lockout: unlinking the admin's last identity is refused.
      const lockIdentity = await jsonRequest(baseUrl, "DELETE", "/api/admin/brain/users/person_admin/identities/identity_telegram_900000009");
      assert.equal(lockIdentity.status, 422);
      assert.equal(lockIdentity.payload.error, "self_lockout");

      // Neither refusal wrote: the store is untouched.
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.equal(stored.grants[0].status, "active");

      // Concurrent modification: a stale expected hash is a retryable 409.
      const conflict = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_admin/grants", { capabilityId: "todos.item.read", expectedStoreHash: "deadbeef" });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.payload.error, "store_conflict");
      assert.equal(conflict.payload.retryable, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A1 (grant entries): a person with TWO active subjects, each holding a
// capability grant in the same catalog group, so the /users response must surface
// the underlying grant entries computed across BOTH subjects.
function multiSubjectStore(): string {
  return JSON.stringify({
    schemaVersion: 2,
    people: [{ id: "person_multi", displayName: "Multi", status: "active", personType: "human", primarySubjectId: "person:person_multi", identityIds: ["identity_telegram_900000123"], subjectIds: ["person:person_multi"] }],
    externalIdentities: [{ id: "identity_telegram_900000123", provider: "telegram", providerUserId: "900000123", personId: "person_multi", status: "linked" }],
    identityProofs: [],
    subjects: [
      { id: "person:person_multi", personId: "person_multi", kind: "person", status: "active" },
      { id: "subject:person_multi_secondary", personId: "person_multi", kind: "person", status: "active" },
    ],
    grants: [
      { id: "g_primary_crm_read", subjectId: "person:person_multi", capabilityId: "crm.contact.read", grantKind: "capability", resource: { selectors: { scope: "owner_all", contactId: "*" } }, actions: ["*"], status: "active", enforcement: "enforcing" },
      { id: "g_secondary_crm_write", subjectId: "subject:person_multi_secondary", capabilityId: "crm.contact.write", grantKind: "capability", resource: { selectors: { scope: "owner_all", contactId: "*" } }, actions: ["*"], status: "active", enforcement: "enforcing" },
    ],
  });
}

// A2/A3: two OVERLAPPING grants of the same capability on one subject, so
// revoking only one leaves it allowed (per-grant preview understates) but
// revoking BOTH in a batch denies it. person_ov also holds a capability-admin
// grant + linked identity so batch-revoking the crm grants never trips lockout.
function overlappingGrantsStore(): string {
  return JSON.stringify({
    schemaVersion: 2,
    people: [{ id: "person_ov", displayName: "Overlap", status: "active", personType: "human", primarySubjectId: "person:person_ov", identityIds: ["identity_telegram_900000123"], subjectIds: ["person:person_ov"] }],
    externalIdentities: [{ id: "identity_telegram_900000123", provider: "telegram", providerUserId: "900000123", personId: "person_ov", status: "linked" }],
    identityProofs: [],
    subjects: [{ id: "person:person_ov", personId: "person_ov", kind: "person", status: "active" }],
    grants: [
      { id: "g_ov_a", subjectId: "person:person_ov", capabilityId: "crm.contact.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
      { id: "g_ov_b", subjectId: "person:person_ov", capabilityId: "crm.contact.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
      { id: "g_ov_admin", subjectId: "person:person_ov", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
    ],
  });
}

test("brain users response carries grant entries across every active subject (A1)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-grant-entries-"));
  try {
    await writeFile(path.join(root, "capabilities.json"), multiSubjectStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const users = (await (await fetch(`${baseUrl}/api/admin/brain/users`, { headers: authHeaders() })).json()) as any;
      const person = users.people.find((p: any) => p.id === "person_multi");
      assert.ok(person, "person present");
      // Both subjects resolve as active.
      assert.deepEqual([...person.activeSubjectIds].sort(), ["person:person_multi", "subject:person_multi_secondary"]);

      const crm = person.grants.byGroup.find((g: any) => g.id === "crm");
      assert.ok(crm, "crm group present");
      assert.equal(crm.granted, true);
      assert.equal(crm.grantedChildCount, 2);
      // Group-revoke targets: exact grant entries across BOTH subjects.
      const entryIds = crm.grantEntries.map((e: any) => e.grantId).sort();
      assert.deepEqual(entryIds, ["g_primary_crm_read", "g_secondary_crm_write"]);
      const subjectIds = crm.grantEntries.map((e: any) => e.subjectId).sort();
      assert.deepEqual(subjectIds, ["person:person_multi", "subject:person_multi_secondary"]);
      // Full grant-entry shape, secret-free selector summary.
      const readEntry = crm.grantEntries.find((e: any) => e.grantId === "g_primary_crm_read");
      assert.equal(readEntry.capabilityId, "crm.contact.read");
      assert.equal(readEntry.grantKind, "capability");
      assert.equal(readEntry.status, "active");
      assert.equal(readEntry.enforcement, "enforcing");
      assert.match(readEntry.selectorsSummary, /scope=owner_all/);

      // Per-child entries map to the subject that grants each capability.
      const childRead = crm.children.find((c: any) => c.capabilityId === "crm.contact.read");
      const childWrite = crm.children.find((c: any) => c.capabilityId === "crm.contact.write");
      assert.deepEqual(childRead.entries.map((e: any) => e.subjectId), ["person:person_multi"]);
      assert.deepEqual(childWrite.entries.map((e: any) => e.subjectId), ["subject:person_multi_secondary"]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain batch revoke is atomic with one combined impact preview and partial-unknown 404 (A2)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-batch-revoke-"));
  try {
    await writeFile(path.join(root, "capabilities.json"), overlappingGrantsStore());
    const auditPath = path.join(root, "capability-audit.jsonl");
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const surface = { actorId: "telegram:user:900000123", operation: "crm.contact.read", resource: {} };
      // Baseline: the capability is allowed (two overlapping grants).
      assert.equal((await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", surface)).payload.allowed, true);

      // Revoking ONLY ONE of the two overlapping grants denies nothing — the other
      // still allows the capability. This is exactly what merged per-grant
      // previews got wrong; the combined preview must report it truthfully.
      const previewOne = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants/revoke-batch?preview=true", { grantIds: ["g_ov_a"] });
      assert.equal(previewOne.status, 200);
      assert.equal(previewOne.payload.impact.summary.newlyDeniedCount, 0);

      // Revoking BOTH overlapping grants together denies the capability — the ONE
      // combined preview over the whole change reports the real impact.
      const previewBoth = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants/revoke-batch?preview=true", { grantIds: ["g_ov_a", "g_ov_b"] });
      assert.equal(previewBoth.status, 200);
      assert.ok(previewBoth.payload.impact.summary.newlyDeniedCount >= 1);
      assert.ok(previewBoth.payload.impact.surfaces.some((s: any) => s.newlyDenied.includes("crm.contact.read")));

      // Partial-unknown-id semantics: a batch naming an unknown grant id aborts the
      // WHOLE batch (404) and writes nothing (chosen: atomic all-or-nothing).
      const partial = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants/revoke-batch", { grantIds: ["g_ov_a", "grant_missing"] });
      assert.equal(partial.status, 404);
      assert.equal(partial.payload.error, "grant_not_found");
      const untouched = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.equal(untouched.grants.find((g: any) => g.id === "g_ov_a").status, "active");

      // Commit the batch: ONE store write revokes both grants and denies the op.
      const commit = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants/revoke-batch", { grantIds: ["g_ov_a", "g_ov_b"] });
      assert.equal(commit.status, 200);
      assert.equal(commit.payload.changed, true);
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      for (const id of ["g_ov_a", "g_ov_b"]) {
        const g = stored.grants.find((row: any) => row.id === id);
        assert.equal(g.status, "revoked", `${id} revoked`);
        assert.ok(g.revokedAt, `${id} has revokedAt`);
      }
      assert.equal((await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", surface)).payload.allowed, false);

      // Exactly ONE audit event for the whole batch, naming both grant ids.
      const auditLines = (await readFile(auditPath, "utf8")).split(/\n/).filter((line) => line.trim());
      const revokeEvents = auditLines.map((line) => JSON.parse(line)).filter((r: any) => r.action === "capability.grant.revoked");
      assert.equal(revokeEvents.length, 1, "one audit event for the batch");
      assert.equal(revokeEvents[0].batch, true);
      assert.deepEqual([...revokeEvents[0].revokedGrantIds].sort(), ["g_ov_a", "g_ov_b"]);

      // Already-revoked ids are a per-grant no-op: a second batch does not rewrite.
      const bytesBefore = await readFile(path.join(root, "capabilities.json"));
      const again = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants/revoke-batch", { grantIds: ["g_ov_a"] });
      assert.equal(again.status, 200);
      assert.equal(again.payload.changed, false);
      assert.ok(bytesBefore.equals(await readFile(path.join(root, "capabilities.json"))), "no-op batch did not rewrite the store");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain batch revoke pins the preview store hash and 409s a stale commit (A3)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-batch-hash-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeFile(path.join(root, "capabilities.json"), overlappingGrantsStore());
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      // Preview against the current store; capture the hash it was computed against.
      const preview = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants/revoke-batch?preview=true", { grantIds: ["g_ov_a", "g_ov_b"] });
      assert.equal(preview.status, 200);
      const staleHash = preview.payload.storeHash as string;
      assert.ok(staleHash);

      // The store moves out-of-band (an unrelated grant is added).
      const drift = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants", { capabilityId: "todos.item.read" });
      assert.equal(drift.status, 200);
      const freshHash = drift.payload.storeHash as string;
      assert.notEqual(freshHash, staleHash);

      // Committing the batch pinned to the stale preview hash is a retryable 409.
      const conflict = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants/revoke-batch", { grantIds: ["g_ov_a", "g_ov_b"], expectedStoreHash: staleHash });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.payload.error, "store_conflict");
      assert.equal(conflict.payload.retryable, true);
      // The conflict wrote nothing: both grants remain active.
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.equal(stored.grants.find((g: any) => g.id === "g_ov_a").status, "active");

      // Re-pinned to the current store hash, the same commit succeeds.
      const ok = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_ov/grants/revoke-batch", { grantIds: ["g_ov_a", "g_ov_b"], expectedStoreHash: freshHash });
      assert.equal(ok.status, 200);
      assert.equal(ok.payload.changed, true);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain capability write refuses a schema-invalid resulting store before persisting", () => {
  // A resulting store missing the required arrays fails-closed the assistant and
  // must be refused by the write path's re-validation (invariant §9.3).
  assert.throws(
    () => assertValidStore({ people: [], externalIdentities: [], subjects: [] }),
    (error: unknown) => error instanceof CapabilityWriteError && error.code === "store_would_be_invalid" && error.status === 422,
  );
});

test("brain capability write retains last-known-good and timestamped backups", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-backup-"));
  try {
    await writeLiveStore(root);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const created = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Backup Person" });
      const personId = created.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "todos.item.read" });

      const lkg = await stat(path.join(root, "capabilities.json.lkg.json"));
      assert.ok(lkg.isFile(), "last-known-good copy retained");
      const backups = (await (await import("node:fs/promises")).readdir(root)).filter((name) => name.startsWith("capabilities.json.") && name.endsWith(".bak"));
      assert.ok(backups.length >= 1, "timestamped backup retained");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain capability write appends audit events into the merged audit feed without secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-writeaudit-"));
  try {
    await writeLiveStore(root);
    // A token-shaped literal assembled at runtime; it must never appear anywhere.
    const fakeToken = ["xoxb", "9990001", "SYNTHETICSECRET"].join("-");
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const created = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Audit Person" });
      const personId = created.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/identities`, { provider: "telegram", externalId: "900000300" });
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { groupId: "crm" });

      const feed = (await (await fetch(`${baseUrl}/api/admin/brain/audit?type=capability&limit=50`, { headers: authHeaders() })).json()) as any;
      const actions = feed.rows.map((row: any) => row.action);
      assert.ok(actions.includes("person.created"), "person.created event present");
      assert.ok(actions.includes("identity.link.added"), "identity.link.added event present");
      assert.ok(actions.includes("capability.grant.applied"), "capability.grant.applied event present");
      const grantRow = feed.rows.find((row: any) => row.action === "capability.grant.applied");
      assert.equal(grantRow.actor, TEST_ADMIN_EMAIL);
      assert.equal(grantRow.type, "capability");

      // The capability audit JSONL never contains a secret-shaped value.
      const auditText = await readFile(path.join(root, "capability-audit.jsonl"), "utf8");
      assert.equal(auditText.includes(fakeToken), false);
      assert.equal(/xox[baprs]-/.test(auditText), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain capability store migration cleans placeholders, converts to enforcing, and is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-migrate-"));
  try {
    const storePath = path.join(root, "capabilities.json");
    await writeFile(storePath, placeholderStore());

    // --dry-run computes changes but writes nothing.
    const before = await readFile(storePath);
    const dry = await migrateCapabilityStore({ storePath, dryRun: true });
    assert.equal(dry.changed, true);
    assert.ok(before.equals(await readFile(storePath)), "dry-run wrote nothing");

    // Real migration removes the zeroed-seed slack placeholders and converts
    // retained grants — but NEVER the codex-chat runtime subject or its active
    // grants (its label says "placeholder" but the running assistant depends on
    // its active enforcing grants).
    const applied = await migrateCapabilityStore({ storePath });
    assert.equal(applied.changed, true);
    assert.deepEqual(applied.changes.removedSubjectIds.sort(), ["slack:channel:T00000000:C00000000", "slack:user:T00000000:U00000000", "slack:workspace:T00000000"]);
    assert.equal(applied.changes.removedSubjectIds.includes("system:codex-chat-runtime"), false);
    assert.deepEqual(applied.changes.removedIdentityIds, ["identity_addable_x"]);
    assert.ok(applied.changes.removedGrantIds.includes("g_example"));
    // The runtime subject's active grants are RETAINED (not cascade-deleted).
    assert.equal(applied.changes.removedGrantIds.includes("g_runtime"), false);
    assert.equal(applied.changes.removedGrantIds.includes("g_runtime_deliver"), false);
    assert.deepEqual(applied.changes.convertedGrantIds, ["g_real"]);
    assert.deepEqual(applied.changes.enforcementTransitions, [{ grantId: "g_real", from: "non_enforcing", to: "enforcing" }]);
    assert.ok(applied.backup, "pre-migration backup written");

    const migrated = JSON.parse(await readFile(storePath, "utf8"));
    // Real synthetic data retained; placeholders gone; grant now enforcing.
    assert.ok(migrated.people.find((p: any) => p.id === "person_alpha"));
    assert.equal(migrated.people[0].identityIds.includes("identity_addable_x"), false);
    assert.ok(migrated.externalIdentities.find((i: any) => i.id === "identity_telegram_900000001"));
    // The codex-chat runtime subject and BOTH active enforcing grants survive.
    assert.equal(migrated.subjects.some((s: any) => s.id === "system:codex-chat-runtime"), true);
    const runtimeCallback = migrated.grants.find((g: any) => g.id === "g_runtime");
    const runtimeDeliver = migrated.grants.find((g: any) => g.id === "g_runtime_deliver");
    assert.ok(runtimeCallback && runtimeCallback.status === "active", "system.callback.enqueue grant retained");
    assert.ok(runtimeDeliver && runtimeDeliver.status === "active", "subagents.result.deliver grant retained");
    assert.equal(migrated.grants.find((g: any) => g.id === "g_real").enforcement, "enforcing");
    // Migrated store stays canonical-schema valid.
    assertValidStore(migrated);

    // Second run is a no-op.
    const again = await migrateCapabilityStore({ storePath });
    assert.equal(again.changed, false);
    assert.match(again.message, /nothing to do/);
    // planMigration on the migrated store reports no changes.
    const { changes } = planMigration(migrated);
    assert.deepEqual(changes, { removedSubjectIds: [], removedGrantIds: [], removedIdentityIds: [], convertedGrantIds: [], enforcementTransitions: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 1: a zeroed-seed slack subject that still holds an ACTIVE grant is a
// live dependency, not a dead placeholder — it (and its grant) must be retained.
test("brain migration retains a zeroed-seed subject that holds an active grant", () => {
  const store = {
    schemaVersion: 2,
    people: [],
    externalIdentities: [],
    identityProofs: [],
    subjects: [{ id: "slack:channel:T00000000:C00000000", kind: "slack_channel" }],
    grants: [{ id: "g_live", subjectId: "slack:channel:T00000000:C00000000", capabilityId: "slack.channel.read", grantKind: "capability", resource: { selectors: { scope: "*" } }, actions: ["*"], status: "active", enforcement: "enforcing" }],
  };
  const { store: migrated, changes } = planMigration(store as never);
  assert.equal(changes.removedSubjectIds.includes("slack:channel:T00000000:C00000000"), false);
  assert.equal(changes.removedGrantIds.includes("g_live"), false);
  assert.ok(migrated.subjects?.some((s) => s.id === "slack:channel:T00000000:C00000000"));
  assert.ok(migrated.grants?.some((g) => g.id === "g_live"));
});

// Finding 2: exact-token matching — a real identity whose id/providerUserId
// merely CONTAINS eight consecutive zeros (as a substring of a longer number) is
// never mistaken for the zeroed seed placeholder and must be retained.
test("brain migration keeps real identities that only contain eight zeros as a substring", () => {
  const store = {
    schemaVersion: 2,
    people: [{ id: "person_x", displayName: "X", status: "active", personType: "human", primarySubjectId: "person:x", subjectIds: ["person:x"], identityIds: ["identity_telegram_5000000003"] }],
    externalIdentities: [
      { id: "identity_telegram_5000000003", provider: "telegram", providerUserId: "5000000003", personId: "person_x", status: "linked" },
    ],
    identityProofs: [],
    subjects: [{ id: "person:x", personId: "person_x", kind: "person", status: "active" }],
    grants: [{ id: "g_conv", subjectId: "person:x", capabilityId: "projects.read", grantKind: "capability", resource: { selectors: { projectId: "*" } }, actions: ["*"], status: "active", enforcement: "non_enforcing" }],
  };
  // Sanity: the providerUserId really does contain the 8-zero substring the old
  // /0{8}/ rule would have (wrongly) matched.
  assert.match("5000000003", /0{8}/);
  const { store: migrated, changes } = planMigration(store as never);
  assert.deepEqual(changes.removedIdentityIds, []);
  assert.ok(migrated.externalIdentities?.some((i) => i.id === "identity_telegram_5000000003"));
});

// Finding 3: the migration self-lockout rail. Removing a genuinely-placeholder
// identity (exact zeroed token) that happens to be the admin's only linked
// surface would strip the last effective capability-admin — refuse instead.
function migrationLockoutStore(): string {
  return JSON.stringify({
    schemaVersion: 2,
    people: [{ id: "person_admin", displayName: "Admin", status: "active", personType: "human", primarySubjectId: "person:person_admin", identityIds: ["identity_slack_T00000000_U00000000"], subjectIds: ["person:person_admin"] }],
    externalIdentities: [
      { id: "identity_slack_T00000000_U00000000", provider: "slack", providerUserId: "U00000000", providerTeamId: "T00000000", personId: "person_admin", status: "linked" },
    ],
    identityProofs: [],
    subjects: [{ id: "person:person_admin", personId: "person_admin", kind: "person", status: "active" }],
    grants: [{ id: "g_admin", subjectId: "person:person_admin", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" }],
  });
}

test("brain migration refuses to strip the last capability-admin (lockout rail)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-migrate-lockout-"));
  try {
    const storePath = path.join(root, "capabilities.json");
    await writeFile(storePath, migrationLockoutStore());
    const before = await readFile(storePath);
    // Dry-run reports the refusal too (throws -> the CLI exits non-zero).
    await assert.rejects(
      () => migrateCapabilityStore({ storePath, dryRun: true }),
      (error: unknown) => error instanceof CapabilityWriteError && error.code === "migration_would_lock_out_admins" && error.status === 422,
    );
    await assert.rejects(
      () => migrateCapabilityStore({ storePath }),
      (error: unknown) => error instanceof CapabilityWriteError && error.code === "migration_would_lock_out_admins",
    );
    assert.ok(before.equals(await readFile(storePath)), "store untouched on refusal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 4: default-created grants carry the broad selector template for the
// capability's group, and explicit selectors merge over that template so live
// resources remain explicitly covered for every runtime selector key.
test("brain grant defaults broad selectors and merges explicit selectors over default coverage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-selectors-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeLiveStore(root);
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const created = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Selector Person" });
      const personId = created.payload.detail.personId as string;
      const subjectId = created.payload.detail.subjectId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/identities`, { provider: "telegram", externalId: "900000400" });
      const grantCrm = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { groupId: "crm" });
      assert.equal(grantCrm.status, 200);
      assert.equal(grantCrm.payload.detail.expandedFromGroup, true);
      assert.deepEqual([...grantCrm.payload.detail.grantedCapabilityIds].sort(), ["crm.contact.read", "crm.contact.write", "crm.note.write"]);

      // A live-shaped request carrying curated selector keys is authorized by
      // the default template ({ scope: "*", contactId: "*", businessId: "*",
      // correspondenceId: "*" }).
      const check = await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", { actorId: "telegram:user:900000400", operation: "crm.contact.read", resource: { scope: "workspace", contactId: "c_123" } });
      assert.equal(check.payload.allowed, true);

      // The impact preview carries the fixed selector/live-resource caveat.
      const preview = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants?preview=true`, { capabilityId: "todos.item.read" });
      assert.match(preview.payload.impact.previewCaveat as string, /selector/);

      // Explicit narrower selectors override the named key while omitted keys
      // keep the default wildcard coverage.
      const grantNarrow = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "calendar.event.read", selectors: { calendarId: "cal_1" } });
      const narrowId = grantNarrow.payload.detail.grantIds[0] as string;
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      const narrow = stored.grants.find((g: any) => g.id === narrowId);
      assert.deepEqual(narrow.resource.selectors, { scope: "*", calendarId: "cal_1" });
      assert.ok(grantNarrow.payload.impact.summary.newlyAllowedCount > 0);
      // The default crm grant on this new subject stores the curated broad template.
      const crmGrant = stored.grants.find((g: any) => g.subjectId === subjectId && g.capabilityId === "crm.contact.read");
      assert.deepEqual(crmGrant.resource.selectors, { scope: "*", contactId: "*", businessId: "*", correspondenceId: "*" });

      const crmPerson = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "CRM Scoped Person" });
      const crmPersonId = crmPerson.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${crmPersonId}/identities`, { provider: "telegram", externalId: "900000403" });
      const grantCrmWrite = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${crmPersonId}/grants`, { capabilityId: "crm.contact.write", selectors: { contactId: "c1" } });
      assert.equal(grantCrmWrite.status, 200);

      const crmScopedStore = parseCapabilityStore(await readFile(path.join(root, "capabilities.json"), "utf8"));
      const crmWriteGrant = crmScopedStore.grants?.find((row) => row.id === grantCrmWrite.payload.detail.grantIds[0]);
      assert.deepEqual(crmWriteGrant?.resource?.selectors, { scope: "*", contactId: "c1", businessId: "*", correspondenceId: "*" });
      const crmActor = { id: "telegram:user:900000403", surfaceKind: "telegram", surfaceUserId: "900000403" };
      assert.equal(evaluateAuthorization(crmScopedStore, { actor: crmActor, requirement: { operation: "crm.contact.write", action: "write", resource: { scope: "owner_all", contactId: "c1" } } }).allowed, true);
      assert.equal(evaluateAuthorization(crmScopedStore, { actor: crmActor, requirement: { operation: "crm.contact.write", action: "write", resource: { scope: "owner_all", contactId: "c2" } } }).allowed, false);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain crm grants accept business and correspondence selector keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-crm-selectors-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeLiveStore(root);
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const businessPerson = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "CRM Business Scoped Person" });
      const businessPersonId = businessPerson.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${businessPersonId}/identities`, { provider: "telegram", externalId: "900000404" });
      const businessGrant = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${businessPersonId}/grants`, { capabilityId: "crm.contact.read", selectors: { businessId: "b1" } });
      assert.equal(businessGrant.status, 200);

      const correspondencePerson = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "CRM Correspondence Scoped Person" });
      const correspondencePersonId = correspondencePerson.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${correspondencePersonId}/identities`, { provider: "telegram", externalId: "900000405" });
      const correspondenceGrant = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${correspondencePersonId}/grants`, { capabilityId: "crm.note.write", selectors: { correspondenceId: "co1" } });
      assert.equal(correspondenceGrant.status, 200);

      const defaultPerson = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "CRM Default Selector Person" });
      const defaultPersonId = defaultPerson.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${defaultPersonId}/identities`, { provider: "telegram", externalId: "900000406" });
      const defaultGrant = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${defaultPersonId}/grants`, { capabilityId: "crm.contact.read" });
      assert.equal(defaultGrant.status, 200);

      const store = parseCapabilityStore(await readFile(path.join(root, "capabilities.json"), "utf8"));
      const businessStored = store.grants?.find((row) => row.id === businessGrant.payload.detail.grantIds[0]);
      assert.deepEqual(businessStored?.resource?.selectors, { scope: "*", contactId: "*", businessId: "b1", correspondenceId: "*" });
      const correspondenceStored = store.grants?.find((row) => row.id === correspondenceGrant.payload.detail.grantIds[0]);
      assert.deepEqual(correspondenceStored?.resource?.selectors, { scope: "*", contactId: "*", businessId: "*", correspondenceId: "co1" });
      const defaultStored = store.grants?.find((row) => row.id === defaultGrant.payload.detail.grantIds[0]);
      assert.deepEqual(defaultStored?.resource?.selectors, { scope: "*", contactId: "*", businessId: "*", correspondenceId: "*" });

      const businessActor = { id: "telegram:user:900000404", surfaceKind: "telegram", surfaceUserId: "900000404" };
      assert.equal(evaluateAuthorization(store, { actor: businessActor, requirement: { operation: "crm.contact.read", action: "read", resource: { businessId: "b1" } } }).allowed, true);
      assert.equal(evaluateAuthorization(store, { actor: businessActor, requirement: { operation: "crm.contact.read", action: "read", resource: { businessId: "b2" } } }).allowed, false);

      const correspondenceActor = { id: "telegram:user:900000405", surfaceKind: "telegram", surfaceUserId: "900000405" };
      assert.equal(evaluateAuthorization(store, { actor: correspondenceActor, requirement: { operation: "crm.note.write", action: "write", resource: { correspondenceId: "co1" } } }).allowed, true);

      const defaultActor = { id: "telegram:user:900000406", surfaceKind: "telegram", surfaceUserId: "900000406" };
      assert.equal(evaluateAuthorization(store, { actor: defaultActor, requirement: { operation: "crm.contact.read", action: "read", resource: { businessId: "b_default" } } }).allowed, true);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain grant validates registry capability ids and selector keys server-side", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-registry-grant-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeLiveStore(root);
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const created = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Scoped Grant Person" });
      const personId = created.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/identities`, { provider: "telegram", externalId: "900000401" });

      const unknown = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "not.in.registry" });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.payload.error, "unknown_capability");

      const badSelector = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "todos.item.read", selectors: { channelId: "C123" } });
      assert.equal(badSelector.status, 400);
      assert.equal(badSelector.payload.error, "invalid_selector");
      assert.equal(badSelector.payload.selectorKey, "channelId");
      assert.deepEqual(badSelector.payload.allowedSelectorKeys, ["scope", "listId"]);

      const emptySelectors = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "todos.item.read", selectors: {} });
      assert.equal(emptySelectors.status, 400);
      assert.equal(emptySelectors.payload.error, "invalid_selector");

      const beforeForbidden = await readFile(path.join(root, "capabilities.json"));
      for (const key of ["__proto__", "constructor", "prototype"]) {
        const selectors = Object.create(null) as Record<string, string>;
        selectors[key] = "blocked";
        const bad = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "todos.item.read", selectors });
        assert.equal(bad.status, 400, `${key} selector rejected`);
        assert.equal(bad.payload.error, "invalid_selector");
        assert.equal(bad.payload.selectorKey, key);
      }
      assert.ok(beforeForbidden.equals(await readFile(path.join(root, "capabilities.json"))), "forbidden selector keys wrote nothing");

      const preview = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants?preview=true`, { capabilityId: "todos.item.read", selectors: { scope: "personal", listId: "list_1" } });
      assert.equal(preview.status, 200);
      assert.ok(preview.payload.impact.surfaces.some((surface: any) => surface.newlyAllowed.includes("todos.item.read")));

      const grant = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${personId}/grants`, { capabilityId: "todos.item.read", selectors: { scope: "personal", listId: "list_1" } });
      assert.equal(grant.status, 200);
      assert.equal(grant.payload.detail.selectors.scope, "personal");
      assert.equal(grant.payload.detail.selectors.listId, "list_1");
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      const written = stored.grants.find((row: any) => row.id === grant.payload.detail.grantIds[0]);
      assert.deepEqual(written.resource.selectors, { scope: "personal", listId: "list_1" });

      const createdDefault = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Default Selector Person" });
      const defaultPersonId = createdDefault.payload.detail.personId as string;
      await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${defaultPersonId}/identities`, { provider: "telegram", externalId: "900000402" });
      const omitted = await jsonRequest(baseUrl, "POST", `/api/admin/brain/users/${defaultPersonId}/grants`, { capabilityId: "todos.item.read" });
      assert.equal(omitted.status, 200);
      const storedAfterOmitted = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      const omittedGrant = storedAfterOmitted.grants.find((row: any) => row.id === omitted.payload.detail.grantIds[0]);
      assert.deepEqual(omittedGrant.resource.selectors, { scope: "*", listId: "*" });
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 5: an admin reachable only through a SUSPENDED subject never resolves
// at runtime, so it must not count toward self-lockout. Revoking the sole
// active-subject admin's grant is blocked with 422 even though a suspended-subject
// "admin" grant still exists.
function suspendedSubjectAdminStore(): string {
  return JSON.stringify({
    schemaVersion: 2,
    people: [
      { id: "person_real", displayName: "Real", status: "active", personType: "human", primarySubjectId: "person:real", identityIds: ["identity_telegram_900000501"], subjectIds: ["person:real"] },
      { id: "person_susp", displayName: "Suspended", status: "active", personType: "human", primarySubjectId: "person:susp", identityIds: ["identity_telegram_900000502"], subjectIds: ["person:susp"] },
    ],
    externalIdentities: [
      { id: "identity_telegram_900000501", provider: "telegram", providerUserId: "900000501", personId: "person_real", status: "linked" },
      { id: "identity_telegram_900000502", provider: "telegram", providerUserId: "900000502", personId: "person_susp", status: "linked" },
    ],
    identityProofs: [],
    subjects: [
      { id: "person:real", personId: "person_real", kind: "person", status: "active" },
      { id: "person:susp", personId: "person_susp", kind: "person", status: "suspended" },
    ],
    grants: [
      { id: "g_real_admin", subjectId: "person:real", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
      { id: "g_susp_admin", subjectId: "person:susp", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
    ],
  });
}

test("brain self-lockout counts only admins on active subjects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-suspended-admin-"));
  try {
    await writeFile(path.join(root, "capabilities.json"), suspendedSubjectAdminStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const revoke = await jsonRequest(baseUrl, "DELETE", "/api/admin/brain/users/person_real/grants/g_real_admin");
      assert.equal(revoke.status, 422);
      assert.equal(revoke.payload.error, "self_lockout");
      // Nothing was written.
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.equal(stored.grants.find((g: any) => g.id === "g_real_admin").status, "active");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function suspendedGrantRegrantStore(): unknown {
  return {
    schemaVersion: 2,
    people: [{ id: "person_regrant", displayName: "Regrant", status: "active", personType: "human", primarySubjectId: "person:regrant", identityIds: ["identity_telegram_900000801"], subjectIds: ["person:regrant", "person:regrant_old"] }],
    externalIdentities: [{ id: "identity_telegram_900000801", provider: "telegram", providerUserId: "900000801", personId: "person_regrant", status: "linked" }],
    identityProofs: [],
    subjects: [
      { id: "person:regrant", personId: "person_regrant", kind: "person", status: "active" },
      { id: "person:regrant_old", personId: "person_regrant", kind: "person", status: "suspended" },
    ],
    grants: [
      { id: "g_old_suspended_crm", subjectId: "person:regrant_old", capabilityId: "crm.contact.read", grantKind: "capability", resource: { selectors: { scope: "*", contactId: "*" } }, actions: ["*"], status: "active", enforcement: "enforcing" },
    ],
  };
}

test("brain grant idempotency ignores suspended subjects and writes to the active primary subject", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-regrant-suspended-"));
  try {
    await writeJson(path.join(root, "capabilities.json"), suspendedGrantRegrantStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const surface = { actorId: "telegram:user:900000801", operation: "crm.contact.read", resource: { scope: "workspace", contactId: "c_801" } };
      assert.equal((await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", surface)).payload.allowed, false);

      const grant = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_regrant/grants", { capabilityId: "crm.contact.read" });
      assert.equal(grant.status, 200);
      assert.equal(grant.payload.changed, true);
      assert.equal(grant.payload.detail.subjectId, "person:regrant");
      assert.equal(grant.payload.detail.grantIds.length, 1);
      assert.deepEqual(grant.payload.detail.alreadyGranted, []);
      assert.ok(grant.payload.impact.summary.newlyAllowedCount > 0);

      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.ok(stored.grants.some((row: any) => row.id === "g_old_suspended_crm" && row.subjectId === "person:regrant_old"));
      assert.ok(stored.grants.some((row: any) => row.subjectId === "person:regrant" && row.capabilityId === "crm.contact.read"));
      assert.equal((await jsonRequest(baseUrl, "POST", "/api/admin/brain/capabilities/check", surface)).payload.allowed, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function badPrimarySubjectStore(subjects: readonly unknown[]): unknown {
  return {
    schemaVersion: 2,
    people: [{ id: "person_bad_primary", displayName: "Bad Primary", status: "active", personType: "human", primarySubjectId: "person:bad_primary", identityIds: ["identity_telegram_900000802"], subjectIds: ["person:bad_primary"] }],
    externalIdentities: [{ id: "identity_telegram_900000802", provider: "telegram", providerUserId: "900000802", personId: "person_bad_primary", status: "linked" }],
    identityProofs: [],
    subjects,
    grants: [],
  };
}

test("brain grant materializes a missing primary subject before writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-missing-primary-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeJson(path.join(root, "capabilities.json"), badPrimarySubjectStore([]));
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const grant = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_bad_primary/grants", { capabilityId: "todos.item.read" });
      assert.equal(grant.status, 200);
      assert.equal(grant.payload.changed, true);
      assert.equal(grant.payload.detail.subjectId, "person:bad_primary");
      assert.equal(grant.payload.detail.materializedPrimarySubject, true);

      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.ok(stored.subjects.some((subject: any) => subject.id === "person:bad_primary" && subject.status === "active" && subject.kind === "person" && subject.source === "manual_admin"));
      assert.ok(stored.people[0].subjectIds.includes("person:bad_primary"));
      assert.ok(stored.grants.some((grantRow: any) => grantRow.subjectId === "person:bad_primary" && grantRow.capabilityId === "todos.item.read"));
      const audit = await readFile(path.join(root, "capability-audit.jsonl"), "utf8");
      assert.match(audit, /materializedPrimarySubject/);
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brain grant refuses a suspended primary subject instead of reactivating it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-suspended-primary-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    await writeJson(path.join(root, "capabilities.json"), badPrimarySubjectStore([{ id: "person:bad_primary", personId: "person_bad_primary", kind: "person", status: "suspended" }]));
    ipc = await startFakeCodexChatIpc(root, { capabilityRegistry: SYNTHETIC_REGISTRY });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const grant = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_bad_primary/grants", { capabilityId: "todos.item.read" });
      assert.equal(grant.status, 400);
      assert.equal(grant.payload.error, "primary_subject_unavailable");
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.equal(stored.grants.length, 0);
      assert.equal(stored.subjects.find((subject: any) => subject.id === "person:bad_primary").status, "suspended");
    });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

function phantomSubjectAdminStore(): unknown {
  return {
    schemaVersion: 2,
    people: [
      { id: "person_real_admin", displayName: "Real Admin", status: "active", personType: "human", primarySubjectId: "person:real_admin", identityIds: ["identity_telegram_900000804"], subjectIds: ["person:real_admin"] },
      { id: "person_phantom_admin", displayName: "Phantom Admin", status: "active", personType: "human", primarySubjectId: "person:phantom_admin", identityIds: ["identity_telegram_900000805"], subjectIds: ["person:phantom_admin"] },
    ],
    externalIdentities: [
      { id: "identity_telegram_900000804", provider: "telegram", providerUserId: "900000804", personId: "person_real_admin", status: "linked" },
      { id: "identity_telegram_900000805", provider: "telegram", providerUserId: "900000805", personId: "person_phantom_admin", status: "linked" },
    ],
    identityProofs: [],
    subjects: [{ id: "person:real_admin", personId: "person_real_admin", kind: "person", status: "active" }],
    grants: [
      { id: "g_real_admin", subjectId: "person:real_admin", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
      { id: "g_phantom_admin", subjectId: "person:phantom_admin", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
    ],
  };
}

test("brain self-lockout ignores phantom subject ids with no subject record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-phantom-admin-"));
  try {
    await writeJson(path.join(root, "capabilities.json"), phantomSubjectAdminStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const revoke = await jsonRequest(baseUrl, "DELETE", "/api/admin/brain/users/person_real_admin/grants/g_real_admin");
      assert.equal(revoke.status, 422);
      assert.equal(revoke.payload.error, "self_lockout");
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.equal(stored.grants.find((row: any) => row.id === "g_real_admin").status, "active");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function identityLinkedSubjectStore(): unknown {
  return {
    schemaVersion: 2,
    people: [{ id: "person_identity_subject", displayName: "Identity Subject", status: "active", personType: "human", primarySubjectId: "person:identity_subject", identityIds: ["identity_telegram_900000806"], subjectIds: ["person:identity_subject"] }],
    externalIdentities: [{ id: "identity_telegram_900000806", provider: "telegram", providerUserId: "900000806", personId: "person_identity_subject", status: "linked" }],
    identityProofs: [],
    subjects: [
      { id: "person:identity_subject", personId: "person_identity_subject", kind: "person", status: "active" },
      { id: "identity:telegram_900000806", identityId: "identity_telegram_900000806", kind: "external_identity", status: "active" },
    ],
    grants: [
      { id: "g_identity_subject_todo", subjectId: "identity:telegram_900000806", capabilityId: "todos.item.read", grantKind: "capability", resource: { selectors: { scope: "*", listId: "*" } }, actions: ["*"], status: "active", enforcement: "enforcing" },
    ],
  };
}

test("brain revoke resolves subjects linked through person identityIds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-identity-subject-"));
  try {
    await writeJson(path.join(root, "capabilities.json"), identityLinkedSubjectStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const users = (await (await fetch(`${baseUrl}/api/admin/brain/users`, { headers: authHeaders() })).json()) as any;
      const person = users.people.find((row: any) => row.id === "person_identity_subject");
      assert.ok(person.activeSubjectIds.includes("identity:telegram_900000806"));
      assert.equal(person.grants.byGroup.find((group: any) => group.id === "todos")?.granted, true);

      const revoke = await jsonRequest(baseUrl, "DELETE", "/api/admin/brain/users/person_identity_subject/grants/g_identity_subject_todo");
      assert.equal(revoke.status, 200);
      assert.equal(revoke.payload.changed, true);
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.equal(stored.grants.find((row: any) => row.id === "g_identity_subject_todo").status, "revoked");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 6: two concurrent in-process mutations serialize via the module-level
// mutation queue — both writes land instead of one silently clobbering the other.
test("brain concurrent mutations serialize in-process without losing writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-concurrent-"));
  try {
    const storePath = path.join(root, "capabilities.json");
    await writeFile(storePath, JSON.stringify({
      schemaVersion: 2,
      people: [{ id: "person_c", displayName: "Concurrent", status: "active", personType: "human", primarySubjectId: "person:c", identityIds: ["identity_telegram_900000601"], subjectIds: ["person:c"] }],
      externalIdentities: [{ id: "identity_telegram_900000601", provider: "telegram", providerUserId: "900000601", personId: "person_c", status: "linked" }],
      identityProofs: [],
      subjects: [{ id: "person:c", personId: "person_c", kind: "person", status: "active" }],
      grants: [{ id: "g_c_admin", subjectId: "person:c", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" }],
    }));
    const [a, b] = await Promise.all([
      commitMutation(storePath, { kind: "grant", personId: "person_c", target: "todos.item.read", adminEmail: "admin@example.test" }),
      commitMutation(storePath, { kind: "grant", personId: "person_c", target: "calendar.event.read", adminEmail: "admin@example.test" }),
    ]);
    assert.equal(a.outcome.changed, true);
    assert.equal(b.outcome.changed, true);
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    assert.ok(stored.grants.some((g: any) => g.capabilityId === "todos.item.read"), "first concurrent write present");
    assert.ok(stored.grants.some((g: any) => g.capabilityId === "calendar.event.read"), "second concurrent write present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 7: an audit-append failure after a SUCCESSFUL store write must not turn
// the response into a 500 (which would prompt a duplicate-creating retry).
test("brain mutation returns 200 with auditWriteFailed when the audit dir is unwritable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-auditfail-"));
  try {
    await writeLiveStore(root);
    // Make the capability audit path unwritable: its parent is a regular file, so
    // mkdir of the log directory fails with ENOTDIR.
    const blocker = path.join(root, "audit-blocker");
    await writeFile(blocker, "not a directory");
    const cfg = config(root, { capabilityAuditLogPath: path.join(blocker, "sub", "capability-audit.jsonl") });
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const created = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users", { displayName: "Audit Fail Person" });
      assert.equal(created.status, 200);
      assert.equal(created.payload.ok, true);
      assert.equal(created.payload.auditWriteFailed, true);
      // The store write still landed.
      const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8"));
      assert.ok(stored.people.some((p: any) => p.id === created.payload.detail.personId));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 8: an unknown individual capability id must be rejected (400) rather
// than persisted as an enforcing junk grant.
test("brain grant rejects an unknown capability id and leaves the store unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-unknown-cap-"));
  try {
    await writeLiveStore(root);
    const before = await readFile(path.join(root, "capabilities.json"));
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const bad = await jsonRequest(baseUrl, "POST", "/api/admin/brain/users/person_alpha/grants", { capabilityId: "todos.read" });
      assert.equal(bad.status, 400);
      assert.equal(bad.payload.error, "unknown_capability");
    });
    const after = await readFile(path.join(root, "capabilities.json"));
    assert.ok(before.equals(after), "store bytes unchanged after a rejected grant");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 9: a malformed request body is a 400 client error, not a 500.
test("brain user mutation rejects a malformed request body with 400 not 500", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-badbody-"));
  try {
    await writeLiveStore(root);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const nonJson = await fetch(`${baseUrl}/api/admin/brain/users`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "not json at all" });
      assert.equal(nonJson.status, 400);
      assert.equal((await nonJson.json() as { error: string }).error, "invalid_body");
      const arrayBody = await fetch(`${baseUrl}/api/admin/brain/users`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "[]" });
      assert.equal(arrayBody.status, 400);
      assert.equal((await arrayBody.json() as { error: string }).error, "invalid_body");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain generic JSON endpoints reject malformed request bodies with 400 not 500", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-generic-badbody-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const nonJson = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "not json at all" });
      assert.equal(nonJson.status, 400);
      assert.equal((await nonJson.json() as { error: string }).error, "invalid_body");
      const empty = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "" });
      assert.equal(empty.status, 400);
      assert.equal((await empty.json() as { error: string }).error, "invalid_body");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Finding 10: a double revoke preserves the original revokedAt/reason and does
// not rewrite the store (a no-op mutation skips the disk write).
test("brain double revoke preserves original revocation and does not rewrite the store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-double-revoke-"));
  try {
    const storePath = path.join(root, "capabilities.json");
    await writeFile(storePath, JSON.stringify({
      schemaVersion: 2,
      people: [{ id: "person_r", displayName: "Revoker", status: "active", personType: "human", primarySubjectId: "person:r", identityIds: ["identity_telegram_900000701"], subjectIds: ["person:r"] }],
      externalIdentities: [{ id: "identity_telegram_900000701", provider: "telegram", providerUserId: "900000701", personId: "person_r", status: "linked" }],
      identityProofs: [],
      subjects: [{ id: "person:r", personId: "person_r", kind: "person", status: "active" }],
      grants: [
        { id: "g_r_admin", subjectId: "person:r", capabilityId: "capability.catalog.read", grantKind: "capability", resource: { selectors: {} }, actions: ["*"], status: "active", enforcement: "enforcing" },
        { id: "g_r_todo", subjectId: "person:r", capabilityId: "todos.item.read", grantKind: "capability", resource: { selectors: { scope: "*", listId: "*" } }, actions: ["*"], status: "active", enforcement: "enforcing" },
      ],
    }));

    const first = await commitMutation(storePath, { kind: "revoke", personId: "person_r", grantId: "g_r_todo", adminEmail: "admin-one@example.test" });
    assert.equal(first.outcome.changed, true);
    const bytesAfterFirst = await readFile(storePath);
    const revokedGrantFirst = JSON.parse(bytesAfterFirst.toString()).grants.find((g: any) => g.id === "g_r_todo");
    assert.ok(revokedGrantFirst.revokedAt, "first revoke set revokedAt");
    assert.match(revokedGrantFirst.reason, /admin-one@example\.test/);

    // A second revoke by a different admin is a no-op: changed=false, no rewrite.
    const second = await commitMutation(storePath, { kind: "revoke", personId: "person_r", grantId: "g_r_todo", adminEmail: "admin-two@example.test" });
    assert.equal(second.outcome.changed, false);
    assert.equal(second.outcome.detail.alreadyRevoked, true);
    const bytesAfterSecond = await readFile(storePath);
    assert.ok(bytesAfterFirst.equals(bytesAfterSecond), "second revoke did not rewrite the store");
    const revokedGrantSecond = JSON.parse(bytesAfterSecond.toString()).grants.find((g: any) => g.id === "g_r_todo");
    assert.equal(revokedGrantSecond.revokedAt, revokedGrantFirst.revokedAt);
    assert.equal(revokedGrantSecond.reason, revokedGrantFirst.reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
