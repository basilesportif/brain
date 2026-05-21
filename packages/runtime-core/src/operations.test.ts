import test from "node:test";
import assert from "node:assert/strict";
import { createGuardedLiveValidationPlan, createOperationsPlan, renderSystemdService } from "./index.js";

test("operations plan renders systemd/update/rollback seams without side effects", () => {
  const plan = createOperationsPlan({
    workspaceId: "personal",
    repoPath: "/srv/brain",
    configPath: "/srv/brain/config/runtime.yaml",
    stateRoot: "/var/lib/brain/state",
    artifactRoot: "/var/lib/brain/artifacts",
    logPath: "/var/log/brain/runtime.jsonl",
    serviceName: "brain-personal",
    serviceUser: "brain",
  });

  assert.equal(plan.unitPath, "/etc/systemd/system/brain-personal.service");
  assert.ok(plan.commands.update.some((command) => command.includes("pnpm run check")));
  assert.ok(plan.commands.rollback.some((command) => command.includes("git reset --hard")));
  assert.match(plan.safety.join("\n"), /does not install systemd/);

  const unit = renderSystemdService(plan);
  assert.match(unit, /ExecStart=pnpm run brainctl -- run/);
  assert.match(unit, /EnvironmentFile=-/);
  assert.match(unit, /Restart=on-failure/);
});

test("guarded live validation plan defaults to no-network checks", () => {
  const plan = createGuardedLiveValidationPlan({
    workspaceId: "personal",
    configPath: "examples/config/runtime.yaml",
    codexTransport: "app-server",
    telegramTokenRef: "env:TELEGRAM_BOT_TOKEN",
  });

  assert.equal(plan.allowLive, false);
  assert.equal(plan.networkStarted, false);
  assert.equal(plan.checks.find((check) => check.id === "codex-provider")?.mode, "plan");
  assert.match(plan.checks.find((check) => check.id === "telegram-entrypoint")?.command ?? "", /--token-env TELEGRAM_BOT_TOKEN/);
});
