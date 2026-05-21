import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSubagentJobStore, InMemorySubagentJobStore, subagentJobSchema } from "./jobs.js";
import { StaticSubagentExecutor, SubagentLifecycle, type StartedSubagentRun, type SubagentExecutor, type SubagentExecutorStartInput, type SubagentJob } from "./index.js";

test("SubagentLifecycle dispatches and completes jobs through an executor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-subagents-"));
  try {
    const store = new FileSubagentJobStore({ root: path.join(root, "state") });
    const lifecycle = new SubagentLifecycle({
      workspaceId: "personal",
      store,
      executor: new StaticSubagentExecutor({ id: "test-static", outputText: "finished", delayMs: 1 }),
      artifactRoot: path.join(root, "artifacts"),
      maxConcurrent: 1,
      idFactory: () => "job_lifecycle_1",
    });

    const id = await lifecycle.dispatch({ profile: "implementer", prompt: "Do work", summary: "test job" });
    await lifecycle.waitForIdle();

    const job = await store.get(id);
    assert.equal(job?.status, "completed");
    assert.equal(job?.provider, "test-static");
    assert.equal(job?.resultText, "finished");
    assert.equal(job?.resultTarget, "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SubagentLifecycle queues by concurrency and cancels queued jobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-subagents-"));
  try {
    const store = new InMemorySubagentJobStore();
    const executor = new BlockingExecutor();
    const lifecycle = new SubagentLifecycle({
      workspaceId: "personal",
      store,
      executor,
      artifactRoot: path.join(root, "artifacts"),
      maxConcurrent: 1,
    });

    const first = await lifecycle.dispatch({ id: "job_first", profile: "implementer", prompt: "first" });
    const second = await lifecycle.dispatch({ id: "job_second", profile: "implementer", prompt: "second" });
    assert.equal((await store.get(first))?.status, "running");
    assert.equal((await store.get(second))?.status, "queued");

    const cancel = await lifecycle.requestCancel(second, "not needed");
    assert.equal(cancel.status, "success");
    assert.equal((await store.get(second))?.status, "cancelled");

    executor.finish(first, { status: "completed", outputText: "done" });
    await lifecycle.waitForIdle();
    assert.equal((await store.get(first))?.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SubagentLifecycle steers and cancels running jobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-subagents-"));
  try {
    const store = new InMemorySubagentJobStore();
    const executor = new BlockingExecutor();
    const lifecycle = new SubagentLifecycle({
      workspaceId: "personal",
      store,
      executor,
      artifactRoot: path.join(root, "artifacts"),
      maxConcurrent: 1,
    });

    const id = await lifecycle.dispatch({ id: "job_running", profile: "implementer", prompt: "keep going" });
    const steer = await lifecycle.steerJob(id, "new instruction");
    assert.equal(steer.status, "success");
    assert.deepEqual(executor.steerTexts, ["new instruction"]);
    assert.equal((await store.get(id))?.steerCount, 1);

    const cancel = await lifecycle.requestCancel(id, "user requested");
    assert.equal(cancel.status, "success");
    await lifecycle.waitForIdle();
    assert.equal((await store.get(id))?.status, "cancelled");
    assert.equal((await store.get(id))?.cancelReason, "user requested");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SubagentLifecycle hydration abandons active persisted jobs", async () => {
  const store = new InMemorySubagentJobStore();
  await store.save(subagentJobSchema.parse({
    id: "job_old_running",
    workspaceId: "personal",
    profile: "implementer",
    prompt: "old",
    artifactDir: "/tmp/job_old_running",
    status: "running",
    enqueuedAt: "2026-05-21T00:00:00.000Z",
    startedAt: "2026-05-21T00:01:00.000Z",
  }));
  const lifecycle = new SubagentLifecycle({
    workspaceId: "personal",
    store,
    executor: new StaticSubagentExecutor(),
    artifactRoot: "/tmp/brain-artifacts",
    now: () => new Date("2026-05-21T00:02:00.000Z"),
  });
  const hydrated = await lifecycle.init();
  assert.equal(hydrated.loaded, 1);
  assert.equal(hydrated.abandoned, 1);
  assert.equal((await store.get("job_old_running"))?.status, "abandoned");
});

class BlockingExecutor implements SubagentExecutor {
  readonly id = "blocking";
  readonly steerTexts: string[] = [];
  private readonly resolvers = new Map<string, (result: { status?: "completed" | "failed" | "cancelled"; outputText?: string; error?: string }) => void>();

  async start(job: SubagentJob, input: SubagentExecutorStartInput): Promise<StartedSubagentRun> {
    const finished = new Promise<{ status?: "completed" | "failed" | "cancelled"; outputText?: string; error?: string }>((resolve) => {
      this.resolvers.set(job.id, resolve);
      input.signal.addEventListener("abort", () => resolve({ status: "cancelled", error: String(input.signal.reason ?? "cancelled") }), { once: true });
    });
    return {
      provider: this.id,
      finished,
      cancel: async () => undefined,
      steer: async (text) => { this.steerTexts.push(text); },
      isAlive: () => this.resolvers.has(job.id),
    };
  }

  finish(id: string, result: { status?: "completed" | "failed" | "cancelled"; outputText?: string; error?: string }): void {
    const resolve = this.resolvers.get(id);
    assert.ok(resolve, `expected resolver for ${id}`);
    this.resolvers.delete(id);
    resolve(result);
  }
}
