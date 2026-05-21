import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeSdkTransport, ClaudeCodeSubagentTransport, createClaudeCodeProvider, createClaudeCodeTransport, type ClaudeCodeSubagentRun } from "./index.js";

test("Claude Code provider creates runtime-core compatible sessions", async () => {
  const provider = createClaudeCodeProvider({ transport: "stub" });
  const session = await provider.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, true);
  assert.equal(health.provider, "claude-code");
});

test("Claude Code provider exposes typed SDK seam without bundling SDK dependency", async () => {
  const transport = createClaudeCodeTransport({ transport: "sdk", model: "sonnet" });
  assert.ok(transport instanceof ClaudeCodeSdkTransport);
  const session = await transport.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, false);
  assert.match(health.detail ?? "", /injected client/);
});

test("Claude Code subagent transport delegates turns, cancellation, and steering", async () => {
  const seen: string[] = [];
  const transport = createClaudeCodeTransport({
    transport: "subagent",
    subagentClient: {
      async start(input): Promise<ClaudeCodeSubagentRun> {
        seen.push(input.turn.prompt);
        return {
          events: (async function* () {
            yield { type: "status" as const, message: "started" };
            yield { type: "final" as const, text: `subagent: ${input.turn.prompt}` };
          })(),
          cancel: async (reason) => { seen.push(`cancel:${reason}`); },
          steer: async (text) => { seen.push(`steer:${text}`); },
        };
      },
    },
  });
  assert.ok(transport instanceof ClaudeCodeSubagentTransport);
  const session = await transport.createSession({ workspaceId: "personal" });
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

  assert.deepEqual(events.at(-1), { type: "final", text: "subagent: hello" });
  assert.deepEqual(seen, ["hello"]);
});
