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
    capabilityStorePath: path.join(root, "capabilities.json"),
    capabilityAuditLogPath: path.join(root, "capability-audit.jsonl"),
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
