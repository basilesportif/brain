import test from "node:test";
import assert from "node:assert/strict";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { BrainRuntime, BrainSupervisor, EmployeeLifecycle, FakeProviderAdapter, InMemoryEmployeeStore, InMemorySubagentJobStore, ProviderEmployeeRuntime, RuntimeCommandInterceptor, StaticSubagentExecutor, SubagentLifecycle, parseTodoCommand, type ProviderTurn } from "./index.js";

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
  assert.match(agents?.actions[0]?.type === "send_text" ? agents.actions[0].text : "", /`abcdef12`/);
  assert.match(agents?.actions[0]?.type === "send_text" ? agents.actions[0].text : "", /test job/);
  assert.match(agents?.actions[0]?.type === "send_text" ? agents.actions[0].text : "", /^Subagents: 1 running, 0 cancelling, 0 queued/);

  const status = await interceptor.handle(event("agent status abcdef12"));
  assert.match(status?.actions[0]?.type === "send_text" ? status.actions[0].text : "", /Subagent job_abcdef123456/);
  assert.match(status?.actions[0]?.type === "send_text" ? status.actions[0].text : "", /ref: abcdef12/);

  const kill = await interceptor.handle(event("agent kill abcdef12"));
  assert.match(kill?.actions[0]?.type === "send_text" ? kill.actions[0].text : "", /Cancellation requested|Cancelled queued/);
  await lifecycle.shutdown("test done").catch(() => undefined);
});

test("RuntimeCommandInterceptor returns codex-chat-compatible empty subagent status", async () => {
  const interceptor = new RuntimeCommandInterceptor({
    subagents: {
      async dispatch() { return "job_unused"; },
      async listJobs() { return []; },
    },
  });
  const sub = await interceptor.handle(event("sub"));
  assert.equal(sub?.handled, true);
  assert.equal(sub?.actions[0]?.type === "send_text" ? sub.actions[0].text : "", "Subagents: 0 running, 0 cancelling, 0 queued\nNo active subagent jobs. Use `agents detail` for recent terminal jobs.");
});

test("RuntimeCommandInterceptor handles todo commands with main_loop formatting", async () => {
  const calls: Array<{ script: string; args: string[] }> = [];
  const interceptor = new RuntimeCommandInterceptor({
    assistantCommands: {
      async run(script, args = []) {
        calls.push({ script, args });
        if (script === "todo-list.js") {
          return { ok: true, userFacingText: "Current todos:\n\n1. Pay card" };
        }
        if (script === "todo-add.js") {
          return { ok: true, userFacingText: "Added todo: Walk dog\n\nCurrent todos:\n\n1. Pay card\n2. Walk dog" };
        }
        return { ok: true, userFacingText: "Removed todo: Pay card\n\nCurrent todos:\n\n1. Walk dog" };
      },
    },
  });

  const list = await interceptor.handle(event("todos"));
  assert.equal(list?.command, "todos");
  assert.equal(list?.actions[0]?.type === "send_text" ? list.actions[0].text : "", "main_loop: model=gpt-5.5 effort=medium\n\nCurrent todos:\n\n1. Pay card");

  const add = await interceptor.handle(event("/todo add Walk dog"));
  assert.match(add?.actions[0]?.type === "send_text" ? add.actions[0].text : "", /Added todo: Walk dog/);

  const del = await interceptor.handle(event("/todo delete #1"));
  assert.match(del?.actions[0]?.type === "send_text" ? del.actions[0].text : "", /Removed todo: Pay card/);
  assert.deepEqual(calls, [
    { script: "todo-list.js", args: [] },
    { script: "todo-add.js", args: ["--title", "Walk dog"] },
    { script: "todo-delete.js", args: ["--number", "1"] },
  ]);
});

test("RuntimeCommandInterceptor leaves natural todo phrasing to the provider prompt path", async () => {
  assert.deepEqual(parseTodoCommand("todo: Walk dog"), { isTodo: false });
  assert.deepEqual(parseTodoCommand("todo Walk dog"), { isTodo: false });
  assert.deepEqual(parseTodoCommand("do Walk dog"), { isTodo: false });
  assert.deepEqual(parseTodoCommand("add todo Walk dog"), { isTodo: false });
  assert.deepEqual(parseTodoCommand("delete #1"), { isTodo: false });
  assert.deepEqual(parseTodoCommand("/todo add Walk dog"), { isTodo: true, action: "add", title: "Walk dog" });
  assert.deepEqual(parseTodoCommand("/todo delete #1"), { isTodo: true, action: "delete", ref: "#1" });

  const seenTurns: ProviderTurn[] = [];
  const entrypoint = new FakeEntrypointAdapter({ workspaceId: "personal", entrypointId: "fake-main" });
  for (const text of ["todo: Walk dog", "todo Walk dog", "do Walk dog"]) {
    entrypoint.enqueueText(text, { conversationId: "test" });
  }
  entrypoint.close();
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "fake-main",
      enabledEntrypoints: { "fake-main": { kind: "fake", enabled: true } },
    },
    provider: new FakeProviderAdapter((turn) => {
      seenTurns.push(turn);
      return [{ type: "final", text: "provider handled natural todo" }];
    }),
  });
  const interceptor = new RuntimeCommandInterceptor({
    assistantCommands: {
      async run() {
        throw new Error("natural todo text must not be intercepted as a deterministic command");
      },
    },
  });
  const supervisor = new BrainSupervisor({ runtime, entrypoint, commandInterceptor: interceptor });

  const result = await supervisor.run({ maxEvents: 3 });
  assert.equal(result.processed.length, 3);
  assert.deepEqual(result.processed.map((item) => item.intercepted?.command), [undefined, undefined, undefined]);
  assert.deepEqual(seenTurns.map((turn) => turn.inboundEvent.text), ["todo: Walk dog", "todo Walk dog", "do Walk dog"]);
  for (const turn of seenTurns) {
    assert.match(turn.prompt, /assistant-agent-logic resources/);
    assert.match(turn.prompt, /legacy\/lab compatibility wrapper/);
    assert.doesNotMatch(turn.prompt, /Natural todo intent/);
    assert.doesNotMatch(turn.prompt, /todo: X/);
    assert.doesNotMatch(turn.prompt, /todo-add\.js -- --title/);
  }
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
