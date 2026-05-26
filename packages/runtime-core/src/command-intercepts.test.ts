import test from "node:test";
import assert from "node:assert/strict";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { BrainRuntime, BrainSupervisor, EmployeeLifecycle, FakeProviderAdapter, InMemoryEmployeeStore, InMemorySubagentJobStore, ProviderEmployeeRuntime, RuntimeCommandInterceptor, StaticSubagentExecutor, SubagentLifecycle } from "./index.js";

test("RuntimeCommandInterceptor handles logs and deploy/update as safe service commands", async () => {
  const interceptor = new RuntimeCommandInterceptor({
    logs: { async tail() { return [{ at: "2026-05-21T00:00:00.000Z", level: "info", component: "test", message: "hello sk-proj-abcdefghijklmnopqrstuvwxyz", raw: { token: "secret" } }]; } },
  });
  const logs = await interceptor.handle(event("logs raw 5"));
  assert.equal(logs?.handled, true);
  assert.equal(logs?.command, "logs");
  assert.match(logs?.actions[0]?.type === "send_text" ? logs.actions[0].text : "", /Runtime logs/);
  assert.doesNotMatch(logs?.actions[0]?.type === "send_text" ? logs.actions[0].text : "", /secret/);
  assert.doesNotMatch(logs?.actions[0]?.type === "send_text" ? logs.actions[0].text : "", /sk-proj-/);

  const deploy = await interceptor.handle(event("update"));
  assert.equal(deploy?.handled, true);
  assert.match(deploy?.actions[0]?.type === "send_text" ? deploy.actions[0].text : "", /will not pull/);
});

test("RuntimeCommandInterceptor handles loop status before provider turns", async () => {
  const interceptor = new RuntimeCommandInterceptor({
    automation: {
      health: () => ({
        ok: true,
        workspaceId: "personal",
        loops: [{ id: "daily-brief", enabled: true, status: "ready", schedule: { valid: true, dueNow: false, noHostSchedulerInstalled: true } }],
        monitors: [{ id: "runtime-errors", enabled: false, status: "disabled" }],
      }),
    },
  });

  const loops = await interceptor.handle(event("loop status"));
  assert.equal(loops?.handled, true);
  assert.equal(loops?.command, "loops");
  const text = loops?.actions[0]?.type === "send_text" ? loops.actions[0].text : "";
  assert.match(text, /Automation status: ok/);
  assert.match(text, /daily-brief/);
  assert.match(text, /runtime-errors/);
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

test("RuntimeCommandInterceptor records safe Employee lifecycle commands", async () => {
  const employees = new EmployeeLifecycle({
    workspaceId: "personal",
    store: new InMemoryEmployeeStore(),
    provider: "fake",
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });
  await employees.init();
  const interceptor = new RuntimeCommandInterceptor({ employees });

  const start = await interceptor.handle(event("employee start analyst"));
  assert.match(start?.actions[0]?.type === "send_text" ? start.actions[0].text : "", /marked running/);

  const steer = await interceptor.handle(event("employee steer analyst watch the queue"));
  assert.match(steer?.actions[0]?.type === "send_text" ? steer.actions[0].text : "", /Recorded steering/);

  const list = await interceptor.handle(event("employees"));
  assert.match(list?.actions[0]?.type === "send_text" ? list.actions[0].text : "", /analyst/);

  const status = await interceptor.handle(event("employee status analyst"));
  assert.match(status?.actions[0]?.type === "send_text" ? status.actions[0].text : "", /lastInstruction: watch the queue/);

  const stop = await interceptor.handle(event("employee stop analyst"));
  assert.match(stop?.actions[0]?.type === "send_text" ? stop.actions[0].text : "", /marked stopped/);
});

test("EmployeeLifecycle can start and steer an injected provider-backed Employee runtime", async () => {
  const employees = new EmployeeLifecycle({
    workspaceId: "personal",
    store: new InMemoryEmployeeStore(),
    runtime: new ProviderEmployeeRuntime({
      workspaceId: "personal",
      provider: new FakeProviderAdapter((turn) => [{ type: "final", text: `employee saw ${turn.prompt}` }]),
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    }),
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });
  await employees.init();

  const start = await employees.startEmployee({ id: "analyst", prompt: "warm up" });
  assert.equal(start.status, "success");
  assert.equal(start.status === "success" ? start.employee.provider : "", "fake");
  assert.deepEqual(start.status === "success" ? start.employee.metadata?.startEventTypes : [], ["final"]);

  const steer = await employees.steerEmployee("analyst", "continue");
  assert.equal(steer.status, "success");
  assert.equal(steer.status === "success" ? (steer.employee.metadata?.lastSteerEventTypes as string[])?.[0] : "", "final");

  const stop = await employees.stopEmployee("analyst");
  assert.equal(stop.status, "success");
  assert.equal(stop.status === "success" ? stop.employee.status : "", "stopped");
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
