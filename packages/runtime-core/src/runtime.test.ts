import test from "node:test";
import assert from "node:assert/strict";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { BrainRuntime, EchoProviderAdapter, FakeProviderAdapter, InMemorySubagentJobStore, RuntimeEntrypointBridge, StaticSubagentExecutor, SubagentLifecycle, type ProviderAdapter, type ProviderSession, type ProviderTurn, type ProviderTurnEvent, type ProviderHealth } from "./index.js";

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

test("BrainRuntime consumes legacy cancel_job directives through subagent control port", async () => {
  const calls: Array<{ ref: string; reason?: string }> = [];
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new FakeProviderAdapter([{
      type: "final",
      text: '```codex-chat\n{"version":1,"actions":[{"type":"cancel_job","jobId":"job_cancel_me","idempotencyKey":"cancel-1"}]}\n```',
    }]),
    subagents: {
      async dispatch() { throw new Error("not expected"); },
      async requestCancel(ref, reason) {
        calls.push({ ref, reason });
        return { status: "success", ref, message: `cancelled ${ref}`, job: { id: ref, profile: "implementer", status: "cancelled" }, previousStatus: "running" } as never;
      },
    },
  });

  const result = await runtime.handleInboundEvent({
    id: "evt_cancel",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "cancel that",
    receivedAt: "2026-05-21T00:00:00.000Z",
  });

  assert.deepEqual(calls, [{ ref: "job_cancel_me", reason: "runtime directive" }]);
  assert.equal(result.controlResults[0]?.status, "success");
  assert.equal(result.actions.some((action) => action.type === "cancel_subagent"), false);
});

test("fake entrypoint smoke sends inbound event through runtime and dispatches outbound action", async () => {
  const entrypoint = new FakeEntrypointAdapter({
    workspaceId: "personal",
    entrypointId: "fake-main",
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "fake-main",
      enabledEntrypoints: { "fake-main": { kind: "fake", enabled: true, displayName: "Fake main" } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new FakeProviderAdapter(),
  });
  const bridge = new RuntimeEntrypointBridge({ runtime, entrypoint });

  entrypoint.enqueueText("ping", { conversationId: "fake-conversation" });
  entrypoint.close();
  const result = await bridge.run({ maxEvents: 1 });

  assert.equal(result.stoppedReason, "max-events");
  assert.equal(result.processed.length, 1);
  assert.equal(entrypoint.dispatchedActions.length, 1);
  assert.equal(entrypoint.dispatchedActions[0]?.type, "send_text");
  assert.match(entrypoint.dispatchedActions[0]?.type === "send_text" ? entrypoint.dispatchedActions[0].text : "", /Fake: ping/);
  assert.equal(entrypoint.dispatchedActions[0]?.target?.entrypointId, "fake-main");
  assert.equal(result.processed[0]?.dispatchResults[0]?.status, "queued");
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
