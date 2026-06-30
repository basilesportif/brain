import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveEnvFilePath } from "./env-file.js";

export interface CapabilityResourceSelector {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  description: string;
  examples: string[];
}

export interface CapabilityCatalogCapability {
  id: string;
  label: string;
  description: string;
  actions: string[];
  resourceSelectors: CapabilityResourceSelector[];
  status: "active" | "placeholder";
  sensitivity: "standard" | "high";
}

export interface CapabilityCatalogGroup {
  id: string;
  label: string;
  description: string;
  status: "active" | "placeholder";
  grantable: true;
  resourceSelectors: CapabilityResourceSelector[];
  semantics: {
    grantKind: "group";
    implies: "all_children";
    impliedCapabilityIds: string[];
    inheritance: string;
    positiveGrantOnly: true;
  };
  children: CapabilityCatalogCapability[];
}

export interface CapabilitySubject {
  id: string;
  kind: "admin_user" | "slack_workspace" | "slack_user" | "slack_channel" | "system";
  label: string;
  description: string;
  source: string;
  externalIds?: Record<string, string>;
}

export interface CapabilityGrant {
  id: string;
  subjectId: string;
  capabilityId: string;
  grantKind: "group" | "capability";
  resource: {
    kind: string;
    id: string;
    selectors: Record<string, string>;
  };
  actions: string[];
  source: {
    kind: "seed" | "admin" | "bundle" | "migration" | "chat_approval" | "system";
    id: string;
  };
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  status: "active" | "revoked" | "expired" | "example";
  reason: string;
  enforcement: "non_enforcing";
}

export interface CapabilityAuditEventType {
  type: string;
  description: string;
  decisionValues: string[];
}

export interface CapabilityAuditShape {
  appendOnly: true;
  writesEnabled: false;
  path: string;
  values: string;
  requiredFields: string[];
  eventTypes: CapabilityAuditEventType[];
  sampleEvent: Record<string, unknown>;
}

interface CapabilityStore {
  schemaVersion: 1;
  storeId: string;
  mode: "read_only_seed";
  createdAt: string;
  updatedAt: string;
  writesEnabled: false;
  enforcementEnabled: false;
  subjects: CapabilitySubject[];
  grants: CapabilityGrant[];
  audit: CapabilityAuditShape;
  notes: string[];
}

export interface CapabilityEffectiveEntry {
  capabilityId: string;
  effective: boolean;
  directGrantIds: string[];
  directGroupGrantIds: string[];
  impliedByGroupGrantIds: string[];
  impliedByCapabilityIds: string[];
}

export interface CapabilityEffectiveSubject {
  subjectId: string;
  directGrantIds: string[];
  directCapabilityIds: string[];
  directGroupCapabilityIds: string[];
  impliedCapabilityIds: string[];
  byCapabilityId: Record<string, CapabilityEffectiveEntry>;
}

export interface CapabilityAdminSummary {
  schemaVersion: 1;
  source: "brain-private-file";
  path: string;
  values: string;
  mode: "read_only_seed";
  writesEnabled: false;
  enforcement: {
    enabled: false;
    runtime: "not_connected";
    codexChatChanged: false;
    summary: string;
  };
  catalog: {
    schemaVersion: 1;
    groups: CapabilityCatalogGroup[];
    counts: {
      groups: number;
      capabilities: number;
      activeCapabilities: number;
      placeholderCapabilities: number;
    };
  };
  store: {
    path: string;
    present: boolean;
    mode?: string;
    size?: number;
    storeId: string;
    createdAt: string;
    updatedAt: string;
    seededThisRequest: boolean;
    parseError?: string;
  };
  defaultSubjectId: string;
  subjects: CapabilitySubject[];
  grants: CapabilityGrant[];
  effectiveBySubject: Record<string, CapabilityEffectiveSubject>;
  audit: CapabilityAuditShape;
  nextOptions: string[];
}

export interface CapabilityAdminSummaryOptions {
  storePath: string;
  auditLogPath: string;
  adminEmail: string;
}

const SEED_TIME = "2026-06-30T00:00:00.000Z";
const CURRENT_ADMIN_SUBJECT_ID = "brain-admin:current";

const projectSelectors = [
  selector("projectId", "Project", "project", true, "Stable project/resource id, not a free-form prompt label.", ["brain", "codex-chat", "assistant-agent-logic"]),
  selector("repoAlias", "Repo alias", "repo", false, "Repo-registry alias when the capability is tied to a checkout.", ["brain", "codex-chat"]),
  selector("path", "Path prefix", "path", false, "Optional path prefix for narrower file/project operations.", ["plans/", "apps/web/"]),
];

const slackSelectors = [
  selector("teamId", "Slack workspace/team", "slack_team", true, "Slack team/workspace id.", ["T0123456789"]),
  selector("channelId", "Slack channel", "slack_channel", false, "Slack channel, DM, MPIM, or private-channel id.", ["C0123456789", "D0123456789"]),
  selector("threadTs", "Slack thread timestamp", "slack_thread", false, "Thread timestamp when a grant is narrowed to one thread.", ["1717000000.000000"]),
];

const catalogGroups = [
  group({
    id: "projects",
    label: "Projects",
    description: "Top-level project capability group. A group grant visibly implies every project child capability in this catalog, including writing project files, tasks, and artifacts.",
    status: "active",
    resourceSelectors: projectSelectors,
    children: [
      capability("projects.project.read", "Read project context", "Read project metadata, plans, docs, and non-secret repository context.", ["read", "search"], projectSelectors),
      capability("projects.project.write", "Write project state", "Create or update project plans, docs, and tracked project metadata.", ["write"], projectSelectors),
      capability("projects.files.write", "Write project files", "Edit files in a project checkout when the runtime/user has an approved workspace scope.", ["write"], projectSelectors),
      capability("projects.tasks.write", "Write project tasks", "Create, update, or close project task/checklist items.", ["write"], projectSelectors),
      capability("projects.artifacts.publish", "Publish project artifacts", "Stage or publish generated artifacts that are attached to a project.", ["write", "publish"], projectSelectors),
    ],
  }),
  group({
    id: "crm",
    label: "CRM",
    description: "Customer/contact relationship data. Included now as a Brain-owned catalog family; no CRM backend is connected in this slice.",
    status: "active",
    resourceSelectors: [
      selector("workspaceId", "CRM workspace", "crm_workspace", true, "CRM workspace/account boundary.", ["personal", "company"]),
      selector("contactId", "Contact", "crm_contact", false, "Specific contact/account id.", ["contact_123"]),
    ],
    children: [
      capability("crm.contact.read", "Read contacts", "Read contact, account, and relationship metadata.", ["read", "search"], [selector("contactId", "Contact", "crm_contact", false, "Specific contact/account id.", ["contact_123"])]),
      capability("crm.contact.write", "Write contacts", "Create or update contact/account metadata.", ["write"], [selector("contactId", "Contact", "crm_contact", false, "Specific contact/account id.", ["contact_123"])]),
      capability("crm.note.write", "Write CRM notes", "Append relationship notes without exposing unrelated CRM records.", ["write"], [selector("contactId", "Contact", "crm_contact", true, "Specific contact/account id.", ["contact_123"])]),
    ],
  }),
  group({
    id: "calendar",
    label: "Calendar",
    description: "Calendar availability and event operations. Read/write semantics are separated so future runtime tools can fail closed per action.",
    status: "active",
    resourceSelectors: [
      selector("calendarId", "Calendar", "calendar", true, "Calendar account or calendar id.", ["primary", "family"]),
      selector("eventId", "Event", "calendar_event", false, "Specific event id for narrowed grants.", ["event_123"]),
    ],
    children: [
      capability("calendar.availability.read", "Read availability", "Read free/busy windows without exposing full event details unless separately granted.", ["read"], [selector("calendarId", "Calendar", "calendar", true, "Calendar account or calendar id.", ["primary"])]),
      capability("calendar.event.read", "Read events", "Read event details for the selected calendar/resource.", ["read", "search"], [selector("calendarId", "Calendar", "calendar", true, "Calendar account or calendar id.", ["primary"])]),
      capability("calendar.event.write", "Write events", "Create, update, or cancel calendar events.", ["write"], [selector("calendarId", "Calendar", "calendar", true, "Calendar account or calendar id.", ["primary"])]),
    ],
  }),
  group({
    id: "slack",
    label: "Slack",
    description: "Slack source-context and output-target capabilities. This catalog is observational only; codex-chat runtime authorization is not connected yet.",
    status: "active",
    resourceSelectors: slackSelectors,
    children: [
      capability("slack.source.read", "Read source conversation", "Read only the originating Slack conversation/thread context for a run.", ["read"], slackSelectors),
      capability("slack.channel.read", "Read channel context", "Read bounded Slack channel history when explicitly granted.", ["read", "search"], slackSelectors),
      capability("slack.thread.read", "Read thread context", "Read bounded Slack thread history when explicitly granted.", ["read", "search"], slackSelectors),
      capability("slack.channel.post", "Post to channel", "Send an output to an explicitly selected Slack channel.", ["post"], slackSelectors),
      capability("slack.thread.reply", "Reply in thread", "Send an output to an explicitly selected Slack thread.", ["post"], slackSelectors),
    ],
  }),
  group({
    id: "todos",
    label: "Todos",
    description: "Personal or team todo/list state. Included to validate resource selectors before a live task backend is connected.",
    status: "active",
    resourceSelectors: [
      selector("listId", "Todo list", "todo_list", true, "Todo list id or namespace.", ["personal", "work"]),
      selector("itemId", "Todo item", "todo_item", false, "Specific todo item id.", ["todo_123"]),
    ],
    children: [
      capability("todos.item.read", "Read todos", "Read todo lists and item metadata.", ["read", "search"], [selector("listId", "Todo list", "todo_list", true, "Todo list id or namespace.", ["personal"])]),
      capability("todos.item.write", "Write todos", "Create, update, complete, or reopen todo items.", ["write"], [selector("listId", "Todo list", "todo_list", true, "Todo list id or namespace.", ["personal"])]),
      capability("todos.list.manage", "Manage todo lists", "Create, rename, archive, or share todo lists.", ["manage"], [selector("listId", "Todo list", "todo_list", false, "Todo list id or namespace.", ["personal"])]),
    ],
  }),
  group({
    id: "finance",
    label: "Finance",
    description: "High-sensitivity finance placeholders. Present so the catalog can model sensitive resources without connecting any finance data.",
    status: "placeholder",
    resourceSelectors: [
      selector("accountId", "Financial account", "finance_account", true, "Financial account/resource id.", ["acct_placeholder"]),
      selector("timeRange", "Time range", "time_range", false, "Bounded time range for future reads.", ["2026-06"]),
    ],
    children: [
      capability("finance.summary.read", "Read finance summaries", "Placeholder for summary-only finance reads.", ["read"], [selector("accountId", "Financial account", "finance_account", true, "Financial account/resource id.", ["acct_placeholder"])], "placeholder", "high"),
      capability("finance.transaction.read", "Read transactions", "Placeholder for high-sensitivity transaction reads.", ["read", "search"], [selector("accountId", "Financial account", "finance_account", true, "Financial account/resource id.", ["acct_placeholder"])], "placeholder", "high"),
    ],
  }),
  group({
    id: "health",
    label: "Health",
    description: "High-sensitivity health placeholders. No health backend is connected; this only reserves explicit read/write vocabulary.",
    status: "placeholder",
    resourceSelectors: [
      selector("profileId", "Health profile", "health_profile", true, "Health profile/person boundary.", ["profile_placeholder"]),
      selector("recordId", "Health record", "health_record", false, "Specific health record id.", ["record_placeholder"]),
    ],
    children: [
      capability("health.summary.read", "Read health summaries", "Placeholder for summary-only health reads.", ["read"], [selector("profileId", "Health profile", "health_profile", true, "Health profile/person boundary.", ["profile_placeholder"])], "placeholder", "high"),
      capability("health.record.read", "Read health records", "Placeholder for high-sensitivity health record reads.", ["read", "search"], [selector("profileId", "Health profile", "health_profile", true, "Health profile/person boundary.", ["profile_placeholder"])], "placeholder", "high"),
    ],
  }),
  group({
    id: "capability-admin",
    label: "Capability administration",
    description: "Admin/catalog/audit operations for future grant management. Writes remain disabled in this slice.",
    status: "active",
    resourceSelectors: [
      selector("adminScope", "Admin scope", "admin_scope", true, "Control-plane scope for catalog, grant, and audit operations.", ["brain-local"]),
    ],
    children: [
      capability("capability.catalog.read", "Read capability catalog", "Read the Brain-owned catalog, grant vocabulary, and store metadata.", ["read"], [selector("adminScope", "Admin scope", "admin_scope", true, "Control-plane scope.", ["brain-local"])]),
      capability("capability.grant.propose", "Propose grants", "Draft grant proposals for review without applying runtime enforcement.", ["propose"], [selector("adminScope", "Admin scope", "admin_scope", true, "Control-plane scope.", ["brain-local"])]),
      capability("audit.capability.read", "Read capability audit", "Read redacted capability audit records and event schemas.", ["read", "audit"], [selector("adminScope", "Admin scope", "admin_scope", true, "Control-plane scope.", ["brain-local"])]),
    ],
  }),
];

export const CAPABILITY_CATALOG: CapabilityCatalogGroup[] = catalogGroups;

const AUDIT_EVENT_TYPES: CapabilityAuditEventType[] = [
  {
    type: "capability.catalog.viewed",
    description: "Optional future view event for catalog reads. The current GET endpoint does not append this on every refresh.",
    decisionValues: ["observed"],
  },
  {
    type: "capability.grant.proposed",
    description: "A non-enforcing grant proposal was drafted for admin review.",
    decisionValues: ["proposed"],
  },
  {
    type: "capability.grant.applied",
    description: "A grant was applied to the Brain capability store after explicit admin confirmation.",
    decisionValues: ["granted"],
  },
  {
    type: "capability.grant.revoked",
    description: "A grant was revoked or expired after explicit admin confirmation or scheduled expiry.",
    decisionValues: ["revoked", "expired"],
  },
  {
    type: "capability.check.observed",
    description: "A runtime capability check result was imported or observed without logging secrets or payload bodies.",
    decisionValues: ["allowed", "denied", "not_enforced"],
  },
  {
    type: "capability.output.observed",
    description: "An output send target was observed with the capability/resource labels that would be checked by runtime enforcement.",
    decisionValues: ["sent", "blocked", "not_enforced"],
  },
];

const AUDIT_REQUIRED_FIELDS = [
  "eventId",
  "timestamp",
  "actor",
  "subject",
  "capabilityId",
  "resource",
  "action",
  "decision",
  "reason",
  "correlationId",
  "redaction",
];

export async function capabilityAdminSummary(options: CapabilityAdminSummaryOptions): Promise<CapabilityAdminSummary> {
  const storePath = resolveEnvFilePath(options.storePath);
  const auditLogPath = resolveEnvFilePath(options.auditLogPath);
  const { store, seededThisRequest, parseError } = await readOrSeedCapabilityStore(storePath, auditLogPath);
  const metadata = await capabilityStoreMetadata(storePath);
  const subjects = store.subjects.map((subject) => subject.id === CURRENT_ADMIN_SUBJECT_ID
    ? { ...subject, label: `Current Brain admin (${sanitizeText(options.adminEmail, "allowlisted admin", 180)})` }
    : subject);
  const effectiveBySubject = buildEffectiveBySubject(subjects, store.grants, CAPABILITY_CATALOG);
  const capabilityCount = CAPABILITY_CATALOG.reduce((sum, item) => sum + item.children.length, 0);
  const placeholderCount = CAPABILITY_CATALOG.reduce((sum, item) => sum + item.children.filter((child) => child.status === "placeholder").length, 0);
  return {
    schemaVersion: 1,
    source: "brain-private-file",
    path: storePath,
    values: "read-only catalog/store; seed grants are non-enforcing examples; no secrets, tokens, message bodies, or runtime authorization decisions",
    mode: "read_only_seed",
    writesEnabled: false,
    enforcement: {
      enabled: false,
      runtime: "not_connected",
      codexChatChanged: false,
      summary: "Brain shows the catalog/store/admin surface only. codex-chat Slack behavior and authorization enforcement are unchanged.",
    },
    catalog: {
      schemaVersion: 1,
      groups: CAPABILITY_CATALOG,
      counts: {
        groups: CAPABILITY_CATALOG.length,
        capabilities: capabilityCount,
        activeCapabilities: capabilityCount - placeholderCount,
        placeholderCapabilities: placeholderCount,
      },
    },
    store: {
      path: storePath,
      present: metadata.present,
      mode: metadata.mode,
      size: metadata.size,
      storeId: store.storeId,
      createdAt: store.createdAt,
      updatedAt: store.updatedAt,
      seededThisRequest,
      parseError,
    },
    defaultSubjectId: CURRENT_ADMIN_SUBJECT_ID,
    subjects,
    grants: store.grants,
    effectiveBySubject,
    audit: store.audit,
    nextOptions: [
      "Validate this capability vocabulary against real Projects, Slack, CRM, Calendar, Todos, Finance, and Health workflows.",
      "Add explicit admin-only grant proposal/apply/revoke APIs with confirmation dialogs and append-only audit events.",
      "Import codex-chat runtime capability-check observations before turning on enforcement.",
      "Design bundles/roles that expand into ordinary per-capability grants instead of bypassing the model.",
      "Only after review, wire codex-chat runtime tools/output sends to fail-closed capability checks.",
    ],
  };
}

function selector(id: string, label: string, kind: string, required: boolean, description: string, examples: string[]): CapabilityResourceSelector {
  return { id, label, kind, required, description, examples };
}

function capability(
  id: string,
  label: string,
  description: string,
  actions: string[],
  resourceSelectors: CapabilityResourceSelector[],
  status: "active" | "placeholder" = "active",
  sensitivity: "standard" | "high" = "standard",
): CapabilityCatalogCapability {
  return { id, label, description, actions, resourceSelectors, status, sensitivity };
}

function group(input: Omit<CapabilityCatalogGroup, "grantable" | "semantics">): CapabilityCatalogGroup {
  return {
    ...input,
    grantable: true,
    semantics: {
      grantKind: "group",
      implies: "all_children",
      impliedCapabilityIds: input.children.map((child) => child.id),
      inheritance: "A positive group grant expands to every listed child capability at evaluation time; child rows remain visible so narrower grants can be audited independently.",
      positiveGrantOnly: true,
    },
  };
}

async function readOrSeedCapabilityStore(storePath: string, auditLogPath: string): Promise<{ store: CapabilityStore; seededThisRequest: boolean; parseError?: string }> {
  const raw = await readTextIfPresent(storePath);
  if (!raw) {
    const store = defaultCapabilityStore(auditLogPath);
    await writeCapabilityStore(storePath, store);
    return { store, seededThisRequest: true };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return { store: normalizeCapabilityStore(parsed, auditLogPath), seededThisRequest: false };
  } catch {
    return { store: defaultCapabilityStore(auditLogPath), seededThisRequest: false, parseError: "invalid_capability_store_json" };
  }
}

function defaultCapabilityStore(auditLogPath: string): CapabilityStore {
  return {
    schemaVersion: 1,
    storeId: "brain-local-capabilities-v1",
    mode: "read_only_seed",
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    writesEnabled: false,
    enforcementEnabled: false,
    subjects: [
      {
        id: CURRENT_ADMIN_SUBJECT_ID,
        kind: "admin_user",
        label: "Current Brain admin",
        description: "The allowlisted Clerk admin viewing this Brain control plane.",
        source: "clerk_allowlist",
      },
      {
        id: "slack:workspace:T00000000",
        kind: "slack_workspace",
        label: "Slack workspace placeholder",
        description: "Workspace-level Slack subject shape for future grants.",
        source: "seed_placeholder",
        externalIds: { teamId: "T00000000" },
      },
      {
        id: "slack:user:T00000000:U00000000",
        kind: "slack_user",
        label: "Slack user placeholder",
        description: "Slack user subject shape for future user-scoped grants.",
        source: "seed_placeholder",
        externalIds: { teamId: "T00000000", userId: "U00000000" },
      },
      {
        id: "slack:channel:T00000000:C00000000",
        kind: "slack_channel",
        label: "Slack channel placeholder",
        description: "Slack channel/chat subject shape for future channel-scoped grants.",
        source: "seed_placeholder",
        externalIds: { teamId: "T00000000", channelId: "C00000000" },
      },
      {
        id: "system:codex-chat-runtime",
        kind: "system",
        label: "codex-chat runtime placeholder",
        description: "Runtime/system subject shape for imported observations. No enforcement is connected in this slice.",
        source: "seed_placeholder",
      },
    ],
    grants: [
      {
        id: "grant_seed_current_admin_projects_group",
        subjectId: CURRENT_ADMIN_SUBJECT_ID,
        capabilityId: "projects",
        grantKind: "group",
        resource: { kind: "project", id: "*", selectors: { projectId: "*", repoAlias: "*" } },
        actions: ["read", "search", "write", "publish", "manage"],
        source: { kind: "seed", id: "phase-5-read-only-slice" },
        grantedBy: "system:seed",
        grantedAt: SEED_TIME,
        status: "active",
        reason: "Seed grant that demonstrates a top-level Projects group grant implying all project child capabilities.",
        enforcement: "non_enforcing",
      },
      {
        id: "grant_seed_current_admin_catalog_read",
        subjectId: CURRENT_ADMIN_SUBJECT_ID,
        capabilityId: "capability.catalog.read",
        grantKind: "capability",
        resource: { kind: "admin_scope", id: "brain-local", selectors: { adminScope: "brain-local" } },
        actions: ["read"],
        source: { kind: "seed", id: "phase-5-read-only-slice" },
        grantedBy: "system:seed",
        grantedAt: SEED_TIME,
        status: "active",
        reason: "Seed child-specific grant for reading the local capability catalog.",
        enforcement: "non_enforcing",
      },
      {
        id: "grant_seed_slack_channel_read_example",
        subjectId: "slack:channel:T00000000:C00000000",
        capabilityId: "slack.channel.read",
        grantKind: "capability",
        resource: { kind: "slack_channel", id: "T00000000:C00000000", selectors: { teamId: "T00000000", channelId: "C00000000" } },
        actions: ["read", "search"],
        source: { kind: "seed", id: "phase-5-read-only-slice" },
        grantedBy: "system:seed",
        grantedAt: SEED_TIME,
        status: "example",
        reason: "Example channel-scoped Slack grant shape only; not used by codex-chat runtime enforcement.",
        enforcement: "non_enforcing",
      },
    ],
    audit: defaultAuditShape(auditLogPath),
    notes: [
      "This is a Brain-local private seed store for Phase 5 UI validation.",
      "Grant writes are disabled; seed grants are examples and non-enforcing.",
      "Do not store tokens, secrets, Slack message bodies, health details, or financial transaction payloads here.",
    ],
  };
}

function defaultAuditShape(auditLogPath: string): CapabilityAuditShape {
  return {
    appendOnly: true,
    writesEnabled: false,
    path: auditLogPath,
    values: "schema persisted in private store; no grant mutation writes are enabled yet, so no capability audit events are appended by this UI slice",
    requiredFields: AUDIT_REQUIRED_FIELDS,
    eventTypes: AUDIT_EVENT_TYPES,
    sampleEvent: {
      eventId: "cap_evt_01HZ0000000000000000000000",
      timestamp: "2026-06-30T00:00:00.000Z",
      actor: { subjectId: CURRENT_ADMIN_SUBJECT_ID, kind: "admin_user" },
      subject: { subjectId: "slack:channel:T00000000:C00000000", kind: "slack_channel" },
      capabilityId: "slack.channel.read",
      resource: { kind: "slack_channel", id: "T00000000:C00000000", selectors: { teamId: "T00000000", channelId: "C00000000" } },
      action: "grant.proposed",
      decision: "proposed",
      reason: "admin-reviewed explicit grant request",
      correlationId: "corr_phase5_example",
      redaction: { secretValuesLogged: false, payloadBodiesLogged: false },
    },
  };
}

function normalizeCapabilityStore(value: unknown, auditLogPath: string): CapabilityStore {
  const fallback = defaultCapabilityStore(auditLogPath);
  if (!isRecord(value)) return fallback;
  return {
    schemaVersion: 1,
    storeId: sanitizeText(value.storeId, fallback.storeId, 120),
    mode: "read_only_seed",
    createdAt: sanitizeIso(value.createdAt, fallback.createdAt),
    updatedAt: sanitizeIso(value.updatedAt, fallback.updatedAt),
    writesEnabled: false,
    enforcementEnabled: false,
    subjects: normalizeSubjects(value.subjects, fallback.subjects),
    grants: normalizeGrants(value.grants, fallback.grants),
    audit: normalizeAudit(value.audit, fallback.audit),
    notes: Array.isArray(value.notes) ? value.notes.map((item) => sanitizeText(item, "", 500)).filter(Boolean) : fallback.notes,
  };
}

function normalizeSubjects(value: unknown, fallback: CapabilitySubject[]): CapabilitySubject[] {
  if (!Array.isArray(value)) return fallback;
  const out: CapabilitySubject[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = sanitizeSubjectKind(item.kind);
    if (!kind) continue;
    const id = sanitizeSubjectId(item.id);
    if (!id) continue;
    const subject: CapabilitySubject = {
      id,
      kind,
      label: sanitizeText(item.label, id, 160),
      description: sanitizeText(item.description, "", 400),
      source: sanitizeText(item.source, "manual", 80),
    };
    const externalIds = normalizeStringRecord(item.externalIds);
    if (externalIds) subject.externalIds = externalIds;
    out.push(subject);
  }
  return out.some((item) => item.id === CURRENT_ADMIN_SUBJECT_ID) ? out : fallback;
}

function normalizeGrants(value: unknown, fallback: CapabilityGrant[]): CapabilityGrant[] {
  if (!Array.isArray(value)) return fallback;
  const out: CapabilityGrant[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = sanitizeGrantId(item.id);
    const subjectId = sanitizeSubjectId(item.subjectId);
    const capabilityId = sanitizeCapabilityId(item.capabilityId);
    if (!id || !subjectId || !capabilityId) continue;
    const grant: CapabilityGrant = {
      id,
      subjectId,
      capabilityId,
      grantKind: item.grantKind === "group" ? "group" : "capability",
      resource: normalizeGrantResource(item.resource),
      actions: normalizeStringArray(item.actions, 20),
      source: normalizeGrantSource(item.source),
      grantedBy: sanitizeSubjectId(item.grantedBy) || "unknown",
      grantedAt: sanitizeIso(item.grantedAt, SEED_TIME),
      status: sanitizeGrantStatus(item.status),
      reason: sanitizeText(item.reason, "", 500),
      enforcement: "non_enforcing",
    };
    if (typeof item.expiresAt === "string") grant.expiresAt = sanitizeText(item.expiresAt, "", 80);
    if (typeof item.revokedAt === "string") grant.revokedAt = sanitizeText(item.revokedAt, "", 80);
    out.push(grant);
  }
  return out.length > 0 ? out : fallback;
}

function normalizeAudit(value: unknown, fallback: CapabilityAuditShape): CapabilityAuditShape {
  if (!isRecord(value)) return fallback;
  return {
    appendOnly: true,
    writesEnabled: false,
    path: sanitizeText(value.path, fallback.path, 400),
    values: sanitizeText(value.values, fallback.values, 500),
    requiredFields: Array.isArray(value.requiredFields) ? normalizeStringArray(value.requiredFields, 50) : fallback.requiredFields,
    eventTypes: fallback.eventTypes,
    sampleEvent: fallback.sampleEvent,
  };
}

function buildEffectiveBySubject(subjects: CapabilitySubject[], grants: CapabilityGrant[], catalog: CapabilityCatalogGroup[]): Record<string, CapabilityEffectiveSubject> {
  return Object.fromEntries(subjects.map((subject) => [subject.id, buildEffectiveForSubject(subject.id, grants, catalog)]));
}

function buildEffectiveForSubject(subjectId: string, grants: CapabilityGrant[], catalog: CapabilityCatalogGroup[]): CapabilityEffectiveSubject {
  const activeGrants = grants.filter((grant) => grant.subjectId === subjectId && (grant.status === "active" || grant.status === "example") && !grant.revokedAt);
  const directGrantIds: string[] = [];
  const directCapabilityIds = new Set<string>();
  const directGroupCapabilityIds = new Set<string>();
  const impliedCapabilityIds = new Set<string>();
  const byCapabilityId: Record<string, CapabilityEffectiveEntry> = {};
  const ensureEntry = (capabilityId: string): CapabilityEffectiveEntry => {
    byCapabilityId[capabilityId] ??= {
      capabilityId,
      effective: false,
      directGrantIds: [],
      directGroupGrantIds: [],
      impliedByGroupGrantIds: [],
      impliedByCapabilityIds: [],
    };
    return byCapabilityId[capabilityId];
  };
  for (const groupItem of catalog) {
    ensureEntry(groupItem.id);
    for (const child of groupItem.children) ensureEntry(child.id);
  }
  for (const grant of activeGrants) {
    directGrantIds.push(grant.id);
    const groupItem = catalog.find((item) => item.id === grant.capabilityId);
    const entry = ensureEntry(grant.capabilityId);
    entry.effective = true;
    entry.directGrantIds.push(grant.id);
    if (groupItem) {
      directGroupCapabilityIds.add(groupItem.id);
      entry.directGroupGrantIds.push(grant.id);
      for (const child of groupItem.children) {
        const childEntry = ensureEntry(child.id);
        childEntry.effective = true;
        childEntry.impliedByGroupGrantIds.push(grant.id);
        childEntry.impliedByCapabilityIds.push(groupItem.id);
        impliedCapabilityIds.add(child.id);
      }
    } else {
      directCapabilityIds.add(grant.capabilityId);
    }
  }
  return {
    subjectId,
    directGrantIds,
    directCapabilityIds: [...directCapabilityIds].sort(),
    directGroupCapabilityIds: [...directGroupCapabilityIds].sort(),
    impliedCapabilityIds: [...impliedCapabilityIds].sort(),
    byCapabilityId,
  };
}

async function writeCapabilityStore(filePath: string, store: CapabilityStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function capabilityStoreMetadata(filePath: string): Promise<{ present: boolean; mode?: string; size?: number }> {
  try {
    const info = await stat(filePath);
    return { present: true, mode: `0${(info.mode & 0o777).toString(8)}`, size: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    throw error;
  }
}

async function readTextIfPresent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function normalizeGrantResource(value: unknown): CapabilityGrant["resource"] {
  if (!isRecord(value)) return { kind: "unknown", id: "unknown", selectors: {} };
  return {
    kind: sanitizeText(value.kind, "unknown", 80),
    id: sanitizeText(value.id, "unknown", 160),
    selectors: normalizeStringRecord(value.selectors) ?? {},
  };
}

function normalizeGrantSource(value: unknown): CapabilityGrant["source"] {
  const fallback = { kind: "seed" as const, id: "unknown" };
  if (!isRecord(value)) return fallback;
  const kind = value.kind === "admin" || value.kind === "bundle" || value.kind === "migration" || value.kind === "chat_approval" || value.kind === "system" ? value.kind : "seed";
  return { kind, id: sanitizeText(value.id, "unknown", 120) };
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const safeKey = sanitizeText(key, "", 80);
    const safeValue = sanitizeText(item, "", 180);
    if (safeKey && safeValue) out[safeKey] = safeValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => sanitizeText(item, "", 120)).filter(Boolean);
}

function sanitizeSubjectKind(value: unknown): CapabilitySubject["kind"] | undefined {
  return value === "admin_user" || value === "slack_workspace" || value === "slack_user" || value === "slack_channel" || value === "system" ? value : undefined;
}

function sanitizeGrantStatus(value: unknown): CapabilityGrant["status"] {
  return value === "revoked" || value === "expired" || value === "example" ? value : "active";
}

function sanitizeSubjectId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9:_@./-]{1,180}$/i);
}

function sanitizeGrantId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9:_-]{1,180}$/i);
}

function sanitizeCapabilityId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9_.-]{1,120}$/i);
}

function sanitizePattern(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string") return "";
  const cleaned = sanitizeText(value, "", 200);
  return pattern.test(cleaned) ? cleaned : "";
}

function sanitizeIso(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = sanitizeText(value, fallback, 80);
  return /^\d{4}-\d{2}-\d{2}T/.test(cleaned) ? cleaned : fallback;
}

function sanitizeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const cleaned = redactSecretish(value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim());
  return (cleaned || fallback).slice(0, maxLength);
}

function redactSecretish(value: string): string {
  return value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "<redacted-openai-key>")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "<redacted-slack-token>")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted-jwt>");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
