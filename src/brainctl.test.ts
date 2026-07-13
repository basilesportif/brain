import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import YAML from "yaml";

const brainctl = new URL("./brainctl.js", import.meta.url);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const assistantLogicPackage = path.join(repoRoot, "packages", "assistant-logic");

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
    assert.match(systemdJson.details.unit, /Brain lab runtime systemd service is disabled by policy/);
    assert.doesNotMatch(systemdJson.details.unit, /--telegram-polling/);
    assert.equal(systemdJson.details.sideEffects, "none");

    const validate = spawnBrainctl(["operations", "validate", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--repo", repoRoot, "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(validate.status, 0, validate.stderr);
    const validateJson = JSON.parse(validate.stdout) as { ok: boolean; details: { sideEffects: string; commandPlan: { preflight: string[] } } };
    assert.equal(validateJson.ok, true);
    assert.ok(validateJson.details.commandPlan.preflight.some((command) => command.includes("runtime smoke")));

    const live = spawnBrainctl(["validate", "live", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--codex-transport", "app-server"]);
    assert.equal(live.status, 0, live.stderr);
    const liveJson = JSON.parse(live.stdout) as {
      ok: boolean;
      summary: string;
      details: {
        plan: { networkStarted: boolean; checks: Array<{ id: string; mode: string }> };
        sideEffects: string;
        nextStep: { step: string; title: string };
        guidedSequence: Array<{ step: string; title: string; botFatherSteps?: string[]; privateStorage?: string[] }>;
        notLiveYet: string[];
      };
    };
    assert.equal(liveJson.ok, true);
    assert.match(liveJson.summary, /Pre-live validation plan ready/);
    assert.equal(liveJson.details.sideEffects, "none");
    assert.equal(liveJson.details.plan.networkStarted, false);
    assert.equal(liveJson.details.plan.checks.find((check) => check.id === "codex-provider")?.mode, "plan");
    assert.equal(liveJson.details.nextStep.step, "telegram-connection");
    assert.ok(liveJson.details.guidedSequence.find((step) => step.step === "private-data-repo"));
    assert.ok(liveJson.details.guidedSequence.find((step) => step.step === "composio-accounts"));
    assert.ok(liveJson.details.guidedSequence.find((step) => step.step === "configure-verify-codex-auth"));
    assert.match(liveJson.details.nextStep.title, /Connect Telegram/);
    assert.ok(liveJson.details.guidedSequence.find((step) => step.step === "install-start-service"));
    const telegramStep = liveJson.details.guidedSequence.find((step) => step.step === "telegram-connection");
    assert.match(telegramStep?.title ?? "", /Connect Telegram/);
    assert.ok(telegramStep?.botFatherSteps?.some((step) => /@BotFather/.test(step)));
    assert.ok(telegramStep?.botFatherSteps?.some((step) => /temp script/.test(step)));
    assert.ok(telegramStep?.privateStorage?.some((step) => /shell history/.test(step)));
    assert.ok(telegramStep?.privateStorage?.some((step) => /bash \//.test(step) && /store-brain-telegram-token/.test(step)));
    assert.ok(liveJson.details.notLiveYet.some((item) => /has not started Telegram polling/.test(item)));

    const pairingState = path.join(root, "telegram-pairing");
    await mkdir(pairingState, { recursive: true });
    await writeFile(path.join(pairingState, "telegram_users.json"), `${JSON.stringify([{ userId: "7", isAdmin: true }])}\n`);
    await writeFile(path.join(pairingState, "telegram_chats.json"), `${JSON.stringify([{ chatId: "123" }])}\n`);
    const entrypoint = spawnBrainctl(["entrypoint", "check", "telegram", "--workspace", "personal", "--pairing-state", pairingState]);
    assert.equal(entrypoint.status, 0, entrypoint.stderr);
    const entrypointJson = JSON.parse(entrypoint.stdout) as { ok: boolean; details: { pairing: { adminPairs: number; users: number; chats: number; codePresent: boolean; rawIdentifiersPrinted: boolean } } };
    assert.equal(entrypointJson.ok, true);
    assert.deepEqual(entrypointJson.details.pairing, {
      stateDir: pairingState,
      adminPairs: 1,
      users: 1,
      chats: 1,
      codePresent: false,
      rawIdentifiersPrinted: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup rerun surfaces remote resume context before first-run questions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-remote-context-"));
  try {
    await mkdir(path.join(root, "private"), { recursive: true });
    await writeFile(path.join(root, "private", "setup-context.json"), `${JSON.stringify({
      version: 1,
      target: "remote",
      workspace: "personal",
      workspaceRoot: "/home/brain/.brain/workspace",
      sshHost: "brain-prod",
      sshUser: "brain",
      repoPath: "/home/brain/brain",
      configPath: "/home/brain/.brain/workspace/config/runtime.yaml",
      updatedAt: "2026-05-23T00:00:00.000Z",
      secretValuesStored: false,
    }, null, 2)}\n`, { mode: 0o600 });

    const status = spawnBrainctl(["setup", "status", "--repo", root, "--workspace", "personal"]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as {
      summary: string;
      details: {
        workspacePathSource: string;
        localSetupContext: { present: boolean; context: { target: string; sshHost: string; workspaceRoot: string } };
        resumeProbe: { target: string; firstAction: string; command: string; progressPath: string; note: string };
      };
    };
    assert.match(statusJson.summary, /prior remote setup context found/);
    assert.equal(statusJson.details.workspacePathSource, "local-setup-context");
    assert.equal(statusJson.details.localSetupContext.present, true);
    assert.equal(statusJson.details.localSetupContext.context.target, "remote");
    assert.equal(statusJson.details.localSetupContext.context.sshHost, "brain-prod");
    assert.equal(statusJson.details.resumeProbe.target, "remote");
    assert.equal(statusJson.details.resumeProbe.firstAction, "inspect-remote-progress");
    assert.equal(statusJson.details.resumeProbe.progressPath, "/home/brain/.brain/workspace/state/setup-progress.json");
    assert.match(statusJson.details.resumeProbe.command, /ssh brain@brain-prod/);
    assert.match(statusJson.details.resumeProbe.command, /setup status/);
    assert.match(statusJson.details.resumeProbe.note, /before restarting the setup wizard/);

    const setup = spawnBrainctl(["setup", "--repo", root, "--workspace", "personal"]);
    assert.equal(setup.status, 0, setup.stderr);
    const setupJson = JSON.parse(setup.stdout) as { summary: string; details: { sideEffects: string; resumeProbe: { target: string; firstAction: string } } };
    assert.match(setupJson.summary, /prior remote setup context found/);
    assert.equal(setupJson.details.sideEffects, "none");
    assert.equal(setupJson.details.resumeProbe.target, "remote");
    assert.equal(setupJson.details.resumeProbe.firstAction, "inspect-remote-progress");
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

    const disabledLivePolling = spawnBrainctl(["run", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--telegram-polling"]);
    assert.equal(disabledLivePolling.status, 1, disabledLivePolling.stderr);
    const disabledLivePollingJson = JSON.parse(disabledLivePolling.stdout) as { summary: string; details: { replacement: string; secretValuesPrinted: boolean } };
    assert.match(disabledLivePollingJson.summary, /Brain live Telegram polling is disabled/);
    assert.match(disabledLivePollingJson.details.replacement, /codex-chat\.service|stack apply/);
    assert.equal(disabledLivePollingJson.details.secretValuesPrinted, false);
    assert.equal(runJson.details.processed, 0);
    assert.equal(runJson.details.stoppedReason, "entrypoint-closed");

    const systemd = spawnBrainctl(["operations", "systemd", "--config", "examples/config/runtime.yaml", "--workspace", "personal", "--repo", repoRoot, "--state", state, "--artifacts", artifacts, "--log", log]);
    assert.equal(systemd.status, 0, systemd.stderr);
    const systemdJson = JSON.parse(systemd.stdout) as { ok: boolean; details: { unit: string; sideEffects: string } };
    assert.equal(systemdJson.ok, true);
    assert.match(systemdJson.details.unit, /Brain lab runtime systemd service is disabled by policy/);
    assert.match(systemdJson.details.unit, /production uses codex-chat\.service/);
    assert.doesNotMatch(systemdJson.details.unit, /--telegram-polling|--entrypoint telegram --provider codex/);
    assert.equal(systemdJson.details.sideEffects, "none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl wires runtime OpenAI transcription config into Telegram without exposing key values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-transcription-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    await writeFile(config, testRuntimeConfig(workspace, backupRepo, { transcriptionEnabled: true }));

    const secretValue = "sk-test-transcription-secret-value-must-not-print";
    const setup = spawnBrainctl(["setup", "inspect", "--config", config, "--workspace", "personal", "--path", workspace], { OPENAI_API_KEY: secretValue });
    assert.equal(setup.status, 1, setup.stderr);
    assert.doesNotMatch(setup.stdout, new RegExp(secretValue));
    const setupJson = JSON.parse(setup.stdout) as { details: { transcription: { enabled: boolean; apiKeyRefPresent: boolean; secretValuesPrinted: boolean }; secretRefs: Array<{ source: string; kind: string; present: boolean; value: string }> } };
    assert.equal(setupJson.details.transcription.enabled, true);
    assert.equal(setupJson.details.transcription.apiKeyRefPresent, true);
    assert.equal(setupJson.details.transcription.secretValuesPrinted, false);
    assert.ok(setupJson.details.secretRefs.some((ref) => ref.source === "transcription.apiKeyRef" && ref.kind === "env" && ref.present && ref.value === "redacted"));

    const setupStatus = spawnBrainctl(["setup", "status", "--config", config, "--workspace", "personal", "--path", workspace], { OPENAI_API_KEY: secretValue });
    assert.equal(setupStatus.status, 1, setupStatus.stderr);
    assert.doesNotMatch(setupStatus.stdout, new RegExp(secretValue));
    const setupStatusJson = JSON.parse(setupStatus.stdout) as { details: { transcription: { secretValuesPrinted: boolean } } };
    assert.equal(setupStatusJson.details.transcription.secretValuesPrinted, false);

    const dryRun = spawnBrainctl(["start", "--config", config, "--workspace", "personal"], { OPENAI_API_KEY: secretValue });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.doesNotMatch(dryRun.stdout, new RegExp(secretValue));
    const dryRunJson = JSON.parse(dryRun.stdout) as { details: { telegramTranscription: { enabled: boolean; provider: string; source: string; apiKeyRefPresent: boolean; attachmentKinds: string[] } } };
    assert.deepEqual(dryRunJson.details.telegramTranscription, {
      enabled: true,
      provider: "openai",
      source: "config",
      apiKeyRefPresent: true,
      model: "gpt-4o-mini-transcribe",
      language: "",
      promptPathPresent: false,
      attachmentKinds: ["voice", "audio"],
      scopedToEntrypoint: true,
    });

    const secrets = spawnBrainctl(["secrets", "check", "--config", config], { OPENAI_API_KEY: secretValue });
    assert.equal(secrets.status, 0, secrets.stderr);
    assert.doesNotMatch(secrets.stdout, new RegExp(secretValue));
    const secretsJson = JSON.parse(secrets.stdout) as { details: Array<{ source: string; kind: string; present: boolean; value?: string }> };
    assert.ok(secretsJson.details.some((ref) => ref.source === "transcription.apiKeyRef" && ref.kind === "env" && ref.present && ref.value === "redacted"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("brainctl Codex provider CLI paths strip configured transcription env refs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-codex-provider-env-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    const fakeCodex = path.join(root, "codex");
    const healthEnvPath = path.join(root, "health-env.json");
    const turnEnvPath = path.join(root, "turn-env.json");
    const turnInvocationPath = path.join(root, "turn-invocation.json");
    await mkdir(workspace, { recursive: true });
    await writeFile(config, testRuntimeConfig(workspace, backupRepo, { transcriptionEnabled: true, transcriptionApiKeyRef: "env:BRAIN_TRANSCRIPTION_KEY" }));
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const snapshot = () => JSON.stringify({
  openai: Boolean(process.env.OPENAI_API_KEY),
  transcription: Boolean(process.env.BRAIN_TRANSCRIPTION_KEY),
  other: process.env.OTHER_VAR || null,
  tmpdir: process.env.TMPDIR || null
});
if (process.argv.includes("--version")) {
  await writeFile(${JSON.stringify(healthEnvPath)}, snapshot());
  console.log("fake-codex 1.0.0");
  process.exit(0);
}
await writeFile(${JSON.stringify(turnEnvPath)}, snapshot());
await writeFile(${JSON.stringify(turnInvocationPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "ok" } }));
console.log(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_fake", status: "completed", items: [] } } }));
`);
    await chmod(fakeCodex, 0o755);

    const env = {
      BRAIN_TRANSCRIPTION_KEY: "sk-test-custom-transcription-value-must-not-print",
      OPENAI_API_KEY: "sk-test-openai-value-must-not-print",
      OTHER_VAR: "keep-me",
    };
    const readSnapshot = async (file: string) => JSON.parse(await readFile(file, "utf8")) as { openai: boolean; transcription: boolean; other: string | null; tmpdir: string | null };

    const providerCheck = spawnBrainctl(["provider", "check", "codex", "--config", config, "--workspace", "personal", "--transport", "exec", "--binary", fakeCodex, "--timeout-ms", "5000"], env);
    assert.equal(providerCheck.status, 0, providerCheck.stderr);
    assert.doesNotMatch(providerCheck.stdout, /sk-test-/);
    assert.deepEqual(await readSnapshot(healthEnvPath), { openai: false, transcription: false, other: "keep-me", tmpdir: path.join(workspace, "tmp") });

    const providerSmoke = spawnBrainctl(["provider", "smoke", "codex", "--config", config, "--workspace", "personal", "--transport", "exec", "--binary", fakeCodex, "--timeout-ms", "5000", "--prompt", "ping", "--allow-live"], env);
    assert.equal(providerSmoke.status, 0, providerSmoke.stderr);
    assert.doesNotMatch(providerSmoke.stdout, /sk-test-/);
    assert.deepEqual(await readSnapshot(turnEnvPath), { openai: false, transcription: false, other: "keep-me", tmpdir: path.join(workspace, "tmp") });
    const invocation = JSON.parse(await readFile(turnInvocationPath, "utf8")) as { argv: string[]; cwd: string };
    assert.equal(invocation.cwd, await realpath(workspace));
    assert.ok(invocation.argv.includes("--cd"));
    assert.equal(invocation.argv[invocation.argv.indexOf("--cd") + 1], workspace);
    assert.ok(invocation.argv.includes("--sandbox"));
    assert.equal(invocation.argv[invocation.argv.indexOf("--sandbox") + 1], "danger-full-access");
    assert.ok(invocation.argv.includes("--config"));
    assert.ok(invocation.argv.includes("approval_policy=\"never\""));

    const live = spawnBrainctl(["validate", "live", "--config", config, "--workspace", "personal", "--codex-transport", "exec", "--allow-live", "--run-safe"], {
      ...env,
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    assert.equal(live.status, 0, live.stderr);
    assert.doesNotMatch(live.stdout, /sk-test-/);
    const liveJson = JSON.parse(live.stdout) as {
      summary: string;
      details: {
        completedChecks: string[];
        nextStep: { step: string };
        guidedSequence: Array<{ step: string; requiresConfirmation?: string; privateStorage?: string[] }>;
        setupStateUpdate: { wrote: boolean; metadata: { mode: string }; state: { secretValuesStored: boolean; nextRecommendedStep: string; statuses: { codexAuth: { status: string; runAsUser?: string }; telegramToken: { configured: boolean } } } };
      };
    };
    assert.match(liveJson.summary, /Pre-live checks passed/);
    assert.ok(liveJson.details.completedChecks.some((check) => /Runtime config/.test(check)));
    assert.equal(liveJson.details.nextStep.step, "telegram-connection");
    assert.ok(liveJson.details.guidedSequence.find((step) => step.step === "install-start-service")?.requiresConfirmation?.includes("systemd"));
    assert.ok(liveJson.details.guidedSequence.find((step) => step.step === "telegram-connection")?.privateStorage?.some((item) => /never paste the token into the repo/.test(item)));
    assert.equal(liveJson.details.setupStateUpdate.wrote, true);
    assert.equal(liveJson.details.setupStateUpdate.metadata.mode, "0600");
    assert.equal(liveJson.details.setupStateUpdate.state.secretValuesStored, false);
    assert.equal(liveJson.details.setupStateUpdate.state.statuses.codexAuth.status, "verified");
    assert.equal(liveJson.details.setupStateUpdate.state.statuses.codexAuth.runAsUser, userInfo().username);
    assert.equal(liveJson.details.setupStateUpdate.state.statuses.telegramToken.configured, false);
    assert.deepEqual(await readSnapshot(healthEnvPath), { openai: false, transcription: false, other: "keep-me", tmpdir: path.join(workspace, "tmp") });

    const liveWithTelegram = spawnBrainctl(["validate", "live", "--config", config, "--workspace", "personal", "--codex-transport", "exec", "--telegram-token-env", "BRAIN_TELEGRAM_TOKEN", "--allow-live", "--run-safe"], {
      ...env,
      BRAIN_TELEGRAM_TOKEN: "123456:fake-token-for-metadata-only",
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    assert.equal(liveWithTelegram.status, 0, liveWithTelegram.stderr);
    assert.doesNotMatch(liveWithTelegram.stdout, /fake-token/);
    const liveWithTelegramJson = JSON.parse(liveWithTelegram.stdout) as {
      summary: string;
      details: {
        nextStep: { step: string };
        setupStateUpdate: { state: { nextRecommendedStep: string; statuses: { telegramToken: { configured: boolean } } } };
      };
    };
    assert.match(liveWithTelegramJson.summary, /Next: Install and start the codex-chat service/);
    assert.equal(liveWithTelegramJson.details.nextStep.step, "install-start-service");
    assert.equal(liveWithTelegramJson.details.setupStateUpdate.state.nextRecommendedStep, "install-start-service");
    assert.equal(liveWithTelegramJson.details.setupStateUpdate.state.statuses.telegramToken.configured, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl live validation does not mark a missing Telegram token file configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-missing-telegram-token-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    const missingToken = path.join(workspace, "secrets", "telegram-bot-token");
    await mkdir(workspace, { recursive: true });
    await writeFile(config, testRuntimeConfig(workspace, backupRepo));

    const live = spawnBrainctl(["validate", "live", "--config", config, "--workspace", "personal", "--telegram-token-file", missingToken, "--run-safe"]);
    assert.equal(live.status, 0, live.stderr);
    const liveJson = JSON.parse(live.stdout) as {
      details: {
        results: Array<{ id: string; details?: { token?: { present: boolean } } }>;
        setupStateUpdate: { state: { statuses: { telegramToken: { configured: boolean } } } };
      };
    };
    assert.equal(liveJson.details.results.find((result) => result.id === "telegram-entrypoint")?.details?.token?.present, false);
    assert.equal(liveJson.details.setupStateUpdate.state.statuses.telegramToken.configured, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl validate live reconciles stale deployment ledger auth/secret blockers when health is clear", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-ledger-reconcile-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    const tokenFile = path.join(workspace, "secrets", "telegram-bot-token");
    const ledgerPath = path.join(workspace, "state", "control-plane", "deployments.json");
    const bin = path.join(root, "bin");
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(config, testRuntimeConfig(workspace, backupRepo));
    await writeFile(tokenFile, "123456:abcDEF_ghi-JKLmnop\n");
    await writeFile(path.join(bin, "systemctl"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"show\" ] && [ \"${3:-}\" = \"--property=LoadState\" ]; then printf 'loaded\\n'; exit 0; fi",
      "if [ \"${1:-}\" = \"show\" ] && [ \"${3:-}\" = \"--property=ExecStart\" ]; then printf 'ExecStart=pnpm run brainctl run --workspace personal --state " + workspace.replace(/'/g, "'\"'\"'") + "/state\\n'; exit 0; fi",
      "if [ \"${1:-}\" = \"is-enabled\" ]; then exit 0; fi",
      "if [ \"${1:-}\" = \"is-active\" ]; then exit 0; fi",
      "exit 1",
      "",
    ].join("\n"));
    await chmod(path.join(bin, "systemctl"), 0o700);
    await writeFile(ledgerPath, `${JSON.stringify({
      version: 1,
      kind: "brain.control-plane.deployments",
      updatedAt: "2026-06-07T00:00:00.000Z",
      canonical: {
        sourceOfTruth: "local-brain-workspace",
        workspaceRoot: workspace,
        path: ledgerPath,
        relativePath: "state/control-plane/deployments.json",
      },
      deployments: [{
        id: "personal:production:codex-chat",
        stack: "codex-chat",
        workspace: "personal",
        environment: "production",
        status: "blocked",
        updatedAt: "2026-06-07T00:00:00.000Z",
        blocker: "blocked_on_user_auth_or_secret",
        blockers: ["blocked_on_user_auth_or_secret"],
        health: { status: "failed" },
        secretValuesStored: false,
      }],
      secretValuesStored: false,
    }, null, 2)}\n`);

    const result = spawnBrainctl(["validate", "live", "--config", config, "--workspace", "personal", "--telegram-token-file", tokenFile, "--run-safe"], {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { details: { ledgerReconciliation: { wrote: boolean; removedBlocker: string; status: string } } };
    assert.equal(parsed.details.ledgerReconciliation.wrote, true);
    assert.equal(parsed.details.ledgerReconciliation.removedBlocker, "blocked_on_user_auth_or_secret");
    assert.equal(parsed.details.ledgerReconciliation.status, "healthy");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { deployments: Array<Record<string, unknown>> };
    assert.equal(ledger.deployments[0]?.status, "healthy");
    assert.equal(ledger.deployments[0]?.blocker, undefined);
    assert.equal(ledger.deployments[0]?.blockers, undefined);
    assert.equal((ledger.deployments[0]?.health as { status?: string }).status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup telegram-token-script writes a syntax-checked one-use secret script", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-token-script-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    const script = path.join(root, "store-brain-telegram-token.sh");
    const token = "123456:abcDEF_ghi-JKLmnop";
    await writeFile(config, testRuntimeConfig(workspace, backupRepo));

    const codexChatEnv = path.join(root, "codex-chat.env");
    const localPollution = "999999:localPollutionMustNotBeCopied";
    const generated = spawnBrainctl(["setup", "telegram-token-script", "--workspace", "personal", "--path", workspace, "--output", script, "--codex-chat-env", codexChatEnv], {
      TELEGRAM_BOT_TOKEN: localPollution,
    });
    assert.equal(generated.status, 0, generated.stderr);
    assert.doesNotMatch(generated.stdout, new RegExp(localPollution));
    const generatedJson = JSON.parse(generated.stdout) as { ok: boolean; details: { scriptPath: string; validation: string; secretValuesPrinted: boolean; writes: { codexChatEnv?: string } } };
    assert.equal(generatedJson.ok, true);
    assert.equal(generatedJson.details.scriptPath, script);
    assert.equal(generatedJson.details.writes.codexChatEnv, codexChatEnv);
    assert.equal(generatedJson.details.validation, "bash -n passed");
    assert.equal(generatedJson.details.secretValuesPrinted, false);
    assert.doesNotMatch(await readFile(script, "utf8"), new RegExp(localPollution));

    const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    const stored = spawnSync("bash", [script], { input: `${token}\n`, encoding: "utf8" });
    assert.equal(stored.status, 0, stored.stderr);
    assert.doesNotMatch(stored.stdout, new RegExp(token));
    assert.doesNotMatch(stored.stderr, new RegExp(token));
    await assert.rejects(stat(script));

    const tokenFile = path.join(workspace, "secrets", "telegram-bot-token");
    const adapterConfig = path.join(workspace, "secrets", "telegram-main.json");
    const serviceEnv = path.join(workspace, "config", "brain-personal.env");
    const secretsEnv = path.join(workspace, "secrets", "secrets.env");
    assert.equal(await readFile(tokenFile, "utf8"), `${token}\n`);
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    assert.equal((await stat(adapterConfig)).mode & 0o777, 0o600);
    assert.match(await readFile(adapterConfig, "utf8"), new RegExp(`"tokenRef": "file:${escapeRegExp(tokenFile)}"`));
    assert.match(await readFile(adapterConfig, "utf8"), /"maxAdminPairs": 2/);
    assert.doesNotMatch(await readFile(serviceEnv, "utf8"), new RegExp(token));
    assert.doesNotMatch(await readFile(secretsEnv, "utf8"), new RegExp(token));
    assert.match(await readFile(serviceEnv, "utf8"), new RegExp(`TELEGRAM_BOT_TOKEN_FILE=${escapeRegExp(tokenFile)}`));
    assert.match(await readFile(secretsEnv, "utf8"), new RegExp(`TELEGRAM_MAIN_CONFIG=${escapeRegExp(adapterConfig)}`));
    assert.equal(await readFile(codexChatEnv, "utf8"), `TELEGRAM_BOT_TOKEN=${token}\n`);
    assert.equal((await stat(codexChatEnv)).mode & 0o777, 0o600);
    const scaffold = spawnBrainctl(["workspace", "scaffold", "--path", workspace]);
    assert.equal(scaffold.status, 0, scaffold.stderr);

    const status = spawnBrainctl(["setup", "status", "--config", config, "--workspace", "personal", "--path", workspace]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as {
      summary: string;
      details: {
        secretRefs: Array<{ source: string; ref: string; present: boolean; envSource?: string; envFile?: { path: string; present: boolean } }>;
        setupWizard: { nextIncompleteStep: { step: string } };
      };
    };
    const telegramConfigRef = statusJson.details.secretRefs.find((ref) => ref.source === "entrypoint.configRef" && ref.ref === "env:TELEGRAM_MAIN_CONFIG");
    assert.equal(telegramConfigRef?.present, true);
    assert.equal(telegramConfigRef?.envSource, "workspace-env-file");
    assert.equal(telegramConfigRef?.envFile?.path, serviceEnv);
    assert.equal(statusJson.details.setupWizard.nextIncompleteStep.step, "configure-verify-codex-auth");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup composio-api-key-script writes a syntax-checked one-use secret script", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-composio-key-script-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    const script = path.join(root, "store-brain-composio-api-key.sh");
    const apiKey = "comp_test_key_123456789";
    await mkdir(workspace, { recursive: true });
    await writeFile(config, testRuntimeConfig(workspace, backupRepo, { composioEnabled: true }));

    const generated = spawnBrainctl(["setup", "composio-api-key-script", "--workspace", "personal", "--path", workspace, "--output", script, "--ssh-host", "203.0.113.10", "--ssh-user", "brain"]);
    assert.equal(generated.status, 0, generated.stderr);
    const generatedJson = JSON.parse(generated.stdout) as { ok: boolean; details: { scriptPath: string; validation: string; secretValuesPrinted: boolean; sshRunCommand: string; nextCommands: { generateGmailOauth: string; generateGoogleCalendarOauth: string } } };
    assert.equal(generatedJson.ok, true);
    assert.equal(generatedJson.details.scriptPath, script);
    assert.equal(generatedJson.details.validation, "bash -n passed");
    assert.equal(generatedJson.details.secretValuesPrinted, false);
    assert.equal(generatedJson.details.sshRunCommand, `ssh -t brain@203.0.113.10 'bash ${script}'`);
    assert.match(generatedJson.details.nextCommands.generateGmailOauth, /--generate --app gmail/);
    assert.match(generatedJson.details.nextCommands.generateGoogleCalendarOauth, /--generate --app google_calendar/);
    assert.doesNotMatch(generated.stdout, new RegExp(apiKey));

    const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    const stored = spawnSync("bash", [script], { input: `${apiKey}\n`, encoding: "utf8" });
    assert.equal(stored.status, 0, stored.stderr);
    assert.doesNotMatch(stored.stdout, new RegExp(apiKey));
    assert.doesNotMatch(stored.stderr, new RegExp(apiKey));
    await assert.rejects(stat(script));

    const workspaceEnv = path.join(workspace, ".env");
    assert.equal((await stat(workspaceEnv)).mode & 0o777, 0o600);
    assert.match(await readFile(workspaceEnv, "utf8"), /^COMPOSIO_API_KEY='comp_test_key_123456789'$/m);

    const status = spawnBrainctl(["composio", "status", "--config", config, "--workspace", "personal"]);
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, new RegExp(apiKey));
    const statusJson = JSON.parse(status.stdout) as { details: { apiKeyPresent: boolean; privateConfig: { workspaceEnv: { keys: string[]; valuesPrinted: boolean } }; nextDataSourceFlow: { missing: string[] } } };
    assert.equal(statusJson.details.apiKeyPresent, true);
    assert.deepEqual(statusJson.details.privateConfig.workspaceEnv.keys, ["COMPOSIO_API_KEY"]);
    assert.equal(statusJson.details.privateConfig.workspaceEnv.valuesPrinted, false);
    assert.ok(statusJson.details.nextDataSourceFlow.missing.includes("Google Calendar connected account"));
    assert.ok(statusJson.details.nextDataSourceFlow.missing.includes("Gmail connected account"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup codex-auth-script verifies login before marking provider auth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-codex-auth-script-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    const script = path.join(root, "verify-brain-codex-auth.sh");
    const bin = path.join(root, "bin");
    const log = path.join(root, "pnpm-args.json");
    await mkdir(bin, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(config, testRuntimeConfig(workspace, backupRepo));
    await writeFile(path.join(bin, "codex"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"--version\" ]; then echo codex-test; exit 0; fi",
      "if [ \"${1:-}\" = \"login\" ] && [ \"${2:-}\" = \"status\" ]; then echo 'Logged in using ChatGPT'; exit 0; fi",
      "exit 2",
      "",
    ].join("\n"), { mode: 0o700 });
    await writeFile(path.join(bin, "pnpm"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$*" > ${shellTestLiteral(log)}`,
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(path.join(bin, "codex"), 0o700);
    await chmod(path.join(bin, "pnpm"), 0o700);

    const generated = spawnBrainctl(["setup", "codex-auth-script", "--workspace", "personal", "--path", workspace, "--config", config, "--repo", root, "--output", script, "--ssh-host", "203.0.113.10", "--ssh-user", "brain"]);
    assert.equal(generated.status, 0, generated.stderr);
    const generatedJson = JSON.parse(generated.stdout) as { ok: boolean; details: { scriptPath: string; validation: string; secretValuesPrinted: boolean; sshRunCommand: string } };
    assert.equal(generatedJson.ok, true);
    assert.equal(generatedJson.details.scriptPath, script);
    assert.equal(generatedJson.details.validation, "bash -n passed");
    assert.equal(generatedJson.details.secretValuesPrinted, false);
    assert.equal(generatedJson.details.sshRunCommand, `ssh -t brain@203.0.113.10 'bash ${script}'`);

    const generatedForServiceUser = spawnBrainctl(["setup", "codex-auth-script", "--workspace", "personal", "--path", workspace, "--config", config, "--repo", root, "--output", script, "--ssh-host", "203.0.113.10", "--ssh-user", "root", "--service-user", "brain"]);
    assert.equal(generatedForServiceUser.status, 0, generatedForServiceUser.stderr);
    const generatedForServiceUserJson = JSON.parse(generatedForServiceUser.stdout) as { ok: boolean; details: { sshRunCommand: string; sshLoginCommand: string; sshInteractiveLoginCommand: string; runAsUser: string } };
    assert.equal(generatedForServiceUserJson.ok, true);
    assert.equal(generatedForServiceUserJson.details.runAsUser, "brain");
    assert.match(generatedForServiceUserJson.details.sshRunCommand, /ssh -t root@203\.0\.113\.10/);
    assert.match(generatedForServiceUserJson.details.sshRunCommand, /sudo -iu brain bash/);
    assert.equal(generatedForServiceUserJson.details.sshLoginCommand, `ssh -t root@203.0.113.10 'sudo -iu brain codex login --device-auth'`);
    assert.equal(generatedForServiceUserJson.details.sshInteractiveLoginCommand, `ssh -t root@203.0.113.10 'sudo -iu brain codex login'`);

    const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    await writeFile(path.join(bin, "codex"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"--version\" ]; then echo codex-test; exit 0; fi",
      "if [ \"${1:-}\" = \"login\" ] && [ \"${2:-}\" = \"status\" ]; then echo 'Not logged in' >&2; exit 1; fi",
      "exit 2",
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(path.join(bin, "codex"), 0o700);
    const missingAuth = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    assert.notEqual(missingAuth.status, 0);
    assert.match(missingAuth.stderr, /Run this exact command from your local terminal/);
    assert.match(missingAuth.stderr, /ssh -t root@203\.0\.113\.10 'sudo -iu brain codex login --device-auth'/);
    assert.match(missingAuth.stderr, /ssh -t root@203\.0\.113\.10 'sudo -iu brain codex login'/);

    await writeFile(path.join(bin, "codex"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"--version\" ]; then echo codex-test; exit 0; fi",
      "if [ \"${1:-}\" = \"login\" ] && [ \"${2:-}\" = \"status\" ]; then echo 'Logged in using ChatGPT'; exit 0; fi",
      "exit 2",
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(path.join(bin, "codex"), 0o700);
    const verified = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(await readFile(log, "utf8"), /run brainctl validate live/);
    assert.match(await readFile(log, "utf8"), /--codex-transport exec/);
    assert.match(await readFile(log, "utf8"), /--allow-live/);
    assert.match(await readFile(log, "utf8"), /--run-safe/);
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

test("brainctl setup inspect is idempotent and redacts secret values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    await writeFile(config, testRuntimeConfig(workspace, backupRepo, { composioEnabled: true }));

    const missing = spawnBrainctl(["setup", "inspect", "--config", config, "--workspace", "personal", "--path", workspace]);
    assert.equal(missing.status, 1, missing.stderr);
    const missingJson = JSON.parse(missing.stdout) as { ok: boolean; details: { plan: { missing_required: string[] } } };
    assert.equal(missingJson.ok, false);
    assert.ok(missingJson.details.plan.missing_required.some((item) => /workspace root missing/.test(item)));

    const first = spawnBrainctl(["setup", "--config", config, "--workspace", "personal", "--path", workspace]);
    assert.equal(first.status, 0, first.stderr);
    const firstJson = JSON.parse(first.stdout) as {
      ok: boolean;
      details: {
        idempotency: { reRunnable: boolean; defaultOverwrite: boolean };
        plan: { missing_required: string[] };
        setupWizard: { nextIncompleteStep: { step: string }; completedSteps: Array<{ step: string }>; stateFile: string; stateFilePresent: boolean };
        setupState: { path: string; metadata: { mode: string }; state: { secretValuesStored: boolean; nextRecommendedStep: string } };
      };
    };
    assert.equal(firstJson.ok, true);
    assert.equal(firstJson.details.idempotency.reRunnable, true);
    assert.equal(firstJson.details.idempotency.defaultOverwrite, false);
    assert.deepEqual(firstJson.details.plan.missing_required, []);
    assert.equal(firstJson.details.setupWizard.nextIncompleteStep.step, "telegram-connection");
    assert.ok(firstJson.details.setupWizard.completedSteps.some((step) => step.step === "workspace-scaffold"));
    assert.equal(firstJson.details.setupState.metadata.mode, "0600");
    assert.equal(firstJson.details.setupState.state.secretValuesStored, false);
    assert.equal(firstJson.details.setupState.state.nextRecommendedStep, "telegram-connection");
    const progressState = JSON.parse(await readFile(firstJson.details.setupState.path, "utf8")) as { secretValuesStored: boolean; workspace: string; workspaceRoot: string; statuses: { telegramToken: { configured: boolean } } };
    assert.equal(progressState.secretValuesStored, false);
    assert.equal(progressState.workspace, "personal");
    assert.equal(progressState.workspaceRoot, workspace);
    assert.equal(progressState.statuses.telegramToken.configured, false);

    const privateConfig = path.join(workspace, "config", "runtime.yaml");
    await writeFile(privateConfig, "existing private config placeholder\n");
    const second = spawnBrainctl(["setup", "status", "--config", config, "--workspace", "personal", "--path", workspace]);
    assert.equal(second.status, 0, second.stderr);
    const secondJson = JSON.parse(second.stdout) as {
      ok: boolean;
      summary: string;
      details: {
        plan: { unsafe_to_overwrite: string[] };
        secretValuesPrinted: boolean;
        setupState: { present: boolean; state: { nextRecommendedStep: string; secretValuesStored: boolean } };
        setupWizard: { resumable: boolean; idempotent: boolean; stateTrust: string; nextIncompleteStep: { step: string }; completedSteps: Array<{ step: string }> };
      };
    };
    assert.equal(secondJson.ok, true);
    assert.equal(secondJson.details.secretValuesPrinted, false);
    assert.ok(secondJson.details.plan.unsafe_to_overwrite.some((item) => /runtime\.yaml/.test(item)));
    assert.match(secondJson.summary, /resume from Connect Telegram/);
    assert.equal(secondJson.details.setupState.present, true);
    assert.equal(secondJson.details.setupState.state.secretValuesStored, false);
    assert.equal(secondJson.details.setupWizard.resumable, true);
    assert.equal(secondJson.details.setupWizard.idempotent, true);
    assert.match(secondJson.details.setupWizard.stateTrust, /resume aid only/);
    assert.equal(secondJson.details.setupWizard.nextIncompleteStep.step, "telegram-connection");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl keeps setup coordinator-only and exposes legacy/lab assistant-logic JSON workspace scaffold separately", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-assistant-workspace-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "runtime.yaml");
    const backupRepo = path.join(root, "backup-repo");
    await writeFile(config, testRuntimeConfig(workspace, backupRepo));

    const setup = spawnBrainctl(["setup", "--config", config, "--workspace", "personal", "--path", workspace]);
    assert.equal(setup.status, 0, setup.stderr);
    const setupJson = JSON.parse(setup.stdout) as { details: { plan: { missing_optional: string[] }; assistantWorkspaceScaffold: { deprecatedLabOnly: boolean; skipped: string } } };
    assert.equal(setupJson.details.assistantWorkspaceScaffold.deprecatedLabOnly, true);
    assert.match(setupJson.details.assistantWorkspaceScaffold.skipped, /production setup does not scaffold Brain's legacy assistant-domain JSON stores/);
    assert.ok(setupJson.details.plan.missing_optional.some((item) => /legacy\/lab Brain assistant workspace scaffold absent/.test(item)));

    const scaffold = spawnBrainctl(["workspace", "scaffold", "--path", workspace]);
    assert.equal(scaffold.status, 0, scaffold.stderr);
    const scaffoldJson = JSON.parse(scaffold.stdout) as { details: { scaffold: { writtenFiles: string[] } } };
    assert.ok(scaffoldJson.details.scaffold.writtenFiles.includes(path.join("data", "todos.json")));
    assert.ok(scaffoldJson.details.scaffold.writtenFiles.includes(path.join("data", "bets.json")));
    assert.ok(scaffoldJson.details.scaffold.writtenFiles.includes(".env.example"));
    assert.ok(scaffoldJson.details.scaffold.writtenFiles.includes("composio.yaml.example"));
    assert.ok(scaffoldJson.details.scaffold.writtenFiles.includes(path.join("instructions", "skills", "projects.md")));
    assert.ok(scaffoldJson.details.scaffold.writtenFiles.includes(path.join("private", "documents", "metadata.jsonl")));

    for (const [file, rootKey] of [
      ["todos.json", "todos"],
      ["projects.json", "projects"],
      ["reminders.json", "reminders"],
    ] as const) {
      const parsed = JSON.parse(await readFile(path.join(workspace, "data", file), "utf8")) as Record<string, unknown>;
      assert.equal(parsed.version, 1);
      assert.deepEqual(parsed[rootKey], []);
    }
    const crm = JSON.parse(await readFile(path.join(workspace, "data", "crm.json"), "utf8")) as { people: unknown[]; businesses: unknown[]; correspondence: unknown[] };
    assert.deepEqual(crm.people, []);
    assert.deepEqual(crm.businesses, []);
    assert.deepEqual(crm.correspondence, []);

    const addTodo = spawnBrainctl(["workspace", "run", "--path", workspace, "todo-add.js", "--", "--title", "Buy coffee"]);
    assert.equal(addTodo.status, 0, addTodo.stderr);
    const addTodoJson = JSON.parse(addTodo.stdout) as { details: { userFacingText?: string } };
    assert.match(addTodoJson.details.userFacingText ?? "", /Added todo: Buy coffee/);
    assert.match(addTodoJson.details.userFacingText ?? "", /main_loop: model=gpt-5\.5 effort=medium/);
    assert.match(addTodoJson.details.userFacingText ?? "", /Current todos:\n\n1\. Buy coffee/);
    assert.doesNotMatch(addTodoJson.details.userFacingText ?? "", /td_|createdAt|updatedAt|\{/);
    const todoList = spawnBrainctl(["workspace", "run", "--path", workspace, "todo-list.js"]);
    assert.equal(todoList.status, 0, todoList.stderr);
    const todoListJson = JSON.parse(todoList.stdout) as { details: { stdout: { todos: Array<{ title: string }> }; userFacingText?: string } };
    assert.equal(todoListJson.details.stdout.todos[0]?.title, "Buy coffee");
    assert.equal(todoListJson.details.userFacingText, "main_loop: model=gpt-5.5 effort=medium\n\nCurrent todos:\n\n1. Buy coffee");
    assert.doesNotMatch(todoListJson.details.userFacingText ?? "", /td_|createdAt|updatedAt|\{/);
    const deleteTodo = spawnBrainctl(["workspace", "run", "--path", workspace, "todo-delete.js", "--", "--number", "1"]);
    assert.equal(deleteTodo.status, 0, deleteTodo.stderr);
    const deleteTodoJson = JSON.parse(deleteTodo.stdout) as { details: { userFacingText?: string } };
    assert.match(deleteTodoJson.details.userFacingText ?? "", /Removed todo: Buy coffee/);
    assert.match(deleteTodoJson.details.userFacingText ?? "", /Current todos:\n\nNo todos\./);
    assert.doesNotMatch(deleteTodoJson.details.userFacingText ?? "", /td_|createdAt|updatedAt|\{/);

    const addProject = spawnBrainctl(["workspace", "run", "--path", workspace, "project-add.js", "--", "--name", "Parity Project"]);
    assert.equal(addProject.status, 0, addProject.stderr);
    const projectList = spawnBrainctl(["workspace", "run", "--path", workspace, "project-list.js"]);
    assert.equal(projectList.status, 0, projectList.stderr);
    const projectListJson = JSON.parse(projectList.stdout) as { details: { stdout: { projects: Array<{ name: string }> } } };
    assert.equal(projectListJson.details.stdout.projects[0]?.name, "Parity Project");

    const addPerson = spawnBrainctl(["workspace", "run", "--path", workspace, "crm-add-person.js", "--", "--name", "Jane Smith"]);
    assert.equal(addPerson.status, 0, addPerson.stderr);
    const people = spawnBrainctl(["workspace", "run", "--path", workspace, "crm-list-people.js"]);
    assert.equal(people.status, 0, people.stderr);
    const peopleJson = JSON.parse(people.stdout) as { details: { stdout: { people: Array<{ name: string }> } } };
    assert.equal(peopleJson.details.stdout.people[0]?.name, "Jane Smith");

    const addReminder = spawnBrainctl(["workspace", "run", "--path", workspace, "reminder-add.js", "--", "--title", "Weekly review", "--weekly", "friday", "--time", "17:00"]);
    assert.equal(addReminder.status, 0, addReminder.stderr);
    const reminderList = spawnBrainctl(["workspace", "run", "--path", workspace, "reminder-list.js"]);
    assert.equal(reminderList.status, 0, reminderList.stderr);
    const reminderListJson = JSON.parse(reminderList.stdout) as { details: { stdout: { reminders: Array<{ title: string }> } } };
    assert.equal(reminderListJson.details.stdout.reminders[0]?.title, "Weekly review");

    const sourceFile = path.join(root, "source.txt");
    await writeFile(sourceFile, "private source bytes\n");
    const saveFile = spawnBrainctl(["workspace", "run", "--path", workspace, "file-save.js", "--", "--source", sourceFile, "--title", "Source note", "--project", "Parity Project"]);
    assert.equal(saveFile.status, 0, saveFile.stderr);
    const fileList = spawnBrainctl(["workspace", "run", "--path", workspace, "file-list.js"]);
    assert.equal(fileList.status, 0, fileList.stderr);
    const fileListJson = JSON.parse(fileList.stdout) as { details: { stdout: { metadataPath: string; documents: Array<{ title: string; project: string }> } } };
    assert.equal(fileListJson.details.stdout.metadataPath, path.join(workspace, "private", "documents", "metadata.jsonl"));
    assert.equal(fileListJson.details.stdout.documents[0]?.title, "Source note");
    assert.equal(fileListJson.details.stdout.documents[0]?.project, "Parity Project");

    const addBet = spawnBrainctl(["workspace", "run", "--path", workspace, "bet-add.js", "--", "--date", "2026-05-26", "--market", "moneyline", "--side", "home", "--home", "Home", "--away", "Away", "--odds", "-110", "--units", "1"]);
    assert.equal(addBet.status, 0, addBet.stderr);
    const betList = spawnBrainctl(["workspace", "run", "--path", workspace, "bet-list.js"]);
    assert.equal(betList.status, 0, betList.stderr);
    const betListJson = JSON.parse(betList.stdout) as { details: { commandKind: string; stdout: { count: number; bets: Array<{ market: string }> } } };
    assert.equal(betListJson.details.commandKind, "vendored");
    assert.equal(betListJson.details.stdout.count, 1);
    assert.equal(betListJson.details.stdout.bets[0]?.market, "moneyline");

    const status = spawnBrainctl(["workspace", "status", "--path", workspace]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as {
      ok: boolean;
      details: {
        status: {
          ready: boolean;
          assistantLogicRoot: string;
          assistantLogicSource: string;
          deprecatedAssistantRepoIgnored: boolean;
          stateStores: Array<{ key: string; valid: boolean }>;
          fileSave: { ready: boolean; metadataPath: string };
          commands: Array<{ area: string; examples: string[] }>;
          scripts: Array<{ script: string; kind: string; path: string; present: boolean }>;
        };
      };
    };
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.details.status.ready, true);
    assert.equal(statusJson.details.status.assistantLogicRoot, assistantLogicPackage);
    assert.equal(statusJson.details.status.assistantLogicSource, "in-repo:@brain/assistant-logic");
    assert.equal(statusJson.details.status.deprecatedAssistantRepoIgnored, false);
    assert.ok(statusJson.details.status.scripts.every((script) => script.present && (script.path.startsWith(path.join(assistantLogicPackage, "dist", "cli")) || script.path.startsWith(path.join(assistantLogicPackage, "scripts")))));
    assert.ok(statusJson.details.status.scripts.some((script) => script.kind === "vendored" && script.script === "gmail-recent.js"));
    assert.ok(statusJson.details.status.scripts.some((script) => script.kind === "native" && script.script === "todo-add.js"));
    assert.ok(statusJson.details.status.stateStores.every((store) => store.valid));
    assert.equal(statusJson.details.status.fileSave.ready, true);
    assert.equal(statusJson.details.status.fileSave.metadataPath, path.join(workspace, "private", "documents", "metadata.jsonl"));
    assert.ok(statusJson.details.status.commands.map((command) => command.area).includes("gmail-email"));
    assert.ok(statusJson.details.status.commands.map((command) => command.area).includes("telegram-user-client-and-messaging"));
    assert.ok(statusJson.details.status.commands.map((command) => command.area).includes("whoop"));
    assert.ok(statusJson.details.status.commands.every((command) => command.examples.every((example) => !example.includes("--assistant-repo"))));

    const deprecatedOptionStatus = spawnBrainctl(["workspace", "status", "--path", workspace, "--assistant-repo", path.join(root, "missing-assistant-agent-logic")]);
    assert.equal(deprecatedOptionStatus.status, 0, deprecatedOptionStatus.stderr);
    const deprecatedOptionJson = JSON.parse(deprecatedOptionStatus.stdout) as { details: { status: { ready: boolean; assistantLogicRoot: string; deprecatedAssistantRepoIgnored: boolean } } };
    assert.equal(deprecatedOptionJson.details.status.ready, true);
    assert.equal(deprecatedOptionJson.details.status.assistantLogicRoot, assistantLogicPackage);
    assert.equal(deprecatedOptionJson.details.status.deprecatedAssistantRepoIgnored, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup status requires Codex auth for the service user", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-service-user-auth-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    await writeFile(config, testRuntimeConfig(workspace, backupRepo));

    const setup = spawnBrainctl(["setup", "--config", config, "--workspace", "personal", "--path", workspace]);
    assert.equal(setup.status, 0, setup.stderr);
    await writeFile(path.join(workspace, "config", "brain-personal.env"), `TELEGRAM_MAIN_CONFIG=${path.join(workspace, "secrets", "telegram-main.json")}\n`);

    const progressPath = path.join(workspace, "state", "setup-progress.json");
    const progress = {
      version: 1,
      workspace: "personal",
      workspaceRoot: workspace,
      updatedAt: new Date().toISOString(),
      completedSteps: ["workspace-scaffold", "runtime-config", "telegram-connection", "configure-verify-codex-auth"],
      statuses: {
        workspace: { configured: true },
        runtimeConfig: { valid: true },
        codexAuth: { status: "verified", metadataOnly: true, checkedAt: new Date().toISOString(), runAsUser: "root" },
        service: { installed: false, started: false, metadataOnly: true },
        telegramToken: { configured: true, metadataOnly: true, source: "file", checkedAt: new Date().toISOString() },
      },
      nextRecommendedStep: "install-start-service",
      secretValuesStored: false,
    };
    await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);

    const statusAsBrain = spawnBrainctl(["setup", "status", "--config", config, "--workspace", "personal", "--path", workspace, "--service-user", "brain"]);
    assert.equal(statusAsBrain.status, 0, statusAsBrain.stderr);
    const statusAsBrainJson = JSON.parse(statusAsBrain.stdout) as { details: { setupWizard: { nextIncompleteStep: { step: string; evidence: string[] } } } };
    assert.equal(statusAsBrainJson.details.setupWizard.nextIncompleteStep.step, "configure-verify-codex-auth");
    assert.ok(statusAsBrainJson.details.setupWizard.nextIncompleteStep.evidence.some((item) => /verified as root/.test(item) && /service user is brain/.test(item)));

    progress.statuses.codexAuth.runAsUser = "brain";
    await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
    const statusAfterBrainAuth = spawnBrainctl(["setup", "status", "--config", config, "--workspace", "personal", "--path", workspace, "--service-user", "brain"]);
    assert.equal(statusAfterBrainAuth.status, 0, statusAfterBrainAuth.stderr);
    const statusAfterBrainAuthJson = JSON.parse(statusAfterBrainAuth.stdout) as { details: { setupWizard: { nextIncompleteStep: { step: string } } } };
    assert.equal(statusAfterBrainAuthJson.details.setupWizard.nextIncompleteStep.step, "install-start-service");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup status uses systemd state for service resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-systemd-status-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    const bin = path.join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(config, testRuntimeConfig(workspace, backupRepo));
    const setup = spawnBrainctl(["setup", "--config", config, "--workspace", "personal", "--path", workspace]);
    assert.equal(setup.status, 0, setup.stderr);
    await writeFile(path.join(workspace, "config", "brain-personal.env"), `TELEGRAM_MAIN_CONFIG=${path.join(workspace, "secrets", "telegram-main.json")}\n`);
    await writeFile(path.join(bin, "systemctl"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "case \"$1\" in",
      "  show) printf 'loaded\\n' ;;",
      "  is-enabled) exit 0 ;;",
      "  is-active) exit 0 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"));
    await chmod(path.join(bin, "systemctl"), 0o700);

    const progressPath = path.join(workspace, "state", "setup-progress.json");
    const progress = {
      version: 1,
      workspace: "personal",
      workspaceRoot: workspace,
      updatedAt: new Date().toISOString(),
      completedSteps: ["workspace-scaffold", "runtime-config", "telegram-connection", "configure-verify-codex-auth"],
      statuses: {
        workspace: { configured: true },
        runtimeConfig: { valid: true },
        codexAuth: { status: "verified", metadataOnly: true, checkedAt: new Date().toISOString(), runAsUser: "brain" },
        service: { installed: false, started: false, metadataOnly: true },
        telegramToken: { configured: true, metadataOnly: true, source: "file", checkedAt: new Date().toISOString() },
      },
      nextRecommendedStep: "install-start-service",
      secretValuesStored: false,
    };
    await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);

    const status = spawnBrainctl(["setup", "status", "--config", config, "--workspace", "personal", "--path", workspace, "--service-user", "brain"], {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as { details: { service: { installed: boolean; enabled: boolean; active: boolean }; setupWizard: { nextIncompleteStep: { step: string; evidence: string[] }; completedSteps: Array<{ step: string }> } } };
    assert.equal(statusJson.details.service.installed, true);
    assert.equal(statusJson.details.service.enabled, true);
    assert.equal(statusJson.details.service.active, true);
    assert.ok(statusJson.details.setupWizard.completedSteps.some((step) => step.step === "install-start-service"));
    assert.equal(statusJson.details.setupWizard.nextIncompleteStep.step, "composio-accounts");
    assert.ok(statusJson.details.setupWizard.nextIncompleteStep.evidence.some((item) => /Gmail connected account/.test(item) && /Google Calendar connected account/.test(item)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup reset only removes setup progress metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-reset-"));
  try {
    const workspace = path.join(root, "workspace");
    const progress = path.join(workspace, "state", "setup-progress.json");
    const secretFile = path.join(workspace, "secrets", "secrets.env");
    const configFile = path.join(workspace, "config", "runtime.yaml");
    const logFile = path.join(workspace, "logs", "runtime.jsonl");
    const backupFile = path.join(workspace, "backups", "snapshot.txt");
    const documentFile = path.join(workspace, "documents", "note.txt");
    await mkdir(path.dirname(progress), { recursive: true });
    await mkdir(path.dirname(secretFile), { recursive: true });
    await mkdir(path.dirname(configFile), { recursive: true });
    await mkdir(path.dirname(logFile), { recursive: true });
    await mkdir(path.dirname(backupFile), { recursive: true });
    await mkdir(path.dirname(documentFile), { recursive: true });
    await writeFile(progress, `${JSON.stringify({ secret: "do-not-print-progress-content" })}\n`, { mode: 0o600 });
    await chmod(progress, 0o600);
    await writeFile(secretFile, "SECRET_VALUE=must-remain\n");
    await writeFile(configFile, "runtime config must remain\n");
    await writeFile(logFile, "log must remain\n");
    await writeFile(backupFile, "backup must remain\n");
    await writeFile(documentFile, "document must remain\n");

    const dryRun = spawnBrainctl(["setup", "reset", "--workspace", "personal", "--path", workspace, "--dry-run"]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.doesNotMatch(dryRun.stdout, /do-not-print-progress-content|SECRET_VALUE/);
    const dryJson = JSON.parse(dryRun.stdout) as { details: { path: string; previous: { present: boolean; mode: string; sizeBytes: number }; action: string; sideEffects: string } };
    assert.equal(dryJson.details.path, progress);
    assert.equal(dryJson.details.previous.present, true);
    assert.equal(dryJson.details.previous.mode, "0600");
    assert.ok(dryJson.details.previous.sizeBytes > 0);
    assert.equal(dryJson.details.action, "would_remove");
    assert.equal(dryJson.details.sideEffects, "none");
    assert.ok((await stat(progress)).isFile());

    const unconfirmed = spawnBrainctl(["setup", "reset", "--workspace", "personal", "--path", workspace]);
    assert.equal(unconfirmed.status, 0, unconfirmed.stderr);
    const unconfirmedJson = JSON.parse(unconfirmed.stdout) as { details: { action: string; skipped: string } };
    assert.equal(unconfirmedJson.details.action, "skipped");
    assert.match(unconfirmedJson.details.skipped, /--yes/);
    assert.ok((await stat(progress)).isFile());

    const reset = spawnBrainctl(["setup", "reset", "--workspace", "personal", "--path", workspace, "--yes"]);
    assert.equal(reset.status, 0, reset.stderr);
    const resetJson = JSON.parse(reset.stdout) as { details: { previous: { present: boolean; mode: string; sizeBytes: number }; action: string; scope: string; sideEffects: string } };
    assert.equal(resetJson.details.previous.present, true);
    assert.equal(resetJson.details.previous.mode, "0600");
    assert.equal(resetJson.details.action, "removed");
    assert.equal(resetJson.details.scope, "state/setup-progress.json only");
    assert.match(resetJson.details.sideEffects, /setup-progress\.json only/);
    await assert.rejects(stat(progress));
    assert.equal(await readFile(secretFile, "utf8"), "SECRET_VALUE=must-remain\n");
    assert.equal(await readFile(configFile, "utf8"), "runtime config must remain\n");
    assert.equal(await readFile(logFile, "utf8"), "log must remain\n");
    assert.equal(await readFile(backupFile, "utf8"), "backup must remain\n");
    assert.equal(await readFile(documentFile, "utf8"), "document must remain\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup defaults renders concise remote choices and persists ignored remote context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-defaults-"));
  try {
    await initRepoWithPrivateIgnore(root);

    const result = spawnBrainctl(["setup", "defaults", "--target", "remote", "--workspace", "personal", "--repo", root]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      details: {
        decisions: Array<{ decision: string; default: string }>;
        safety: string[];
        setupFlow: { coreSteps: Array<{ step: string; prompt: string }>; orderingNotes: string[] };
        localSetupContext: { wrote: boolean; path: string; mode: string; git: { ignored: boolean; tracked: boolean } };
        advanced?: unknown;
      };
    };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.details.decisions.map((item) => item.decision), ["Setup mode", "Remote SSH host", "Initial remote SSH user", "Future remote SSH user", "Source checkout", "Private workspace", "Initial workspace"]);
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Remote SSH host")?.default, "ask: server IP or DNS name");
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Initial remote SSH user")?.default, "root");
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Future remote SSH user")?.default, "brain");
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Source checkout")?.default, "/home/brain/brain");
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Private workspace")?.default, "/home/brain/.brain/workspace");
    assert.deepEqual(parsed.details.setupFlow.coreSteps.map((item) => item.step), ["essential-runtime-choices", "configure-verify-codex-auth", "telegram-connection", "personal-workspace", "private-data-repo", "openai-transcription", "composio-accounts"]);
    assert.ok(parsed.details.setupFlow.orderingNotes.some((item) => /provider is Codex/.test(item)));
    assert.ok(parsed.details.setupFlow.orderingNotes.some((item) => /Codex auth before starting the service/.test(item)));
    assert.ok(parsed.details.setupFlow.orderingNotes.some((item) => /assistant-agent-data/.test(item) && /not Brain/.test(item)));
    assert.ok(parsed.details.safety.some((item) => /outside git/.test(item)));
    assert.equal(parsed.details.localSetupContext.wrote, true);
    assert.equal(parsed.details.localSetupContext.mode, "0600");
    assert.equal(parsed.details.localSetupContext.git.ignored, true);
    assert.equal(parsed.details.localSetupContext.git.tracked, false);
    assert.equal(parsed.details.advanced, undefined);
    assert.doesNotMatch(result.stdout, /serviceUser|serviceName|secretsEnv|runtimeConfig|pnpm caveat|package manager|srv\/brain/);

    const contextPath = path.join(root, "private", "setup-context.json");
    const context = JSON.parse(await readFile(contextPath, "utf8")) as { target: string; workspaceRoot: string; repoPath: string; sshHost?: string; sshUser: string; bootstrapSshUser?: string; secretValuesStored: boolean };
    assert.equal(context.target, "remote");
    assert.equal(context.workspaceRoot, "/home/brain/.brain/workspace");
    assert.equal(context.repoPath, "/home/brain/brain");
    assert.equal(context.sshHost, undefined);
    assert.equal(context.sshUser, "brain");
    assert.equal(context.bootstrapSshUser, "root");
    assert.equal(context.secretValuesStored, false);
    assert.equal((await stat(contextPath)).mode & 0o777, 0o600);

    const verbose = spawnBrainctl(["setup", "defaults", "--target", "remote", "--workspace", "personal", "--repo", root, "--ssh-host", "203.0.113.10", "--ssh-user", "ubuntu", "--verbose"]);
    assert.equal(verbose.status, 0, verbose.stderr);
    const verboseJson = JSON.parse(verbose.stdout) as { details: { decisions: Array<{ decision: string; default: string }>; advanced: { ssh: { host: string; user: string }; serviceUser: string; serviceName: string; paths: { runtimeConfig: string; secretsEnv: string } } } };
    assert.equal(verboseJson.details.decisions.find((item) => item.decision === "Remote SSH host")?.default, "203.0.113.10");
    assert.equal(verboseJson.details.decisions.find((item) => item.decision === "Initial remote SSH user")?.default, "ubuntu");
    assert.equal(verboseJson.details.decisions.find((item) => item.decision === "Future remote SSH user")?.default, "ubuntu");
    assert.deepEqual(verboseJson.details.advanced.ssh, { host: "203.0.113.10", user: "ubuntu" });
    assert.equal(verboseJson.details.advanced.serviceUser, "brain");
    assert.equal(verboseJson.details.advanced.serviceName, "codex-chat.service");
    assert.equal(verboseJson.details.advanced.paths.runtimeConfig, "/home/brain/.brain/workspace/config/runtime.yaml");
    assert.equal(verboseJson.details.advanced.paths.secretsEnv, "/home/brain/.brain/workspace/secrets/secrets.env");

    const updatedContext = JSON.parse(await readFile(contextPath, "utf8")) as { sshHost: string; sshUser: string };
    assert.equal(updatedContext.sshHost, "203.0.113.10");
    assert.equal(updatedContext.sshUser, "ubuntu");

    const status = spawnBrainctl(["setup", "status", "--repo", root, "--workspace", "personal"]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as { summary: string; details: { localSetupContext: { present: boolean }; resumeProbe: { command: string } } };
    assert.match(statusJson.summary, /prior remote setup context found/);
    assert.equal(statusJson.details.localSetupContext.present, true);
    assert.match(statusJson.details.resumeProbe.command, /ssh ubuntu@203\.0\.113\.10/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup refuses remote context writes when private path is not git-ignored", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-unsafe-context-"));
  try {
    const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    const result = spawnBrainctl(["setup", "defaults", "--target", "remote", "--workspace", "personal", "--repo", root, "--ssh-host", "brain-prod"]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; summary: string; details: { localSetupContext: { wrote: boolean; skipped: string; git: { ignored: boolean; tracked: boolean } } } };
    assert.equal(parsed.ok, false);
    assert.match(parsed.summary, /not persisted safely/);
    assert.equal(parsed.details.localSetupContext.wrote, false);
    assert.match(parsed.details.localSetupContext.skipped, /not ignored by git/);
    assert.equal(parsed.details.localSetupContext.git.ignored, false);
    assert.equal(parsed.details.localSetupContext.git.tracked, false);
    await assert.rejects(stat(path.join(root, "private", "setup-context.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup --target remote writes only local resume context and not remote workspace dirs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-remote-target-"));
  try {
    await initRepoWithPrivateIgnore(root);
    const remoteWorkspace = path.join(root, "remote-workspace");
    const result = spawnBrainctl(["setup", "--target", "remote", "--workspace", "personal", "--repo", root, "--ssh-host", "brain-prod", "--ssh-user", "ubuntu", "--path", remoteWorkspace]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; summary: string; details: { localSetupContext: { wrote: boolean; context: { target: string; workspaceRoot: string; sshHost: string; sshUser: string } }; sideEffects: string } };
    assert.equal(parsed.ok, true);
    assert.match(parsed.summary, /remote setup context persisted/);
    assert.equal(parsed.details.localSetupContext.wrote, true);
    assert.equal(parsed.details.localSetupContext.context.target, "remote");
    assert.equal(parsed.details.localSetupContext.context.workspaceRoot, remoteWorkspace);
    assert.equal(parsed.details.localSetupContext.context.sshHost, "brain-prod");
    assert.equal(parsed.details.localSetupContext.context.sshUser, "ubuntu");
    assert.match(parsed.details.sideEffects, /setup-context\.json/);
    await assert.rejects(stat(remoteWorkspace));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl setup remote-bootstrap rewrites root bootstrap context to service-user SSH", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-setup-remote-bootstrap-"));
  try {
    await initRepoWithPrivateIgnore(root);
    const bin = path.join(root, "bin");
    const sshLog = path.join(root, "ssh-log.jsonl");
    const sshConfig = path.join(root, "ssh-config");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "ssh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `log=${shellTestLiteral(sshLog)}`,
      "dest=${1:-}",
      "cmd=${2:-}",
      "script=''",
      'if [ "$cmd" = "bash -s" ]; then script=$(cat); fi',
      `printf '{"dest":%s,"cmd":%s,"script":%s}\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$dest")" "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$cmd")" "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$script")" >> "$log"`,
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(path.join(bin, "ssh"), 0o700);

    const result = spawnBrainctl([
      "setup", "remote-bootstrap",
      "--workspace", "personal",
      "--repo", root,
      "--ssh-host", "204.168.209.41",
      "--ssh-user", "root",
      "--service-user", "brain",
      "--ssh-config", sshConfig,
      "--ssh-alias", "brain-prod",
    ], { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; details: { initialSsh: { destination: string; scope: string }; futureSsh: { destination: string }; serviceValidationCommand: string; workspaceParent: string; localSetupContext: { context: { sshUser: string; bootstrapSshUser: string } }; sshConfig: { wrote: boolean; alias: string } } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.details.initialSsh.destination, "root@204.168.209.41");
    assert.equal(parsed.details.initialSsh.scope, "one-time-bootstrap");
    assert.equal(parsed.details.futureSsh.destination, "brain@204.168.209.41");
    assert.equal(parsed.details.workspaceParent, "/home/brain/.brain");
    assert.match(parsed.details.serviceValidationCommand, /workspace parent is not writable by brain: \/home\/brain\/\.brain/);
    assert.equal(parsed.details.localSetupContext.context.sshUser, "brain");
    assert.equal(parsed.details.localSetupContext.context.bootstrapSshUser, "root");
    assert.equal(parsed.details.sshConfig.wrote, true);
    assert.equal(parsed.details.sshConfig.alias, "brain-prod");

    const context = JSON.parse(await readFile(path.join(root, "private", "setup-context.json"), "utf8")) as { sshHost: string; sshUser: string; bootstrapSshUser: string; repoPath: string; workspaceRoot: string };
    assert.equal(context.sshHost, "204.168.209.41");
    assert.equal(context.sshUser, "brain");
    assert.equal(context.bootstrapSshUser, "root");
    assert.equal(context.repoPath, "/home/brain/brain");
    assert.equal(context.workspaceRoot, "/home/brain/.brain/workspace");

    const sshConfigText = await readFile(sshConfig, "utf8");
    assert.match(sshConfigText, /Host brain-prod/);
    assert.match(sshConfigText, /HostName 204\.168\.209\.41/);
    assert.match(sshConfigText, /User brain/);
    assert.doesNotMatch(sshConfigText, /User root/);

    const sshLogText = await readFile(sshLog, "utf8");
    const sshCalls = sshLogText.trim().split("\n").map((line) => JSON.parse(line) as { dest: string; cmd: string; script: string });
    const bootstrapCall = sshCalls.find((call) => call.dest === "root@204.168.209.41" && call.cmd === "bash -s");
    assert.ok(bootstrapCall);
    assert.match(bootstrapCall.script, /workspace_parent='\/home\/brain\/\.brain'/);
    assert.match(bootstrapCall.script, /install -d -o "\$service_user" -g "\$service_group" -m 700 "\$workspace_parent"/);
    assert.match(bootstrapCall.script, /chown "\$service_user:\$service_group" "\$workspace_parent" "\$workspace_root"/);
    assert.match(bootstrapCall.script, /validate_as_service_user "write workspace parent \$workspace_parent" test -w "\$workspace_parent"/);
    const validationCall = sshCalls.find((call) => call.dest === "brain@204.168.209.41");
    assert.ok(validationCall);
    assert.match(validationCall.cmd, /workspace parent is not writable by brain: \/home\/brain\/\.brain/);
    assert.match(sshLogText, /root@204\.168\.209\.41/);
    assert.match(sshLogText, /brain@204\.168\.209\.41/);
    assert.match(sshLogText, /useradd --create-home/);
    assert.match(sshLogText, /authorized_keys/);
    assert.match(sshLogText, /\/home\/brain\/brain/);
    assert.match(sshLogText, /\/home\/brain\/\.brain\/workspace/);

    const status = spawnBrainctl(["setup", "status", "--repo", root, "--workspace", "personal"]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as { details: { resumeProbe: { command: string; sshUser: string; bootstrapSshUser: string } } };
    assert.match(statusJson.details.resumeProbe.command, /ssh brain@204\.168\.209\.41/);
    assert.doesNotMatch(statusJson.details.resumeProbe.command, /root@204\.168\.209\.41/);
    assert.equal(statusJson.details.resumeProbe.sshUser, "brain");
    assert.equal(statusJson.details.resumeProbe.bootstrapSshUser, "root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl backup, web setup, and Composio status are safe and metadata-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-optional-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    await writeFile(config, testRuntimeConfig(workspace, backupRepo, { composioEnabled: true, webEnabled: true }));
    await mkdir(workspace, { recursive: true });

    const plan = spawnBrainctl(["backup", "plan", "--config", config, "--workspace", "personal"]);
    assert.equal(plan.status, 0, plan.stderr);
    const planJson = JSON.parse(plan.stdout) as { ok: boolean; details: { plan: { config: { strategy: string; privateGit: { include: string[]; exclude: string[] } }; dryRunDefault: boolean } } };
    assert.equal(planJson.ok, true);
    assert.equal(planJson.details.plan.config.strategy, "private-git");
    assert.equal(planJson.details.plan.dryRunDefault, true);
    assert.ok(planJson.details.plan.config.privateGit.include.includes("data/**"));
    assert.ok(planJson.details.plan.config.privateGit.include.includes("instructions/**"));
    assert.ok(planJson.details.plan.config.privateGit.include.includes("tasks/**"));
    assert.ok(planJson.details.plan.config.privateGit.include.includes("private/documents/metadata.jsonl"));
    assert.ok(planJson.details.plan.config.privateGit.include.includes(".claude/repo-registry/index.yaml"));
    assert.ok(planJson.details.plan.config.privateGit.exclude.includes("secrets/**"));
    assert.ok(planJson.details.plan.config.privateGit.exclude.includes("private/documents/files/**"));

    const init = spawnBrainctl(["backup", "init", "--config", config, "--workspace", "personal", "--apply"]);
    assert.equal(init.status, 0, init.stderr);
    const initJson = JSON.parse(init.stdout) as { ok: boolean; details: { init: { wroteGitignore: boolean; initializedRepo: boolean } } };
    assert.equal(initJson.ok, true);
    assert.equal(initJson.details.init.wroteGitignore, true);
    assert.equal(initJson.details.init.initializedRepo, true);

    const status = spawnBrainctl(["backup", "status", "--config", config, "--workspace", "personal"]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as { ok: boolean; details: { status: { git: { present: boolean; status: { filenamesPrinted: boolean } } } } };
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.details.status.git.present, true);
    assert.equal(statusJson.details.status.git.status.filenamesPrinted, false);

    const web = spawnBrainctl(["web", "status", "--config", config, "--workspace", "personal", "--base-url", "http://127.0.0.1/pages", "--publish-root", path.join(root, "pages")]);
    assert.equal(web.status, 0, web.stderr);
    const webJson = JSON.parse(web.stdout) as { ok: boolean; details: { dns: { needed: string; changed: boolean }; dnsChanged: boolean } };
    assert.equal(webJson.ok, true);
    assert.equal(webJson.details.dns.needed, "not-needed-for-direct-IP");
    assert.equal(webJson.details.dnsChanged, false);
    assert.equal(webJson.details.dns.changed, false);

    const secretValue = "composio-secret-value-must-not-print";
    const composio = spawnBrainctl(["composio", "status", "--config", config, "--workspace", "personal"], { COMPOSIO_API_KEY: secretValue });
    assert.equal(composio.status, 0, composio.stderr);
    assert.doesNotMatch(composio.stdout, new RegExp(secretValue));
    const composioJson = JSON.parse(composio.stdout) as { ok: boolean; details: { enabled: boolean; refs: Array<{ kind: string; present: boolean; value: string }>; credentialsUsed: boolean; secretValuesPrinted: boolean } };
    assert.equal(composioJson.ok, true);
    assert.equal(composioJson.details.enabled, true);
    assert.equal(composioJson.details.credentialsUsed, false);
    assert.equal(composioJson.details.secretValuesPrinted, false);
    assert.ok(composioJson.details.refs.some((ref) => ref.kind === "env" && ref.present && ref.value === "redacted"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl registry init generates a stack-ready generic registry idempotently and backs up changed input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-registry-init-"));
  try {
    const brainRepo = path.join(root, "control-plane-checkout");
    const serviceHome = path.join(root, "service-home");
    const workspace = path.join(root, "private-workspace");
    const setupContext = path.join(root, "setup-context.json");
    const registry = path.join(workspace, ".claude", "repo-registry", "index.yaml");
    await mkdir(brainRepo, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(setupContext, `${JSON.stringify({
      version: 1,
      target: "local",
      workspace: "generic",
      workspaceRoot: workspace,
      serviceUser: "servant",
      repoPath: path.join(serviceHome, "brain"),
      configPath: path.join(workspace, "config", "runtime.yaml"),
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const initArgs = (codexRef = "main") => [
      "registry", "init",
      "--repo", brainRepo,
      "--setup-context", setupContext,
      "--workspace", "generic",
      "--service-home", serviceHome,
      "--brain-remote", "https://git.example.test/acme/brain.git",
      "--codex-chat-remote", "https://git.example.test/acme/codex-chat.git",
      "--codex-chat-ref", codexRef,
      "--assistant-logic-remote", "https://git.example.test/acme/assistant-agent-logic.git",
      "--assistant-data-remote", "ssh://git@git.example.test/acme/assistant-agent-data.git",
      "--deploy-host", "local",
      "--runtime-user", "servant",
    ];

    const first = spawnBrainctl(initArgs());
    assert.equal(first.status, 0, first.stderr);
    const firstJson = JSON.parse(first.stdout) as {
      ok: boolean;
      details: { registryPath: string; changed: boolean; backupPath?: string; unresolvedRemotes: string[]; validation: { stackReady: boolean; missing: string[] } };
    };
    assert.equal(firstJson.ok, true);
    assert.equal(firstJson.details.registryPath, registry);
    assert.equal(firstJson.details.changed, true);
    assert.equal(firstJson.details.backupPath, undefined);
    assert.deepEqual(firstJson.details.unresolvedRemotes, []);
    assert.equal(firstJson.details.validation.stackReady, true);
    assert.deepEqual(firstJson.details.validation.missing, []);

    const firstContents = await readFile(registry, "utf8");
    const parsed = YAML.parse(firstContents) as {
      controller_root: string;
      repos: Record<string, {
        path: string;
        remote_url: string;
        current_branch: string;
        apps?: {
          "codex-chat"?: { environments: { production: { deploy: Record<string, unknown>; health_checks: Array<{ command: string }> } } };
          "brain-admin"?: { environments: { production: { deploy: Record<string, unknown>; health_checks: Array<{ command: string }> } } };
        };
      }>;
    };
    assert.equal(parsed.controller_root, serviceHome);
    assert.deepEqual(Object.keys(parsed.repos).sort(), ["assistant-agent-data", "assistant-agent-logic", "brain", "codex-chat"]);
    assert.equal(parsed.repos.brain?.remote_url, "https://git.example.test/acme/brain.git");
    assert.equal(parsed.repos["assistant-agent-logic"]?.current_branch, "main");
    assert.equal(parsed.repos["assistant-agent-data"]?.path, path.join(serviceHome, "assistant-agent-data"));
    const deploy = parsed.repos["codex-chat"]?.apps?.["codex-chat"]?.environments.production.deploy;
    assert.equal(deploy?.host, "local");
    assert.equal(deploy?.path, path.join(serviceHome, "codex-chat"));
    assert.equal(deploy?.service, "codex-chat.service");
    assert.equal(deploy?.runtime_user, "servant");
    assert.equal(deploy?.env_file, path.join(workspace, "config", "codex-chat.env"));
    assert.equal(deploy?.config_path, path.join(workspace, "config", "codex-chat.toml"));
    assert.equal(deploy?.capability_store_path, path.join(serviceHome, ".brain", "control-plane", "capabilities.json"));
    assert.equal(deploy?.ipc_socket_path, path.join(workspace, "state", "run", "codex-chat.sock"));
    assert.match(parsed.repos["codex-chat"]?.apps?.["codex-chat"]?.environments.production.health_checks[0]?.command ?? "", /brainctl canary/);
    const brainAdminDeploy = parsed.repos.brain?.apps?.["brain-admin"]?.environments.production.deploy;
    assert.equal(brainAdminDeploy?.service, "brain-admin.service");
    assert.equal(brainAdminDeploy?.runtime_user, "servant");
    assert.equal(brainAdminDeploy?.env_file, path.join(workspace, "config", "brain-admin.env"));
    assert.equal(brainAdminDeploy?.bind_host, "127.0.0.1");
    assert.equal(brainAdminDeploy?.port, 49347);
    assert.match(parsed.repos.brain?.apps?.["brain-admin"]?.environments.production.health_checks[0]?.command ?? "", /127\.0\.0\.1:49347\/healthz/);
    assert.ok(Object.values(parsed.repos).every((repo) => repo.remote_url.includes("git.example.test/acme/")));
    assert.doesNotMatch(firstContents, new RegExp(escapeRegExp(userInfo().homedir)));

    const status = spawnBrainctl(["stack", "status", "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "generic"]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as { ok: boolean; details: { missing: string[]; assistantLogic: { present: boolean }; assistantData: { present: boolean; workspacePath: string }; servantRuntime: { present: boolean } } };
    assert.equal(statusJson.ok, true);
    assert.deepEqual(statusJson.details.missing, []);
    assert.equal(statusJson.details.servantRuntime.present, true);
    assert.equal(statusJson.details.assistantLogic.present, true);
    assert.equal(statusJson.details.assistantData.present, true);
    assert.equal(statusJson.details.assistantData.workspacePath, workspace);

    const second = spawnBrainctl(initArgs());
    assert.equal(second.status, 0, second.stderr);
    const secondJson = JSON.parse(second.stdout) as { details: { changed: boolean; backupPath?: string } };
    assert.equal(secondJson.details.changed, false);
    assert.equal(secondJson.details.backupPath, undefined);
    assert.equal(await readFile(registry, "utf8"), firstContents);
    assert.deepEqual((await readdir(path.dirname(registry))).filter((name) => name.includes(".backup-")), []);

    const changed = spawnBrainctl(initArgs("stable"));
    assert.equal(changed.status, 0, changed.stderr);
    const changedJson = JSON.parse(changed.stdout) as { details: { changed: boolean; backupPath?: string } };
    assert.equal(changedJson.details.changed, true);
    assert.ok(changedJson.details.backupPath);
    assert.equal(await readFile(changedJson.details.backupPath!, "utf8"), firstContents);
    const changedParsed = YAML.parse(await readFile(registry, "utf8")) as { repos: Record<string, { current_branch: string }> };
    assert.equal(changedParsed.repos["codex-chat"]?.current_branch, "stable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack status and plan resolve servant runtime control-plane metadata without network or secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const registry = path.join(root, "registry.yaml");
    const setupContext = path.join(root, "setup-context.json");
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await writeFile(registry, stackRegistryFixture({ assistantData }));
    await writeFile(setupContext, `${JSON.stringify({
      version: 1,
      target: "remote",
      workspace: "personal",
      workspaceRoot: "/srv/brain/workspace",
      sshHost: "brain.example.test",
      sshUser: "brain",
      serviceUser: "brain",
      repoPath: "/srv/brain/control-plane",
      configPath: "/srv/brain/workspace/config/runtime.yaml",
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const secretValue = "super-secret-stack-value";
    const status = spawnBrainctl(["stack", "status", "--registry", registry, "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "personal"], {
      TELEGRAM_BOT_TOKEN: secretValue,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, new RegExp(secretValue));
    const statusJson = JSON.parse(status.stdout) as {
      ok: boolean;
      details: {
        role: string;
        dryRun: boolean;
        networkAccess: boolean;
        sideEffects: string;
        secretValuesPrinted: boolean;
        servantRuntime: { repoName: string; deploy: { sshIdentity: string; serviceName: string; envFile: string; configPath: string; envVars: string[]; expectedTelegramBot?: { id?: string; username?: string } } };
        brainAdmin: { serviceName: string; runtimeUser: string; envFile: string; bindHost: string; port: number; ownerAdminEmail: string; readiness: string; capabilityStorePath: string; ipcSocketPath: string; auditLogPath: string };
        assistantLogic: { alias: string; repoName: string; path: string };
        assistantData: { workspacePath: string; promptRequired: boolean; migrationPlaceholder: string };
        servicePaths: { deployHost: string; sshIdentity: string; envFile: string; configPath: string; setupContextConfigPath: string };
        secretMetadataChecks: Array<{ kind: string; value: string; metadataOnly: boolean; plannedCheck: string }>;
        deploymentMetadata: { canonical: { sourceOfTruth: string; path: string; relativePath: string; note: string }; read: { attempted: boolean; plannedReadCommand: string }; localProjectNotesAreSecondary: boolean };
        repoBoundaries: { ok: boolean; policy: string[] };
        missing: string[];
      };
    };
    assert.equal(statusJson.ok, true);
    assert.match(statusJson.details.role, /control plane/);
    assert.equal(statusJson.details.dryRun, true);
    assert.equal(statusJson.details.networkAccess, false);
    assert.equal(statusJson.details.sideEffects, "none");
    assert.equal(statusJson.details.secretValuesPrinted, false);
    assert.equal(statusJson.details.servantRuntime.repoName, "codex-chat");
    assert.equal(statusJson.details.servantRuntime.deploy.sshIdentity, "codex@app.example.test");
    assert.equal(statusJson.details.servantRuntime.deploy.serviceName, "codex-chat.service");
    assert.equal(statusJson.details.servantRuntime.deploy.envFile, "/etc/codex-chat/env");
    assert.equal(statusJson.details.servantRuntime.deploy.configPath, "/etc/codex-chat/codex-chat.toml");
    assert.deepEqual(statusJson.details.servantRuntime.deploy.envVars, ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY"]);
    assert.deepEqual(statusJson.details.servantRuntime.deploy.expectedTelegramBot, { id: "1234567890", username: "ExampleServantBot" });
    assert.equal(statusJson.details.brainAdmin.serviceName, "brain-admin.service");
    assert.equal(statusJson.details.brainAdmin.runtimeUser, "codex");
    assert.equal(statusJson.details.brainAdmin.envFile, "/srv/brain/workspace/config/brain-admin.env");
    assert.equal(statusJson.details.brainAdmin.bindHost, "127.0.0.1");
    assert.equal(statusJson.details.brainAdmin.port, 49347);
    assert.equal(statusJson.details.brainAdmin.ownerAdminEmail, "owner@example.test");
    assert.equal(statusJson.details.brainAdmin.readiness, "ready-for-secret-fill");
    assert.equal(statusJson.details.brainAdmin.auditLogPath, "/home/codex/.brain/control-plane/audit.jsonl");
    assert.equal(statusJson.details.assistantLogic.alias, "assistant-claude");
    assert.equal(statusJson.details.assistantLogic.repoName, "assistant-agent-logic");
    assert.equal(statusJson.details.assistantLogic.path, "/srv/src/assistant-agent-logic");
    assert.equal(statusJson.details.assistantData.workspacePath, "/srv/brain/workspace");
    assert.equal(statusJson.details.assistantData.promptRequired, true);
    assert.match(statusJson.details.assistantData.migrationPlaceholder, /do not auto-migrate/);
    assert.equal(statusJson.details.servicePaths.deployHost, "app.example.test");
    assert.equal(statusJson.details.servicePaths.sshIdentity, "codex@app.example.test");
    assert.equal(statusJson.details.servicePaths.setupContextConfigPath, "/srv/brain/workspace/config/runtime.yaml");
    assert.equal(statusJson.details.repoBoundaries.ok, true);
    assert.ok(statusJson.details.repoBoundaries.policy.some((line) => /codex-chat is the servant runtime/.test(line)));
    assert.equal(statusJson.details.deploymentMetadata.canonical.sourceOfTruth, "remote-brain-workspace");
    assert.equal(statusJson.details.deploymentMetadata.canonical.path, "/srv/brain/workspace/state/control-plane/deployments.json");
    assert.equal(statusJson.details.deploymentMetadata.canonical.relativePath, "state/control-plane/deployments.json");
    assert.match(statusJson.details.deploymentMetadata.canonical.note, /repo-registry\/local notes are secondary/);
    assert.equal(statusJson.details.deploymentMetadata.read.attempted, false);
    assert.match(statusJson.details.deploymentMetadata.read.plannedReadCommand, /ssh brain@brain\.example\.test/);
    assert.equal(statusJson.details.deploymentMetadata.localProjectNotesAreSecondary, true);
    assert.deepEqual(statusJson.details.missing, []);
    assert.ok(statusJson.details.secretMetadataChecks.every((check) => check.value === "redacted" && check.metadataOnly));
    assert.ok(statusJson.details.secretMetadataChecks.some((check) => check.plannedCheck.includes("stat -c") && check.plannedCheck.includes("/etc/codex-chat/env")));
    assert.ok(statusJson.details.secretMetadataChecks.some((check) => check.kind === "env" && check.plannedCheck.includes("grep -qE")));
    assert.ok(statusJson.details.secretMetadataChecks.some((check) => check.kind === "telegram-getMe" && check.plannedCheck.includes("BRAIN_EXPECTED_BOT_USERNAME=ExampleServantBot")));

    const plan = spawnBrainctl(["stack", "plan", "--registry", registry, "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "personal"], {
      TELEGRAM_BOT_TOKEN: secretValue,
    });
    assert.equal(plan.status, 0, plan.stderr);
    assert.doesNotMatch(plan.stdout, new RegExp(secretValue));
    const planJson = JSON.parse(plan.stdout) as {
      ok: boolean;
      details: {
        dryRun: boolean;
        networkAccess: boolean;
        sideEffects: string;
        secretValuesPrinted: boolean;
        plan: { mode: string; steps: Array<{ id: string; commands?: string[]; prompts?: string[]; migrationPlaceholder?: string; target?: Record<string, string>; status?: string; renderedEnvPreview?: string; renderedUnitPreview?: string; capabilityStorePath?: string; ipcSocketPath?: string; auditLogPath?: string; ownerAdminEmail?: string }>; execution: { actions: Array<{ id: string; executor: string; requiredGate: string; displayCommand?: string }> }; forbidden: string[] };
      };
    };
    assert.equal(planJson.ok, true);
    assert.equal(planJson.details.dryRun, true);
    assert.equal(planJson.details.networkAccess, false);
    assert.equal(planJson.details.sideEffects, "none");
    assert.equal(planJson.details.secretValuesPrinted, false);
    assert.equal(planJson.details.plan.mode, "dry-run/no-network");
    const steps = new Map(planJson.details.plan.steps.map((step) => [step.id, step]));
    assert.ok(steps.get("clone-update-codex-chat")?.commands?.some((command) => /git clone .*codex-chat/.test(command) && /BRAIN_REPO_SHA/.test(command)));
    assert.ok(steps.get("clone-update-assistant-agent-logic")?.commands?.some((command) => /assistant-agent-logic/.test(command)));
    assert.ok(steps.get("install-assistant-agent-logic-deps")?.commands?.some((command) => /package-lock\.json/.test(command) && /npm ci/.test(command)));
    assert.ok(steps.get("install-assistant-agent-logic-deps")?.commands?.some((command) => /BRAIN_COMPOSIO_WORKFLOW_DEPS/.test(command) && /gmail-recent\.js/.test(command)));
    assert.ok(steps.get("assistant-data-workspace")?.prompts?.some((prompt) => /pull existing private repo/.test(prompt)));
    assert.match(steps.get("assistant-data-workspace")?.migrationPlaceholder ?? "", /do not auto-migrate/);
    assert.ok(steps.get("render-codex-chat-config-env")?.target?.envFile);
    assert.doesNotMatch(steps.get("render-codex-chat-config-env")?.renderedEnvPreview ?? "", new RegExp(secretValue));
    assert.equal(steps.get("render-brain-admin-env-unit")?.capabilityStorePath, statusJson.details.brainAdmin.capabilityStorePath);
    assert.equal(steps.get("render-brain-admin-env-unit")?.ipcSocketPath, statusJson.details.brainAdmin.ipcSocketPath);
    assert.equal(steps.get("render-brain-admin-env-unit")?.auditLogPath, "/home/codex/.brain/control-plane/audit.jsonl");
    assert.equal(steps.get("render-brain-admin-env-unit")?.ownerAdminEmail, "owner@example.test");
    assert.match(steps.get("render-brain-admin-env-unit")?.renderedEnvPreview ?? "", /CLERK_PUBLISHABLE_KEY=<redacted:set-on-server-with-one-use-helper>/);
    assert.match(steps.get("render-brain-admin-env-unit")?.renderedUnitPreview ?? "", /\/etc\/systemd\/system|WantedBy=multi-user\.target/);
    assert.ok(steps.get("migrate-telegram-pairing-state")?.commands?.some((command) => command.includes("state/telegram-pairing") && command.includes("state/codex-chat")));
    assert.ok(steps.get("install-start-codex-chat-service")?.commands?.some((command) => /systemctl disable --now brain-personal\.service/.test(command)));
    assert.ok(steps.get("install-start-codex-chat-service")?.commands?.some((command) => /systemctl enable codex-chat\.service.*systemctl restart codex-chat\.service/.test(command)));
    assert.ok(steps.get("record-deployment-metadata")?.target?.path.includes("state/control-plane/deployments.json"));
    assert.ok(steps.get("health-check-codex-chat")?.commands?.some((command) => /codex-chat health --json/.test(command)));
    assert.ok(planJson.details.plan.execution.actions.some((action) => action.id === "clone-update-codex-chat-deploy" && action.executor === "ssh" && /ssh codex@app\.example\.test/.test(action.displayCommand ?? "")));
    assert.ok(planJson.details.plan.execution.actions.some((action) => action.id === "install-assistant-agent-logic-deps" && action.executor === "ssh" && /ssh dev\.example\.test/.test(action.displayCommand ?? "") && /BRAIN_COMPOSIO_WORKFLOW_DEPS/.test(action.displayCommand ?? "")));
    assert.ok(planJson.details.plan.execution.actions.some((action) => action.id === "migrate-telegram-pairing-state" && /BRAIN_PAIRING_MIGRATION/.test(action.displayCommand ?? "") && /rawIdentifiersPrinted=false/.test(action.displayCommand ?? "")));
    assert.ok(planJson.details.plan.execution.actions.some((action) => action.id === "install-codex-chat-systemd" && /BRAIN_EXPECTED_BOT_USERNAME=ExampleServantBot/.test(action.displayCommand ?? "") && /systemctl restart codex-chat\.service/.test(action.displayCommand ?? "")));
    assert.ok(planJson.details.plan.execution.actions.some((action) => action.id === "render-brain-admin-env-unit" && action.requiredGate === "config" && /CLERK_ALLOWED_EMAILS=owner@example\.test/.test(action.displayCommand ?? "")));
    assert.ok(planJson.details.plan.execution.actions.some((action) => action.id === "install-brain-admin-systemd" && action.requiredGate === "service" && /CLERK_PUBLISHABLE_KEY/.test(action.displayCommand ?? "") && /systemctl enable brain-admin\.service.*systemctl restart brain-admin\.service/.test(action.displayCommand ?? "")));
    assert.ok(planJson.details.plan.execution.actions.some((action) => action.id === "health-check-brain-admin" && action.requiredGate === "health" && /127\.0\.0\.1:49347\/healthz/.test(action.displayCommand ?? "")));
    assert.ok(planJson.details.plan.execution.actions.some((action) => action.id === "assistant-agent-data-clone-or-init-placeholder" && action.executor === "ssh" && /ssh brain@brain\.example\.test/.test(action.displayCommand ?? "")));
    assert.ok(planJson.details.plan.forbidden.some((line) => /Do not vendor or merge/.test(line)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack plan renders local executor actions for local control-plane targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-local-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const codexChat = path.join(root, "codex-chat");
    const assistantLogic = path.join(root, "assistant-agent-logic");
    const registry = path.join(root, "registry.yaml");
    const setupContext = path.join(root, "setup-context.json");
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await writeFile(registry, stackRegistryFixture({
      assistantData,
      assistantLogicPath: assistantLogic,
      assistantLogicHost: "local",
      codexHost: "local",
      codexPath: codexChat,
      deployHost: "local",
      deployPath: codexChat,
      sshIdentity: "",
      envFile: path.join(root, "codex-chat.env"),
      configPath: path.join(root, "codex-chat.yaml"),
    }));
    await writeFile(setupContext, `${JSON.stringify({
      version: 1,
      target: "local",
      workspace: "personal",
      workspaceRoot,
      repoPath: brainRepo,
      configPath: path.join(workspaceRoot, "config", "runtime.yaml"),
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const plan = spawnBrainctl(["stack", "plan", "--registry", registry, "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "personal"]);
    assert.equal(plan.status, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout) as { details: { status: { deploymentMetadata: { canonical: { sourceOfTruth: string; path: string } } }; plan: { execution: { actions: Array<{ id: string; executor: string; displayCommand?: string }> } } } };
    assert.equal(parsed.details.status.deploymentMetadata.canonical.sourceOfTruth, "local-brain-workspace");
    assert.equal(parsed.details.status.deploymentMetadata.canonical.path, `${workspaceRoot}/state/control-plane/deployments.json`);
    assert.ok(parsed.details.plan.execution.actions.some((action) => action.id === "clone-update-codex-chat-source" && action.executor === "local" && !/ssh /.test(action.displayCommand ?? "")));
    assert.ok(parsed.details.plan.execution.actions.some((action) => action.id === "install-assistant-agent-logic-deps" && action.executor === "local" && !/ssh /.test(action.displayCommand ?? "") && /npm ci/.test(action.displayCommand ?? "")));
    assert.ok(parsed.details.plan.execution.actions.some((action) => action.id === "migrate-telegram-pairing-state" && action.executor === "local" && !/ssh /.test(action.displayCommand ?? "")));
    assert.ok(parsed.details.plan.execution.actions.some((action) => action.id === "install-codex-chat-systemd" && action.executor === "local" && !/ssh /.test(action.displayCommand ?? "")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack status can bind assistant-agent-logic to the service-host checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-logic-live-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const registry = path.join(root, "registry.yaml");
    const setupContext = path.join(root, "setup-context.json");
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await writeFile(registry, stackRegistryFixture({
      assistantData,
      assistantLogicDeployHost: "codex@app.example.test",
      assistantLogicDeployPath: "/srv/codex-chat/assistant-agent-logic",
    }));
    await writeFile(setupContext, `${JSON.stringify({
      version: 1,
      target: "remote",
      workspace: "personal",
      workspaceRoot: "/srv/brain/workspace",
      sshHost: "brain.example.test",
      sshUser: "brain",
      serviceUser: "brain",
      repoPath: "/srv/brain/control-plane",
      configPath: "/srv/brain/workspace/config/runtime.yaml",
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const plan = spawnBrainctl(["stack", "plan", "--registry", registry, "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "personal"]);
    assert.equal(plan.status, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout) as {
      details: {
        status: { assistantLogic: { host: string; path: string; requestedRef: string } };
        plan: { steps: Array<{ id: string; commands?: string[]; renderedConfigPreview?: string }> };
      };
    };
    assert.equal(parsed.details.status.assistantLogic.host, "codex@app.example.test");
    assert.equal(parsed.details.status.assistantLogic.path, "/srv/codex-chat/assistant-agent-logic");
    assert.equal(parsed.details.status.assistantLogic.requestedRef, "main");
    const steps = new Map(parsed.details.plan.steps.map((step) => [step.id, step]));
    const renderedConfig = steps.get("render-codex-chat-config-env")?.renderedConfigPreview ?? "";
    assert.ok(steps.get("clone-update-assistant-agent-logic")?.commands?.some((command) => /ssh codex@app\.example\.test/.test(command) && /BRAIN_REPO_SHA role=assistant-logic/.test(command)));
    assert.ok(steps.get("install-assistant-agent-logic-deps")?.commands?.some((command) => /ssh codex@app\.example\.test/.test(command) && /BRAIN_COMPOSIO_WORKFLOW_DEPS/.test(command)));
    assert.match(renderedConfig, /\/srv\/brain\/workspace/);
    assert.match(renderedConfig, /\/srv\/brain\/control-plane/);
    assert.match(renderedConfig, /\/srv\/codex-chat\/assistant-agent-logic/);
    assert.doesNotMatch(renderedConfig, new RegExp(assistantData.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack plan renders and exposes the new-owner path, store, and socket contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-render-brain-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const registry = path.join(root, "registry.yaml");
    const setupContext = path.join(root, "setup-context.json");
    const workspaceRoot = "/home/brain/.brain/workspace";
    const logicRepo = "/home/brain/assistant-agent-logic";
    const ipcSocketPath = `${workspaceRoot}/state/run/codex-chat.sock`;
    const capabilityStorePath = "/home/brain/.brain/control-plane/capabilities.json";
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await writeFile(registry, stackRegistryFixture({
      assistantData,
      assistantLogicPath: logicRepo,
      runtimeUser: "brain",
      codexPath: "/home/brain/codex-chat",
      deployPath: "/home/brain/codex-chat",
      sshIdentity: "brain@brain.example.test",
    }));
    await writeFile(setupContext, `${JSON.stringify({
      version: 1,
      target: "remote",
      workspace: "personal",
      workspaceRoot,
      sshHost: "brain.example.test",
      sshUser: "brain",
      serviceUser: "brain",
      repoPath: "/home/brain/brain",
      configPath: `${workspaceRoot}/config/runtime.yaml`,
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const plan = spawnBrainctl(["stack", "plan", "--registry", registry, "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "personal"]);
    assert.equal(plan.status, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout) as {
      details: { plan: { steps: Array<{ id: string; renderedConfigPreview?: string; renderedEnvPreview?: string; renderedUnitPreview?: string; capabilityStorePath?: string; ipcSocketPath?: string; auditLogPath?: string; ownerAdminEmail?: string }> } };
    };
    const render = parsed.details.plan.steps.find((step) => step.id === "render-codex-chat-config-env");
    const adminRender = parsed.details.plan.steps.find((step) => step.id === "render-brain-admin-env-unit");
    assert.equal(render?.capabilityStorePath, capabilityStorePath);
    assert.equal(render?.ipcSocketPath, ipcSocketPath);
    assert.equal(adminRender?.capabilityStorePath, render?.capabilityStorePath, "brain-admin and codex-chat must render the exact same capability store path");
    assert.equal(adminRender?.ipcSocketPath, render?.ipcSocketPath, "brain-admin and codex-chat must render the exact same IPC socket path");
    assert.equal(adminRender?.auditLogPath, "/home/brain/.brain/control-plane/audit.jsonl");
    assert.equal(adminRender?.ownerAdminEmail, "owner@example.test");
    assert.ok(render?.renderedConfigPreview?.includes(`[service]\nname = "codex-chat"\nworkspace = "${workspaceRoot}"\nstateDir = "${workspaceRoot}/state/codex-chat"\nlogLevel = "info"\ntimezone = "Etc/UTC"\nipcSocket = "${ipcSocketPath}"`));
    assert.ok(render?.renderedConfigPreview?.includes(`[paths]\nlogicRepo = "${logicRepo}"\nassistantWorkspace = "${workspaceRoot}"`));
    assert.ok(render?.renderedConfigPreview?.includes(`[brain]\nstorePath = "${capabilityStorePath}"\nenforcementEnabled = true`));
    assert.match(adminRender?.renderedEnvPreview ?? "", new RegExp(`BRAIN_CAPABILITY_STORE_PATH=${escapeRegExp(capabilityStorePath)}`));
    assert.match(adminRender?.renderedEnvPreview ?? "", new RegExp(`BRAIN_CODEX_CHAT_IPC_SOCKET=${escapeRegExp(ipcSocketPath)}`));
    assert.match(adminRender?.renderedEnvPreview ?? "", /BRAIN_ADMIN_AUDIT_LOG=\/home\/brain\/\.brain\/control-plane\/audit\.jsonl/);
    assert.match(adminRender?.renderedEnvPreview ?? "", /BRAIN_ADMIN_HOST=127\.0\.0\.1/);
    assert.match(adminRender?.renderedEnvPreview ?? "", /BRAIN_ADMIN_PORT=49347/);
    assert.match(adminRender?.renderedEnvPreview ?? "", /CLERK_ALLOWED_EMAILS=owner@example\.test/);
    assert.match(adminRender?.renderedEnvPreview ?? "", /CLERK_SECRET_KEY=<redacted:set-on-server-with-one-use-helper>/);
    assert.match(adminRender?.renderedUnitPreview ?? "", /User=brain/);
    assert.match(adminRender?.renderedUnitPreview ?? "", /WorkingDirectory=\/home\/brain\/brain/);
    assert.match(adminRender?.renderedUnitPreview ?? "", /EnvironmentFile=\/home\/brain\/\.brain\/workspace\/config\/brain-admin\.env/);
    assert.match(adminRender?.renderedUnitPreview ?? "", /ExecStart=\/usr\/bin\/env node \/home\/brain\/brain\/apps\/web\/dist\/brain-admin\.js/);
    assert.match(adminRender?.renderedUnitPreview ?? "", /Restart=always/);
    assert.doesNotMatch(`${adminRender?.renderedEnvPreview}\n${adminRender?.renderedUnitPreview}`, /\/home\/tim|basilesportif|@gmail\.com/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack plan derives Tim-style config paths from deployment metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-render-tim-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const registry = path.join(root, "registry.yaml");
    const setupContext = path.join(root, "setup-context.json");
    const workspaceRoot = "/home/tim/.assistant-claude/workspace";
    const logicRepo = "/home/tim/pkg/tim/assistant-agent-logic";
    const ipcSocketPath = `${workspaceRoot}/state/run/codex-chat.sock`;
    const capabilityStorePath = "/home/tim/.brain/control-plane/capabilities.json";
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await writeFile(registry, stackRegistryFixture({
      assistantData,
      assistantLogicPath: logicRepo,
      runtimeUser: "tim",
      codexPath: "/home/tim/pkg/tim/codex-chat",
      deployPath: "/home/tim/pkg/tim/codex-chat",
      sshIdentity: "tim@tim.example.test",
    }));
    await writeFile(setupContext, `${JSON.stringify({
      version: 1,
      target: "remote",
      workspace: "personal",
      workspaceRoot,
      sshHost: "tim.example.test",
      sshUser: "tim",
      serviceUser: "tim",
      repoPath: "/home/tim/pkg/tim/brain",
      configPath: `${workspaceRoot}/config/runtime.yaml`,
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const plan = spawnBrainctl(["stack", "plan", "--registry", registry, "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "personal"]);
    assert.equal(plan.status, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout) as {
      details: { plan: { steps: Array<{ id: string; renderedConfigPreview?: string; capabilityStorePath?: string; ipcSocketPath?: string }> } };
    };
    const render = parsed.details.plan.steps.find((step) => step.id === "render-codex-chat-config-env");
    assert.equal(render?.capabilityStorePath, capabilityStorePath);
    assert.equal(render?.ipcSocketPath, ipcSocketPath);
    assert.ok(render?.renderedConfigPreview?.includes(`[paths]\nlogicRepo = "${logicRepo}"\nassistantWorkspace = "${workspaceRoot}"`));
    assert.ok(render?.renderedConfigPreview?.includes(`[brain]\nstorePath = "${capabilityStorePath}"\nenforcementEnabled = true`));
    assert.ok(render?.renderedConfigPreview?.includes(`ipcSocket = ${JSON.stringify(ipcSocketPath)}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack apply defaults to dry-run, enforces approval gates, and writes redacted deployment metadata through mock executor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-apply-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const registry = path.join(root, "registry.yaml");
    const setupContext = path.join(root, "setup-context.json");
    const metadataFile = path.join(root, "offline", "deployments.json");
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await writeFile(registry, stackRegistryFixture({ assistantData }));
    await writeFile(setupContext, `${JSON.stringify({
      version: 1,
      target: "remote",
      workspace: "personal",
      workspaceRoot: "/srv/brain/workspace",
      sshHost: "brain.example.test",
      sshUser: "brain",
      serviceUser: "brain",
      repoPath: "/srv/brain/control-plane",
      configPath: "/srv/brain/workspace/config/runtime.yaml",
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const secretValue = "super-secret-stack-apply-value";
    const dryRun = spawnBrainctl(["stack", "apply", "--registry", registry, "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "personal", "--executor", "mock", "--metadata-file", metadataFile], {
      TELEGRAM_BOT_TOKEN: secretValue,
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.doesNotMatch(dryRun.stdout, new RegExp(secretValue));
    const dryRunJson = JSON.parse(dryRun.stdout) as { details: { executor: { dryRun: boolean; effective: string }; approvalGates: Array<{ gate: string; approved: boolean }>; metadataWrite?: unknown; actionResults: Array<{ status: string; reason?: string }> } };
    assert.equal(dryRunJson.details.executor.dryRun, true);
    assert.equal(dryRunJson.details.executor.effective, "dry-run");
    assert.equal(dryRunJson.details.approvalGates.find((gate) => gate.gate === "apply")?.approved, false);
    assert.ok(dryRunJson.details.actionResults.some((result) => result.status === "skipped" && /approval gate/.test(result.reason ?? "")));
    assert.equal(dryRunJson.details.metadataWrite, undefined);
    await assert.rejects(stat(metadataFile));

    const apply = spawnBrainctl([
      "stack", "apply",
      "--registry", registry,
      "--repo", brainRepo,
      "--setup-context", setupContext,
      "--workspace", "personal",
      "--executor", "mock",
      "--metadata-file", metadataFile,
      "--approve",
      "--approve-data",
      "--approve-config",
      "--approve-service",
      "--approve-health",
      "--now", "2026-06-07T00:00:00.000Z",
    ], {
      TELEGRAM_BOT_TOKEN: secretValue,
      OPENAI_API_KEY: "sk-stack-apply-secret-value-must-not-print",
    });
    assert.equal(apply.status, 0, `${apply.stderr}\n${apply.stdout}`);
    assert.doesNotMatch(apply.stdout, new RegExp(secretValue));
    assert.doesNotMatch(apply.stdout, /sk-stack-apply-secret-value-must-not-print/);
    const applyJson = JSON.parse(apply.stdout) as { details: { executor: { dryRun: boolean; effective: string }; metadataWrite: { ok: boolean; path: string; canonicalPath: string; deployments: Array<{ id: string; status: string }> }; actionResults: Array<{ status: string }> } };
    assert.equal(applyJson.details.executor.dryRun, false);
    assert.equal(applyJson.details.executor.effective, "mock");
    assert.ok(applyJson.details.actionResults.every((result) => result.status === "mocked" || result.status === "handled-by-metadata-writer"));
    assert.equal(applyJson.details.metadataWrite.ok, true);
    assert.equal(applyJson.details.metadataWrite.path, metadataFile);
    assert.equal(applyJson.details.metadataWrite.canonicalPath, "/srv/brain/workspace/state/control-plane/deployments.json");
    assert.deepEqual(applyJson.details.metadataWrite.deployments, [{ id: "personal:production:codex-chat", status: "healthy", updatedAt: "2026-06-07T00:00:00.000Z" }]);
    assert.equal((await stat(metadataFile)).mode & 0o777, 0o600);

    const storeText = await readFile(metadataFile, "utf8");
    assert.doesNotMatch(storeText, new RegExp(secretValue));
    assert.doesNotMatch(storeText, /sk-stack-apply-secret-value-must-not-print/);
    const store = JSON.parse(storeText) as {
      version: number;
      kind: string;
      canonical: { sourceOfTruth: string; path: string; relativePath: string };
      secretValuesStored: boolean;
      deployments: Array<{ id: string; status: string; secretValuesStored: boolean; config: { capabilityStorePath: string; ipcSocketPath: string; envVars: Array<{ name: string; value: string; metadataOnly: boolean }>; renderedEnvPreview: string }; health: { status: string } }>;
    };
    assert.equal(store.version, 1);
    assert.equal(store.kind, "brain.control-plane.deployments");
    assert.equal(store.canonical.sourceOfTruth, "remote-brain-workspace");
    assert.equal(store.canonical.path, "/srv/brain/workspace/state/control-plane/deployments.json");
    assert.equal(store.canonical.relativePath, "state/control-plane/deployments.json");
    assert.equal(store.secretValuesStored, false);
    assert.equal(store.deployments[0]?.id, "personal:production:codex-chat");
    assert.equal(store.deployments[0]?.status, "healthy");
    assert.equal(store.deployments[0]?.secretValuesStored, false);
    assert.equal(store.deployments[0]?.health.status, "passed");
    assert.equal(store.deployments[0]?.config.capabilityStorePath, "/home/codex/.brain/control-plane/capabilities.json");
    assert.equal(store.deployments[0]?.config.ipcSocketPath, "/srv/brain/workspace/state/run/codex-chat.sock");
    assert.ok(store.deployments[0]?.config.envVars.every((envVar) => envVar.value === "redacted" && envVar.metadataOnly));
    assert.match(store.deployments[0]?.config.renderedEnvPreview ?? "", /<redacted:set-on-server>/);

    const status = spawnBrainctl(["stack", "status", "--registry", registry, "--repo", brainRepo, "--setup-context", setupContext, "--workspace", "personal", "--metadata-file", metadataFile]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as { details: { deploymentMetadata: { read: { attempted: boolean; present: boolean; validation: { ok: boolean } }; deployments: Array<{ id: string; status: string; serviceName: string; deployHost: string }> } } };
    assert.equal(statusJson.details.deploymentMetadata.read.attempted, true);
    assert.equal(statusJson.details.deploymentMetadata.read.present, true);
    assert.equal(statusJson.details.deploymentMetadata.read.validation.ok, true);
    assert.deepEqual(statusJson.details.deploymentMetadata.deployments, [{ id: "personal:production:codex-chat", stack: "codex-chat", workspace: "personal", environment: "production", status: "healthy", updatedAt: "2026-06-07T00:00:00.000Z", serviceName: "codex-chat.service", deployHost: "app.example.test" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack apply local updates configured repo refs and records resolved SHAs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-sha-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const codexCheckout = path.join(root, "deploy", "codex-chat");
    const logicCheckout = path.join(root, "deploy", "assistant-agent-logic");
    const codexRemote = path.join(root, "remotes", "codex-chat.git");
    const logicRemote = path.join(root, "remotes", "assistant-agent-logic.git");
    const registry = path.join(root, "registry.yaml");
    const setupContext = path.join(root, "setup-context.json");
    const metadataFile = path.join(root, "offline", "deployments.json");
    const bin = path.join(root, "bin");
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "pnpm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    await chmod(path.join(bin, "pnpm"), 0o700);
    const codexSha = await createBareRepoWithCommit(root, "codex-source", codexRemote);
    const logicSha = await createBareRepoWithCommit(root, "logic-source", logicRemote);
    await writeFile(registry, stackRegistryFixture({
      assistantData,
      assistantLogicPath: logicCheckout,
      codexHost: "local",
      codexPath: codexCheckout,
      assistantLogicHost: "local",
      deployHost: "local",
      deployPath: codexCheckout,
      sshIdentity: "",
      envFile: path.join(root, "codex-chat.env"),
      configPath: path.join(root, "codex-chat.toml"),
      codexRemoteUrl: codexRemote,
      assistantLogicRemoteUrl: logicRemote,
    }));
    await writeFile(setupContext, `${JSON.stringify({
      version: 1,
      target: "local",
      workspace: "personal",
      workspaceRoot: path.join(root, "workspace"),
      repoPath: brainRepo,
      configPath: path.join(root, "workspace", "config", "runtime.yaml"),
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const apply = spawnBrainctl([
      "stack", "apply",
      "--registry", registry,
      "--repo", brainRepo,
      "--setup-context", setupContext,
      "--workspace", "personal",
      "--executor", "local",
      "--metadata-file", metadataFile,
      "--approve",
      "--now", "2026-06-08T00:00:00.000Z",
    ], { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
    assert.equal(apply.status, 0, `${apply.stderr}\n${apply.stdout}`);
    const parsed = JSON.parse(apply.stdout) as { details: { actionResults: Array<{ id: string; repoUpdate?: { resolvedSha?: string; verified: boolean } }> } };
    assert.equal(parsed.details.actionResults.find((result) => result.id === "clone-update-codex-chat-source")?.repoUpdate?.resolvedSha, codexSha);
    assert.equal(parsed.details.actionResults.find((result) => result.id === "clone-update-codex-chat-source")?.repoUpdate?.verified, true);
    assert.equal(parsed.details.actionResults.find((result) => result.id === "clone-update-assistant-agent-logic")?.repoUpdate?.resolvedSha, logicSha);

    const store = JSON.parse(await readFile(metadataFile, "utf8")) as {
      deployments: Array<{
        servantRuntime: { requestedRef?: string; resolvedSha?: string };
        assistantLogic: { requestedRef?: string; resolvedSha?: string };
        repositories: Array<{ role: string; requestedRef?: string; resolvedSha?: string; verified: boolean }>;
      }>;
    };
    assert.equal(store.deployments[0]?.servantRuntime.requestedRef, "main");
    assert.equal(store.deployments[0]?.servantRuntime.resolvedSha, codexSha);
    assert.equal(store.deployments[0]?.assistantLogic.requestedRef, "main");
    assert.equal(store.deployments[0]?.assistantLogic.resolvedSha, logicSha);
    assert.ok(store.deployments[0]?.repositories.some((repo) => repo.role === "servant-runtime" && repo.resolvedSha === codexSha && repo.verified));
    assert.ok(store.deployments[0]?.repositories.some((repo) => repo.role === "assistant-logic" && repo.resolvedSha === logicSha && repo.verified));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack status validates deployment metadata schema", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-metadata-schema-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const registry = path.join(root, "registry.yaml");
    const metadataFile = path.join(root, "deployments.json");
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await writeFile(registry, stackRegistryFixture({ assistantData }));
    await writeFile(metadataFile, `${JSON.stringify({ version: 2, kind: "wrong", secretValuesStored: true, deployments: [{ id: "bad", stack: "codex-chat", status: "healthy", secretValuesStored: true }] }, null, 2)}\n`);

    const status = spawnBrainctl(["stack", "status", "--registry", registry, "--repo", brainRepo, "--metadata-file", metadataFile]);
    assert.equal(status.status, 1, status.stderr);
    const parsed = JSON.parse(status.stdout) as { details: { deploymentMetadata: { read: { validation: { ok: boolean; issues: string[] } } }; missing: string[] } };
    assert.equal(parsed.details.deploymentMetadata.read.validation.ok, false);
    assert.ok(parsed.details.deploymentMetadata.read.validation.issues.some((issue) => /version must be 1/.test(issue)));
    assert.ok(parsed.details.deploymentMetadata.read.validation.issues.some((issue) => /secretValuesStored must be false/.test(issue)));
    assert.ok(parsed.details.missing.some((issue) => /deployment metadata store invalid/.test(issue)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brainctl stack status blocks repo-boundary violations instead of preserving stale runtime parity nesting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-stack-boundary-"));
  try {
    const brainRepo = path.join(root, "brain");
    const assistantData = path.join(root, "assistant-agent-data");
    const registry = path.join(root, "registry.yaml");
    await mkdir(brainRepo, { recursive: true });
    await mkdir(assistantData, { recursive: true });
    await writeFile(registry, stackRegistryFixture({ assistantData, assistantLogicPath: "/srv/src/codex-chat/vendor/assistant-agent-logic" }));

    const status = spawnBrainctl(["stack", "status", "--registry", registry, "--repo", brainRepo]);
    assert.equal(status.status, 1, status.stderr);
    const parsed = JSON.parse(status.stdout) as { ok: boolean; details: { repoBoundaries: { ok: boolean; issues: string[] }; missing: string[] } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.details.repoBoundaries.ok, false);
    assert.ok(parsed.details.repoBoundaries.issues.some((issue) => /assistant-logic path is nested inside servant-runtime/.test(issue)));
    assert.ok(parsed.details.missing.some((issue) => /nested inside/.test(issue)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function testRuntimeConfig(workspace: string, backupRepo: string, options: { composioEnabled?: boolean; webEnabled?: boolean; transcriptionEnabled?: boolean; transcriptionApiKeyRef?: string } = {}): string {
  return [
    "runtime:",
    "  activeEntrypointMode: single-primary",
    "workspaces:",
    "  personal:",
    `    workspacePath: ${JSON.stringify(workspace)}`,
    "    provider: codex",
    "    primaryEntrypointId: telegram-main",
    "    enabledEntrypoints:",
    "      telegram-main:",
    "        kind: telegram",
    "        enabled: true",
    "        configRef: env:TELEGRAM_MAIN_CONFIG",
    "    outboundDefaults:",
    "      route: originating-entrypoint",
    "      allowCrossEntrypointReplies: false",
    "    promptContext:",
    "      includeActiveEntrypointMetadata: true",
    "      exposeChannelSecrets: false",
    "    backup:",
    "      strategy: private-git",
    "      privateGit:",
    `        repoPath: ${JSON.stringify(backupRepo)}`,
    "        branch: main",
    "    webPublishing:",
    `      enabled: ${options.webEnabled ? "true" : "false"}`,
    `      mode: ${options.webEnabled ? "domain" : "disabled"}`,
    "      baseUrl: https://example.test/pages",
    `      publishRoot: ${JSON.stringify(path.join(workspace, "pages"))}`,
    "    transcription:",
    `      enabled: ${options.transcriptionEnabled ? "true" : "false"}`,
    "      provider: openai",
    `      apiKeyRef: ${options.transcriptionApiKeyRef ?? "env:OPENAI_API_KEY"}`,
    "      model: gpt-4o-mini-transcribe",
    "      scope:",
    "        entrypointIds:",
    "          - telegram-main",
    "        attachmentKinds:",
    "          - voice",
    "          - audio",
    "    integrations:",
    "      composio:",
    `        enabled: ${options.composioEnabled ? "true" : "false"}`,
    "        apiKeyRef: env:COMPOSIO_API_KEY",
    `        connectedAccountRef: file:${path.join(workspace, "config", "composio-account.json")}`,
    "        dataSources:",
    "          googleCalendar:",
    `            enabled: ${options.composioEnabled ? "true" : "false"}`,
    `            connectedAccountRef: file:${path.join(workspace, "config", "google-calendar-account.json")}`,
    "            requiredEnvRefs:",
    "              - env:COMPOSIO_API_KEY",
    "          gmail:",
    `            enabled: ${options.composioEnabled ? "true" : "false"}`,
    `            connectedAccountRef: file:${path.join(workspace, "config", "gmail-account.json")}`,
    "            requiredEnvRefs:",
    "              - env:COMPOSIO_API_KEY",
    "",
  ].join("\n");
}

function stackRegistryFixture(options: {
  assistantData: string;
  assistantLogicPath?: string;
  assistantLogicHost?: string;
  assistantLogicDeployHost?: string;
  assistantLogicDeployPath?: string;
  codexHost?: string;
  codexPath?: string;
  deployHost?: string;
  deployPath?: string;
  runtimeUser?: string;
  sshIdentity?: string;
  envFile?: string;
  configPath?: string;
  expectedTelegramBot?: { id?: string; username?: string };
  codexRemoteUrl?: string;
  assistantLogicRemoteUrl?: string;
}): string {
  const assistantLogicPath = options.assistantLogicPath ?? "/srv/src/assistant-agent-logic";
  const assistantLogicHost = options.assistantLogicHost ?? "dev.example.test";
  const codexHost = options.codexHost ?? "dev.example.test";
  const codexPath = options.codexPath ?? "/srv/src/codex-chat";
  const deployHost = options.deployHost ?? "app.example.test";
  const deployPath = options.deployPath ?? "/srv/codex-chat";
  const runtimeUser = options.runtimeUser ?? "codex";
  const sshIdentity = options.sshIdentity ?? "codex@app.example.test";
  const envFile = options.envFile ?? "/etc/codex-chat/env";
  const configPath = options.configPath ?? "/etc/codex-chat/codex-chat.toml";
  const expectedTelegramBot = options.expectedTelegramBot ?? { id: "1234567890", username: "ExampleServantBot" };
  const codexRemoteUrl = options.codexRemoteUrl ?? "git@github.com:example/codex-chat.git";
  const assistantLogicRemoteUrl = options.assistantLogicRemoteUrl ?? "git@github.com:example/assistant-agent-logic.git";
  const assistantLogicEnvironment = options.assistantLogicDeployHost || options.assistantLogicDeployPath
    ? [
        "            assistant_logic:",
        `              host: ${JSON.stringify(options.assistantLogicDeployHost ?? assistantLogicHost)}`,
        `              path: ${JSON.stringify(options.assistantLogicDeployPath ?? assistantLogicPath)}`,
        "              branch: main",
        `              remote_url: ${JSON.stringify(assistantLogicRemoteUrl)}`,
      ]
    : [];
  return [
    "version: 1",
    `controller_root: ${JSON.stringify(path.dirname(options.assistantData))}`,
    "repos:",
    "  codex-chat:",
    "    alias: codex-chat",
    `    host: ${JSON.stringify(codexHost)}`,
    `    path: ${JSON.stringify(codexPath)}`,
    "    repo_name: codex-chat",
    "    default_branch: main",
    "    current_branch: main",
    `    remote_url: ${JSON.stringify(codexRemoteUrl)}`,
    "    apps:",
    "      codex-chat:",
    "        kind: service",
    "        environments:",
    "          production:",
    "            source:",
    `              host: ${JSON.stringify(codexHost)}`,
    `              path: ${JSON.stringify(codexPath)}`,
    "              branch: main",
    `              remote_url: ${JSON.stringify(codexRemoteUrl)}`,
    "            deploy:",
    `              host: ${JSON.stringify(deployHost)}`,
    `              path: ${JSON.stringify(deployPath)}`,
    "              service: codex-chat.service",
    `              runtime_user: ${JSON.stringify(runtimeUser)}`,
    ...(sshIdentity ? [`              ssh_identity: ${JSON.stringify(sshIdentity)}`] : []),
    `              env_file: ${JSON.stringify(envFile)}`,
    `              config_path: ${JSON.stringify(configPath)}`,
    ...(expectedTelegramBot ? [
      "              expected_telegram_bot:",
      ...(expectedTelegramBot.id ? [`                id: ${JSON.stringify(expectedTelegramBot.id)}`] : []),
      ...(expectedTelegramBot.username ? [`                username: ${JSON.stringify(expectedTelegramBot.username)}`] : []),
    ] : []),
    "              env_vars:",
    "                - TELEGRAM_BOT_TOKEN",
    "                - OPENAI_API_KEY",
    "            health_checks:",
    "              - kind: command",
    "                command: codex-chat health --json",
    ...assistantLogicEnvironment,
    "  assistant-claude:",
    "    alias: assistant-claude",
    `    host: ${JSON.stringify(assistantLogicHost)}`,
    `    path: ${JSON.stringify(assistantLogicPath)}`,
    "    repo_name: assistant-agent-logic",
    "    default_branch: main",
    "    current_branch: main",
    `    remote_url: ${JSON.stringify(assistantLogicRemoteUrl)}`,
    "  assistant-agent-data:",
    "    alias: assistant-agent-data",
    "    host: local",
    `    path: ${JSON.stringify(options.assistantData)}`,
    "    repo_name: assistant-agent-data",
    "    default_branch: main",
    "    current_branch: main",
    "    remote_url: https://github.com/example/assistant-agent-data.git",
    "",
  ].join("\n");
}

function spawnBrainctl(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [brainctl.pathname, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellTestLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function initRepoWithPrivateIgnore(root: string): Promise<void> {
  await mkdir(path.join(root, "private"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), [
    "private/*",
    "!private/README.md",
    "",
  ].join("\n"));
  await writeFile(path.join(root, "private", "README.md"), "private placeholder\n");
  const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
}

async function createBareRepoWithCommit(root: string, name: string, barePath: string): Promise<string> {
  const work = path.join(root, name);
  await mkdir(work, { recursive: true });
  let result = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: work, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(work, "README.md"), `${name}\n`);
  result = spawnSync("git", ["add", "README.md"], { cwd: work, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("git", ["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-q", "-m", `init ${name}`], { cwd: work, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const sha = result.stdout.trim();
  await mkdir(path.dirname(barePath), { recursive: true });
  result = spawnSync("git", ["clone", "--bare", work, barePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return sha;
}
