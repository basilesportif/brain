import test from "node:test";
import assert from "node:assert/strict";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { BrainRuntime, BrainSupervisor, FakeProviderAdapter, InMemorySubagentJobStore, StaticSubagentExecutor, SubagentLifecycle, type ProviderTurn } from "./index.js";

const workspace = {
  workspacePath: "/tmp/personal",
  primaryEntrypointId: "fake-main",
  enabledEntrypoints: { "fake-main": { kind: "fake", enabled: true } },
};

test("BrainSupervisor dispatches streaming status/reaction actions before final text", async () => {
  const entrypoint = new FakeEntrypointAdapter({ workspaceId: "personal", entrypointId: "fake-main" });
  entrypoint.enqueueText("work", { conversationId: "test" });
  entrypoint.close();
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace,
    provider: new FakeProviderAdapter([
      { type: "action", action: { type: "show_status", status: "running", text: "Working" } },
      { type: "action", action: { type: "react", emoji: "👀" } },
      { type: "final", text: "Done" },
    ]),
  });
  const supervisor = new BrainSupervisor({ runtime, entrypoint });

  const result = await supervisor.run({ maxEvents: 1 });

  assert.equal(result.processed[0]?.streamingDispatchResults?.length, 2);
  assert.equal(entrypoint.dispatchedActions.map((action) => action.type).join(","), "show_status,react,send_text");
});

test("BrainSupervisor logs failed outbound dispatches above debug", async () => {
  const logs: Array<{ level: string; message: string; raw?: unknown }> = [];
  const entrypoint = new FakeEntrypointAdapter({
    workspaceId: "personal",
    entrypointId: "fake-main",
    dispatchStatus: "failed",
  });
  entrypoint.enqueueText("work", { conversationId: "test" });
  entrypoint.close();
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace,
    provider: new FakeProviderAdapter([{ type: "final", text: "Done" }]),
  });
  const supervisor = new BrainSupervisor({
    runtime,
    entrypoint,
    logger: (record) => { logs.push({ level: record.level, message: record.message, raw: record.raw }); },
  });

  await supervisor.run({ maxEvents: 1 });

  const dispatchLog = logs.find((record) => record.message === "Dispatched outbound action: send_text");
  assert.equal(dispatchLog?.level, "error");
  const raw = dispatchLog?.raw as { status?: string; target?: { route?: string; entrypointId?: string; conversationId?: string }; error?: string };
  assert.equal(raw.status, "failed");
  assert.equal(raw.target?.route, "originating-entrypoint");
  assert.equal(raw.target?.entrypointId, "fake-main");
  assert.equal(raw.target?.conversationId, "test");
  assert.equal(raw.error, undefined);
});

test("BrainSupervisor logs successful outbound dispatches at info", async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const entrypoint = new FakeEntrypointAdapter({ workspaceId: "personal", entrypointId: "fake-main" });
  entrypoint.enqueueText("work", { conversationId: "test" });
  entrypoint.close();
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace,
    provider: new FakeProviderAdapter([{ type: "final", text: "Done" }]),
  });
  const supervisor = new BrainSupervisor({
    runtime,
    entrypoint,
    logger: (record) => { logs.push({ level: record.level, message: record.message }); },
  });

  await supervisor.run({ maxEvents: 1 });

  const dispatchLog = logs.find((record) => record.message === "Dispatched outbound action: send_text");
  assert.equal(dispatchLog?.level, "info");
});

test("BrainSupervisor delivers send_to_user subagent terminal results to the originating target", async () => {
  const entrypoint = new FakeEntrypointAdapter({ workspaceId: "personal", entrypointId: "fake-main" });
  const runtime = new BrainRuntime({ workspaceId: "personal", workspace, provider: new FakeProviderAdapter() });
  const supervisor = new BrainSupervisor({ runtime, entrypoint });
  const store = new InMemorySubagentJobStore();
  const lifecycle = new SubagentLifecycle({
    workspaceId: "personal",
    store,
    executor: new StaticSubagentExecutor({ outputText: "child result", delayMs: 1 }),
    artifactRoot: "/tmp/brain-supervisor-subagents",
    idFactory: () => "job_user_result",
    onTerminal: async (job, result) => { await supervisor.deliverSubagentResult(job, result); },
  });
  await lifecycle.init();

  await lifecycle.dispatch({
    profile: "implementer",
    prompt: "do work",
    route: "send_to_user",
    summary: "child",
    metadata: {
      origin: {
        eventId: "evt_1",
        entrypointId: "fake-main",
        channelKind: "fake",
        conversationId: "conversation-1",
      },
    },
  });
  await lifecycle.waitForIdle();

  const action = entrypoint.dispatchedActions.find((candidate) => candidate.type === "send_text");
  assert.equal(action?.type, "send_text");
  assert.match(action.type === "send_text" ? action.text : "", /child result/);
  assert.equal(action.target?.conversationId, "conversation-1");
});

test("BrainSupervisor includes subagent result artifacts for user delivery routes", async () => {
  const entrypoint = new FakeEntrypointAdapter({ workspaceId: "personal", entrypointId: "fake-main" });
  const runtime = new BrainRuntime({ workspaceId: "personal", workspace, provider: new FakeProviderAdapter() });
  const supervisor = new BrainSupervisor({ runtime, entrypoint });
  await supervisor.deliverSubagentResult({
    id: "job_artifact",
    workspaceId: "personal",
    profile: "implementer",
    route: "send_to_user",
    ownerType: "main",
    resultTarget: "user",
    status: "completed",
    prompt: "make artifact",
    artifactDir: "/tmp/job_artifact",
    lastMessagePath: "/tmp/job_artifact/last.md",
    enqueuedAt: "2026-05-21T00:00:00.000Z",
    metadata: { origin: { entrypointId: "fake-main", channelKind: "fake", conversationId: "conversation-1" } },
  }, { status: "completed", outputText: "done", raw: { lastArtifactPath: "/tmp/job_artifact/out.md" } });

  assert.deepEqual(entrypoint.dispatchedActions.map((action) => action.type), ["send_text", "send_artifact"]);
  const artifact = entrypoint.dispatchedActions[1];
  assert.equal(artifact?.type, "send_artifact");
  assert.equal(artifact?.type === "send_artifact" ? artifact.path : "", "/tmp/job_artifact/out.md");
  assert.equal(artifact?.target?.conversationId, "conversation-1");
});

test("BrainSupervisor can return subagent terminal results to the main runtime", async () => {
  const entrypoint = new FakeEntrypointAdapter({ workspaceId: "personal", entrypointId: "fake-main" });
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace,
    provider: new FakeProviderAdapter((turn: ProviderTurn) => [{ type: "final", text: `Main received: ${turn.inboundEvent.text ?? ""}` }]),
  });
  const supervisor = new BrainSupervisor({ runtime, entrypoint, now: () => new Date("2026-05-21T00:00:00.000Z") });
  const job = {
    id: "job_return_main",
    workspaceId: "personal",
    profile: "implementer",
    route: "return_to_main",
    ownerType: "main",
    resultTarget: "main",
    status: "completed",
    prompt: "do work",
    artifactDir: "/tmp/job_return_main",
    summary: "child",
    enqueuedAt: "2026-05-21T00:00:00.000Z",
    completedAt: "2026-05-21T00:00:01.000Z",
    resultText: "child result",
    metadata: {
      origin: {
        eventId: "evt_1",
        entrypointId: "fake-main",
        channelKind: "fake",
        conversationId: "conversation-1",
      },
    },
  } as const;

  const delivered = await supervisor.deliverSubagentResult(job, { status: "completed", outputText: "child result" });

  assert.equal(delivered.returnToMain?.eventId, "subagent_result_job_return_main");
  const action = entrypoint.dispatchedActions.find((candidate) => candidate.type === "send_text");
  assert.match(action?.type === "send_text" ? action.text : "", /Main received/);
  assert.equal(action?.target?.conversationId, "conversation-1");
});
