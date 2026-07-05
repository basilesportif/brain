import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { authorizeBrainAdminRequest, parseAdminAllowedEmails } from "./admin-auth.js";
import { renderBrainAdminDeniedPage, renderBrainAdminPage, renderBrainAdminSignInPage } from "./admin-page.js";
import { createBrainAdminServer, type BrainAdminServiceConfig, type BrainAdminServiceDeps } from "./admin-service.js";
import { mergeEnvFileText } from "./env-file.js";
import { LIVE_CAPABILITY_STORE_JSON } from "./capability-store.fixture.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

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
    slackAppId: undefined,
    slackCanaryPath: path.join(root, "slack-canary.json"),
    slackSetupStatePath: path.join(root, "slack-setup.json"),
    capabilityStorePath: path.join(root, "capabilities.json"),
    capabilityAuditLogPath: path.join(root, "capability-audit.jsonl"),
    capabilityDecisionsDir: path.join(root, "codex-chat", "data", "state", "capability_decisions"),
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
      assert.equal(deniedHtml.includes("Brain Control Plane"), false);
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
  assert.equal(signInHtml.includes("Brain Control Plane"), false);

  const deniedHtml = renderBrainAdminDeniedPage(cfg, "forbidden", "https://brain.example.test/admin/auth/sign-in", "other@example.test");
  assert.deepEqual(extractJsonScript(deniedHtml, "config"), { publishableKey: `pk_test_<unsafe>&value`, signInUrl: "https://brain.example.test/admin/auth/sign-in" });
  assert.match(deniedHtml, /other@example\.test/);
  assert.match(deniedHtml, /Sign out/);
  assert.equal(deniedHtml.includes("Brain Control Plane"), false);
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
  assert.match(html, /mobile-section-menu-button/);
  assert.match(html, /Open admin section menu/);
  assert.match(html, /Control Plane sections/);
  assert.match(html, /Capabilities &amp; Users sections/);
  assert.match(html, /mobile-section-popover/);
  assert.match(html, /tim\.galebach@gmail\.com/);
  assert.match(html, /Sign out \/ switch account/);
  assert.match(html, /<title>Brain<\/title>/);
  assert.equal(html.includes("Brain Control Plane"), false);
  assert.match(html, /id="admin-shell" class="shell" data-app-area="control-plane"/);
  assert.match(html, /data-app-area-switch="control-plane"[^>]*>Control Plane/);
  assert.match(html, /data-app-area-switch="capabilities-users"[^>]*>Capabilities & Users/);
  assert.match(html, /aria-label="Control Plane sections"/);
  assert.match(html, /aria-label="Capabilities &amp; Users sections"/);
  assert.equal(html.includes("href=\"#capabilities\""), false);
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
  assert.match(html, /Slack Canary/);
  assert.match(html, /Slack Visibility \/ Canary/);
  assert.match(html, /Slack visibility \/ canary rollup/);
  assert.match(html, /Manual read-only canary checklist/);
  assert.match(html, /Telemetry correlation rollup/);
  assert.match(html, /OpenRouter/);
  assert.match(html, /OpenRouter subagent model settings/);
  assert.match(html, /Review & write OpenRouter settings/);
  assert.match(html, /Confirm OpenRouter settings write/);
  assert.match(html, /Main-loop model/);
  assert.match(html, /id="main-model-preset"/);
  assert.match(html, /OpenRouter GLM 5\.2/);
  assert.match(html, /Codex\/OpenAI subscription default/);
  assert.match(html, /Save changes \/ Apply model preset/);
  assert.match(html, /id="main-model-preset-status"/);
  assert.match(html, /Confirm main-loop model switch/);
  assert.equal(html.includes('Switch main-loop model'), false);
  assert.match(html, /Slack Details/);
  assert.match(html, /Manifest/);
  assert.match(html, /Capabilities &amp; Users/);
  assert.equal(html.includes('href="#cap-overview"'), false);
  assert.match(html, /href="#cap-users"/);
  assert.match(html, /href="#cap-identities"/);
  assert.match(html, /href="#cap-grants"/);
  assert.match(html, /href="#cap-catalog"/);
  assert.match(html, /href="#cap-audit"/);
  assert.equal(html.includes('id="cap-overview"'), false);
  assert.match(html, /id="cap-users"/);
  assert.match(html, /id="cap-identities"/);
  assert.match(html, /id="cap-grants"/);
  assert.match(html, /id="cap-catalog"/);
  assert.match(html, /id="cap-audit"/);
  assert.equal(html.includes("Counts and top facts for the non-enforcing capability foundation"), false);
  assert.equal(html.includes('data-compact-capabilities-overview="true"'), false);
  assert.equal(html.includes('cap-metric-people'), false);
  assert.match(html, /capSetNavLabel\('cap-users','Users \('/);
  assert.match(html, /capSetNavLabel\('cap-catalog','Catalog \('/);
  assert.match(html, /Coverage subject/);
  assert.match(html, /Compact people rows/);
  assert.match(html, /External identity facts/);
  assert.match(html, /Non-enforcing grants grouped by subject\/person/);
  assert.match(html, /Capability groups are collapsed by default/);
  assert.match(html, /data-compact-capability-catalog/);
  assert.match(html, /data-capability-group/);
  assert.match(html, /Source grant\/bundle/);
  assert.match(html, /owner\/all expanded into rows/);
  assert.match(html, /placeholders not granted/);
  assert.match(html, /Effective active coverage/);
  assert.match(html, /Filter actor \(placeholder\)/);
  assert.match(html, /Dense audit schema\/feed preview/);
  assert.match(html, /data-compact-audit/);
  assert.match(html, /Read-only \/ non-enforcing/);
  assert.match(html, /codex-chat auth unchanged/);
  assert.equal(html.includes("Users / People and communication identities"), false);
  assert.equal(html.includes("Future admin write API shape"), false);
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
  assert.match(html, /Open Slack App Settings/);
  assert.match(html, /id="slack-app-settings-wizard-link"/);
  assert.match(html, /id="slack-app-settings-top-link"/);
  assert.match(html, /Slack API settings/);
  assert.match(html, /https:\/\/api\.slack\.com\/apps/);
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
  assert.match(html, /<select[^>]*id="op"[^>]*>[\s\S]*<option value="restart" selected>restart<\/option>/);
  assert.match(html, /Review & confirm restart/);
  assert.match(html, /Confirm Slack settings write/);
  assert.match(html, /Review & write Slack settings/);
  assert.match(html, /Read-only Slack telemetry/);
  assert.match(html, /Raw \/slack\/telemetry/);
  assert.match(html, /writes codex-chat runtime env to disk/i);
  assert.equal(html.includes('id="op-approval"'), false);
  assert.equal(html.includes('id="slack-approval"'), false);
  assert.equal(html.includes('Type exactly: write Slack settings'), false);
  assert.equal(html.includes("xoxb-super-secret"), false);
  assert.equal(html.includes("signing-secret"), false);
});

test("brain admin page renders direct Slack app settings URL when app id is configured", () => {
  const cfg = config("/tmp/brain-admin-render-app-id", { slackAppId: "A0123456789" });
  const html = renderBrainAdminPage(cfg, "tim.galebach@gmail.com");

  assert.match(html, /Open Slack App Settings/);
  assert.match(html, /https:\/\/api\.slack\.com\/apps\/A0123456789/);
  assert.match(html, /id="slack-app-settings-wizard-url"/);
  assert.match(html, /id="slack-app-settings-top-url"/);
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

test("brain admin capabilities API exposes v2 identities, grouped catalog, grants, and audit shape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-capabilities-"));
  try {
    await writeJson(path.join(root, "workspace/data/projects.json"), {
      version: 1,
      projects: [{ id: "pj_travel", name: "Work/Business Travel", status: "active" }],
    });
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/admin/brain/capabilities`, { headers: authHeaders() });
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        schemaVersion: number;
        path: string;
        mode: string;
        writesEnabled: boolean;
        enforcement: { enabled: boolean; codexChatChanged: boolean };
        catalog: { groups: Array<{ id: string; label: string; resourceScope: { wildcardGrantResourceId?: string }; semantics: { impliedCapabilityIds: string[] }; children: Array<{ id: string; label: string; status: string; resourceScope: { wildcardGrantResourceId?: string } }> }>; counts: { groups: number; capabilities: number; activeCapabilities: number; placeholderCapabilities: number } };
        projectResources: { loaded: boolean; count: number; projects: Array<{ id: string; name: string; resourceScope: string }> };
        store: { path: string; mode?: string; seededThisRequest: boolean; migratedThisRequest: boolean };
        defaultSubjectId: string;
        defaultPersonId: string;
        people: Array<{ id: string; displayName: string; status: string; primarySubjectId: string }>;
        externalIdentities: Array<{ id: string; provider: string; personId?: string; providerUserId: string; providerChatId?: string; status: string }>;
        identityProofs: Array<{ identityId: string; source: string }>;
        communicationChannels: Array<{ provider: string; kind: string; externalIds: Record<string, string> }>;
        subjects: Array<{ id: string; kind: string; label: string }>;
        grantBundles: Array<{ id: string; includes: { capabilityIds: string[] } }>;
        grants: Array<{ id: string; subjectId: string; capabilityId: string; grantKind: string; bundleId?: string; enforcement: string; resource: { kind: string; id: string; selectors: Record<string, string> } }>;
        effectiveBySubject: Record<string, { directGroupCapabilityIds: string[]; impliedCapabilityIds: string[]; byCapabilityId: Record<string, { effective: boolean; impliedByCapabilityIds: string[] }> }>;
        effectiveByPerson: Record<string, { effective: { directBundleIds: string[]; directCapabilityIds: string[]; summary: { activeGrantCount: number; allCapabilities: boolean; allActiveCapabilities: boolean; effectiveCapabilityCount: number; effectiveActiveCapabilityCount: number; totalCapabilityCount: number; activeCapabilityCount: number; placeholderCapabilityCount: number }; byCapabilityId: Record<string, { effective: boolean; directGrantIds: string[]; impliedByBundleIds: string[] }> } }>;
        adminWriteModel: { writesEnabled: boolean; plannedEndpoints: Array<{ path: string }> };
        audit: { writesEnabled: boolean; requiredFields: string[]; eventTypes: Array<{ type: string }>; sampleEvent: Record<string, unknown> };
      };

      assert.equal(payload.schemaVersion, 2);
      assert.equal(payload.mode, "identity_capability_foundation");
      assert.equal(payload.path, path.join(root, "capabilities.json"));
      assert.equal(payload.store.path, path.join(root, "capabilities.json"));
      assert.equal(payload.writesEnabled, false);
      assert.equal(payload.enforcement.enabled, false);
      assert.equal(payload.enforcement.codexChatChanged, false);
      assert.ok(payload.catalog.counts.groups >= 7);
      assert.ok(payload.catalog.counts.capabilities >= 20);

      const projects = payload.catalog.groups.find((group) => group.id === "projects");
      assert.ok(projects);
      assert.equal(projects.label, "Projects");
      assert.ok(projects.semantics.impliedCapabilityIds.includes("projects.files.write"));
      assert.ok(projects.semantics.impliedCapabilityIds.includes("projects.read"));
      assert.equal(projects.resourceScope.wildcardGrantResourceId, "project:*");
      assert.equal(projects.children.some((child) => child.id === "projects.project.read"), false);
      assert.ok(projects.children.some((child) => child.id === "projects.read" && child.resourceScope.wildcardGrantResourceId === "project:*"));
      assert.ok(projects.children.some((child) => child.id === "projects.tasks.write"));
      assert.equal(payload.projectResources.loaded, true);
      assert.equal(payload.projectResources.count, 1);
      assert.ok(payload.projectResources.projects.some((project) => project.name === "Work/Business Travel" && project.resourceScope === "project:pj_travel"));

      assert.equal(payload.defaultPersonId, "person_tim");
      assert.equal(payload.defaultSubjectId, "person:person_tim");
      assert.ok(payload.people.some((person) => person.id === "person_tim" && person.displayName === "Tim" && person.status === "active"));
      assert.ok(payload.externalIdentities.some((identity) => identity.id === "identity_telegram_253768951" && identity.provider === "telegram" && identity.personId === "person_tim" && identity.providerUserId === "253768951" && identity.providerChatId === "253768951"));
      assert.ok(payload.externalIdentities.some((identity) => identity.provider === "slack" && identity.personId === "person_tim" && identity.status === "addable_placeholder"));
      assert.ok(payload.identityProofs.some((proof) => proof.identityId === "identity_telegram_253768951" && proof.source === "telegram_allowlist_migration"));
      assert.ok(payload.communicationChannels.some((channel) => channel.provider === "telegram" && channel.kind === "telegram_private_chat" && channel.externalIds.chatId === "253768951"));
      assert.ok(payload.subjects.some((subject) => subject.id === "brain-admin:current" && subject.kind === "admin_user" && /tim\.galebach@gmail\.com/.test(subject.label)));
      assert.ok(payload.subjects.some((subject) => subject.id === "person:person_tim" && subject.kind === "person"));
      assert.ok(payload.subjects.some((subject) => subject.id === "slack:channel:T00000000:C00000000" && subject.kind === "slack_channel"));
      assert.ok(payload.grantBundles.some((bundle) => bundle.id === "bundle.owner.all" && bundle.includes.capabilityIds.includes("projects.files.write") && !bundle.includes.capabilityIds.includes("finance.summary.read")));
      const timGrants = payload.grants.filter((grant) => grant.subjectId === "person:person_tim");
      assert.equal(timGrants.length, payload.catalog.counts.activeCapabilities);
      assert.equal(timGrants.some((grant) => grant.id === "grant_seed_tim_owner_all" || grant.grantKind === "bundle" || grant.capabilityId === "bundle.owner.all"), false);
      assert.ok(timGrants.some((grant) => grant.id === "grant_seed_tim_owner_projects_read" && grant.capabilityId === "projects.read" && grant.resource.id === "project:*"));
      assert.ok(timGrants.some((grant) => grant.id === "grant_seed_tim_owner_projects_files_write" && grant.capabilityId === "projects.files.write" && grant.grantKind === "capability" && grant.enforcement === "non_enforcing"));
      assert.equal(timGrants.some((grant) => grant.capabilityId === "projects.project.read" || grant.capabilityId === "projects.project.write"), false);
      assert.equal(timGrants.some((grant) => grant.capabilityId === "finance.summary.read" || grant.capabilityId === "health.record.read"), false);
      assert.ok(payload.grants.some((grant) => grant.id === "grant_seed_current_admin_projects_group" && grant.capabilityId === "projects" && grant.grantKind === "group" && grant.enforcement === "non_enforcing"));
      assert.ok(payload.grants.some((grant) => grant.capabilityId === "slack.channel.read" && grant.grantKind === "capability"));

      const adminEffective = payload.effectiveBySubject["brain-admin:current"];
      assert.ok(adminEffective);
      assert.ok(adminEffective.directGroupCapabilityIds.includes("projects"));
      assert.ok(adminEffective.impliedCapabilityIds.includes("projects.files.write"));
      assert.equal(adminEffective.byCapabilityId["projects.files.write"].effective, true);
      assert.deepEqual(adminEffective.byCapabilityId["projects.files.write"].impliedByCapabilityIds, ["projects"]);

      const timEffective = payload.effectiveByPerson.person_tim.effective;
      assert.deepEqual(timEffective.directBundleIds, []);
      assert.equal(timEffective.summary.allCapabilities, false);
      assert.equal(timEffective.summary.allActiveCapabilities, true);
      assert.equal(timEffective.summary.activeGrantCount, payload.catalog.counts.activeCapabilities);
      assert.equal(timEffective.summary.effectiveCapabilityCount, payload.catalog.counts.activeCapabilities);
      assert.equal(timEffective.summary.effectiveActiveCapabilityCount, payload.catalog.counts.activeCapabilities);
      assert.equal(timEffective.summary.totalCapabilityCount, payload.catalog.counts.capabilities);
      assert.equal(timEffective.summary.placeholderCapabilityCount, payload.catalog.counts.placeholderCapabilities);
      assert.equal(timEffective.byCapabilityId["projects.files.write"].effective, true);
      assert.ok(timEffective.byCapabilityId["projects.files.write"].directGrantIds.includes("grant_seed_tim_owner_projects_files_write"));
      assert.equal(timEffective.byCapabilityId["finance.summary.read"].effective, false);
      assert.equal(payload.adminWriteModel.writesEnabled, false);
      assert.ok(payload.adminWriteModel.plannedEndpoints.some((endpoint) => /identity-links/.test(endpoint.path)));

      assert.equal(payload.audit.writesEnabled, false);
      assert.ok(payload.audit.requiredFields.includes("correlationId"));
      assert.ok(payload.audit.eventTypes.some((event) => event.type === "capability.grant.proposed"));
      assert.ok(payload.audit.eventTypes.some((event) => event.type === "capability.check.observed"));
      assert.ok(payload.audit.eventTypes.some((event) => event.type === "identity.link.seeded"));
      assert.equal(JSON.stringify(payload).includes("xoxb-super-secret"), false);

      const fileInfo = await stat(path.join(root, "capabilities.json"));
      assert.equal(`0${(fileInfo.mode & 0o777).toString(8)}`, "0600");
      const store = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8")) as { schemaVersion: number; mode: string; audit: { eventTypes: Array<{ type: string }> } };
      assert.equal(store.schemaVersion, 2);
      assert.equal(store.mode, "identity_capability_foundation");
      assert.ok(store.audit.eventTypes.some((event) => event.type === "capability.catalog.viewed"));

      const writeAttempt = await fetch(`${baseUrl}/api/admin/brain/capabilities`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ capabilityId: "projects" }),
      });
      assert.equal(writeAttempt.status, 404);
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



test("brain admin main-loop model switch writes only CODEX_CHAT_CODEX selectors and keeps subagent settings separate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-main-model-"));
  try {
    const cfg = config(root, { codexChatConfigFile: path.join(root, "codex-chat", "config", "codex-chat.toml") });
    await mkdir(path.dirname(cfg.codexChatConfigFile ?? ""), { recursive: true });
    await writeFile(cfg.codexChatConfigFile ?? "", `version = 1\n\n[codex]\nmodel = "gpt-5.5"\nprofile = ""\nserviceTier = "fast"\n\n[subagents]\ndefaultModel = "gpt-5.5"\ndefaultCodexProfile = ""\n`);
    await withServer(cfg, authDeps(), async (baseUrl) => {
      const summaryResponse = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, { headers: authHeaders() });
      assert.equal(summaryResponse.status, 200);
      const summary = await summaryResponse.json() as { env: { envFile: string }; effective: { model: string; profile: string; modelProvider: string; serviceTierMode: string }; activePreset: string; openRouter: { apiKeyPresent: boolean } };
      assert.equal(summary.effective.model, "gpt-5.5");
      assert.equal(summary.activePreset, "codex-openai-default");
      assert.equal(summary.openRouter.apiKeyPresent, false);

      const keys = [
        "CODEX_CHAT_CODEX_MODEL",
        "CODEX_CHAT_CODEX_PROFILE",
        "CODEX_CHAT_CODEX_MODEL_PROVIDER",
        "CODEX_CHAT_CODEX_SERVICE_TIER",
        "CODEX_CHAT_CODEX_SERVICE_TIER_MODE",
      ];
      const missingConfirmation = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ preset: "openrouter-glm-5.2" }),
      });
      assert.equal(missingConfirmation.status, 400);

      const writeGlm = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ preset: "openrouter-glm-5.2", confirmation: { token: "brain-admin-main-loop-model-confirmed-v1", action: "codex-chat.main-loop-model.write", envFile: summary.env.envFile, preset: "openrouter-glm-5.2", keys } }),
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
      assert.equal(envText.includes("CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL"), false);
      assert.equal(envText.includes("OPENROUTER_API_KEY"), false);

      const rollback = await fetch(`${baseUrl}/api/admin/brain/codex-chat/main-model`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ preset: "codex-openai-default", confirmation: { token: "brain-admin-main-loop-model-confirmed-v1", action: "codex-chat.main-loop-model.write", envFile: summary.env.envFile, preset: "codex-openai-default", keys } }),
      });
      assert.equal(rollback.status, 200);
      const rollbackText = await readFile(path.join(root, "codex-chat.env"), "utf8");
      assert.match(rollbackText, /CODEX_CHAT_CODEX_MODEL='gpt-5\.5'/);
      assert.match(rollbackText, /CODEX_CHAT_CODEX_PROFILE=''/);
      assert.match(rollbackText, /CODEX_CHAT_CODEX_MODEL_PROVIDER=''/);
      assert.match(rollbackText, /CODEX_CHAT_CODEX_SERVICE_TIER_MODE='auto'/);

      const configText = await readFile(cfg.codexChatConfigFile ?? "", "utf8");
      assert.match(configText, /\[subagents\]/);
      assert.doesNotMatch(configText, /defaultModel = "z-ai\/glm-5\.2"/);
      const audit = await readFile(path.join(root, "audit.jsonl"), "utf8");
      assert.match(audit, /codex-chat\.main_loop_model\.write/);
      assert.match(audit, /main-loop-only/);
      assert.equal(audit.includes("OPENROUTER_API_KEY"), false);
      assert.equal(audit.includes("sk-or-"), false);
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
      const settingsPayload = await settings.json() as { publicEventsUrl: string; appSettingsUrl: string; slackAppId: string | null; env: { allowedKeys: string[]; keys: Array<{ key: string; present: boolean; value: string | null }> } };
      assert.equal(settingsPayload.publicEventsUrl, "https://brain.decisive-outcomes.com/api/slack/events");
      assert.equal(settingsPayload.slackAppId, null);
      assert.equal(settingsPayload.appSettingsUrl, "https://api.slack.com/apps");
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
        token: "xoxb-super-secret",
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
        reason: "Bearer xoxb-super-secret",
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
      assert.equal(serialized.includes("xoxb-super-secret"), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin persists manual Slack canary outcomes and correlates redacted telemetry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-slack-canary-"));
  try {
    const observedAt = new Date().toISOString();
    const summaryPath = path.join(root, "codex-chat", "data", "state", "slack_telemetry", "summary.json");
    await writeFileRecursive(summaryPath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: observedAt,
      counters: { "inbound.accepted": 2, "outbound.success": 1, "context.hydrated": 1 },
      lastAcceptedEvent: {
        observedAt,
        direction: "inbound",
        outcome: "accepted",
        eventType: "app_mention",
        channelId: "CROOT",
        userId: "U123",
        text: "must not leak",
      },
      lastContextDecision: {
        observedAt,
        direction: "context",
        outcome: "hydrated",
        sourceKind: "channel",
        selectedSources: ["channel_history"],
        messagesIncluded: 5,
        fallbackCodes: ["no_thread_history:missing_scope"],
        promptExposed: true,
        channelId: "CROOT",
        threadTs: "1782000000.000100",
      },
      lastOutboundSuccess: {
        observedAt,
        direction: "outbound",
        outcome: "success",
        channelId: "CROOT",
        threadTs: "1782000000.000100",
        outboundResultCount: 1,
      },
      lastSubagentRouting: {
        observedAt,
        direction: "subagent",
        outcome: "callback_routed",
        channelId: "CROOT",
        threadTs: "1782000000.000100",
        outputThreadTsPresent: true,
      },
    }));

    await withServer(config(root), authDeps(), async (baseUrl) => {
      const initial = await fetch(`${baseUrl}/api/admin/brain/slack/canary`, { headers: authHeaders() });
      assert.equal(initial.status, 200);
      const initialPayload = await initial.json() as {
        items: Array<{ id: string; label: string; telemetryHints: string[]; status: string }>;
        telemetryRollup: { context?: { sourceKind?: string; selectedSources?: string[]; fallbackCodes?: string[] }; outputTarget: { channelId?: string; threadTs?: string }; counts: Record<string, number>; subagent?: { outputThreadTsPresent?: boolean } };
      };
      assert.ok(initialPayload.items.some((item) => item.id === "root_channel_attached_thread_reply" && item.label === "Root-channel attached-thread reply"));
      assert.ok(initialPayload.items.some((item) => item.label === "Telemetry redaction"));
      assert.equal(initialPayload.telemetryRollup.context?.sourceKind, "channel");
      assert.deepEqual(initialPayload.telemetryRollup.context?.selectedSources, ["channel_history"]);
      assert.deepEqual(initialPayload.telemetryRollup.context?.fallbackCodes, ["no_thread_history:missing_scope"]);
      assert.equal(initialPayload.telemetryRollup.outputTarget.channelId, "CROOT");
      assert.equal(initialPayload.telemetryRollup.outputTarget.threadTs, "1782000000.000100");
      assert.equal(initialPayload.telemetryRollup.counts["inbound.accepted"], 2);
      assert.equal(initialPayload.telemetryRollup.subagent?.outputThreadTsPresent, true);
      assert.equal(JSON.stringify(initialPayload).includes("must not leak"), false);

      const update = await fetch(`${baseUrl}/api/admin/brain/slack/canary`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          itemId: "root_channel_attached_thread_reply",
          status: "passed",
          evidence: "CROOT/1782000000.000100 Bearer xoxb-super-secret",
          notes: "reply landed in attached thread",
        }),
      });
      assert.equal(update.status, 200);
      const updatePayload = await update.json() as { canary: { counts: Record<string, number>; items: Array<{ id: string; status: string; evidence?: string; notes?: string; updatedBy?: string }> } };
      assert.equal(updatePayload.canary.counts.passed, 1);
      const item = updatePayload.canary.items.find((entry) => entry.id === "root_channel_attached_thread_reply");
      assert.equal(item?.status, "passed");
      assert.equal(item?.updatedBy, "tim.galebach@gmail.com");
      assert.equal(item?.evidence?.includes("xoxb-super-secret"), false);
      assert.match(item?.evidence ?? "", /Bearer \[redacted-slack-token\]/);

      const storeText = await readFile(path.join(root, "slack-canary.json"), "utf8");
      assert.equal(storeText.includes("xoxb-super-secret"), false);
      assert.match(storeText, /root_channel_attached_thread_reply/);
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
    await writeFile(path.join(root, "codex-chat.env"), "SLACK_SIGNING_SECRET='s'\nSLACK_BOT_TOKEN='xoxb-super-secret'\nCODEX_CHAT_BASE_URL='https://brain.example.test'\n");
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
      assert.equal(JSON.stringify(payload).includes("xoxb-super-secret"), false);
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
    await writeFile(path.join(root, "codex-chat.env"), "SLACK_SIGNING_SECRET='s'\nSLACK_BOT_TOKEN='xoxb-super-secret'\n");
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
    await writeFile(path.join(root, "codex-chat.env"), "SLACK_SIGNING_SECRET='s'\nSLACK_BOT_TOKEN='xoxb-super-secret'\n");
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
    await writeFile(path.join(root, "codex-chat.env"), "SLACK_SIGNING_SECRET='s'\nSLACK_BOT_TOKEN='xoxb-super-secret'\n");
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
      assert.equal(JSON.stringify(initialPayload).includes("xoxb-super-secret"), false);

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
      assert.equal(completePayload.setup.completedBy, "tim.galebach@gmail.com");
      assert.equal(completePayload.setup.steps.find((step) => step.id === "restart")?.done, true);
      assert.equal((await stat(path.join(root, "slack-setup.json"))).mode & 0o777, 0o600);

      const reconfigure = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ complete: false }),
      });
      assert.equal(reconfigure.status, 200);
      const after = await fetch(`${baseUrl}/api/admin/brain/slack/setup`, { headers: authHeaders() });
      assert.equal((await after.json() as { setupComplete: boolean }).setupComplete, false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin env schema exposes grouped metadata including an other group for unrecognized keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-env-schema-"));
  try {
    await writeFile(path.join(root, "codex-chat.env"), "SLACK_BOT_TOKEN='xoxb-super-secret'\nSOME_CUSTOM_FLAG='1'\nCUSTOM_API_TOKEN='shh'\n");
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/env/schema`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      // Plan §6.4: the endpoint returns the bare schema array (no wrapper object).
      const payload = await res.json() as Array<{ key: string; group: string; required: boolean; secret: boolean; description: string }>;
      assert.ok(Array.isArray(payload));
      const by = Object.fromEntries(payload.map((entry) => [entry.key, entry]));
      assert.equal(by.SLACK_BOT_TOKEN.group, "slack");
      assert.equal(by.SLACK_BOT_TOKEN.secret, true);
      assert.equal(by.SLACK_BOT_TOKEN.required, true);
      assert.equal(by.CODEX_CHAT_BASE_URL.group, "slack");
      assert.equal(by.CODEX_CHAT_CODEX_MODEL.group, "model");
      assert.equal(by.OPENROUTER_API_KEY.group, "openrouter");
      assert.equal(by.CODEX_CHAT_API_ENABLED.group, "feature_flags");
      // Unrecognized keys present in the env file surface under the other group.
      assert.equal(by.SOME_CUSTOM_FLAG.group, "other");
      assert.equal(by.CUSTOM_API_TOKEN.group, "other");
      assert.equal(by.CUSTOM_API_TOKEN.secret, true);
      assert.equal(JSON.stringify(payload).includes("xoxb-super-secret"), false);
      assert.equal(JSON.stringify(payload).includes("shh"), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brain admin env write still requires the approval phrase and validates against the schema", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-env-validate-"));
  try {
    await withServer(config(root), authDeps(), async (baseUrl) => {
      // The approval phrase is still required (the legacy console posts on one click).
      const noApproval = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ entries: { CODEX_CHAT_BASE_URL: "https://brain.example.test", SLACK_BOT_TOKEN: "xoxb-super-secret" } }),
      });
      assert.equal(noApproval.status, 400);
      assert.equal((await noApproval.json() as { error: string }).error, "approval_required");

      // With the phrase, allowed writes succeed.
      const write = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ approval: "write env", entries: { CODEX_CHAT_BASE_URL: "https://brain.example.test", SLACK_BOT_TOKEN: "xoxb-super-secret" } }),
      });
      assert.equal(write.status, 200);
      const okPayload = await write.json() as { writtenKeys: string[] };
      assert.deepEqual(okPayload.writtenKeys.sort(), ["CODEX_CHAT_BASE_URL", "SLACK_BOT_TOKEN"]);

      // With the phrase, schema validation still returns field-level errors (bad URL format).
      const invalid = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ approval: "write env", entries: { CODEX_CHAT_BASE_URL: "not-a-url" } }),
      });
      assert.equal(invalid.status, 400);
      const invalidPayload = await invalid.json() as { error: string; fieldErrors: Array<{ key: string; code: string }> };
      assert.equal(invalidPayload.error, "validation_failed");
      assert.ok(invalidPayload.fieldErrors.some((fieldError) => fieldError.key === "CODEX_CHAT_BASE_URL" && fieldError.code === "invalid_format"));

      // Empty required value is a field-level error.
      const empty = await fetch(`${baseUrl}/api/admin/brain/codex-chat/env`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ approval: "write env", entries: { CODEX_CHAT_BASE_URL: "" } }),
      });
      assert.equal(empty.status, 400);
      assert.ok((await empty.json() as { fieldErrors: Array<{ key: string; code: string }> }).fieldErrors.some((fieldError) => fieldError.code === "required"));
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

test("brain capability catalog endpoint serves groups as data from the store vocabulary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-admin-catalog-"));
  try {
    await writeLiveStore(root);
    await withServer(config(root), authDeps(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/brain/capabilities/catalog`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const payload = await res.json() as {
        storeAvailable: boolean;
        groups: Array<{ id: string; status: string; childCount: number; presentChildCount: number; children: Array<{ id: string; present: boolean }> }>;
        counts: { groups: number; uncategorized: number };
      };
      assert.equal(payload.storeAvailable, true);
      const groupIds = payload.groups.map((group) => group.id);
      // Plan §2.3 canonical group list renders first, in order, as data.
      assert.deepEqual(groupIds.slice(0, 8), ["projects", "crm", "calendar", "slack", "todos", "finance", "health", "capability-admin"]);
      const byId = Object.fromEntries(payload.groups.map((group) => [group.id, group]));
      // Finance/Health are ordinary not-yet-connected placeholder groups (empty).
      assert.equal(byId.finance.status, "placeholder");
      assert.equal(byId.finance.childCount, 0);
      assert.equal(byId.health.status, "placeholder");
      // Real grant vocabulary is marked present under human groups.
      assert.equal(byId.projects.children.find((child) => child.id === "projects.read")?.present, true);
      assert.equal(byId.output.children.find((child) => child.id === "output.text.send")?.present, true);
      assert.equal(byId.events.children.find((child) => child.id === "telegram.event.receive")?.present, true);
      // Every capability id the store references maps to a catalog group.
      assert.equal(payload.counts.uncategorized, 0);
    });
  } finally {
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
        people: Array<{ id: string; displayName: string; identities: Array<{ provider: string; externalId: string; linkedAt?: string }>; grants: { total: number; grantedGroupCount: number; totalGroupCount: number; byGroup: Array<{ id: string; granted: boolean }> } }>;
        systemSubjects: Array<{ id: string; grants: { total: number; capabilityIds: string[] } }>;
        counts: { people: number; systemSubjects: number };
      };
      assert.equal(payload.storeAvailable, true);
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
  try {
    await writeJson(path.join(root, "capabilities.json"), disabledSubjectStore());
    await withServer(config(root), authDeps(), async (baseUrl) => {
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
