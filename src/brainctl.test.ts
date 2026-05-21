import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const run = spawnBrainctl(["run", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--fake", "--once", "--fake-text", "agents", "--state", state, "--artifacts", artifacts, "--log", log]);
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

    const validate = spawnBrainctl(["operations", "validate", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--repo", repoRoot, "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(validate.status, 0, validate.stderr);
    const validateJson = JSON.parse(validate.stdout) as { ok: boolean; details: { sideEffects: string; commandPlan: { preflight: string[] } } };
    assert.equal(validateJson.ok, true);
    assert.ok(validateJson.details.commandPlan.preflight.some((command) => command.includes("runtime smoke")));

    const live = spawnBrainctl(["validate", "live", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--codex-transport", "app-server"]);
    assert.equal(live.status, 0, live.stderr);
    const liveJson = JSON.parse(live.stdout) as { ok: boolean; details: { plan: { networkStarted: boolean; checks: Array<{ id: string; mode: string }> }; sideEffects: string } };
    assert.equal(liveJson.ok, true);
    assert.equal(liveJson.details.sideEffects, "none");
    assert.equal(liveJson.details.plan.networkStarted, false);
    assert.equal(liveJson.details.plan.checks.find((check) => check.id === "codex-provider")?.mode, "plan");

    const pairingState = path.join(root, "telegram-pairing");
    await mkdir(pairingState, { recursive: true });
    await writeFile(path.join(pairingState, "telegram_users.json"), `${JSON.stringify([{ userId: "7", isAdmin: true }])}\n`);
    await writeFile(path.join(pairingState, "telegram_chats.json"), `${JSON.stringify([{ chatId: "123" }])}\n`);
    const entrypoint = spawnBrainctl(["entrypoint", "check", "telegram", "--workspace", "personal", "--pairing-state", pairingState]);
    assert.equal(entrypoint.status, 0, entrypoint.stderr);
    const entrypointJson = JSON.parse(entrypoint.stdout) as { ok: boolean; details: { pairing: { users: number; chats: number; codePresent: boolean; rawIdentifiersPrinted: boolean } } };
    assert.equal(entrypointJson.ok, true);
    assert.deepEqual(entrypointJson.details.pairing, {
      stateDir: pairingState,
      users: 1,
      chats: 1,
      codePresent: false,
      rawIdentifiersPrinted: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl run/start/operations resolve Telegram and Codex from runtime config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-config-runtime-"));
  try {
    const state = path.join(root, "state");
    const artifacts = path.join(root, "artifacts");
    const log = path.join(root, "runtime.jsonl");

    const start = spawnBrainctl(["start", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(start.status, 0, start.stderr);
    const startJson = JSON.parse(start.stdout) as { ok: boolean; details: { provider: string; providerSource: string; entrypoint: string; entrypointSource: string; subagentExecutor: string } };
    assert.equal(startJson.ok, true);
    assert.equal(startJson.details.provider, "codex");
    assert.equal(startJson.details.providerSource, "config");
    assert.equal(startJson.details.entrypoint, "telegram");
    assert.equal(startJson.details.entrypointSource, "config");
    assert.equal(startJson.details.subagentExecutor, "provider:codex");

    const run = spawnBrainctl(["run", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--once", "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(run.status, 0, run.stderr);
    const runJson = JSON.parse(run.stdout) as { ok: boolean; details: { providerKind: string; providerSource: string; entrypointKind: string; entrypointSource: string; subagentExecutor: string; processed: number; stoppedReason: string } };
    assert.equal(runJson.ok, true);
    assert.equal(runJson.details.providerKind, "codex");
    assert.equal(runJson.details.providerSource, "config");
    assert.equal(runJson.details.entrypointKind, "telegram");
    assert.equal(runJson.details.entrypointSource, "config");
    assert.equal(runJson.details.subagentExecutor, "provider:codex");
    assert.equal(runJson.details.processed, 0);
    assert.equal(runJson.details.stoppedReason, "entrypoint-closed");

    const systemd = spawnBrainctl(["operations", "systemd", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--repo", repoRoot, "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(systemd.status, 0, systemd.stderr);
    const systemdJson = JSON.parse(systemd.stdout) as { ok: boolean; details: { unit: string; sideEffects: string } };
    assert.equal(systemdJson.ok, true);
    assert.match(systemdJson.details.unit, /--config .*runtime\.yaml --workspace personal/);
    assert.match(systemdJson.details.unit, /--entrypoint telegram --provider codex/);
    assert.doesNotMatch(systemdJson.details.unit, /--entrypoint fake|--provider fake/);
    assert.equal(systemdJson.details.sideEffects, "none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl status, provider smoke, automation monitor, and web wrappers are safe and testable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-parity-"));
  try {
    const state = path.join(root, "state");
    const artifacts = path.join(root, "artifacts");
    const log = path.join(root, "runtime.jsonl");

    const status = spawnBrainctl(["status", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as { ok: boolean; details: { liveProcessesStarted: boolean; operations: { preflight: string[] } } };
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.details.liveProcessesStarted, false);
    assert.ok(statusJson.details.operations.preflight.length > 0);

    const providerSmoke = spawnBrainctl(["provider", "smoke", "codex", "--transport", "stub", "--workspace", "personal", "--prompt", "ping"]);
    assert.equal(providerSmoke.status, 0, providerSmoke.stderr);
    const providerJson = JSON.parse(providerSmoke.stdout) as { ok: boolean; details: { taskStarted: boolean; eventTypes: string[] } };
    assert.equal(providerJson.ok, true);
    assert.equal(providerJson.details.taskStarted, true);
    assert.ok(providerJson.details.eventTypes.includes("final"));

    const employeeRun = spawnBrainctl(["run", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--fake", "--once", "--fake-text", "employee start analyst", "--employee-runtime", "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(employeeRun.status, 0, employeeRun.stderr);
    const employeeJson = JSON.parse(employeeRun.stdout) as { ok: boolean; details: { interceptedCommands: string[]; dispatchResults: Array<{ type: string }> } };
    assert.equal(employeeJson.ok, true);
    assert.deepEqual(employeeJson.details.interceptedCommands, ["employees"]);

    const automationFile = path.join(root, "automation.yaml");
    await writeFile(automationFile, [
      "monitors:",
      "  - id: inbox",
      "    enabled: true",
      "    source: filesystem",
      "    route: dispatch_subagent",
      "    prompt: Investigate inbox alert.",
      "    config:",
      "      profile: debugger",
      "",
    ].join("\n"));
    const automation = spawnBrainctl(["automation", "monitor", "inbox", "--file", automationFile, "--workspace", "personal", "--dispatch", "--state", state, "--artifacts", artifacts, "--line", "ERROR sample"]);
    assert.equal(automation.status, 0, automation.stderr);
    const automationJson = JSON.parse(automation.stdout) as { ok: boolean; details: { result: { status: string }; safeDefault: string } };
    assert.equal(automationJson.ok, true);
    assert.match(automationJson.details.safeDefault, /no watcher/);

    const pageDir = path.join(root, "page");
    await mkdir(pageDir, { recursive: true });
    await writeFile(path.join(pageDir, "index.html"), "<!doctype html><title>Smoke Page</title><h1>ok</h1>\n");
    const webValidate = spawnBrainctl(["web", "validate", "--dir", pageDir]);
    assert.equal(webValidate.status, 0, webValidate.stderr);
    const webValidateJson = JSON.parse(webValidate.stdout) as { ok: boolean; details: { title: string; sideEffects: string } };
    assert.equal(webValidateJson.ok, true);
    assert.equal(webValidateJson.details.title, "Smoke Page");

    const manifest = path.join(root, "manifest.json");
    const runtimeRoot = path.join(root, "pages");
    const webPublish = spawnBrainctl(["web", "publish", "--dir", pageDir, "--id", "smoke-page", "--runtime-root", runtimeRoot, "--manifest-path", manifest, "--public-base-url", "http://example.test/pages", "--dry-run"]);
    assert.equal(webPublish.status, 0, webPublish.stderr);
    const webPublishJson = JSON.parse(webPublish.stdout) as { ok: boolean; details: { dryRun: boolean; url: string } };
    assert.equal(webPublishJson.ok, true);
    assert.equal(webPublishJson.details.dryRun, true);
    assert.equal(webPublishJson.details.url, "http://example.test/pages/smoke-page/");
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
