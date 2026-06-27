import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { authorizeBrainAdminRequest, parseAdminAllowedEmails } from "./admin-auth.js";
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
    repoRegistryPath: path.join(root, "repo-registry.yaml"),
    codexChatEnvFile: path.join(root, "codex-chat.env"),
    codexChatConfigFile: undefined,
    codexChatServiceName: "codex-chat.service",
    codexChatDeployCommand: "echo deploy-ok",
    codexChatRestartCommand: "echo restart-ok",
    brainServiceName: "brain-admin.service",
    auditLogPath: path.join(root, "audit.jsonl"),
    allowedEnvKeys: ["CODEX_CHAT_BASE_URL", "SLACK_BOT_TOKEN"],
    operationTimeoutMs: 5_000,
    ...overrides,
  };
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

test("brain admin auth parses allowlist and fails closed", async () => {
  assert.deepEqual(parseAdminAllowedEmails(" Tim.Galebach@Gmail.com, timgalebachukraine@gmail.com "), new Set(["tim.galebach@gmail.com", "timgalebachukraine@gmail.com"]));

  assert.deepEqual(
    await authorizeBrainAdminRequest({ headers: { authorization: "Bearer token" } } as never, { clerkPublishableKey: "pk", clerkSecretKey: "sk", clerkAllowedEmails: "" }, authDeps()),
    { ok: false, statusCode: 403, error: "admin_allowlist_empty" },
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

test("brain admin operation API requires explicit approval and audits execution", async () => {
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
      const missingApproval = await fetch(`${baseUrl}/api/admin/brain/codex-chat/operation`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ operation: "restart", approval: "restart" }),
      });
      assert.equal(missingApproval.status, 400);

      const plan = await fetch(`${baseUrl}/api/admin/brain/codex-chat/operation`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ operation: "plan", approval: "plan codex-chat.service" }),
      });
      assert.equal(plan.status, 200);
      assert.equal((await plan.json() as { dryRun: boolean }).dryRun, true);
      assert.deepEqual(calls, []);

      const restart = await fetch(`${baseUrl}/api/admin/brain/codex-chat/operation`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ operation: "restart", approval: "restart codex-chat.service" }),
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
