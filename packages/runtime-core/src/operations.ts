import path from "node:path";

export interface OperationsPlanInput {
  workspaceId: string;
  repoPath: string;
  configPath: string;
  stateRoot: string;
  artifactRoot: string;
  logPath: string;
  serviceName?: string;
  serviceUser?: string;
  nodeBinary?: string;
  pnpmBinary?: string;
  environmentFile?: string;
}

export interface OperationsPlan {
  workspaceId: string;
  serviceName: string;
  serviceUser: string;
  repoPath: string;
  configPath: string;
  stateRoot: string;
  artifactRoot: string;
  logPath: string;
  unitPath: string;
  environmentFile: string;
  commands: {
    preflight: string[];
    update: string[];
    restart: string[];
    rollback: string[];
    postUpdateSmoke: string[];
  };
  safety: string[];
}

export function createOperationsPlan(input: OperationsPlanInput): OperationsPlan {
  const serviceName = input.serviceName ?? `brain-${input.workspaceId}`;
  const serviceUser = input.serviceUser ?? "brain";
  const repoPath = path.resolve(input.repoPath);
  const configPath = path.resolve(input.configPath);
  const stateRoot = path.resolve(input.stateRoot);
  const artifactRoot = path.resolve(input.artifactRoot);
  const logPath = path.resolve(input.logPath);
  const environmentFile = path.resolve(input.environmentFile ?? path.join(path.dirname(stateRoot), "config", `${serviceName}.env`));
  const pnpm = shellWord(input.pnpmBinary ?? "pnpm");
  const brainctl = `${pnpm} --dir ${shellWord(repoPath)} run brainctl --`;

  return {
    workspaceId: input.workspaceId,
    serviceName,
    serviceUser,
    repoPath,
    configPath,
    stateRoot,
    artifactRoot,
    logPath,
    unitPath: `/etc/systemd/system/${serviceName}.service`,
    environmentFile,
    commands: {
      preflight: [
        `${brainctl} config validate ${shellWord(configPath)}`,
        `${brainctl} secrets check --config ${shellWord(configPath)}`,
        `${brainctl} runtime smoke --config ${shellWord(configPath)} --workspace ${shellWord(input.workspaceId)} --text ping`,
      ],
      update: [
        `cd ${shellWord(repoPath)} && git fetch --all --prune`,
        `cd ${shellWord(repoPath)} && git status --short --branch`,
        `cd ${shellWord(repoPath)} && ${pnpm} install --frozen-lockfile`,
        `cd ${shellWord(repoPath)} && ${pnpm} run check`,
      ],
      restart: [
        `sudo systemctl daemon-reload`,
        `sudo systemctl restart ${shellWord(serviceName)}.service`,
        `sudo systemctl status --no-pager ${shellWord(serviceName)}.service`,
      ],
      rollback: [
        `cd ${shellWord(repoPath)} && git rev-parse HEAD > ${shellWord(path.join(path.dirname(stateRoot), "backups", `${serviceName}.pre-update-sha`))}`,
        `cd ${shellWord(repoPath)} && git reset --hard <known-good-sha>`,
        `cd ${shellWord(repoPath)} && ${pnpm} install --frozen-lockfile && ${pnpm} run check`,
        `sudo systemctl restart ${shellWord(serviceName)}.service`,
      ],
      postUpdateSmoke: [
        `${brainctl} health --config ${shellWord(configPath)} --workspace ${shellWord(input.workspaceId)} --state ${shellWord(stateRoot)} --log ${shellWord(logPath)}`,
        `${brainctl} logs --file ${shellWord(logPath)} --lines 50`,
      ],
    },
    safety: [
      "This plan is data only; rendering it does not install systemd units, pull git, restart services, or contact live providers.",
      "Secret refs are checked by metadata only; values must stay in the private workspace or host secret store.",
      "Rollback uses explicit known-good git refs; Brain does not keep a persistent turn replay/idempotency store.",
    ],
  };
}

export function renderSystemdService(plan: OperationsPlan): string {
  const exec = [
    "pnpm",
    "run",
    "brainctl",
    "--",
    "run",
    "--config",
    plan.configPath,
    "--workspace",
    plan.workspaceId,
    "--state",
    plan.stateRoot,
    "--artifacts",
    plan.artifactRoot,
    "--log",
    plan.logPath,
  ].map(systemdEscapeArg).join(" ");

  return [
    "[Unit]",
    `Description=Brain runtime (${plan.workspaceId})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${plan.serviceUser}`,
    `WorkingDirectory=${plan.repoPath}`,
    `EnvironmentFile=-${plan.environmentFile}`,
    `ExecStart=${exec}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    `ReadWritePaths=${path.dirname(plan.stateRoot)} ${path.dirname(plan.logPath)} ${plan.artifactRoot}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export interface GuardedLiveValidationPlan {
  workspaceId: string;
  allowLive: boolean;
  networkStarted: boolean;
  checks: Array<{ id: string; mode: "run" | "plan"; command: string; reason: string }>;
  guards: string[];
}

export function createGuardedLiveValidationPlan(input: {
  workspaceId: string;
  configPath: string;
  codexTransport?: string;
  telegramTokenRef?: string;
  allowLive?: boolean;
}): GuardedLiveValidationPlan {
  const brainctl = "pnpm run brainctl --";
  const allowLive = Boolean(input.allowLive);
  const codexTransport = input.codexTransport ?? "stub";
  const checks: GuardedLiveValidationPlan["checks"] = [
    { id: "config", mode: "run", command: `${brainctl} config validate ${shellWord(input.configPath)}`, reason: "validate public-safe runtime config" },
    { id: "secrets", mode: "run", command: `${brainctl} secrets check --config ${shellWord(input.configPath)}`, reason: "verify secret refs by metadata only" },
    { id: "runtime-smoke", mode: "run", command: `${brainctl} runtime smoke --config ${shellWord(input.configPath)} --workspace ${shellWord(input.workspaceId)} --text ping`, reason: "prove no-network runtime path" },
  ];
  checks.push({
    id: "codex-provider",
    mode: allowLive || codexTransport === "stub" ? "run" : "plan",
    command: `${brainctl} provider check codex --workspace ${shellWord(input.workspaceId)} --transport ${shellWord(codexTransport)}`,
    reason: codexTransport === "stub" ? "instantiate Codex provider seam without live app-server" : "guarded Codex app-server health check; no user task is sent",
  });
  checks.push({
    id: "telegram-entrypoint",
    mode: "run",
    command: `${brainctl} entrypoint check telegram --workspace ${shellWord(input.workspaceId)}${input.telegramTokenRef ? ` --token-${input.telegramTokenRef.startsWith("env:") ? "env" : "file"} ${shellWord(input.telegramTokenRef.replace(/^(env|file):/, ""))}` : ""}`,
    reason: "instantiate Telegram adapter and inspect token metadata only; no polling/webhook by default",
  });

  return {
    workspaceId: input.workspaceId,
    allowLive,
    networkStarted: false,
    checks,
    guards: [
      "Default mode is no-secret/no-network; live Telegram polling requires separate run/start flags and an explicit token ref.",
      "Codex app-server validation is health-only and must be explicitly allowed before connecting to a live URL or spawning a binary.",
      "No real user turns, provider tasks, deployments, or service restarts are part of this validation plan.",
    ],
  };
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function systemdEscapeArg(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%").replaceAll("\n", " ");
  return /\s/.test(escaped) ? `"${escaped}"` : escaped;
}
