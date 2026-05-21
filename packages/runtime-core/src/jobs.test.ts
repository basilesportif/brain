import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileRuntimeStateStore, FileSubagentJobStore, InMemorySubagentJobStore, loopDefinitionSchema, subagentJobSchema } from "./jobs.js";

test("validates subagent jobs and stores lifecycle status", async () => {
  const store = new InMemorySubagentJobStore();
  const job = subagentJobSchema.parse({ id: "job_1", profile: "implementer", prompt: "Do work", artifactDir: "data/jobs/job_1", enqueuedAt: "2026-05-21T00:00:00.000Z" });
  await store.save(job);
  await store.updateStatus("job_1", "running", { startedAt: "2026-05-21T00:01:00.000Z" });
  const stored = await store.get("job_1");
  assert.equal(stored?.status, "running");
  assert.equal(stored?.route, "return_to_main");
});

test("file-backed subagent job store persists and filters workspace jobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-job-store-"));
  try {
    const store = new FileSubagentJobStore({ root });
    await store.init();
    await store.save(subagentJobSchema.parse({
      id: "job_file_1",
      workspaceId: "personal",
      profile: "implementer",
      prompt: "Do work",
      artifactDir: path.join(root, "artifacts", "job_file_1"),
      enqueuedAt: "2026-05-21T00:00:00.000Z",
    }));
    await store.save(subagentJobSchema.parse({
      id: "job_file_2",
      workspaceId: "other",
      profile: "explorer",
      prompt: "Inspect",
      artifactDir: path.join(root, "artifacts", "job_file_2"),
      enqueuedAt: "2026-05-21T00:02:00.000Z",
    }));

    const updated = await store.updateStatus("job_file_1", "completed", { completedAt: "2026-05-21T00:03:00.000Z", resultText: "done" });
    assert.equal(updated.status, "completed");

    const reloaded = new FileSubagentJobStore({ root });
    const personalJobs = await reloaded.list({ workspaceId: "personal" });
    assert.equal(personalJobs.length, 1);
    assert.equal(personalJobs[0]?.id, "job_file_1");
    assert.equal(personalJobs[0]?.resultText, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file runtime state store rejects path traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-state-store-"));
  try {
    const state = new FileRuntimeStateStore({ root });
    await state.init();
    assert.throws(() => state.path("../escape.json"), /escapes root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file runtime state store does not create turn replay or idempotency stores", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-state-policy-"));
  try {
    const state = new FileRuntimeStateStore({ root });
    await state.init();
    await assert.rejects(stat(path.join(root, "idempotency")), /ENOENT/);
    await assert.rejects(stat(path.join(root, "turns")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates loop definitions without importing scheduler runtime", () => {
  const loop = loopDefinitionSchema.parse({ id: "daily", enabled: true, schedule: "0 9 * * *", type: "prompt", prompt: "Summarize state" });
  assert.equal(loop.timezone, "Etc/UTC");
  assert.throws(() => loopDefinitionSchema.parse({ id: "bad", schedule: "* * * * *", type: "prompt" }), /prompt loops require prompt/);
});
