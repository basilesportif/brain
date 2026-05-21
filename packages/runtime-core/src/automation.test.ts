import test from "node:test";
import assert from "node:assert/strict";
import { AutomationRuntime } from "./automation.js";
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
