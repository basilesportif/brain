import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    assert.match(systemdJson.details.unit, /ExecStart=pnpm run brainctl run/);
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
    await mkdir(workspace, { recursive: true });
    await writeFile(config, testRuntimeConfig(workspace, backupRepo, { transcriptionEnabled: true, transcriptionApiKeyRef: "env:BRAIN_TRANSCRIPTION_KEY" }));
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const snapshot = () => JSON.stringify({
  openai: Boolean(process.env.OPENAI_API_KEY),
  transcription: Boolean(process.env.BRAIN_TRANSCRIPTION_KEY),
  other: process.env.OTHER_VAR || null
});
if (process.argv.includes("--version")) {
  await writeFile(${JSON.stringify(healthEnvPath)}, snapshot());
  console.log("fake-codex 1.0.0");
  process.exit(0);
}
await writeFile(${JSON.stringify(turnEnvPath)}, snapshot());
console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "ok" } }));
console.log(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_fake", status: "completed", items: [] } } }));
`);
    await chmod(fakeCodex, 0o755);

    const env = {
      BRAIN_TRANSCRIPTION_KEY: "sk-test-custom-transcription-value-must-not-print",
      OPENAI_API_KEY: "sk-test-openai-value-must-not-print",
      OTHER_VAR: "keep-me",
    };
    const readSnapshot = async (file: string) => JSON.parse(await readFile(file, "utf8")) as { openai: boolean; transcription: boolean; other: string | null };

    const providerCheck = spawnBrainctl(["provider", "check", "codex", "--config", config, "--workspace", "personal", "--transport", "exec", "--binary", fakeCodex, "--timeout-ms", "5000"], env);
    assert.equal(providerCheck.status, 0, providerCheck.stderr);
    assert.doesNotMatch(providerCheck.stdout, /sk-test-/);
    assert.deepEqual(await readSnapshot(healthEnvPath), { openai: false, transcription: false, other: "keep-me" });

    const providerSmoke = spawnBrainctl(["provider", "smoke", "codex", "--config", config, "--workspace", "personal", "--transport", "exec", "--binary", fakeCodex, "--timeout-ms", "5000", "--prompt", "ping", "--allow-live"], env);
    assert.equal(providerSmoke.status, 0, providerSmoke.stderr);
    assert.doesNotMatch(providerSmoke.stdout, /sk-test-/);
    assert.deepEqual(await readSnapshot(turnEnvPath), { openai: false, transcription: false, other: "keep-me" });

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
        setupStateUpdate: { wrote: boolean; metadata: { mode: string }; state: { secretValuesStored: boolean; statuses: { codexAuth: { status: string }; telegramToken: { configured: boolean } } } };
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
    assert.equal(liveJson.details.setupStateUpdate.state.statuses.telegramToken.configured, false);
    assert.deepEqual(await readSnapshot(healthEnvPath), { openai: false, transcription: false, other: "keep-me" });
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

test("brainctl setup telegram-token-script writes a syntax-checked one-use secret script", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-token-script-"));
  try {
    const workspace = path.join(root, "workspace");
    const backupRepo = path.join(root, "backup-repo");
    const config = path.join(root, "runtime.yaml");
    const script = path.join(root, "store-brain-telegram-token.sh");
    const token = "123456:abcDEF_ghi-JKLmnop";
    await writeFile(config, testRuntimeConfig(workspace, backupRepo));

    const generated = spawnBrainctl(["setup", "telegram-token-script", "--workspace", "personal", "--path", workspace, "--output", script]);
    assert.equal(generated.status, 0, generated.stderr);
    const generatedJson = JSON.parse(generated.stdout) as { ok: boolean; details: { scriptPath: string; validation: string; secretValuesPrinted: boolean } };
    assert.equal(generatedJson.ok, true);
    assert.equal(generatedJson.details.scriptPath, script);
    assert.equal(generatedJson.details.validation, "bash -n passed");
    assert.equal(generatedJson.details.secretValuesPrinted, false);

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
    assert.doesNotMatch(await readFile(serviceEnv, "utf8"), new RegExp(token));
    assert.doesNotMatch(await readFile(secretsEnv, "utf8"), new RegExp(token));
    assert.match(await readFile(serviceEnv, "utf8"), new RegExp(`TELEGRAM_BOT_TOKEN_FILE=${escapeRegExp(tokenFile)}`));
    assert.match(await readFile(secretsEnv, "utf8"), new RegExp(`TELEGRAM_MAIN_CONFIG=${escapeRegExp(adapterConfig)}`));
    for (const dir of ["logs", "artifacts", "backups", "tmp"]) await mkdir(path.join(workspace, dir), { recursive: true });

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
    assert.deepEqual(parsed.details.decisions.map((item) => item.decision), ["Setup mode", "Remote SSH host", "Remote SSH user", "Source checkout", "Private workspace", "Initial workspace"]);
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Remote SSH host")?.default, "ask: server IP or DNS name");
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Remote SSH user")?.default, "root");
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Source checkout")?.default, "/home/brain/brain");
    assert.equal(parsed.details.decisions.find((item) => item.decision === "Private workspace")?.default, "/home/brain/.brain/workspace");
    assert.deepEqual(parsed.details.setupFlow.coreSteps.map((item) => item.step), ["essential-runtime-choices", "configure-verify-codex-auth", "telegram-connection", "private-data-repo", "composio-accounts"]);
    assert.ok(parsed.details.setupFlow.orderingNotes.some((item) => /provider is Codex/.test(item)));
    assert.ok(parsed.details.setupFlow.orderingNotes.some((item) => /Codex auth before starting the service/.test(item)));
    assert.ok(parsed.details.safety.some((item) => /outside git/.test(item)));
    assert.equal(parsed.details.localSetupContext.wrote, true);
    assert.equal(parsed.details.localSetupContext.mode, "0600");
    assert.equal(parsed.details.localSetupContext.git.ignored, true);
    assert.equal(parsed.details.localSetupContext.git.tracked, false);
    assert.equal(parsed.details.advanced, undefined);
    assert.doesNotMatch(result.stdout, /serviceUser|serviceName|secretsEnv|runtimeConfig|pnpm caveat|package manager|srv\/brain/);

    const contextPath = path.join(root, "private", "setup-context.json");
    const context = JSON.parse(await readFile(contextPath, "utf8")) as { target: string; workspaceRoot: string; repoPath: string; sshHost?: string; sshUser: string; secretValuesStored: boolean };
    assert.equal(context.target, "remote");
    assert.equal(context.workspaceRoot, "/home/brain/.brain/workspace");
    assert.equal(context.repoPath, "/home/brain/brain");
    assert.equal(context.sshHost, undefined);
    assert.equal(context.sshUser, "root");
    assert.equal(context.secretValuesStored, false);
    assert.equal((await stat(contextPath)).mode & 0o777, 0o600);

    const verbose = spawnBrainctl(["setup", "defaults", "--target", "remote", "--workspace", "personal", "--repo", root, "--ssh-host", "203.0.113.10", "--ssh-user", "ubuntu", "--verbose"]);
    assert.equal(verbose.status, 0, verbose.stderr);
    const verboseJson = JSON.parse(verbose.stdout) as { details: { decisions: Array<{ decision: string; default: string }>; advanced: { ssh: { host: string; user: string }; serviceUser: string; serviceName: string; paths: { runtimeConfig: string; secretsEnv: string } } } };
    assert.equal(verboseJson.details.decisions.find((item) => item.decision === "Remote SSH host")?.default, "203.0.113.10");
    assert.equal(verboseJson.details.decisions.find((item) => item.decision === "Remote SSH user")?.default, "ubuntu");
    assert.deepEqual(verboseJson.details.advanced.ssh, { host: "203.0.113.10", user: "ubuntu" });
    assert.equal(verboseJson.details.advanced.serviceUser, "brain");
    assert.equal(verboseJson.details.advanced.serviceName, "brain-personal");
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
    const planJson = JSON.parse(plan.stdout) as { ok: boolean; details: { plan: { config: { strategy: string; privateGit: { exclude: string[] } }; dryRunDefault: boolean } } };
    assert.equal(planJson.ok, true);
    assert.equal(planJson.details.plan.config.strategy, "private-git");
    assert.equal(planJson.details.plan.dryRunDefault, true);
    assert.ok(planJson.details.plan.config.privateGit.exclude.includes("secrets/**"));

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
    "          chat:",
    `            enabled: ${options.composioEnabled ? "true" : "false"}`,
    `            connectedAccountRef: file:${path.join(workspace, "config", "chat-account.json")}`,
    "            requiredEnvRefs:",
    "              - env:COMPOSIO_API_KEY",
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
