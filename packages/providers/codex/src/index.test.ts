import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerTransport, createCodexProvider, createCodexTransport } from "./index.js";

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
  assert.match(health.detail ?? "", /typed but not implemented/);

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
