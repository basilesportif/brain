import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySubagentJobStore, loopDefinitionSchema, subagentJobSchema } from "./jobs.js";

test("validates subagent jobs and stores lifecycle status", async () => {
  const store = new InMemorySubagentJobStore();
  const job = subagentJobSchema.parse({ id: "job_1", profile: "implementer", prompt: "Do work", artifactDir: "data/jobs/job_1", enqueuedAt: "2026-05-21T00:00:00.000Z" });
  await store.save(job);
  await store.updateStatus("job_1", "running", { startedAt: "2026-05-21T00:01:00.000Z" });
  const stored = await store.get("job_1");
  assert.equal(stored?.status, "running");
  assert.equal(stored?.route, "return_to_main");
});

test("validates loop definitions without importing scheduler runtime", () => {
  const loop = loopDefinitionSchema.parse({ id: "daily", enabled: true, schedule: "0 9 * * *", type: "prompt", prompt: "Summarize state" });
  assert.equal(loop.timezone, "Etc/UTC");
  assert.throws(() => loopDefinitionSchema.parse({ id: "bad", schedule: "* * * * *", type: "prompt" }), /prompt loops require prompt/);
});
