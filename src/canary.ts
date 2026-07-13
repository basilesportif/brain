import { constants as fsConstants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  checkCapability,
  evaluateAuthorization,
  parseCapabilityStore,
  type CapabilityStore,
  type CodexChatCapabilityCheckResult,
  type StoreExternalIdentity,
  type StorePerson,
} from "@brain/web";

export type CanaryStatus = "PASS" | "FAIL" | "SKIP";

export interface CanaryCheck {
  id: string;
  number: number;
  label: string;
  status: CanaryStatus;
  reason: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface CanaryReport {
  command: "brainctl canary";
  readOnly: true;
  ok: boolean;
  verdict: "PASS" | "FAIL";
  configPath?: string;
  configSource?: string;
  ownerSubjectId?: string;
  checks: CanaryCheck[];
  summary: { pass: number; fail: number; skip: number };
}

export interface CanaryOptions {
  config?: string;
  socket?: string;
  store?: string;
  logicRepo?: string;
  workspace?: string;
  owner?: string;
  live?: boolean;
  since?: string;
  repo?: string;
  setupContext?: string;
  metadataFile?: string;
  workspaceId?: string;
  timeoutMs?: number;
  now?: Date;
}

interface ResolvedConfig {
  path?: string;
  source?: string;
  parsed?: Record<string, unknown>;
  error?: string;
}

interface CanaryPaths {
  configRoot?: string;
  logicRepo?: string;
  assistantWorkspace?: string;
  store?: string;
  socket?: string;
  behaviorDir?: string;
  behaviorEntrypoint?: string;
  stateRoot?: string;
}

interface ResolvedOwner {
  person: StorePerson;
  identity: StoreExternalIdentity;
  subjectId: string;
}

const BASELINE_OPERATIONS = [
  "telegram.event.receive",
  "assistant.run",
  "output.text.send",
  "crm.contact.read",
] as const;
const ABSENT_SUBJECT = "person:__canary_absent__";

function representativeBaselineResource(owner: ResolvedOwner, operation: typeof BASELINE_OPERATIONS[number]): Record<string, unknown> {
  if (operation === "crm.contact.read") return {};

  switch (owner.identity.provider) {
    case "telegram": {
      const telegramUserId = owner.identity.providerUserId;
      const resource: Record<string, unknown> = {
        source: "telegram",
        surfaceKind: "telegram",
        chatId: owner.identity.providerChatId ?? telegramUserId,
        actorId: telegramUserId,
        messageId: "canary",
        conversationSessionId: "canary",
      };
      return operation === "output.text.send" ? { ...resource, outputType: "text" } : resource;
    }
    default:
      return {};
  }
}

export async function runCanary(options: CanaryOptions): Promise<CanaryReport> {
  const resolvedConfig = await resolveCanaryConfig(options);
  const paths = resolveConfiguredPaths(resolvedConfig, options);
  const checks: CanaryCheck[] = [];

  checks.push(await checkConfigPaths(resolvedConfig, paths, options));

  let store: CapabilityStore | undefined;
  if (paths.store) {
    try {
      store = parseCapabilityStore(await readFile(paths.store, "utf8"));
    } catch {
      // Check 2 owns the parse/read failure and reports a bounded error.
    }
  }
  checks.push(checkCapabilityStore(paths.store, store));

  const owner = store ? resolveOwner(store, options.owner) : undefined;
  checks.push(checkOwner(store, owner, options.owner));

  const ipcResults = new Map<string, CodexChatCapabilityCheckResult>();
  const probeSubject = owner?.subjectId ?? ABSENT_SUBJECT;
  const probeKey = ipcKey(probeSubject, BASELINE_OPERATIONS[0]);
  const probeResource = owner ? representativeBaselineResource(owner, BASELINE_OPERATIONS[0]) : {};
  let ipcReachable = false;
  if (paths.socket) {
    try {
      const result = await checkCapability(paths.socket, {
        brainSubjectId: probeSubject,
        operation: BASELINE_OPERATIONS[0],
        action: "*",
        resource: probeResource,
      }, { timeoutMs: options.timeoutMs });
      ipcResults.set(probeKey, result);
      ipcReachable = true;
    } catch (error) {
      checks.push({
        id: "ipc_reachable",
        number: 4,
        label: "codex-chat IPC is reachable",
        status: "FAIL",
        reason: `check_capability failed at ${paths.socket}: ${errorMessage(error)}`,
        remediation: `Verify codex-chat is using this socket and that its service user can create/access it: ${paths.socket}. A green systemd unit is not sufficient.`,
        details: { socketPath: paths.socket },
      });
    }
  } else {
    checks.push({
      id: "ipc_reachable",
      number: 4,
      label: "codex-chat IPC is reachable",
      status: "FAIL",
      reason: "no IPC socket path was resolved",
      remediation: "Set [service].ipcSocket in the codex-chat TOML or pass --socket <path>.",
    });
  }
  if (ipcReachable) {
    checks.push({
      id: "ipc_reachable",
      number: 4,
      label: "codex-chat IPC is reachable",
      status: "PASS",
      reason: `check_capability returned a well-formed response from ${paths.socket}`,
      details: { socketPath: paths.socket },
    });
  }

  checks.push(await checkOwnerBaseline(paths.socket, store, owner, ipcReachable, ipcResults, options.timeoutMs));
  checks.push(await checkNegativeControl(paths.socket, ipcReachable, ipcResults, options.timeoutMs));
  checks.push(await checkBehaviorPack(resolvedConfig, paths));

  if (options.live) {
    checks.push(await checkLiveState(resolvedConfig, paths, owner, options));
  }

  const summary = {
    pass: checks.filter((check) => check.status === "PASS").length,
    fail: checks.filter((check) => check.status === "FAIL").length,
    skip: checks.filter((check) => check.status === "SKIP").length,
  };
  const ok = summary.fail === 0;
  return {
    command: "brainctl canary",
    readOnly: true,
    ok,
    verdict: ok ? "PASS" : "FAIL",
    configPath: resolvedConfig.path,
    configSource: resolvedConfig.source,
    ownerSubjectId: owner?.subjectId,
    checks,
    summary,
  };
}

export function formatCanaryReport(report: CanaryReport): string {
  const lines = [
    `Brain provisioning canary: ${report.verdict}`,
    `Config: ${report.configPath ?? "unresolved"}${report.configSource ? ` (${report.configSource})` : ""}`,
  ];
  if (report.ownerSubjectId) lines.push(`Owner subject: ${report.ownerSubjectId}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.number}. ${check.label} — ${check.reason}`);
    if (check.status === "FAIL" && check.remediation) lines.push(`  Fix: ${check.remediation}`);
  }
  lines.push("", `Summary: ${report.summary.pass} PASS, ${report.summary.fail} FAIL, ${report.summary.skip} SKIP`);
  return `${lines.join("\n")}\n`;
}

async function resolveCanaryConfig(options: CanaryOptions): Promise<ResolvedConfig> {
  if (options.config) return loadCodexChatConfig(path.resolve(options.config), "--config");

  const repoRoot = path.resolve(options.repo ?? process.cwd());
  const setupContextPath = path.resolve(options.setupContext ?? path.join(repoRoot, "private", "setup-context.json"));
  const setupContext = await readJsonRecord(setupContextPath);
  const workspace = options.workspaceId ?? "personal";
  const workspaceRoot = stringValue(setupContext?.workspaceRoot);
  const metadataPath = options.metadataFile
    ? path.resolve(options.metadataFile)
    : workspaceRoot
      ? path.resolve(workspaceRoot, "state", "control-plane", "deployments.json")
      : undefined;
  if (metadataPath) {
    const metadata = await readJsonRecord(metadataPath);
    const deployments = Array.isArray(metadata?.deployments) ? metadata.deployments.filter(isRecord) : [];
    const candidates = deployments
      .filter((deployment) => deployment.stack === "codex-chat" && (stringValue(deployment.workspace) ?? workspace) === workspace)
      .sort((a, b) => (stringValue(b.updatedAt) ?? "").localeCompare(stringValue(a.updatedAt) ?? ""));
    const configPath = stringValue(asRecord(candidates[0]?.config)?.configPath);
    if (configPath) return loadCodexChatConfig(path.resolve(configPath), `deployment metadata ${metadataPath}`);
  }

  const contextConfig = stringValue(setupContext?.configPath);
  if (contextConfig) return loadCodexChatConfig(path.resolve(contextConfig), `setup context ${setupContextPath}`);

  return {
    error: `no codex-chat config was resolved from --config, deployment metadata, or ${setupContextPath}`,
  };
}

async function loadCodexChatConfig(configPath: string, source: string): Promise<ResolvedConfig> {
  try {
    const parsed = parseToml(await readFile(configPath, "utf8"));
    if (!isRecord(parsed)) return { path: configPath, source, error: "codex-chat TOML root is not an object" };
    return { path: configPath, source, parsed };
  } catch (error) {
    return { path: configPath, source, error: `codex-chat TOML could not be read/parsed: ${errorMessage(error)}` };
  }
}

function resolveConfiguredPaths(config: ResolvedConfig, options: CanaryOptions): CanaryPaths {
  const root = config.path ? path.resolve(path.dirname(config.path), "..") : undefined;
  const service = asRecord(config.parsed?.service);
  const configuredPaths = asRecord(config.parsed?.paths);
  const brain = asRecord(config.parsed?.brain);
  const behavior = asRecord(config.parsed?.behavior);
  const resolveValue = (value: unknown): string | undefined => {
    const text = stringValue(value);
    if (!text) return undefined;
    return path.isAbsolute(text) ? path.normalize(text) : root ? path.resolve(root, text) : path.resolve(text);
  };
  const behaviorDir = resolveValue(behavior?.dir);
  const behaviorEntry = stringValue(behavior?.entrypoint);
  return {
    configRoot: root,
    logicRepo: options.logicRepo ? path.resolve(options.logicRepo) : resolveValue(configuredPaths?.logicRepo),
    assistantWorkspace: options.workspace ? path.resolve(options.workspace) : resolveValue(configuredPaths?.assistantWorkspace),
    store: options.store ? path.resolve(options.store) : resolveValue(brain?.storePath),
    socket: options.socket ? path.resolve(options.socket) : resolveValue(service?.ipcSocket),
    behaviorDir,
    behaviorEntrypoint: behaviorDir && behaviorEntry ? path.resolve(behaviorDir, behaviorEntry) : undefined,
    stateRoot: resolveValue(service?.stateDir),
  };
}

async function checkConfigPaths(config: ResolvedConfig, paths: CanaryPaths, options: CanaryOptions): Promise<CanaryCheck> {
  const failures: string[] = [];
  if (config.error) failures.push(config.error);
  if (!paths.logicRepo) failures.push("[paths].logicRepo is empty and --logic-repo was not supplied");
  else if (!await isDirectory(paths.logicRepo)) failures.push(`logicRepo does not exist as a directory: ${paths.logicRepo}`);
  if (!paths.assistantWorkspace) failures.push("[paths].assistantWorkspace is empty and --workspace was not supplied");
  else if (!await isDirectory(paths.assistantWorkspace)) failures.push(`assistantWorkspace does not exist as a directory: ${paths.assistantWorkspace}`);
  if (!paths.store) failures.push("[brain].storePath is empty and --store was not supplied");
  else if (!await isReadableFile(paths.store)) failures.push(`capability store does not exist as a readable file: ${paths.store}`);
  if (!paths.socket) failures.push("[service].ipcSocket is empty and --socket was not supplied");
  if (failures.length > 0) {
    return {
      id: "config_paths",
      number: 1,
      label: "Config resolves to real, non-fallback paths",
      status: "FAIL",
      reason: failures.join("; "),
      remediation: "Render or correct the provisioned codex-chat TOML so logicRepo, assistantWorkspace, storePath, and ipcSocket are explicit. For legacy configs, supply intentional --logic-repo/--workspace/--store/--socket overrides.",
      details: {
        configPath: config.path,
        logicRepoOverride: Boolean(options.logicRepo),
        workspaceOverride: Boolean(options.workspace),
        storeOverride: Boolean(options.store),
        socketOverride: Boolean(options.socket),
      },
    };
  }
  return {
    id: "config_paths",
    number: 1,
    label: "Config resolves to real, non-fallback paths",
    status: "PASS",
    reason: "logic repo, assistant workspace, readable capability store, and IPC socket path resolved explicitly",
    details: {
      logicRepo: paths.logicRepo,
      assistantWorkspace: paths.assistantWorkspace,
      storePath: paths.store,
      socketPath: paths.socket,
    },
  };
}

function checkCapabilityStore(storePath: string | undefined, store: CapabilityStore | undefined): CanaryCheck {
  if (!store) {
    return {
      id: "capability_store",
      number: 2,
      label: "Capability store is valid",
      status: "FAIL",
      reason: `capability store could not be read or parsed${storePath ? `: ${storePath}` : ""}`,
      remediation: "Provision a readable schemaVersion 2 capability store with non-empty people, subjects, externalIdentities, and grants arrays.",
      details: { storePath },
    };
  }
  const counts = {
    people: store.people?.length ?? 0,
    subjects: store.subjects?.length ?? 0,
    grants: store.grants?.length ?? 0,
  };
  const failures = [
    ...(store.schemaVersion === 2 ? [] : [`schemaVersion is ${String(store.schemaVersion)}, expected 2`]),
    ...(counts.people > 0 ? [] : ["people is empty"]),
    ...(counts.subjects > 0 ? [] : ["subjects is empty"]),
    ...(counts.grants > 0 ? [] : ["grants is empty"]),
  ];
  return failures.length > 0
    ? {
      id: "capability_store",
      number: 2,
      label: "Capability store is valid",
      status: "FAIL",
      reason: failures.join("; "),
      remediation: "Regenerate or migrate the capability store to schemaVersion 2 and provision its owner subjects and grants.",
      details: { storePath, counts },
    }
    : {
      id: "capability_store",
      number: 2,
      label: "Capability store is valid",
      status: "PASS",
      reason: `${storePath}: schemaVersion 2; ${counts.people} people, ${counts.subjects} subjects, ${counts.grants} grants`,
      details: { storePath, schemaVersion: store.schemaVersion, counts },
    };
}

function resolveOwner(store: CapabilityStore, requested: string | undefined): ResolvedOwner | undefined {
  const identities = (store.externalIdentities ?? []).filter((identity) =>
    identity.provider === "telegram"
    && (!identity.status || identity.status === "linked" || identity.status === "active")
    && Boolean(identity.personId),
  );
  const matchesRequestedIdentity = (identity: StoreExternalIdentity): boolean =>
    !requested || identity.providerUserId === requested;
  for (const identity of identities) {
    if (!matchesRequestedIdentity(identity)) continue;
    const person = (store.people ?? []).find((candidate) => candidate.id === identity.personId);
    if (!person || (person.status && person.status !== "active")) continue;
    const requestedSubject = requested
      ? (store.subjects ?? []).find((subject) =>
        subject.id === requested && subject.personId === person.id && (!subject.status || subject.status === "active"))
      : undefined;
    const subjectId = requestedSubject?.id ?? person.primarySubjectId;
    if (!subjectId) continue;
    const subject = (store.subjects ?? []).find((candidate) => candidate.id === subjectId);
    if (!subject || (subject.status && subject.status !== "active")) continue;
    return { person, identity, subjectId };
  }
  if (requested) {
    const subject = (store.subjects ?? []).find((candidate) => candidate.id === requested);
    const person = subject?.personId ? (store.people ?? []).find((candidate) => candidate.id === subject.personId) : undefined;
    const identity = person ? identities.find((candidate) => candidate.personId === person.id) : undefined;
    if (person && identity && (!person.status || person.status === "active") && (!subject?.status || subject.status === "active")) {
      return { person, identity, subjectId: requested };
    }
  }
  return undefined;
}

function checkOwner(store: CapabilityStore | undefined, owner: ResolvedOwner | undefined, requested: string | undefined): CanaryCheck {
  if (!store) {
    return {
      id: "owner_provisioned",
      number: 3,
      label: "Owner is provisioned",
      status: "SKIP",
      reason: "capability store was unavailable after check 2",
    };
  }
  if (!owner) {
    return {
      id: "owner_provisioned",
      number: 3,
      label: "Owner is provisioned",
      status: "FAIL",
      reason: requested ? "the requested owner is not a linked Telegram person with an active subject" : "no Telegram-linked owner with an active primary subject exists",
      remediation: "Complete Telegram owner pairing/linking, set the person's primarySubjectId, and ensure the matching subject is active in the capability store.",
    };
  }
  return {
    id: "owner_provisioned",
    number: 3,
    label: "Owner is provisioned",
    status: "PASS",
    reason: `linked Telegram owner resolves to primary subject ${owner.subjectId}`,
    details: { subjectId: owner.subjectId, personId: owner.person.id },
  };
}

async function checkOwnerBaseline(
  socketPath: string | undefined,
  store: CapabilityStore | undefined,
  owner: ResolvedOwner | undefined,
  ipcReachable: boolean,
  cache: Map<string, CodexChatCapabilityCheckResult>,
  timeoutMs: number | undefined,
): Promise<CanaryCheck> {
  if (!owner) return skip(5, "owner_baseline", "Owner authorizes the runtime baseline", "no owner subject was resolved by check 3");
  if (!ipcReachable || !socketPath) return skip(5, "owner_baseline", "Owner authorizes the runtime baseline", "codex-chat IPC was unavailable after check 4");

  const results: Array<{ operation: string; liveAllowed: boolean; liveReason: string; localAllowed?: boolean; localReason?: string }> = [];
  for (const operation of BASELINE_OPERATIONS) {
    const resource = representativeBaselineResource(owner, operation);
    const key = ipcKey(owner.subjectId, operation);
    let live = cache.get(key);
    if (!live) {
      try {
        live = await checkCapability(socketPath, {
          brainSubjectId: owner.subjectId,
          operation,
          action: "*",
          resource,
        }, { timeoutMs });
        cache.set(key, live);
      } catch (error) {
        return {
          id: "owner_baseline",
          number: 5,
          label: "Owner authorizes the runtime baseline",
          status: "FAIL",
          reason: `check_capability failed while checking ${operation}: ${errorMessage(error)}`,
          remediation: `Restore IPC health at ${socketPath}, then rerun the canary.`,
        };
      }
    }
    const local = store ? evaluateAuthorization(store, {
      actor: { id: owner.subjectId, surfaceKind: "system", metadata: { brainSubjectId: owner.subjectId } },
      requirement: { operation, action: "*", resource },
    }) : undefined;
    results.push({
      operation,
      liveAllowed: live.allowed,
      liveReason: live.reason,
      localAllowed: local?.allowed,
      localReason: local?.reason,
    });
  }
  const missing = results.filter((result) => !result.liveAllowed).map((result) => result.operation);
  const drift = results.filter((result) => result.localAllowed !== undefined && result.localAllowed !== result.liveAllowed).map((result) => result.operation);
  if (missing.length > 0 || drift.length > 0) {
    const reasons = [
      ...(missing.length > 0 ? [`missing live grants: ${missing.join(", ")}`] : []),
      ...(drift.length > 0 ? [`store/live authorization mismatch: ${drift.join(", ")}`] : []),
    ];
    return {
      id: "owner_baseline",
      number: 5,
      label: "Owner authorizes the runtime baseline",
      status: "FAIL",
      reason: reasons.join("; "),
      remediation: missing.length > 0
        ? `Grant the owner exactly these capabilities with actions and selectors that cover the representative Telegram runtime resource: ${missing.join(", ")}.`
        : "Verify codex-chat [brain].storePath matches this canary's store and reload/restart codex-chat after correcting the config.",
      details: { subjectId: owner.subjectId, capabilities: results },
    };
  }
  return {
    id: "owner_baseline",
    number: 5,
    label: "Owner authorizes the runtime baseline",
    status: "PASS",
    reason: BASELINE_OPERATIONS.join(", "),
    details: { subjectId: owner.subjectId, capabilities: results },
  };
}

async function checkNegativeControl(
  socketPath: string | undefined,
  ipcReachable: boolean,
  cache: Map<string, CodexChatCapabilityCheckResult>,
  timeoutMs: number | undefined,
): Promise<CanaryCheck> {
  if (!ipcReachable || !socketPath) return skip(6, "negative_control", "Enforcement is actually on", "codex-chat IPC was unavailable after check 4");
  const key = ipcKey(ABSENT_SUBJECT, "telegram.event.receive");
  try {
    const result = cache.get(key) ?? await checkCapability(socketPath, {
      brainSubjectId: ABSENT_SUBJECT,
      operation: "telegram.event.receive",
      action: "*",
      resource: {},
    }, { timeoutMs });
    if (result.allowed) {
      return {
        id: "negative_control",
        number: 6,
        label: "Enforcement is actually on",
        status: "FAIL",
        reason: `${ABSENT_SUBJECT} was allowed telegram.event.receive`,
        remediation: "Enable [brain].enforcementEnabled and remove wildcard/open grants that authorize absent subjects; this instance is effectively open.",
        details: { subjectId: ABSENT_SUBJECT, operation: "telegram.event.receive", response: result },
      };
    }
    return {
      id: "negative_control",
      number: 6,
      label: "Enforcement is actually on",
      status: "PASS",
      reason: `${ABSENT_SUBJECT} was denied telegram.event.receive (${result.reason})`,
      details: { subjectId: ABSENT_SUBJECT, operation: "telegram.event.receive", response: result },
    };
  } catch (error) {
    return {
      id: "negative_control",
      number: 6,
      label: "Enforcement is actually on",
      status: "FAIL",
      reason: `negative-control check_capability failed: ${errorMessage(error)}`,
      remediation: `Restore IPC health at ${socketPath} and rerun the negative control.`,
    };
  }
}

async function checkBehaviorPack(config: ResolvedConfig, paths: CanaryPaths): Promise<CanaryCheck> {
  if (!config.parsed) return skip(7, "behavior_pack", "Behavior pack is present", "codex-chat config was unavailable after check 1");
  if (!paths.behaviorDir || !paths.behaviorEntrypoint) {
    return {
      id: "behavior_pack",
      number: 7,
      label: "Behavior pack is present",
      status: "FAIL",
      reason: "[behavior].dir or [behavior].entrypoint is empty",
      remediation: "Set [behavior].dir and entrypoint in the codex-chat TOML to the deployed, non-empty behavior pack entry file.",
    };
  }
  try {
    const metadata = await stat(paths.behaviorEntrypoint);
    if (!metadata.isFile() || metadata.size === 0) throw new Error("entrypoint is not a non-empty file");
    return {
      id: "behavior_pack",
      number: 7,
      label: "Behavior pack is present",
      status: "PASS",
      reason: `${paths.behaviorEntrypoint} is present and non-empty`,
      details: { behaviorDir: paths.behaviorDir, entrypointPath: paths.behaviorEntrypoint, sizeBytes: metadata.size },
    };
  } catch (error) {
    return {
      id: "behavior_pack",
      number: 7,
      label: "Behavior pack is present",
      status: "FAIL",
      reason: `behavior entrypoint is missing, unreadable, or empty: ${paths.behaviorEntrypoint} (${errorMessage(error)})`,
      remediation: "Deploy the behavior pack and point [behavior].dir/entrypoint at its non-empty entry file.",
    };
  }
}

async function checkLiveState(config: ResolvedConfig, paths: CanaryPaths, owner: ResolvedOwner | undefined, options: CanaryOptions): Promise<CanaryCheck> {
  if (!config.parsed || !paths.stateRoot) return skip(8, "live_confirmation", "Recent live owner message completed end-to-end", "stateDir could not be resolved from the codex-chat config");
  if (!owner) return skip(8, "live_confirmation", "Recent live owner message completed end-to-end", "owner was not resolved by check 3");
  let sinceMs: number;
  try {
    sinceMs = parseDuration(options.since ?? "10m");
  } catch (error) {
    return {
      id: "live_confirmation",
      number: 8,
      label: "Recent live owner message completed end-to-end",
      status: "FAIL",
      reason: errorMessage(error),
      remediation: "Pass --since as a positive duration such as 30s, 10m, 2h, or 1d.",
    };
  }
  const cutoff = (options.now ?? new Date()).getTime() - sinceMs;
  const turnsDir = path.join(paths.stateRoot, "turns");
  const outboundDir = path.join(paths.stateRoot, "outbound_messages");
  const decisionsDir = path.join(paths.stateRoot, "capability_decisions");
  if (!await isDirectory(turnsDir) || !await isDirectory(outboundDir) || !await isDirectory(decisionsDir)) {
    return skip(
      8,
      "live_confirmation",
      "Recent live owner message completed end-to-end",
      `codex-chat state layout is incomplete; expected readable turns/, outbound_messages/, and capability_decisions/ under ${paths.stateRoot}`,
    );
  }

  const telegramUserId = owner.identity.providerUserId;
  const telegramChatId = owner.identity.providerChatId ?? telegramUserId;
  const turns = await readJsonFiles(turnsDir);
  const candidates = turns
    .filter((turn) => {
      const input = asRecord(turn.input);
      const timestamp = dateValue(turn.completedAt) ?? dateValue(turn.startedAt) ?? dateValue(input?.receivedAt);
      return turn.status === "completed"
        && input?.source === "telegram"
        && String(input.userId ?? "") === telegramUserId
        && Boolean(timestamp && timestamp >= cutoff);
    })
    .sort((a, b) => (dateValue(b.completedAt) ?? 0) - (dateValue(a.completedAt) ?? 0));
  const decisions = await readJsonLines(decisionsDir);
  const outbound = await readJsonFiles(outboundDir);
  for (const turn of candidates) {
    const input = asRecord(turn.input);
    const inboundAt = dateValue(input?.receivedAt) ?? dateValue(turn.startedAt) ?? cutoff;
    const completedAt = dateValue(turn.completedAt) ?? Date.now();
    const ownerDecision = (operation: string): boolean => decisions.some((decision) => {
      const checkedAt = dateValue(decision.checkedAt) ?? dateValue(decision.recordedAt);
      const brainSubjects = Array.isArray(decision.brainSubjectIds) ? decision.brainSubjectIds : [];
      const matchesOwner = decision.actorId === `telegram:user:${telegramUserId}` || brainSubjects.includes(owner.subjectId);
      return matchesOwner
        && decision.operation === operation
        && decision.allowed === true
        && decision.caller !== "ipc_check"
        && Boolean(checkedAt && checkedAt >= inboundAt && checkedAt <= completedAt);
    });
    const reply = outbound.find((message) =>
      message.platform === "telegram"
      && String(message.chatId ?? "") === telegramChatId
      && Boolean((dateValue(message.sentAt) ?? 0) >= inboundAt)
      && Boolean((dateValue(message.sentAt) ?? 0) <= completedAt),
    );
    if (ownerDecision("telegram.event.receive") && ownerDecision("assistant.run") && reply) {
      return {
        id: "live_confirmation",
        number: 8,
        label: "Recent live owner message completed end-to-end",
        status: "PASS",
        reason: `a recent owner Telegram turn was authorized for receive+run, completed, and produced an outbound reply within ${options.since ?? "10m"}`,
        details: { stateRoot: paths.stateRoot, turnId: stringValue(turn.id), since: options.since ?? "10m" },
      };
    }
  }
  return {
    id: "live_confirmation",
    number: 8,
    label: "Recent live owner message completed end-to-end",
    status: "FAIL",
    reason: `no owner Telegram turn within ${options.since ?? "10m"} had authorized receive+run decisions, a completed turn, and an outbound reply`,
    remediation: "Send the bot a real owner message, wait for its reply, then rerun brainctl canary --live with a suitable --since window.",
    details: { stateRoot: paths.stateRoot, recentOwnerCompletedTurns: candidates.length, since: options.since ?? "10m" },
  };
}

async function readJsonFiles(directory: string): Promise<Record<string, unknown>[]> {
  const names = await readdir(directory).catch(() => []);
  const values: Record<string, unknown>[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = await readJsonRecord(path.join(directory, name));
    if (parsed) values.push(parsed);
  }
  return values;
}

async function readJsonLines(directory: string): Promise<Record<string, unknown>[]> {
  const names = await readdir(directory).catch(() => []);
  const values: Record<string, unknown>[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const text = await readFile(path.join(directory, name), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed)) values.push(parsed);
      } catch {
        // A partially-written or unrelated malformed audit line cannot prove a live turn.
      }
    }
  }
  return values;
}

function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`invalid --since duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (!(amount > 0)) throw new Error(`invalid --since duration: ${value}`);
  return amount * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "s" | "m" | "h" | "d"]);
}

function ipcKey(subjectId: string, operation: string): string {
  return `${subjectId}\0${operation}`;
}

function skip(number: number, id: string, label: string, reason: string): CanaryCheck {
  return { id, number, label, status: "SKIP", reason };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isReadableFile(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.R_OK);
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function readJsonRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function dateValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
