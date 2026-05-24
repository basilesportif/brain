import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAppServerTransport, CodexExecTransport, buildCodexExecArgs, codexProviderSecretEnvNames, createCodexProvider, createCodexTransport, sanitizeCodexProviderEnv, type CodexAppServerWebSocket } from "./index.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("Codex provider creates runtime-core compatible stub sessions", async () => {
  const provider = createCodexProvider({ transport: "stub" });
  const session = await provider.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, true);
  assert.equal(health.provider, "codex");
});

test("Codex provider exposes typed app-server transport seam", async () => {
  const transport = createCodexTransport({ transport: "app-server" });
  assert.ok(transport instanceof CodexAppServerTransport);
  const session = await transport.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, false);
  assert.match(health.detail ?? "", /appServerUrl|binary/);

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

test("Codex provider env sanitizer strips OpenAI and configured transcription refs", () => {
  const env = sanitizeCodexProviderEnv(
    { transcriptionApiKeyRef: "env:BRAIN_TRANSCRIPTION_KEY", secretEnvNames: ["EXTRA_SECRET"] },
    {
      OPENAI_API_KEY: "present",
      BRAIN_TRANSCRIPTION_KEY: "present",
      EXTRA_SECRET: "present",
      OTHER_VAR: "keep",
    },
  );

  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.BRAIN_TRANSCRIPTION_KEY, undefined);
  assert.equal(env.EXTRA_SECRET, undefined);
  assert.equal(env.OTHER_VAR, "keep");
  assert.deepEqual(new Set(codexProviderSecretEnvNames({ transcriptionApiKeyRef: "BRAIN_TRANSCRIPTION_KEY" })), new Set(["OPENAI_API_KEY", "BRAIN_TRANSCRIPTION_KEY"]));
  assert.deepEqual(codexProviderSecretEnvNames({ transcriptionApiKeyRef: "file:/tmp/transcription-key" }), ["OPENAI_API_KEY"]);
});

test("Codex app-server transport speaks JSON-RPC over the protocol seam", async () => {
  const sent: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  class FakeWebSocket implements CodexAppServerWebSocket {
    readyState = 0;
    private listeners = new Map<string, Array<(event?: unknown) => void>>();

    constructor() {
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    addEventListener(type: "open", listener: () => void): void;
    addEventListener(type: "close", listener: (event?: unknown) => void): void;
    addEventListener(type: "error", listener: (event?: unknown) => void): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    addEventListener(type: "open" | "close" | "error" | "message", listener: (...args: never[]) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as (event?: unknown) => void]);
    }

    close(): void {
      this.readyState = 3;
      this.emit("close");
    }

    send(data: string): void {
      const message = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
      sent.push({ method: message.method, params: message.params });
      if (message.method === "initialize") this.respond(message.id, {});
      else if (message.method === "thread/start") this.respond(message.id, { thread: { id: "thread_fake" } });
      else if (message.method === "turn/start") {
        this.respond(message.id, { turn: { id: "turn_fake" } });
        setTimeout(() => {
          this.message({ method: "item/agentMessage/delta", params: { turnId: "turn_fake", delta: "hello " } });
          this.message({ method: "item/agentMessage/delta", params: { turnId: "turn_fake", delta: "world" } });
          this.message({ method: "turn/completed", params: { turn: { id: "turn_fake", threadId: "thread_fake", status: "completed" } } });
        }, 0);
      } else this.respond(message.id, {});
    }

    private respond(id: number, result: unknown): void {
      queueMicrotask(() => this.message({ id, result }));
    }

    private message(value: unknown): void {
      this.emit("message", { data: JSON.stringify(value) });
    }

    private emit(type: string, event?: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  const session = await createCodexTransport({
    transport: "app-server",
    appServerUrl: "ws://127.0.0.1:9999",
    appServerWebSocketFactory: () => new FakeWebSocket(),
    model: "gpt-test",
    effort: "medium",
  }).createSession({ workspaceId: "personal" });
  await session.start();
  assert.equal((await session.health()).ok, true);

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

  assert.deepEqual(events.filter((event) => event.type === "delta").map((event) => event.text).join(""), "hello world");
  assert.deepEqual(events.find((event) => event.type === "final"), { type: "final", text: "hello world" });
  assert.equal((await session.resumeHandle?.())?.sessionId, "thread_fake");
  assert.deepEqual(sent.map((item) => item.method), ["initialize", "thread/start", "turn/start"]);
  await session.stop();
});

test("Codex app-server spawn does not inherit OpenAI or transcription env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "brain-codex-app-env-"));
  const fakeCodex = path.join(dir, "fake-codex-app.mjs");
  const appEnvPath = path.join(dir, "app-server-env.json");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(appEnvPath)}, JSON.stringify({
  openai: Boolean(process.env.OPENAI_API_KEY),
  transcription: Boolean(process.env.BRAIN_TRANSCRIPTION_KEY),
  other: process.env.OTHER_VAR || null
}));
setInterval(() => {}, 1000);
`);
  await chmod(fakeCodex, 0o755);
  const original = {
    openai: process.env.OPENAI_API_KEY,
    transcription: process.env.BRAIN_TRANSCRIPTION_KEY,
    other: process.env.OTHER_VAR,
  };
  try {
    process.env.OPENAI_API_KEY = "sk-test-parent-openai";
    process.env.BRAIN_TRANSCRIPTION_KEY = "sk-test-parent-transcription";
    process.env.OTHER_VAR = "keep-me";
    const session = await createCodexTransport({
      transport: "app-server",
      binary: fakeCodex,
      cwd: dir,
      appServerStartupTimeoutMs: 1000,
      appServerRequestTimeoutMs: 100,
      transcriptionApiKeyRef: "BRAIN_TRANSCRIPTION_KEY",
    }).createSession({ workspaceId: "personal" });

    try {
      await assert.rejects(session.start(), /Codex app-server/);
    } finally {
      await session.stop();
    }

    assert.deepEqual(JSON.parse(await readFile(appEnvPath, "utf8")), { openai: false, transcription: false, other: "keep-me" });
  } finally {
    restoreEnv("OPENAI_API_KEY", original.openai);
    restoreEnv("BRAIN_TRANSCRIPTION_KEY", original.transcription);
    restoreEnv("OTHER_VAR", original.other);
  }
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

test("Codex exec health and turn spawns do not inherit OpenAI or transcription env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "brain-codex-env-"));
  const fakeCodex = path.join(dir, "fake-codex.mjs");
  const healthEnvPath = path.join(dir, "health-env.json");
  const turnEnvPath = path.join(dir, "turn-env.json");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const snapshot = () => JSON.stringify({
  openai: Boolean(process.env.OPENAI_API_KEY),
  transcription: Boolean(process.env.BRAIN_TRANSCRIPTION_KEY),
  other: process.env.OTHER_VAR || null
});
if (process.argv.includes("--version")) {
  await writeFile(${JSON.stringify(healthEnvPath)}, snapshot());
  console.log("fake-codex 1.0.0");
  process.exit(0);
}
await writeFile(${JSON.stringify(turnEnvPath)}, snapshot());
console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "ok" } }));
console.log(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_fake", status: "completed", items: [] } } }));
`);
  await chmod(fakeCodex, 0o755);

  const original = {
    openai: process.env.OPENAI_API_KEY,
    transcription: process.env.BRAIN_TRANSCRIPTION_KEY,
    other: process.env.OTHER_VAR,
  };
  try {
    process.env.OPENAI_API_KEY = "sk-test-parent-openai";
    process.env.BRAIN_TRANSCRIPTION_KEY = "sk-test-parent-transcription";
    process.env.OTHER_VAR = "keep-me";

    const session = await createCodexTransport({
      transport: "exec",
      binary: fakeCodex,
      cwd: dir,
      transcriptionApiKeyRef: "env:BRAIN_TRANSCRIPTION_KEY",
    }).createSession({ workspaceId: "personal" });
    assert.equal((await session.health()).ok, true);
    const events = [];
    for await (const event of session.sendTurn({
      id: "turn_env",
      sessionId: session.id,
      inboundEvent: {
        id: "evt_env",
        kind: "message",
        workspaceId: "personal",
        entrypoint: { entrypointId: "cli", channelKind: "cli" },
        text: "hello",
        receivedAt: "2026-05-21T00:00:00.000Z",
      },
      prompt: "hello",
    })) events.push(event);

    assert.equal(events.some((event) => event.type === "error"), false);
    assert.deepEqual(JSON.parse(await readFile(healthEnvPath, "utf8")), { openai: false, transcription: false, other: "keep-me" });
    assert.deepEqual(JSON.parse(await readFile(turnEnvPath, "utf8")), { openai: false, transcription: false, other: "keep-me" });
  } finally {
    restoreEnv("OPENAI_API_KEY", original.openai);
    restoreEnv("BRAIN_TRANSCRIPTION_KEY", original.transcription);
    restoreEnv("OTHER_VAR", original.other);
  }
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
