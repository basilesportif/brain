import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAppServerTransport, CodexExecTransport, buildCodexExecArgs, createCodexProvider, createCodexTransport } from "./index.js";

test("Codex provider creates runtime-core compatible stub sessions", async () => {
  const provider = createCodexProvider({ transport: "stub" });
  const session = await provider.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, true);
  assert.equal(health.provider, "codex");
});

test("Codex provider exposes typed app-server transport seam", async () => {
  const transport = createCodexTransport({ transport: "app-server", appServerUrl: "ws://127.0.0.1:9999" });
  assert.ok(transport instanceof CodexAppServerTransport);
  const session = await transport.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, false);
  assert.match(health.detail ?? "", /protocol client/);

  const events = [];
  for await (const event of session.sendTurn({
    id: "turn_1",
    sessionId: session.id,
    inboundEvent: {
      id: "evt_1",
      kind: "message",
      workspaceId: "personal",
      entrypoint: { entrypointId: "cli", channelKind: "cli" },
      text: "hello",
      receivedAt: "2026-05-21T00:00:00.000Z",
    },
    prompt: "hello",
  })) events.push(event);
  assert.equal(events[0]?.type, "error");
});

test("Codex exec transport shells out and maps JSONL events", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "brain-codex-exec-"));
  const fakeCodex = path.join(dir, "fake-codex.mjs");
  await writeFile(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  console.log(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn_fake" } } }));
  console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "Codex fake: " } }));
  console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: input.trim() } }));
  console.log(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_fake", status: "completed", items: [] } } }));
});
`);
  await chmod(fakeCodex, 0o755);

  const artifactDir = path.join(dir, "artifacts");
  const transport = createCodexTransport({ transport: "exec", binary: fakeCodex, cwd: dir });
  assert.ok(transport instanceof CodexExecTransport);
  const session = await transport.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, true);
  assert.match(health.detail ?? "", /fake-codex/);

  const events = [];
  for await (const event of session.sendTurn({
    id: "turn_1",
    sessionId: session.id,
    inboundEvent: {
      id: "evt_1",
      kind: "message",
      workspaceId: "personal",
      entrypoint: { entrypointId: "cli", channelKind: "cli" },
      text: "hello",
      receivedAt: "2026-05-21T00:00:00.000Z",
    },
    prompt: "hello",
    artifactDir,
  })) events.push(event);

  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.text).join(""), "Codex fake: hello");
  assert.deepEqual(events.find((event) => event.type === "final"), { type: "final", text: "Codex fake: hello" });
});

test("Codex exec transport captures last-message artifacts and resume handles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "brain-codex-artifacts-"));
  const fakeCodex = path.join(dir, "fake-codex.mjs");
  await writeFile(fakeCodex, `#!/usr/bin/env node
const outIndex = process.argv.indexOf("--output-last-message");
if (outIndex >= 0) await import("node:fs/promises").then(({ writeFile }) => writeFile(process.argv[outIndex + 1], "last message from file\\n"));
console.log(JSON.stringify({ method: "thread/started", params: { thread: { id: "thread_123" } } }));
console.log(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_123", threadId: "thread_123", items: [] } } }));
`);
  await chmod(fakeCodex, 0o755);

  const artifactDir = path.join(dir, "artifacts");
  const session = await createCodexTransport({ transport: "exec", binary: fakeCodex, cwd: dir }).createSession({ workspaceId: "personal" });
  const events = [];
  for await (const event of session.sendTurn({
    id: "turn_1",
    sessionId: session.id,
    inboundEvent: {
      id: "evt_1",
      kind: "message",
      workspaceId: "personal",
      entrypoint: { entrypointId: "cli", channelKind: "cli" },
      text: "hello",
      receivedAt: "2026-05-21T00:00:00.000Z",
    },
    prompt: "hello",
    artifactDir,
  })) events.push(event);

  assert.deepEqual(events.find((event) => event.type === "final"), { type: "final", text: "last message from file" });
  const artifact = events.find((event) => event.type === "artifact");
  assert.equal(artifact?.artifact.localPath, path.join(artifactDir, "codex-last-message.md"));
  assert.equal((await session.resumeHandle?.())?.sessionId, "thread_123");
});

test("Codex exec transport cancels active turns on abort", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "brain-codex-cancel-"));
  const fakeCodex = path.join(dir, "fake-codex.mjs");
  await writeFile(fakeCodex, `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);
`);
  await chmod(fakeCodex, 0o755);
  const session = await createCodexTransport({ transport: "exec", binary: fakeCodex, timeoutMs: 30_000 }).createSession({ workspaceId: "personal" });
  const controller = new AbortController();
  const events = [];
  setTimeout(() => controller.abort("unit test"), 25).unref();
  for await (const event of session.sendTurn({
    id: "turn_cancel",
    sessionId: session.id,
    inboundEvent: {
      id: "evt_1",
      kind: "message",
      workspaceId: "personal",
      entrypoint: { entrypointId: "cli", channelKind: "cli" },
      text: "cancel",
      receivedAt: "2026-05-21T00:00:00.000Z",
    },
    prompt: "cancel",
    abortSignal: controller.signal,
  })) events.push(event);

  assert.equal(events.some((event) => event.type === "error" && /cancelled/.test(event.message)), true);
});

test("buildCodexExecArgs keeps Codex session persistence enabled unless ephemeral is requested", () => {
  const args = buildCodexExecArgs({ transport: "exec", model: "gpt-5.5", effort: "high", approvalPolicy: "never" }, {
    id: "turn_1",
    sessionId: "session_1",
    inboundEvent: {
      id: "evt_1",
      kind: "message",
      workspaceId: "personal",
      entrypoint: { entrypointId: "cli", channelKind: "cli" },
      text: "hello",
      receivedAt: "2026-05-21T00:00:00.000Z",
    },
    prompt: "hello",
  });
  assert.equal(args.includes("--ephemeral"), false);
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--color", "never"]);
  assert.equal(args.at(-1), "-");
});

test("buildCodexExecArgs supports provider-native resume without turn replay persistence", () => {
  const args = buildCodexExecArgs({ transport: "exec", resumeSessionId: "thread_123", effort: "medium" }, {
    id: "turn_2",
    sessionId: "session_1",
    inboundEvent: {
      id: "evt_2",
      kind: "message",
      workspaceId: "personal",
      entrypoint: { entrypointId: "cli", channelKind: "cli" },
      text: "resume",
      receivedAt: "2026-05-21T00:00:00.000Z",
    },
    prompt: "resume",
  });
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "--json"]);
  assert.equal(args.includes("thread_123"), true);
  assert.equal(args.at(-1), "-");
});
