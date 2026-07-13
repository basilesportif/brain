import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatCanaryReport, runCanary } from "./canary.js";

const OWNER_SUBJECT = "person:owner";
const OWNER_TELEGRAM_ID = "900000001";
const BASELINE = [
  "telegram.event.receive",
  "assistant.run",
  "output.text.send",
  "crm.contact.read",
];

interface Fixture {
  root: string;
  configPath: string;
  logicRepo: string;
  workspace: string;
  socketPath: string;
  storePath: string;
  store: Record<string, unknown>;
}

interface FakeIpc {
  close(): Promise<void>;
  requests: Array<Record<string, unknown>>;
}

test("fully provisioned canary fixture passes every default check", async () => {
  const fixture = await createFixture();
  let ipc: FakeIpc | undefined;
  try {
    ipc = await startFakeIpc(fixture.socketPath, fixture.store);
    const report = await runCanary({ config: fixture.configPath, timeoutMs: 500 });

    assert.equal(report.ok, true);
    assert.equal(report.verdict, "PASS");
    assert.equal(report.checks.length, 7);
    assert.deepEqual(report.checks.map((check) => check.status), Array(7).fill("PASS"));
    assert.match(formatCanaryReport(report), /Brain provisioning canary: PASS/);
    assert.equal(ipc.requests.every((request) => request.type === "check_capability"), true);
    const ownerRequests = ipc.requests.filter((request) => request.brainSubjectId === OWNER_SUBJECT);
    const resources = Object.fromEntries(ownerRequests.map((request) => [request.operation, request.resource]));
    const telegramResource = {
      source: "telegram",
      surfaceKind: "telegram",
      chatId: OWNER_TELEGRAM_ID,
      actorId: OWNER_TELEGRAM_ID,
      messageId: "canary",
      conversationSessionId: "canary",
    };
    assert.deepEqual(resources["telegram.event.receive"], telegramResource);
    assert.deepEqual(resources["assistant.run"], telegramResource);
    assert.deepEqual(resources["output.text.send"], { ...telegramResource, outputType: "text" });
    assert.deepEqual(resources["crm.contact.read"], {});
  } finally {
    if (ipc) await ipc.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing output.text.send grant fails check 5 and names the grant", async () => {
  const fixture = await createFixture({ missingCapability: "output.text.send" });
  let ipc: FakeIpc | undefined;
  try {
    ipc = await startFakeIpc(fixture.socketPath, fixture.store);
    const report = await runCanary({ config: fixture.configPath, timeoutMs: 500 });
    const check = report.checks.find((candidate) => candidate.number === 5);

    assert.equal(report.ok, false);
    assert.equal(check?.status, "FAIL");
    assert.match(check?.reason ?? "", /missing live grants: output\.text\.send/);
    assert.match(check?.remediation ?? "", /output\.text\.send/);
  } finally {
    if (ipc) await ipc.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("wrongly scoped runtime grant still fails check 5", async () => {
  const fixture = await createFixture({ wrongSurfaceCapability: "assistant.run" });
  let ipc: FakeIpc | undefined;
  try {
    ipc = await startFakeIpc(fixture.socketPath, fixture.store);
    const report = await runCanary({ config: fixture.configPath, timeoutMs: 500 });
    const check = report.checks.find((candidate) => candidate.number === 5);

    assert.equal(report.ok, false);
    assert.equal(check?.status, "FAIL");
    assert.match(check?.reason ?? "", /missing live grants: assistant\.run/);
  } finally {
    if (ipc) await ipc.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy config without paths passes when logic repo and workspace overrides are supplied", async () => {
  const fixture = await createFixture({ omitPaths: true });
  let ipc: FakeIpc | undefined;
  try {
    ipc = await startFakeIpc(fixture.socketPath, fixture.store);
    const withoutOverrides = await runCanary({ config: fixture.configPath, timeoutMs: 500 });
    const missingPaths = withoutOverrides.checks.find((candidate) => candidate.number === 1);
    assert.equal(missingPaths?.status, "FAIL");
    assert.match(missingPaths?.reason ?? "", /--logic-repo/);
    assert.match(missingPaths?.reason ?? "", /--workspace/);

    const withOverrides = await runCanary({
      config: fixture.configPath,
      logicRepo: fixture.logicRepo,
      workspace: fixture.workspace,
      timeoutMs: 500,
    });
    assert.equal(withOverrides.ok, true);
    assert.deepEqual(withOverrides.checks.map((check) => check.status), Array(7).fill("PASS"));
  } finally {
    if (ipc) await ipc.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("store without a Telegram-linked owner fails check 3", async () => {
  const fixture = await createFixture({ telegramOwner: false });
  let ipc: FakeIpc | undefined;
  try {
    ipc = await startFakeIpc(fixture.socketPath, fixture.store);
    const report = await runCanary({ config: fixture.configPath, timeoutMs: 500 });
    const check = report.checks.find((candidate) => candidate.number === 3);

    assert.equal(report.ok, false);
    assert.equal(check?.status, "FAIL");
    assert.match(check?.reason ?? "", /no Telegram-linked owner/);
  } finally {
    if (ipc) await ipc.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unreachable IPC fails check 4 and reports the socket path", async () => {
  const fixture = await createFixture();
  try {
    const report = await runCanary({ config: fixture.configPath, timeoutMs: 50 });
    const check = report.checks.find((candidate) => candidate.number === 4);

    assert.equal(report.ok, false);
    assert.equal(check?.status, "FAIL");
    assert.ok(check?.reason.includes(fixture.socketPath));
    assert.match(check?.remediation ?? "", /green systemd unit is not sufficient/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("open enforcement that allows an absent subject fails check 6", async () => {
  const fixture = await createFixture();
  let ipc: FakeIpc | undefined;
  try {
    ipc = await startFakeIpc(fixture.socketPath, fixture.store, { allowAbsent: true });
    const report = await runCanary({ config: fixture.configPath, timeoutMs: 500 });
    const check = report.checks.find((candidate) => candidate.number === 6);

    assert.equal(report.ok, false);
    assert.equal(check?.status, "FAIL");
    assert.match(check?.reason ?? "", /person:__canary_absent__/);
    assert.match(check?.remediation ?? "", /effectively open/);
  } finally {
    if (ipc) await ipc.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(options: {
  missingCapability?: string;
  omitPaths?: boolean;
  telegramOwner?: boolean;
  wrongSurfaceCapability?: string;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-canary-"));
  const logicRepo = path.join(root, "assistant-agent-logic");
  const workspace = path.join(root, "workspace");
  const behaviorDir = path.join(root, "behavior");
  const configDir = path.join(root, "config");
  const storePath = path.join(root, "control-plane", "capabilities.json");
  const socketPath = path.join(workspace, "state", "run", "codex-chat.sock");
  const configPath = path.join(configDir, "codex-chat.toml");
  await Promise.all([
    mkdir(logicRepo, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(behaviorDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(path.dirname(storePath), { recursive: true }),
    mkdir(path.dirname(socketPath), { recursive: true }),
  ]);
  await writeFile(path.join(behaviorDir, "AGENTS.md"), "# Synthetic behavior pack\n");

  const grants = BASELINE
    .filter((operation) => operation !== options.missingCapability)
    .map((operation, index) => ({
      id: `grant-${index + 1}`,
      subjectId: OWNER_SUBJECT,
      capabilityId: operation,
      actions: [{
        "telegram.event.receive": "receive",
        "assistant.run": "run",
        "output.text.send": "send",
        "crm.contact.read": "read",
      }[operation]],
      resource: {
        selectors: operation === "crm.contact.read" ? {} : {
          source: "*",
          surfaceKind: operation === options.wrongSurfaceCapability ? "slack" : "telegram",
          chatId: "*",
          actorId: "*",
          messageId: "*",
          conversationSessionId: "*",
          ...(operation === "output.text.send" ? { outputType: "text" } : {}),
        },
      },
      status: "active",
      enforcement: "enforcing",
    }));
  const telegramOwner = options.telegramOwner !== false;
  const store = {
    schemaVersion: 2,
    people: [{
      id: "owner",
      status: "active",
      primarySubjectId: OWNER_SUBJECT,
      subjectIds: [OWNER_SUBJECT],
      identityIds: telegramOwner ? ["telegram-owner"] : [],
    }],
    externalIdentities: telegramOwner ? [{
      id: "telegram-owner",
      provider: "telegram",
      providerUserId: OWNER_TELEGRAM_ID,
      providerChatId: OWNER_TELEGRAM_ID,
      personId: "owner",
      status: "linked",
    }] : [],
    subjects: [{ id: OWNER_SUBJECT, kind: "person", personId: "owner", status: "active" }],
    grants,
  };
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`);
  const configLines = [
    "version = 1",
    "",
    "[service]",
    `workspace = ${JSON.stringify(workspace)}`,
    `stateDir = ${JSON.stringify(path.join(workspace, "state", "codex-chat"))}`,
    `ipcSocket = ${JSON.stringify(socketPath)}`,
    "",
    "[brain]",
    `storePath = ${JSON.stringify(storePath)}`,
    "enforcementEnabled = true",
    "",
    "[behavior]",
    `dir = ${JSON.stringify(behaviorDir)}`,
    'entrypoint = "AGENTS.md"',
    "",
  ];
  if (!options.omitPaths) {
    configLines.splice(7, 0,
      "[paths]",
      `logicRepo = ${JSON.stringify(logicRepo)}`,
      `assistantWorkspace = ${JSON.stringify(workspace)}`,
      "",
    );
  }
  await writeFile(configPath, configLines.join("\n"));
  return { root, configPath, logicRepo, workspace, socketPath, storePath, store };
}

async function startFakeIpc(
  socketPath: string,
  store: Record<string, unknown>,
  options: { allowAbsent?: boolean } = {},
): Promise<FakeIpc> {
  const requests: Array<Record<string, unknown>> = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      if (request.type !== "check_capability") {
        socket.write(`${JSON.stringify({ ok: false, error: "unsupported" })}\n`);
        return;
      }
      const subjectId = String(request.brainSubjectId ?? "");
      const operation = String(request.operation ?? "");
      const action = String(request.action ?? "");
      const resource = isRecord(request.resource) ? request.resource : {};
      const grants = Array.isArray(store.grants) ? store.grants.filter(isRecord) : [];
      const allowed = options.allowAbsent && subjectId === "person:__canary_absent__"
        ? true
        : grants.some((grant) =>
          grant.subjectId === subjectId
          && grant.capabilityId === operation
          && actionAllowed(grant, action)
          && selectorsMatch(grant, resource));
      socket.write(`${JSON.stringify({
        ok: true,
        result: { allowed, reason: allowed ? "active_brain_grant" : "actor_not_linked_to_brain_subject" },
      })}\n`);
    });
  });
  await listen(server, socketPath);
  return {
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function actionAllowed(grant: Record<string, unknown>, action: string): boolean {
  if (!action || action === "*") return true;
  const actions = Array.isArray(grant.actions) ? grant.actions.map(String) : [];
  return actions.includes(action) || actions.includes("*");
}

function selectorsMatch(grant: Record<string, unknown>, resource: Record<string, unknown>): boolean {
  const grantResource = isRecord(grant.resource) ? grant.resource : {};
  const selectors = isRecord(grantResource.selectors) ? grantResource.selectors : {};
  for (const [key, selector] of Object.entries(selectors)) {
    if (selector !== "*" && selector !== resource[key]) return false;
    if (resource[key] === undefined) return false;
  }
  for (const [key, actual] of Object.entries(resource)) {
    if (actual !== undefined && actual !== null && actual !== "" && !(key in selectors)) return false;
  }
  return true;
}
