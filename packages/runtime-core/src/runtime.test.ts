import test from "node:test";
import assert from "node:assert/strict";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { BrainRuntime, EchoProviderAdapter, FakeProviderAdapter, InMemorySubagentJobStore, RuntimeEntrypointBridge, StaticSubagentExecutor, SubagentLifecycle, buildPrompt, type ProviderAdapter, type ProviderSession, type ProviderTurn, type ProviderTurnEvent, type ProviderHealth } from "./index.js";

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

test("buildPrompt exposes private workspace paths and codex-chat parity behavior rules", () => {
  const prompt = buildPrompt({
    id: "evt_projects",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "do I have projects?",
    receivedAt: "2026-05-21T00:00:00.000Z",
  }, {
    workspacePath: "/home/brain/.brain/workspace",
    primaryEntrypointId: "telegram-main",
    enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
    outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
    promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
  });

  assert.match(prompt, /data\/projects\.json/);
  assert.match(prompt, /data\/todos\.json/);
  assert.match(prompt, /data\/crm\.json/);
  assert.match(prompt, /data\/reminders\.json/);
  assert.match(prompt, /private\/documents\/metadata\.jsonl/);
  assert.match(prompt, /native assistant-logic CLI commands/);
  assert.match(prompt, /packages\/assistant-logic/);
  assert.match(prompt, /Markdown project\/notes\/documents directories are supporting resources only/);
  assert.match(prompt, /do not claim no project\/todo\/CRM\/reminder list exists/);
  assert.match(prompt, /Main-loop routing parity/);
  assert.match(prompt, /main_loop: model=<configured-or-runtime-default>/);
  assert.match(prompt, /Dispatch a subagent for repo\/file inspection/);
  assert.match(prompt, /stress\/fan-out requests/);
  assert.match(prompt, /For add\/delete, run the mutation and then always run/);
  assert.match(prompt, /include the full updated numbered todo list/);
  assert.match(prompt, /project-resource\.js/);
  assert.match(prompt, /calendar\/email\/Gmail\/Composio live account lookup should dispatch a subagent/);
  assert.match(prompt, /File-save\/PDF attach/);
  assert.match(prompt, /Generated images/);
  assert.match(prompt, /Scratch web pages \/ codex-chat-web/);
  assert.match(prompt, /Loops\/monitors/);
  assert.match(prompt, /send_image\/send_document compatibility/);
});

test("buildPrompt injects active subagent snapshots for natural-language steering", () => {
  const prompt = buildPrompt({
    id: "evt_steer",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "tell the implementer to focus on tests",
    receivedAt: "2026-05-21T00:00:00.000Z",
  }, {
    workspacePath: "/tmp/personal",
    primaryEntrypointId: "telegram-main",
    enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
  }, {
    activeSubagents: {
      jobs: [{
        id: "job_feedfacecafebeef",
        ref: "feedface",
        status: "running",
        profile: "implementer",
        provider: "provider:codex",
        summary: "Fix tests",
        ownerType: "main",
        route: "return_to_main",
        resultTarget: "main",
        model: "gpt-5.5",
        effort: "high",
        enqueuedAt: "2026-05-21T00:00:00.000Z",
        startedAt: "2026-05-21T00:00:01.000Z",
        elapsedSec: 3,
        steerable: true,
      }],
      omitted: 0,
    },
  });

  assert.match(prompt, /Active subagent jobs/);
  assert.match(prompt, /ref=feedface/);
  assert.match(prompt, /id=job_feedfacecafebeef/);
  assert.match(prompt, /steerable=true/);
  assert.match(prompt, /emit steer_subagent only when exactly one matching job/);
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
  const dispatchStatus = result.actions.find((action) => action.type === "send_text");
  assert.match(dispatchStatus?.type === "send_text" ? dispatchStatus.text : "", /Sub: child/);
  assert.match(dispatchStatus?.type === "send_text" ? dispatchStatus.text : "", /implementer · gpt-5.5 · high/);
  assert.match(dispatchStatus?.type === "send_text" ? dispatchStatus.text : "", /ref: runtime_/);
  assert.match(dispatchStatus?.type === "send_text" ? dispatchStatus.text : "", /id: job_runtime_1/);
  assert.equal((await store.get("job_runtime_1"))?.status, "completed");
});

test("BrainRuntime streams dispatch feedback when provider emits a subagent action mid-turn", async () => {
  const store = new InMemorySubagentJobStore();
  const subagents = new SubagentLifecycle({
    workspaceId: "personal",
    store,
    executor: new StaticSubagentExecutor({ id: "runtime-static", outputText: "child done" }),
    artifactRoot: "/tmp/brain-runtime-subagents",
    idFactory: () => "job_stream_1",
  });
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
    },
    provider: new FakeProviderAdapter([
      { type: "action", action: { type: "dispatch_subagent", profile: "researcher", prompt: "Research", summary: "Research parity", model: "gpt-5.5", effort: "high", idempotencyKey: "research-1" } },
      { type: "final", text: "Queued." },
    ]),
    subagents,
  });
  const streamed: string[] = [];

  const result = await runtime.handleInboundEvent({
    id: "evt_stream_subagent",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "research this",
    receivedAt: "2026-05-21T00:00:00.000Z",
  }, {
    onStreamingAction: (action) => {
      if (action.type === "send_text") streamed.push(action.text);
    },
  });

  assert.deepEqual(result.subagentJobIds, ["job_stream_1"]);
  assert.equal(result.streamingActions.length, 1);
  assert.match(streamed[0] ?? "", /Sub: Research parity/);
  assert.equal(result.actions.some((action) => action.type === "send_text" && /Research parity/.test(action.text)), false);
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
      text: '```brain-actions\n{"version":1,"actions":[{"type":"dispatch_subagent","profile":"implementer","prompt":"Do a child task","summary":"child","model":"gpt-5.5","effort":"high","idempotencyKey":"child-1"}]}\n```',
    };
  }
}
