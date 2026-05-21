import test from "node:test";
import assert from "node:assert/strict";
import { BrainRuntime, EchoProviderAdapter, InMemorySubagentJobStore, StaticSubagentExecutor, SubagentLifecycle, type ProviderAdapter, type ProviderSession, type ProviderTurn, type ProviderTurnEvent, type ProviderHealth } from "./index.js";

test("BrainRuntime turns provider final text into origin-routed outbound action", async () => {
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new EchoProviderAdapter(),
  });
  const result = await runtime.handleInboundEvent({
    id: "evt_1",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "hello",
    receivedAt: "2026-05-21T00:00:00.000Z",
  });
  assert.equal(result.actions[0]?.type, "send_text");
  assert.equal(result.actions[0]?.target?.entrypointId, "telegram-main");
  assert.match(result.cleanText, /Echo: hello/);
  assert.deepEqual(result.subagentJobIds, []);
});

test("BrainRuntime consumes dispatch_subagent actions through lifecycle port", async () => {
  const store = new InMemorySubagentJobStore();
  const subagents = new SubagentLifecycle({
    workspaceId: "personal",
    store,
    executor: new StaticSubagentExecutor({ id: "runtime-static", outputText: "child done" }),
    artifactRoot: "/tmp/brain-runtime-subagents",
    idFactory: () => "job_runtime_1",
  });
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new DirectiveProviderAdapter(),
    subagents,
  });

  const result = await runtime.handleInboundEvent({
    id: "evt_subagent",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "delegate",
    receivedAt: "2026-05-21T00:00:00.000Z",
  });
  await subagents.waitForIdle();

  assert.deepEqual(result.subagentJobIds, ["job_runtime_1"]);
  assert.equal(result.actions.some((action) => action.type === "dispatch_subagent"), false);
  assert.equal((await store.get("job_runtime_1"))?.status, "completed");
});

class DirectiveProviderAdapter implements ProviderAdapter {
  readonly id = "directive";
  async createSession(): Promise<ProviderSession> {
    return new DirectiveProviderSession();
  }
}

class DirectiveProviderSession implements ProviderSession {
  readonly id = "directive_session";
  readonly provider = "directive";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<ProviderHealth> {
    return { ok: true, provider: this.provider, sessionId: this.id };
  }
  async *sendTurn(_turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    yield {
      type: "final",
      text: '```brain-actions\n{"version":1,"actions":[{"type":"dispatch_subagent","profile":"implementer","prompt":"Do a child task","summary":"child","idempotencyKey":"child-1"}]}\n```',
    };
  }
}
