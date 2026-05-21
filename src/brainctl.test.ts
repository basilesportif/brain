import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const brainctl = new URL("./brainctl.js", import.meta.url);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

test("brainctl runtime smoke exercises no-network entrypoint/provider path", () => {
  const result = spawnBrainctl(["runtime", "smoke", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--text", "ping"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { ok: boolean; summary: string; details: { processed: number; dispatchedActions: Array<{ type: string }> } };
  assert.equal(parsed.ok, true);
  assert.match(parsed.summary, /runtime smoke passed/);
  assert.equal(parsed.details.processed, 1);
  assert.equal(parsed.details.dispatchedActions[0]?.type, "send_text");
});

test("brainctl directives check parses legacy codex-chat controls without executing them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-directives-"));
  try {
    const file = path.join(root, "directives.md");
    await writeFile(file, [
      "Visible text",
      "```codex-chat",
      "{\"version\":1,\"actions\":[{\"type\":\"cancel_job\",\"jobId\":\"job_123\",\"idempotencyKey\":\"cancel\"},{\"type\":\"notify_owner\",\"text\":\"note\",\"idempotencyKey\":\"notify\"}]}",
      "```",
    ].join("\n"));
    const result = spawnBrainctl(["directives", "check", file]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; details: { actionCounts: Record<string, number>; cleanTextBytes: number } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.details.actionCounts.cancel_subagent, 1);
    assert.equal(parsed.details.actionCounts.send_text, 1);
    assert.ok(parsed.details.cleanTextBytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("brainctl start, run, health, and logs expose safe supervisor seams", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-supervisor-"));
  try {
    const state = path.join(root, "state");
    const artifacts = path.join(root, "artifacts");
    const log = path.join(root, "runtime.jsonl");

    const start = spawnBrainctl(["start", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(start.status, 0, start.stderr);
    const startJson = JSON.parse(start.stdout) as { ok: boolean; summary: string; details: { deployment: string } };
    assert.equal(startJson.ok, true);
    assert.match(startJson.summary, /dry run/);
    assert.equal(startJson.details.deployment, "not performed");

    const run = spawnBrainctl(["run", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--once", "--fake-text", "agents", "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(run.status, 0, run.stderr);
    const runJson = JSON.parse(run.stdout) as { ok: boolean; details: { processed: number; interceptedCommands: string[]; logPath: string } };
    assert.equal(runJson.ok, true);
    assert.equal(runJson.details.processed, 1);
    assert.deepEqual(runJson.details.interceptedCommands, ["agents"]);
    assert.equal(runJson.details.logPath, log);

    const health = spawnBrainctl(["health", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--state", state, "--log", log]);
    assert.equal(health.status, 0, health.stderr);
    const healthJson = JSON.parse(health.stdout) as { ok: boolean; details: { liveProcessesStarted: boolean } };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.details.liveProcessesStarted, false);

    const logs = spawnBrainctl(["logs", "--file", log, "--lines", "3"]);
    assert.equal(logs.status, 0, logs.stderr);
    const logsJson = JSON.parse(logs.stdout) as { ok: boolean; details: { lines: number; entries: Array<{ message: string }> } };
    assert.equal(logsJson.ok, true);
    assert.ok(logsJson.details.lines > 0);
    assert.ok(logsJson.details.entries.some((entry) => /Intercepted service command/.test(entry.message)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl operations and live validation commands are non-mutating by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-ops-"));
  try {
    const state = path.join(root, "state");
    const artifacts = path.join(root, "artifacts");
    const log = path.join(root, "runtime.jsonl");

    const plan = spawnBrainctl(["operations", "plan", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--repo", repoRoot, "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(plan.status, 0, plan.stderr);
    const planJson = JSON.parse(plan.stdout) as { ok: boolean; details: { sideEffects: string; plan: { commands: { rollback: string[] } } } };
    assert.equal(planJson.ok, true);
    assert.equal(planJson.details.sideEffects, "none");
    assert.ok(planJson.details.plan.commands.rollback.some((command) => command.includes("git reset --hard")));

    const systemd = spawnBrainctl(["operations", "systemd", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--repo", repoRoot, "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(systemd.status, 0, systemd.stderr);
    const systemdJson = JSON.parse(systemd.stdout) as { ok: boolean; details: { unit: string; sideEffects: string } };
    assert.equal(systemdJson.ok, true);
    assert.match(systemdJson.details.unit, /ExecStart=pnpm run brainctl -- run/);
    assert.equal(systemdJson.details.sideEffects, "none");

    const live = spawnBrainctl(["validate", "live", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--codex-transport", "app-server"]);
    assert.equal(live.status, 0, live.stderr);
    const liveJson = JSON.parse(live.stdout) as { ok: boolean; details: { plan: { networkStarted: boolean; checks: Array<{ id: string; mode: string }> }; sideEffects: string } };
    assert.equal(liveJson.ok, true);
    assert.equal(liveJson.details.sideEffects, "none");
    assert.equal(liveJson.details.plan.networkStarted, false);
    assert.equal(liveJson.details.plan.checks.find((check) => check.id === "codex-provider")?.mode, "plan");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function spawnBrainctl(args: string[]) {
  return spawnSync(process.execPath, [brainctl.pathname, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}
