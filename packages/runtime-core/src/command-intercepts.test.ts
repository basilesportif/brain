import test from "node:test";
import assert from "node:assert/strict";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { BrainRuntime, BrainSupervisor, FakeProviderAdapter, InMemorySubagentJobStore, RuntimeCommandInterceptor, StaticSubagentExecutor, SubagentLifecycle } from "./index.js";

test("RuntimeCommandInterceptor handles logs and deploy/update as safe service commands", async () => {
  const interceptor = new RuntimeCommandInterceptor({
    logs: { async tail() { return [{ at: "2026-05-21T00:00:00.000Z", level: "info", component: "test", message: "hello", raw: { token: "secret" } }]; } },
  });
  const logs = await interceptor.handle(event("logs raw 5"));
  assert.equal(logs?.handled, true);
  assert.equal(logs?.command, "logs");
  assert.match(logs?.actions[0]?.type === "send_text" ? logs.actions[0].text : "", /Runtime logs/);
  assert.doesNotMatch(logs?.actions[0]?.type === "send_text" ? logs.actions[0].text : "", /secret/);

  const deploy = await interceptor.handle(event("update"));
  assert.equal(deploy?.handled, true);
  assert.match(deploy?.actions[0]?.type === "send_text" ? deploy.actions[0].text : "", /will not pull/);
});

test("RuntimeCommandInterceptor formats and controls subagent jobs", async () => {
  const store = new InMemorySubagentJobStore();
  const lifecycle = new SubagentLifecycle({
    workspaceId: "personal",
    store,
    executor: new StaticSubagentExecutor({ id: "slow-static", delayMs: 10_000 }),
    artifactRoot: "/tmp/brain-command-intercepts",
    idFactory: () => "job_abcdef123456",
  });
  await lifecycle.init();
  await lifecycle.dispatch({ profile: "implementer", prompt: "work", route: "return_to_main", summary: "test job" });

  const interceptor = new RuntimeCommandInterceptor({ subagents: lifecycle });
  const agents = await interceptor.handle(event("agents"));
  assert.match(agents?.actions[0]?.type === "send_text" ? agents.actions[0].text : "", /job_abcdef123456/);

  const status = await interceptor.handle(event("agent status abcdef12"));
  assert.match(status?.actions[0]?.type === "send_text" ? status.actions[0].text : "", /Subagent job_abcdef123456/);

  const kill = await interceptor.handle(event("agent kill abcdef12"));
  assert.match(kill?.actions[0]?.type === "send_text" ? kill.actions[0].text : "", /Cancellation requested|Cancelled queued/);
  await lifecycle.shutdown("test done").catch(() => undefined);
});

test("BrainSupervisor intercepts service commands before provider turns", async () => {
  const entrypoint = new FakeEntrypointAdapter({ workspaceId: "personal", entrypointId: "fake-main" });
  entrypoint.enqueueText("health", { conversationId: "test" });
  entrypoint.close();
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "fake-main",
      enabledEntrypoints: { "fake-main": { kind: "fake", enabled: true } },
    },
    provider: new FakeProviderAdapter([{ type: "final", text: "provider should not run" }]),
  });
  let supervisor: BrainSupervisor;
  const interceptor = new RuntimeCommandInterceptor({ health: { health: () => supervisor.health() } });
  supervisor = new BrainSupervisor({ runtime, entrypoint, commandInterceptor: interceptor });

  const result = await supervisor.run({ maxEvents: 1 });
  assert.equal(result.processed[0]?.intercepted?.command, "health");
  assert.equal(result.processed[0]?.turn, undefined);
  assert.equal(entrypoint.dispatchedActions[0]?.type, "send_text");
  assert.match(entrypoint.dispatchedActions[0]?.type === "send_text" ? entrypoint.dispatchedActions[0].text : "", /Health snapshot/);
});

function event(text: string) {
  return {
    id: `evt_${text.replace(/\W+/g, "_")}`,
    kind: "message" as const,
    workspaceId: "personal",
    entrypoint: { entrypointId: "fake-main", channelKind: "fake" },
    text,
    conversation: { id: "test" },
    receivedAt: "2026-05-21T00:00:00.000Z",
  };
}
