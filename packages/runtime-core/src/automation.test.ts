import test from "node:test";
import assert from "node:assert/strict";
import { AutomationRuntime, InMemoryAutomationLockStore, InMemoryAutomationSpool, isCronDueNow, isValidCronExpression } from "./automation.js";
import type { SubagentDispatchInput, SubagentDispatchPort } from "./subagents.js";

test("AutomationRuntime exposes loop/monitor health without host side effects", () => {
  const runtime = new AutomationRuntime({
    workspaceId: "personal",
    loops: [
      { id: "daily", enabled: true, schedule: "0 9 * * *", type: "dispatch_subagent", profile: "implementer", prompt: "Summarize", route: "store_only" },
      { id: "shell", enabled: true, schedule: "* * * * *", type: "command", command: "true" },
    ],
    monitors: [
      { id: "inbox", enabled: true, source: "filesystem", config: { path: "/tmp/inbox" } },
    ],
  });

  const health = runtime.health();
  assert.equal(health.ok, false);
  assert.equal(health.loops[0]?.status, "ready");
  assert.equal(health.loops[1]?.status, "not_runnable");
  assert.equal(health.loops[0]?.schedule?.noHostSchedulerInstalled, true);
  assert.equal(health.monitors[0]?.status, "ready");
});

test("AutomationRuntime can dry-run or dispatch subagent loops", async () => {
  const dispatches: SubagentDispatchInput[] = [];
  const runtime = new AutomationRuntime({
    workspaceId: "personal",
    now: () => new Date("2026-05-21T00:00:00.000Z"),
    subagents: {
      async dispatch(input) {
        dispatches.push(input);
        return "job_loop_1";
      },
    } satisfies SubagentDispatchPort,
    loops: [
      { id: "hourly", enabled: true, description: "Hourly work", schedule: "0 * * * *", type: "dispatch_subagent", profile: "implementer", prompt: "Do hourly work", route: "return_to_main" },
    ],
  });

  assert.deepEqual(await runtime.runLoopOnce("hourly", { dryRun: true }), {
    status: "dry_run",
    loopId: "hourly",
    dryRun: true,
    detail: "Would dispatch implementer from loop hourly.",
  });

  const result = await runtime.runLoopOnce("hourly");
  assert.deepEqual(result, { status: "dispatched", loopId: "hourly", jobId: "job_loop_1", dryRun: false });
  assert.equal(dispatches[0]?.ownerType, "loop");
  assert.equal(dispatches[0]?.ownerId, "hourly");
  assert.equal(dispatches[0]?.metadata?.triggeredAt, "2026-05-21T00:00:00.000Z");
});

test("AutomationRuntime validates cron schedules and can run due loops safely", async () => {
  assert.equal(isValidCronExpression("0 9 * * *"), true);
  assert.equal(isValidCronExpression("not cron"), false);
  assert.equal(isCronDueNow("0 9 * * *", new Date("2026-05-21T09:00:00.000Z")), true);
  assert.equal(isCronDueNow("0 9 * * *", new Date("2026-05-21T09:01:00.000Z")), false);

  const dispatches: SubagentDispatchInput[] = [];
  const runtime = new AutomationRuntime({
    workspaceId: "personal",
    now: () => new Date("2026-05-21T09:00:00.000Z"),
    subagents: {
      async dispatch(input) {
        dispatches.push(input);
        return `job_${input.profile}`;
      },
    },
    loops: [
      { id: "due", enabled: true, schedule: "0 9 * * *", type: "dispatch_subagent", profile: "implementer", prompt: "due", route: "store_only" },
      { id: "later", enabled: true, schedule: "5 9 * * *", type: "dispatch_subagent", profile: "implementer", prompt: "later", route: "store_only" },
      { id: "bad", enabled: true, schedule: "bad", type: "dispatch_subagent", profile: "implementer", prompt: "bad", route: "store_only" },
    ],
  });
  const health = runtime.health();
  assert.equal(health.ok, false);
  assert.equal(health.loops.find((loop) => loop.id === "bad")?.status, "not_runnable");

  assert.deepEqual(await runtime.runDueLoops(), [{
    status: "dry_run",
    loopId: "due",
    dryRun: true,
    detail: "Would dispatch implementer from loop due.",
  }]);

  assert.deepEqual(await runtime.runDueLoops({ dryRun: false }), [{ status: "dispatched", loopId: "due", jobId: "job_implementer", dryRun: false }]);
  assert.equal(dispatches.length, 1);
});

test("AutomationRuntime records spool events, honors locks, and can fake command/monitor execution", async () => {
  const spool = new InMemoryAutomationSpool();
  const locks = new InMemoryAutomationLockStore();
  const notifications: string[] = [];
  const dispatches: SubagentDispatchInput[] = [];
  const runtime = new AutomationRuntime({
    workspaceId: "personal",
    now: () => new Date("2026-05-21T10:00:00.000Z"),
    spool,
    locks,
    notifier: {
      async notifyAdmins(text) { notifications.push(text); },
      async enqueueMain(text) { notifications.push(`main:${text}`); },
    },
    commandRunner: {
      async run(command, args) {
        return { exitCode: 0, stdout: `${command} ${args.join(" ")}`.trim(), stderr: "" };
      },
    },
    subagents: {
      async dispatch(input) {
        dispatches.push(input);
        return "job_monitor_1";
      },
    },
    loops: [
      { id: "cmd", enabled: true, schedule: "* * * * *", type: "command", command: "echo", args: ["ok"], route: "send_to_admins", lock: true },
    ],
    monitors: [
      { id: "errors", enabled: true, source: "filesystem", route: "dispatch_subagent", prompt: "Investigate monitor event.", config: { profile: "debugger" } },
    ],
  });

  const loop = await runtime.runLoopOnce("cmd", { dryRun: false });
  assert.equal(loop.status, "executed");
  assert.equal(loop.status === "executed" ? loop.outputText : "", "echo ok");
  assert.equal(notifications[0], "echo ok");
  assert.deepEqual(spool.events.filter((event) => event.kind === "loop").map((event) => event.phase), ["started", "completed"]);

  const monitor = await runtime.runMonitorOnce("errors", { line: "ERROR bad", dryRun: false });
  assert.equal(monitor.status, "dispatched");
  assert.equal(dispatches[0]?.ownerType, "monitor");
  assert.equal(dispatches[0]?.profile, "debugger");
  assert.deepEqual(spool.events.filter((event) => event.kind === "monitor").map((event) => event.phase), ["started", "completed"]);
});
