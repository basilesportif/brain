import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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

export interface CapabilityResourceScopeMetadata {
  resourceKind: "global" | "project" | string;
  selectorId?: string;
  grantResourceIdPrefix?: string;
  wildcardGrantResourceId?: string;
  specificGrantResourceExample?: string;
  labels: {
    global: string;
    wildcard: string;
    specific: string;
  };
  description: string;
}

export interface CapabilityCatalogCapability {
  id: string;
  label: string;
  description: string;
  actions: string[];
  resourceSelectors: CapabilityResourceSelector[];
  resourceScope: CapabilityResourceScopeMetadata;
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
  resourceScope: CapabilityResourceScopeMetadata;
  semantics: {
    grantKind: "group";
    implies: "all_children";
    impliedCapabilityIds: string[];
    inheritance: string;
    positiveGrantOnly: true;
  };
  children: CapabilityCatalogCapability[];
}

export interface CapabilityProjectResourceOption {
  id: string;
  name: string;
  status: string;
  resourceScope: string;
}

export type CapabilityIdentityProvider = "telegram" | "slack" | "clerk" | "system" | "unknown";

export interface CapabilityPerson {
  id: string;
  displayName: string;
  status: "active" | "inactive" | "observed" | "placeholder";
  personType: "human" | "system";
  primarySubjectId: string;
  source: "admin_seed" | "telegram_allowlist_migration" | "migration" | "observed_runtime_metadata" | "manual_admin";
  identityIds: string[];
  subjectIds: string[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityExternalIdentity {
  id: string;
  provider: CapabilityIdentityProvider;
  providerUserId: string;
  providerTeamId?: string;
  providerChatId?: string;
  providerChannelId?: string;
  personId?: string;
  label: string;
  status: "linked" | "observed_unlinked" | "addable_placeholder" | "inactive";
  channelKinds: string[];
  communicationChannelIds: string[];
  proofIds: string[];
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface CapabilityIdentityProof {
  id: string;
  personId?: string;
  identityId: string;
  source: "telegram_allowlist_migration" | "admin_seed" | "slack_signed_event" | "observed_runtime_metadata" | "manual_admin" | "migration";
  confidence: "high" | "medium" | "low" | "placeholder";
  observedAt: string;
  summary: string;
  evidence: Record<string, string | number | boolean>;
}

export interface CapabilityCommunicationChannel {
  id: string;
  provider: CapabilityIdentityProvider;
  kind: "telegram_private_chat" | "slack_workspace" | "slack_channel" | "slack_dm" | "unknown";
  label: string;
  status: "linked" | "observed" | "addable_placeholder" | "inactive";
  identityIds: string[];
  externalIds: Record<string, string>;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface CapabilitySubject {
  id: string;
  kind: "person" | "external_identity" | "admin_user" | "slack_workspace" | "slack_user" | "slack_channel" | "system";
  label: string;
  description: string;
  source: string;
  personId?: string;
  identityId?: string;
  externalIds?: Record<string, string>;
}

export interface CapabilityGrantBundle {
  id: string;
  label: string;
  description: string;
  status: "active" | "placeholder";
  includes: {
    groupIds: string[];
    capabilityIds: string[];
  };
  semantics: {
    grantKind: "bundle";
    implies: "all_catalog_capabilities" | "listed_capabilities";
    expansion: string;
    positiveGrantOnly: true;
  };
}

export interface CapabilityGrant {
  id: string;
  subjectId: string;
  capabilityId: string;
  grantKind: "bundle" | "group" | "capability";
  bundleId?: string;
  resource: {
    kind: string;
    id: string;
    selectors: Record<string, string>;
  };
  actions: string[];
  source: {
    kind: "seed" | "admin" | "bundle" | "migration" | "chat_approval" | "system" | "identity_proof";
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
  schemaVersion: 2;
  storeId: string;
  mode: "identity_capability_foundation";
  createdAt: string;
  updatedAt: string;
  writesEnabled: false;
  enforcementEnabled: false;
  people: CapabilityPerson[];
  externalIdentities: CapabilityExternalIdentity[];
  identityProofs: CapabilityIdentityProof[];
  communicationChannels: CapabilityCommunicationChannel[];
  subjects: CapabilitySubject[];
  grantBundles: CapabilityGrantBundle[];
  grants: CapabilityGrant[];
  audit: CapabilityAuditShape;
  notes: string[];
  legacyStoreIds?: string[];
}

export interface CapabilityEffectiveEntry {
  capabilityId: string;
  effective: boolean;
  directGrantIds: string[];
  directBundleGrantIds: string[];
  directGroupGrantIds: string[];
  impliedByBundleGrantIds: string[];
  impliedByBundleIds: string[];
  impliedByGroupGrantIds: string[];
  impliedByCapabilityIds: string[];
}

export interface CapabilityEffectiveSubject {
  subjectId: string;
  directGrantIds: string[];
  directBundleGrantIds: string[];
  directBundleIds: string[];
  directCapabilityIds: string[];
  directGroupCapabilityIds: string[];
  impliedGroupCapabilityIds: string[];
  impliedCapabilityIds: string[];
  byCapabilityId: Record<string, CapabilityEffectiveEntry>;
  summary: {
    activeGrantCount: number;
    effectiveCapabilityCount: number;
    effectiveActiveCapabilityCount: number;
    totalCapabilityCount: number;
    activeCapabilityCount: number;
    placeholderCapabilityCount: number;
    allCapabilities: boolean;
    allActiveCapabilities: boolean;
    bundles: string[];
    enforcement: "non_enforcing";
  };
}

export interface CapabilityEffectivePerson {
  personId: string;
  subjectId: string;
  identityIds: string[];
  communicationChannelIds: string[];
  effective: CapabilityEffectiveSubject;
}

export interface CapabilityAdminWriteModel {
  writesEnabled: false;
  plannedEndpoints: Array<{ method: "POST" | "PATCH" | "DELETE"; path: string; purpose: string }>;
  mutationShapes: {
    linkIdentity: Record<string, string>;
    grantBundle: Record<string, string>;
    grantCapability: Record<string, string>;
    revokeGrant: Record<string, string>;
  };
}

export interface CapabilityAdminSummary {
  schemaVersion: 2;
  source: "brain-private-file";
  path: string;
  values: string;
  mode: "identity_capability_foundation";
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
  projectResources: {
    sourcePath?: string;
    loaded: boolean;
    count: number;
    projects: CapabilityProjectResourceOption[];
    error?: string;
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
    migratedThisRequest: boolean;
    parseError?: string;
  };
  defaultSubjectId: string;
  defaultPersonId: string;
  people: CapabilityPerson[];
  externalIdentities: CapabilityExternalIdentity[];
  identityProofs: CapabilityIdentityProof[];
  communicationChannels: CapabilityCommunicationChannel[];
  subjects: CapabilitySubject[];
  grantBundles: CapabilityGrantBundle[];
  grants: CapabilityGrant[];
  effectiveBySubject: Record<string, CapabilityEffectiveSubject>;
  effectiveByPerson: Record<string, CapabilityEffectivePerson>;
  audit: CapabilityAuditShape;
  adminWriteModel: CapabilityAdminWriteModel;
  nextOptions: string[];
}

export interface CapabilityAdminSummaryOptions {
  storePath: string;
  auditLogPath: string;
  adminEmail: string;
  codexChatPath?: string;
  workspacePath?: string;
}

interface ReadStoreResult {
  store: CapabilityStore;
  seededThisRequest: boolean;
  migratedThisRequest: boolean;
  parseError?: string;
}

interface ObservedSlackIdentity {
  providerTeamId: string;
  providerUserId: string;
  channelIds: string[];
  eventCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sourcePath: string;
  correlationIds: string[];
}

interface ObservedSlackState {
  status: "not_observed" | "single_signed_user" | "multiple_signed_users" | "unreadable";
  observedIdentities: ObservedSlackIdentity[];
  linkableIdentity?: ObservedSlackIdentity;
  sourcePath?: string;
  error?: string;
}

const SEED_TIME = "2026-06-30T00:00:00.000Z";
const CURRENT_ADMIN_SUBJECT_ID = "brain-admin:current";
const TIM_PERSON_ID = "person_tim";
const TIM_SUBJECT_ID = "person:person_tim";
const TIM_TELEGRAM_USER_ID = "253768951";
const TIM_TELEGRAM_CHAT_ID = "253768951";
const TIM_TELEGRAM_IDENTITY_ID = "identity_telegram_253768951";
const TIM_TELEGRAM_CHANNEL_ID = "channel_telegram_private_253768951";
const TIM_TELEGRAM_PROOF_ID = "proof_tim_telegram_allowlist_migration";
const OWNER_ALL_BUNDLE_ID = "bundle.owner.all";

const GLOBAL_RESOURCE_SCOPE: CapabilityResourceScopeMetadata = {
  resourceKind: "global",
  wildcardGrantResourceId: "global:*",
  labels: {
    global: "Global",
    wildcard: "All resources",
    specific: "Specific resource",
  },
  description: "Global capability scope. Grants use global:* when no narrower resource boundary is modeled yet.",
};

const PROJECT_RESOURCE_SCOPE: CapabilityResourceScopeMetadata = {
  resourceKind: "project",
  selectorId: "projectId",
  grantResourceIdPrefix: "project:",
  wildcardGrantResourceId: "project:*",
  specificGrantResourceExample: "project:pj_1234567890abcdef",
  labels: {
    global: "Global project catalog",
    wildcard: "All projects",
    specific: "Specific project",
  },
  description: "Project granularity is modeled by generic project capability IDs plus grant resource ids project:* or project:<projectId>; per-project capability IDs are not generated.",
};

const PROJECT_CAPABILITY_ID_MIGRATIONS: Record<string, string> = {
  "projects.project.read": "projects.read",
  "projects.project.write": "projects.write",
};

const projectSelectors = [
  selector("projectId", "Project", "project", true, "Stable workspace project id. Use * for all projects; specific grants are resource-scoped as project:<projectId>.", ["*", "pj_47da1852cb41f0e3"]),
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
    resourceScope: PROJECT_RESOURCE_SCOPE,
    children: [
      capability("projects.read", "Read project context", "Read project metadata, plans, docs, and non-secret repository context.", ["read", "search"], projectSelectors, "active", "standard", PROJECT_RESOURCE_SCOPE),
      capability("projects.write", "Write project state", "Create or update project plans, docs, and tracked project metadata.", ["write"], projectSelectors, "active", "standard", PROJECT_RESOURCE_SCOPE),
      capability("projects.files.write", "Write project files", "Edit files in a project checkout when the runtime/user has an approved workspace scope.", ["write"], projectSelectors, "active", "standard", PROJECT_RESOURCE_SCOPE),
      capability("projects.tasks.write", "Write project tasks", "Create, update, or close project task/checklist items.", ["write"], projectSelectors, "active", "standard", PROJECT_RESOURCE_SCOPE),
      capability("projects.artifacts.publish", "Publish project artifacts", "Stage or publish generated artifacts that are attached to a project.", ["write", "publish"], projectSelectors, "active", "standard", PROJECT_RESOURCE_SCOPE),
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
    type: "identity.link.seeded",
    description: "A person/external identity link was seeded or migrated with proof metadata; non-enforcing in this slice.",
    decisionValues: ["not_enforced", "linked"],
  },
  {
    type: "identity.proof.observed",
    description: "External identity proof metadata was observed from runtime telemetry without logging message bodies or secrets.",
    decisionValues: ["observed", "not_enforced"],
  },
  {
    type: "capability.bundle.granted",
    description: "A non-enforcing bundle grant was seeded or applied; effective view expands it into ordinary catalog capabilities.",
    decisionValues: ["granted", "not_enforced"],
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
  "identity",
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
  const observedSlack = await deriveObservedSlackState(options.codexChatPath);
  const projectResources = await readWorkspaceProjectResources(options.workspacePath);
  const { store, seededThisRequest, migratedThisRequest, parseError } = await readOrSeedCapabilityStore(storePath, auditLogPath, observedSlack);
  const metadata = await capabilityStoreMetadata(storePath);
  const subjects = store.subjects.map((subject) => subject.id === CURRENT_ADMIN_SUBJECT_ID
    ? { ...subject, label: `Current Brain admin (${sanitizeText(options.adminEmail, "allowlisted admin", 180)})` }
    : subject);
  const effectiveBySubject = buildEffectiveBySubject(subjects, store.grants, store.grantBundles, CAPABILITY_CATALOG);
  const effectiveByPerson = buildEffectiveByPerson(store.people, store.externalIdentities, store.communicationChannels, effectiveBySubject);
  const capabilityCount = catalogCapabilityIds(CAPABILITY_CATALOG).length;
  const placeholderCount = CAPABILITY_CATALOG.reduce((sum, item) => sum + item.children.filter((child) => child.status === "placeholder").length, 0);
  return {
    schemaVersion: 2,
    source: "brain-private-file",
    path: storePath,
    values: "identity/capability foundation store; writes and runtime enforcement disabled; no secrets, tokens, message bodies, or runtime authorization decisions",
    mode: "identity_capability_foundation",
    writesEnabled: false,
    enforcement: {
      enabled: false,
      runtime: "not_connected",
      codexChatChanged: false,
      summary: "Brain shows unified identities, catalog/store/admin surface only. codex-chat Slack/Telegram behavior and authorization enforcement are unchanged.",
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
    projectResources,
    store: {
      path: storePath,
      present: metadata.present,
      mode: metadata.mode,
      size: metadata.size,
      storeId: store.storeId,
      createdAt: store.createdAt,
      updatedAt: store.updatedAt,
      seededThisRequest,
      migratedThisRequest,
      parseError,
    },
    defaultSubjectId: TIM_SUBJECT_ID,
    defaultPersonId: TIM_PERSON_ID,
    people: store.people,
    externalIdentities: store.externalIdentities,
    identityProofs: store.identityProofs,
    communicationChannels: store.communicationChannels,
    subjects,
    grantBundles: store.grantBundles,
    grants: store.grants,
    effectiveBySubject,
    effectiveByPerson,
    audit: store.audit,
    adminWriteModel: defaultAdminWriteModel(),
    nextOptions: [
      "Review Tim's seeded Telegram owner identity and any Slack signed-event identity observation before enabling writes.",
      "Add explicit admin-only person/identity link and unlink APIs with confirmation dialogs and append-only audit events.",
      "Add grant proposal/apply/revoke APIs that write ordinary auditable capability grants; keep owner/all as a catalog bundle convenience, not an opaque Tim grant row.",
      "Import codex-chat runtime capability-check observations before turning on enforcement.",
      "Only after review, wire Telegram/Slack runtimes, tools, and output sends to fail-closed capability checks.",
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
  resourceScope: CapabilityResourceScopeMetadata = GLOBAL_RESOURCE_SCOPE,
): CapabilityCatalogCapability {
  return { id, label, description, actions, resourceSelectors, resourceScope, status, sensitivity };
}

function group(input: Omit<CapabilityCatalogGroup, "grantable" | "semantics" | "resourceScope"> & { resourceScope?: CapabilityResourceScopeMetadata }): CapabilityCatalogGroup {
  return {
    ...input,
    resourceScope: input.resourceScope ?? GLOBAL_RESOURCE_SCOPE,
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

async function readOrSeedCapabilityStore(storePath: string, auditLogPath: string, observedSlack: ObservedSlackState): Promise<ReadStoreResult> {
  const raw = await readTextIfPresent(storePath);
  if (!raw) {
    const store = defaultCapabilityStore(auditLogPath, observedSlack);
    await writeCapabilityStore(storePath, store);
    return { store, seededThisRequest: true, migratedThisRequest: false };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeCapabilityStore(parsed, auditLogPath, observedSlack);
    if (normalized.changed) await writeCapabilityStore(storePath, normalized.store);
    return { store: normalized.store, seededThisRequest: false, migratedThisRequest: normalized.migrated };
  } catch {
    return { store: defaultCapabilityStore(auditLogPath, observedSlack), seededThisRequest: false, migratedThisRequest: false, parseError: "invalid_capability_store_json" };
  }
}

function defaultCapabilityStore(auditLogPath: string, observedSlack: ObservedSlackState = { status: "not_observed", observedIdentities: [] }): CapabilityStore {
  const identitySeed = defaultIdentitySeed(observedSlack);
  const people = [
    {
      id: TIM_PERSON_ID,
      displayName: "Tim",
      status: "active",
      personType: "human",
      primarySubjectId: TIM_SUBJECT_ID,
      source: "admin_seed",
      identityIds: identitySeed.externalIdentities.filter((identity) => identity.personId === TIM_PERSON_ID).map((identity) => identity.id),
      subjectIds: [TIM_SUBJECT_ID],
      notes: ["Seeded as the owner/admin person for the non-enforcing Phase 5 identity/capability foundation."],
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    } satisfies CapabilityPerson,
  ];
  const identitySubjects = identitySeed.externalIdentities.map(identitySubjectFromIdentity);
  return {
    schemaVersion: 2,
    storeId: "brain-local-capabilities-v2",
    mode: "identity_capability_foundation",
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    writesEnabled: false,
    enforcementEnabled: false,
    people,
    externalIdentities: identitySeed.externalIdentities,
    identityProofs: identitySeed.identityProofs,
    communicationChannels: identitySeed.communicationChannels,
    subjects: [
      {
        id: TIM_SUBJECT_ID,
        kind: "person",
        label: "Tim",
        description: "Tim's unified person/user subject seeded for future runtime capability checks.",
        source: "admin_seed",
        personId: TIM_PERSON_ID,
      },
      ...identitySubjects,
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
    grantBundles: defaultGrantBundles(),
    grants: defaultCapabilityGrants(),
    audit: defaultAuditShape(auditLogPath),
    notes: [
      "This Brain-local private store is the non-enforcing Phase 5 foundation for unified people, external identities, capabilities, grants, proofs, and audit shape.",
      "Grant/link writes are disabled; seed grants are non-enforcing and runtime authorization remains disconnected.",
      "Tim owner/all seed is materialized as individual non-placeholder capability grants; generic project capabilities are broadly scoped with resource id project:* rather than per-project capability ids.",
      "Do not store tokens, secrets, Telegram or Slack message bodies, health details, or financial transaction payloads here.",
    ],
  };
}

function defaultIdentitySeed(observedSlack: ObservedSlackState): Pick<CapabilityStore, "externalIdentities" | "identityProofs" | "communicationChannels"> {
  const telegramIdentity: CapabilityExternalIdentity = {
    id: TIM_TELEGRAM_IDENTITY_ID,
    provider: "telegram",
    providerUserId: TIM_TELEGRAM_USER_ID,
    providerChatId: TIM_TELEGRAM_CHAT_ID,
    personId: TIM_PERSON_ID,
    label: "Tim Telegram (253768951)",
    status: "linked",
    channelKinds: ["telegram_private_chat"],
    communicationChannelIds: [TIM_TELEGRAM_CHANNEL_ID],
    proofIds: [TIM_TELEGRAM_PROOF_ID],
    metadata: { provider: "telegram", chatId: TIM_TELEGRAM_CHAT_ID, origin: "origin_message", chatType: "private" },
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  };
  const telegramProof: CapabilityIdentityProof = {
    id: TIM_TELEGRAM_PROOF_ID,
    personId: TIM_PERSON_ID,
    identityId: TIM_TELEGRAM_IDENTITY_ID,
    source: "telegram_allowlist_migration",
    confidence: "high",
    observedAt: SEED_TIME,
    summary: "Tim explicitly requested linking this Brain user to Telegram user_id/chat_id 253768951 in the origin task.",
    evidence: { provider: "telegram", providerUserId: TIM_TELEGRAM_USER_ID, chatId: TIM_TELEGRAM_CHAT_ID, payloadBodiesLogged: false, secretValuesLogged: false },
  };
  const telegramChannel: CapabilityCommunicationChannel = {
    id: TIM_TELEGRAM_CHANNEL_ID,
    provider: "telegram",
    kind: "telegram_private_chat",
    label: "Telegram private chat 253768951",
    status: "linked",
    identityIds: [TIM_TELEGRAM_IDENTITY_ID],
    externalIds: { userId: TIM_TELEGRAM_USER_ID, chatId: TIM_TELEGRAM_CHAT_ID },
    metadata: { chatType: "private", provider: "telegram" },
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  };

  const externalIdentities = [telegramIdentity];
  const identityProofs = [telegramProof];
  const communicationChannels = [telegramChannel];
  if (observedSlack.linkableIdentity) {
    const slack = linkedSlackIdentityForTim(observedSlack.linkableIdentity);
    externalIdentities.push(slack.identity);
    identityProofs.push(slack.proof);
    communicationChannels.push(...slack.channels);
  } else if (observedSlack.observedIdentities.length > 0) {
    for (const observed of observedSlack.observedIdentities) {
      const slack = observedUnlinkedSlackIdentity(observed);
      externalIdentities.push(slack.identity);
      identityProofs.push(slack.proof);
      communicationChannels.push(...slack.channels);
    }
  } else {
    const placeholder = slackAddablePlaceholder();
    externalIdentities.push(placeholder.identity);
    identityProofs.push(placeholder.proof);
    communicationChannels.push(placeholder.channel);
  }
  return { externalIdentities, identityProofs, communicationChannels };
}

function linkedSlackIdentityForTim(observed: ObservedSlackIdentity): { identity: CapabilityExternalIdentity; proof: CapabilityIdentityProof; channels: CapabilityCommunicationChannel[] } {
  const identityId = slackIdentityId(observed.providerTeamId, observed.providerUserId);
  const proofId = `proof_tim_${identityId}`;
  const channelIds = observed.channelIds.map((channelId) => slackChannelId(observed.providerTeamId, channelId));
  const identity: CapabilityExternalIdentity = {
    id: identityId,
    provider: "slack",
    providerUserId: observed.providerUserId,
    providerTeamId: observed.providerTeamId,
    personId: TIM_PERSON_ID,
    label: `Tim Slack (${observed.providerTeamId}/${observed.providerUserId})`,
    status: "linked",
    channelKinds: ["slack_workspace", "slack_channel"],
    communicationChannelIds: channelIds.length ? channelIds : [slackWorkspaceChannelId(observed.providerTeamId)],
    proofIds: [proofId],
    metadata: { teamId: observed.providerTeamId, source: "codex-chat-slack-telemetry", eventCount: String(observed.eventCount) },
    createdAt: observed.firstSeenAt,
    updatedAt: observed.lastSeenAt,
    lastSeenAt: observed.lastSeenAt,
  };
  const proof: CapabilityIdentityProof = {
    id: proofId,
    personId: TIM_PERSON_ID,
    identityId,
    source: "slack_signed_event",
    confidence: "medium",
    observedAt: observed.lastSeenAt,
    summary: "A single Slack user/team pair was observed in accepted codex-chat Slack event telemetry; no Slack profile lookup or message body was used.",
    evidence: {
      provider: "slack",
      teamId: observed.providerTeamId,
      providerUserId: observed.providerUserId,
      acceptedEventCount: observed.eventCount,
      sourcePath: observed.sourcePath,
      payloadBodiesLogged: false,
      secretValuesLogged: false,
    },
  };
  return { identity, proof, channels: slackChannelsFromObserved(observed, identityId, "linked") };
}

function observedUnlinkedSlackIdentity(observed: ObservedSlackIdentity): { identity: CapabilityExternalIdentity; proof: CapabilityIdentityProof; channels: CapabilityCommunicationChannel[] } {
  const identityId = slackIdentityId(observed.providerTeamId, observed.providerUserId);
  const proofId = `proof_observed_${identityId}`;
  const channelIds = observed.channelIds.map((channelId) => slackChannelId(observed.providerTeamId, channelId));
  const identity: CapabilityExternalIdentity = {
    id: identityId,
    provider: "slack",
    providerUserId: observed.providerUserId,
    providerTeamId: observed.providerTeamId,
    label: `Observed Slack user (${observed.providerTeamId}/${observed.providerUserId})`,
    status: "observed_unlinked",
    channelKinds: ["slack_workspace", "slack_channel"],
    communicationChannelIds: channelIds.length ? channelIds : [slackWorkspaceChannelId(observed.providerTeamId)],
    proofIds: [proofId],
    metadata: { teamId: observed.providerTeamId, source: "codex-chat-slack-telemetry", eventCount: String(observed.eventCount), linkState: "unlinked_requires_admin_review" },
    createdAt: observed.firstSeenAt,
    updatedAt: observed.lastSeenAt,
    lastSeenAt: observed.lastSeenAt,
  };
  const proof: CapabilityIdentityProof = {
    id: proofId,
    identityId,
    source: "observed_runtime_metadata",
    confidence: "medium",
    observedAt: observed.lastSeenAt,
    summary: "Slack metadata was observed but not linked to Tim because more than one signed Slack user was present or admin review is still required.",
    evidence: { provider: "slack", teamId: observed.providerTeamId, providerUserId: observed.providerUserId, acceptedEventCount: observed.eventCount, sourcePath: observed.sourcePath, payloadBodiesLogged: false, secretValuesLogged: false },
  };
  return { identity, proof, channels: slackChannelsFromObserved(observed, identityId, "observed") };
}

function slackAddablePlaceholder(): { identity: CapabilityExternalIdentity; proof: CapabilityIdentityProof; channel: CapabilityCommunicationChannel } {
  const identityId = "identity_slack_addable_tim";
  const proofId = "proof_slack_addable_tim";
  const channelId = "channel_slack_addable_tim";
  return {
    identity: {
      id: identityId,
      provider: "slack",
      providerUserId: "",
      personId: TIM_PERSON_ID,
      label: "Tim Slack identity (addable)",
      status: "addable_placeholder",
      channelKinds: ["slack_workspace", "slack_channel", "slack_dm"],
      communicationChannelIds: [channelId],
      proofIds: [proofId],
      metadata: { linkState: "awaiting_signed_slack_event_or_admin_link", provider: "slack" },
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    },
    proof: {
      id: proofId,
      personId: TIM_PERSON_ID,
      identityId,
      source: "admin_seed",
      confidence: "placeholder",
      observedAt: SEED_TIME,
      summary: "Slack identity support is modeled, but no safe Tim Slack user ID was available at seed time.",
      evidence: { provider: "slack", payloadBodiesLogged: false, secretValuesLogged: false },
    },
    channel: {
      id: channelId,
      provider: "slack",
      kind: "unknown",
      label: "Slack channel/DM (add after identity link)",
      status: "addable_placeholder",
      identityIds: [identityId],
      externalIds: {},
      metadata: { linkState: "awaiting_slack_metadata" },
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    },
  };
}

function identitySubjectFromIdentity(identity: CapabilityExternalIdentity): CapabilitySubject {
  if (identity.provider === "slack" && identity.providerTeamId && identity.providerUserId) {
    return {
      id: `identity:${identity.id}`,
      kind: "external_identity",
      label: identity.label,
      description: identity.personId ? "Linked Slack external identity subject for future grants." : "Observed Slack external identity subject awaiting person link.",
      source: identity.status === "linked" ? "identity_link" : "observed_runtime_metadata",
      personId: identity.personId,
      identityId: identity.id,
      externalIds: { teamId: identity.providerTeamId, userId: identity.providerUserId },
    };
  }
  return {
    id: `identity:${identity.id}`,
    kind: "external_identity",
    label: identity.label,
    description: `${identity.provider} external identity subject for future grants and link administration.`,
    source: identity.status === "linked" ? "identity_link" : identity.status,
    personId: identity.personId,
    identityId: identity.id,
    externalIds: compactRecord({ provider: identity.provider, providerUserId: identity.providerUserId, providerChatId: identity.providerChatId, providerTeamId: identity.providerTeamId }),
  };
}

function defaultGrantBundles(): CapabilityGrantBundle[] {
  return [
    {
      id: OWNER_ALL_BUNDLE_ID,
      label: "Owner / all capabilities",
      description: "Non-enforcing owner bundle catalog convenience. Tim's seed materializes this as individual active capability grants so review UIs do not hide access behind one opaque bundle row.",
      status: "active",
      includes: { groupIds: activeCatalogGroupIds(CAPABILITY_CATALOG), capabilityIds: activeCatalogCapabilityIds(CAPABILITY_CATALOG) },
      semantics: {
        grantKind: "bundle",
        implies: "all_catalog_capabilities",
        expansion: "The owner/all bundle is a catalog shortcut that currently expands to individual non-placeholder capability grant rows for Tim; placeholder finance/health capabilities are intentionally excluded until reviewed.",
        positiveGrantOnly: true,
      },
    },
  ];
}

function defaultCapabilityGrants(): CapabilityGrant[] {
  return [
    ...timOwnerCapabilityGrants(),
    {
      id: "grant_seed_current_admin_projects_group",
      subjectId: CURRENT_ADMIN_SUBJECT_ID,
      capabilityId: "projects",
      grantKind: "group",
      resource: projectGrantResource("*"),
      actions: ["read", "search", "write", "publish", "manage"],
      source: { kind: "seed", id: "phase-5-read-only-slice" },
      grantedBy: "system:seed",
      grantedAt: SEED_TIME,
      status: "active",
      reason: "Seed grant that preserves the original top-level Projects group example semantics.",
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
  ];
}

function timOwnerCapabilityGrants(): CapabilityGrant[] {
  return CAPABILITY_CATALOG.flatMap((groupItem) => groupItem.children)
    .filter((capabilityItem) => capabilityItem.status !== "placeholder")
    .map((capabilityItem) => ({
      id: `grant_seed_tim_owner_${capabilityItem.id.replace(/[^a-z0-9]+/gi, "_")}`,
      subjectId: TIM_SUBJECT_ID,
      capabilityId: capabilityItem.id,
      grantKind: "capability" as const,
      resource: ownerCapabilityResource(capabilityItem),
      actions: capabilityItem.actions,
      source: { kind: "bundle" as const, id: "owner_all_seed_expanded" },
      grantedBy: "system:admin_seed",
      grantedAt: SEED_TIME,
      status: "active" as const,
      reason: "Tim owner/all seed expanded into this individual non-placeholder capability grant for transparent review; runtime enforcement remains disconnected.",
      enforcement: "non_enforcing" as const,
    }));
}

function ownerCapabilityResource(capabilityItem: CapabilityCatalogCapability): CapabilityGrant["resource"] {
  if (capabilityItem.resourceScope.resourceKind === "project") return projectGrantResource("*", capabilityItem);
  return { kind: "global", id: "global:*", selectors: ownerCapabilitySelectors(capabilityItem) };
}

function projectGrantResource(projectId: string, capabilityItem?: CapabilityCatalogCapability): CapabilityGrant["resource"] {
  const normalizedProjectId = projectId === "*" ? "*" : sanitizeProjectId(projectId);
  const selectors: Record<string, string> = { projectId: normalizedProjectId || "*" };
  if (capabilityItem) {
    for (const selectorItem of capabilityItem.resourceSelectors) {
      if (selectorItem.id === "projectId") continue;
      selectors[selectorItem.id] = "*";
    }
  } else {
    selectors.repoAlias = "*";
  }
  selectors.resourceScope = projectResourceId(selectors.projectId);
  return { kind: "project", id: projectResourceId(selectors.projectId), selectors };
}

function ownerCapabilitySelectors(capabilityItem: CapabilityCatalogCapability): Record<string, string> {
  const selectors: Record<string, string> = { scope: "owner_all" };
  for (const selectorItem of capabilityItem.resourceSelectors) selectors[selectorItem.id] = "*";
  return selectors;
}

function defaultAuditShape(auditLogPath: string): CapabilityAuditShape {
  return {
    appendOnly: true,
    writesEnabled: false,
    path: auditLogPath,
    values: "schema persisted in private store; no grant/link mutation writes are enabled yet, so no capability audit events are appended by this UI slice",
    requiredFields: AUDIT_REQUIRED_FIELDS,
    eventTypes: AUDIT_EVENT_TYPES,
    sampleEvent: {
      eventId: "cap_evt_01HZ0000000000000000000000",
      timestamp: "2026-06-30T00:00:00.000Z",
      actor: { subjectId: CURRENT_ADMIN_SUBJECT_ID, kind: "admin_user" },
      subject: { subjectId: TIM_SUBJECT_ID, kind: "person", personId: TIM_PERSON_ID },
      identity: { identityId: TIM_TELEGRAM_IDENTITY_ID, provider: "telegram" },
      capabilityId: OWNER_ALL_BUNDLE_ID,
      resource: { kind: "project", id: "project:*", selectors: { projectId: "*", resourceScope: "project:*" } },
      action: "identity.link.seeded",
      decision: "not_enforced",
      reason: "admin-seeded non-enforcing identity/capability foundation",
      correlationId: "corr_phase5_identity_seed_example",
      redaction: { secretValuesLogged: false, payloadBodiesLogged: false },
    },
  };
}

function normalizeCapabilityStore(value: unknown, auditLogPath: string, observedSlack: ObservedSlackState): { store: CapabilityStore; migrated: boolean; changed: boolean } {
  const fallback = defaultCapabilityStore(auditLogPath, observedSlack);
  if (!isRecord(value)) return { store: fallback, migrated: false, changed: true };
  if (value.schemaVersion !== 2) return { store: migrateCapabilityStoreV1(value, fallback), migrated: true, changed: true };
  const store: CapabilityStore = {
    schemaVersion: 2,
    storeId: sanitizeText(value.storeId, fallback.storeId, 120),
    mode: "identity_capability_foundation",
    createdAt: sanitizeIso(value.createdAt, fallback.createdAt),
    updatedAt: sanitizeIso(value.updatedAt, fallback.updatedAt),
    writesEnabled: false,
    enforcementEnabled: false,
    people: normalizePeople(value.people, fallback.people),
    externalIdentities: normalizeExternalIdentities(value.externalIdentities, fallback.externalIdentities),
    identityProofs: normalizeIdentityProofs(value.identityProofs, fallback.identityProofs),
    communicationChannels: normalizeCommunicationChannels(value.communicationChannels, fallback.communicationChannels),
    subjects: normalizeSubjects(value.subjects, fallback.subjects),
    grantBundles: normalizeGrantBundles(value.grantBundles, fallback.grantBundles),
    grants: normalizeGrants(value.grants, fallback.grants),
    audit: normalizeAudit(value.audit, fallback.audit),
    notes: Array.isArray(value.notes) ? value.notes.map((item) => sanitizeText(item, "", 500)).filter(Boolean) : fallback.notes,
    legacyStoreIds: Array.isArray(value.legacyStoreIds) ? normalizeStringArray(value.legacyStoreIds, 20) : undefined,
  };
  const ensured = ensureCoreSeed(store, fallback);
  return { store: ensured.store, migrated: false, changed: ensured.changed };
}

function migrateCapabilityStoreV1(value: Record<string, unknown>, fallback: CapabilityStore): CapabilityStore {
  const legacyStoreId = sanitizeText(value.storeId, "", 120);
  const store: CapabilityStore = {
    ...fallback,
    createdAt: sanitizeIso(value.createdAt, fallback.createdAt),
    updatedAt: SEED_TIME,
    legacyStoreIds: legacyStoreId ? [legacyStoreId] : undefined,
    subjects: mergeUniqueById(fallback.subjects, normalizeSubjects(value.subjects, [])),
    grants: mergeUniqueById(fallback.grants, normalizeGrants(value.grants, [])),
    audit: normalizeAudit(value.audit, fallback.audit),
    notes: [
      ...fallback.notes,
      "Migrated from capability store schema v1; original read-only subject/grant semantics were preserved and v2 identity foundation rows were added.",
    ],
  };
  return pruneSupersededPlaceholders(store);
}

function ensureCoreSeed(store: CapabilityStore, fallback: CapabilityStore): { store: CapabilityStore; changed: boolean } {
  let changed = false;
  const merge = <T extends { id: string }>(current: T[], required: T[]): T[] => {
    const before = current.length;
    const merged = mergeUniqueById(current, required);
    if (merged.length !== before) changed = true;
    return merged;
  };
  store.people = merge(store.people, fallback.people);
  store.externalIdentities = merge(store.externalIdentities, fallback.externalIdentities);
  store.identityProofs = merge(store.identityProofs, fallback.identityProofs);
  store.communicationChannels = merge(store.communicationChannels, fallback.communicationChannels);
  store.subjects = merge(store.subjects, fallback.subjects);
  store.grantBundles = merge(store.grantBundles, fallback.grantBundles).map((bundle) => bundle.id === OWNER_ALL_BUNDLE_ID ? defaultGrantBundles()[0] ?? bundle : bundle);
  store.grants = merge(store.grants, fallback.grants);
  const projectMigrated = migrateProjectCapabilityGrantRows(store);
  if (projectMigrated.changed) changed = true;
  store = projectMigrated.store;
  const expanded = expandLegacyTimOwnerBundleGrant(store);
  if (expanded.changed) changed = true;
  const pruned = pruneSupersededPlaceholders(expanded.store);
  if (pruned !== store) changed = true;
  const tim = pruned.people.find((person) => person.id === TIM_PERSON_ID);
  if (tim) {
    const identityIds = pruned.externalIdentities.filter((identity) => identity.personId === TIM_PERSON_ID).map((identity) => identity.id).sort();
    if (identityIds.join("\0") !== [...tim.identityIds].sort().join("\0")) {
      tim.identityIds = identityIds;
      changed = true;
    }
  }
  return { store: pruned, changed };
}

function migrateProjectCapabilityGrantRows(store: CapabilityStore): { store: CapabilityStore; changed: boolean } {
  let changed = false;
  const seenIds = new Set<string>();
  const grants: CapabilityGrant[] = [];
  for (const grant of store.grants) {
    const nextCapabilityId = canonicalCapabilityId(grant.capabilityId);
    const next: CapabilityGrant = {
      ...grant,
      capabilityId: nextCapabilityId,
      resource: normalizeGrantResourceForCapability(grant.resource, nextCapabilityId),
    };
    if (next.capabilityId !== grant.capabilityId || next.resource.id !== grant.resource.id || next.resource.kind !== grant.resource.kind) changed = true;
    if (grant.id === "grant_seed_tim_owner_projects_project_read") {
      next.id = "grant_seed_tim_owner_projects_read";
      changed = true;
    } else if (grant.id === "grant_seed_tim_owner_projects_project_write") {
      next.id = "grant_seed_tim_owner_projects_write";
      changed = true;
    }
    if (seenIds.has(next.id)) {
      changed = true;
      continue;
    }
    seenIds.add(next.id);
    grants.push(next);
  }
  const note = "Migrated project capability grants to generic capability ids with resource-scoped project:* / project:<projectId> grant resources.";
  return {
    store: changed ? {
      ...store,
      grants,
      updatedAt: SEED_TIME,
      notes: store.notes.includes(note) ? store.notes : [...store.notes, note],
    } : store,
    changed,
  };
}

function expandLegacyTimOwnerBundleGrant(store: CapabilityStore): { store: CapabilityStore; changed: boolean } {
  const legacyGrantIds = new Set(store.grants
    .filter((grant) => grant.subjectId === TIM_SUBJECT_ID && grant.grantKind === "bundle" && (grant.bundleId === OWNER_ALL_BUNDLE_ID || grant.capabilityId === OWNER_ALL_BUNDLE_ID))
    .map((grant) => grant.id));
  const required = timOwnerCapabilityGrants();
  const beforeCount = store.grants.length;
  const grants = mergeUniqueById(store.grants.filter((grant) => !legacyGrantIds.has(grant.id)), required);
  const changed = legacyGrantIds.size > 0 || grants.length !== beforeCount;
  if (!changed) return { store, changed: false };
  const note = "Migrated legacy Tim owner/all bundle grant into individual non-placeholder capability grants; placeholder finance/health capabilities remain ungranted.";
  return {
    store: {
      ...store,
      grants,
      updatedAt: SEED_TIME,
      notes: store.notes.includes(note) ? store.notes : [...store.notes, note],
    },
    changed: true,
  };
}

function pruneSupersededPlaceholders(store: CapabilityStore): CapabilityStore {
  const hasLinkedSlack = store.externalIdentities.some((identity) => identity.provider === "slack" && identity.personId === TIM_PERSON_ID && identity.status === "linked" && identity.id !== "identity_slack_addable_tim");
  if (!hasLinkedSlack) return store;
  const removeIds = new Set(["identity_slack_addable_tim", "proof_slack_addable_tim", "channel_slack_addable_tim", "identity:identity_slack_addable_tim"]);
  return {
    ...store,
    externalIdentities: store.externalIdentities.filter((item) => !removeIds.has(item.id)),
    identityProofs: store.identityProofs.filter((item) => !removeIds.has(item.id)),
    communicationChannels: store.communicationChannels.filter((item) => !removeIds.has(item.id)),
    subjects: store.subjects.filter((item) => !removeIds.has(item.id)),
  };
}

function normalizePeople(value: unknown, fallback: CapabilityPerson[]): CapabilityPerson[] {
  if (!Array.isArray(value)) return fallback;
  const out: CapabilityPerson[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = sanitizePersonId(item.id);
    if (!id) continue;
    out.push({
      id,
      displayName: sanitizeText(item.displayName, id, 160),
      status: sanitizePersonStatus(item.status),
      personType: item.personType === "system" ? "system" : "human",
      primarySubjectId: sanitizeSubjectId(item.primarySubjectId) || `person:${id}`,
      source: sanitizePersonSource(item.source),
      identityIds: normalizeStringArray(item.identityIds, 50),
      subjectIds: normalizeStringArray(item.subjectIds, 50),
      notes: normalizeStringArray(item.notes, 20),
      createdAt: sanitizeIso(item.createdAt, SEED_TIME),
      updatedAt: sanitizeIso(item.updatedAt, SEED_TIME),
    });
  }
  return out.length ? out : fallback;
}

function normalizeExternalIdentities(value: unknown, fallback: CapabilityExternalIdentity[]): CapabilityExternalIdentity[] {
  if (!Array.isArray(value)) return fallback;
  const out: CapabilityExternalIdentity[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = sanitizeIdentityId(item.id);
    if (!id) continue;
    const identity: CapabilityExternalIdentity = {
      id,
      provider: sanitizeIdentityProvider(item.provider),
      providerUserId: sanitizeText(item.providerUserId, "", 180),
      label: sanitizeText(item.label, id, 200),
      status: sanitizeIdentityStatus(item.status),
      channelKinds: normalizeStringArray(item.channelKinds, 20),
      communicationChannelIds: normalizeStringArray(item.communicationChannelIds, 50),
      proofIds: normalizeStringArray(item.proofIds, 50),
      metadata: normalizeStringRecord(item.metadata) ?? {},
      createdAt: sanitizeIso(item.createdAt, SEED_TIME),
      updatedAt: sanitizeIso(item.updatedAt, SEED_TIME),
    };
    const providerTeamId = sanitizeText(item.providerTeamId, "", 180);
    const providerChatId = sanitizeText(item.providerChatId, "", 180);
    const providerChannelId = sanitizeText(item.providerChannelId, "", 180);
    const personId = sanitizePersonId(item.personId);
    const lastSeenAt = sanitizeIso(item.lastSeenAt, "");
    if (providerTeamId) identity.providerTeamId = providerTeamId;
    if (providerChatId) identity.providerChatId = providerChatId;
    if (providerChannelId) identity.providerChannelId = providerChannelId;
    if (personId) identity.personId = personId;
    if (lastSeenAt) identity.lastSeenAt = lastSeenAt;
    out.push(identity);
  }
  return out.length ? out : fallback;
}

function normalizeIdentityProofs(value: unknown, fallback: CapabilityIdentityProof[]): CapabilityIdentityProof[] {
  if (!Array.isArray(value)) return fallback;
  const out: CapabilityIdentityProof[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = sanitizeProofId(item.id);
    const identityId = sanitizeIdentityId(item.identityId);
    if (!id || !identityId) continue;
    const proof: CapabilityIdentityProof = {
      id,
      identityId,
      source: sanitizeProofSource(item.source),
      confidence: sanitizeProofConfidence(item.confidence),
      observedAt: sanitizeIso(item.observedAt, SEED_TIME),
      summary: sanitizeText(item.summary, "", 500),
      evidence: normalizeEvidenceRecord(item.evidence),
    };
    const personId = sanitizePersonId(item.personId);
    if (personId) proof.personId = personId;
    out.push(proof);
  }
  return out.length ? out : fallback;
}

function normalizeCommunicationChannels(value: unknown, fallback: CapabilityCommunicationChannel[]): CapabilityCommunicationChannel[] {
  if (!Array.isArray(value)) return fallback;
  const out: CapabilityCommunicationChannel[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = sanitizeChannelId(item.id);
    if (!id) continue;
    const channel: CapabilityCommunicationChannel = {
      id,
      provider: sanitizeIdentityProvider(item.provider),
      kind: sanitizeChannelKind(item.kind),
      label: sanitizeText(item.label, id, 200),
      status: sanitizeChannelStatus(item.status),
      identityIds: normalizeStringArray(item.identityIds, 50),
      externalIds: normalizeStringRecord(item.externalIds) ?? {},
      metadata: normalizeStringRecord(item.metadata) ?? {},
      createdAt: sanitizeIso(item.createdAt, SEED_TIME),
      updatedAt: sanitizeIso(item.updatedAt, SEED_TIME),
    };
    const lastSeenAt = sanitizeIso(item.lastSeenAt, "");
    if (lastSeenAt) channel.lastSeenAt = lastSeenAt;
    out.push(channel);
  }
  return out.length ? out : fallback;
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
    const personId = sanitizePersonId(item.personId);
    const identityId = sanitizeIdentityId(item.identityId);
    const externalIds = normalizeStringRecord(item.externalIds);
    if (personId) subject.personId = personId;
    if (identityId) subject.identityId = identityId;
    if (externalIds) subject.externalIds = externalIds;
    out.push(subject);
  }
  return out.length ? out : fallback;
}

function normalizeGrantBundles(value: unknown, fallback: CapabilityGrantBundle[]): CapabilityGrantBundle[] {
  if (!Array.isArray(value)) return fallback;
  const out: CapabilityGrantBundle[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = sanitizeBundleId(item.id);
    if (!id) continue;
    const includes = isRecord(item.includes) ? item.includes : {};
    out.push({
      id,
      label: sanitizeText(item.label, id, 160),
      description: sanitizeText(item.description, "", 500),
      status: item.status === "placeholder" ? "placeholder" : "active",
      includes: {
        groupIds: normalizeStringArray(includes.groupIds, 100),
        capabilityIds: normalizeStringArray(includes.capabilityIds, 300),
      },
      semantics: {
        grantKind: "bundle",
        implies: "all_catalog_capabilities",
        expansion: sanitizeText(isRecord(item.semantics) ? item.semantics.expansion : undefined, "Bundle expands into listed capabilities.", 500),
        positiveGrantOnly: true,
      },
    });
  }
  return out.length ? out : fallback;
}

function normalizeGrants(value: unknown, fallback: CapabilityGrant[]): CapabilityGrant[] {
  if (!Array.isArray(value)) return fallback;
  const out: CapabilityGrant[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = sanitizeGrantId(item.id);
    const subjectId = sanitizeSubjectId(item.subjectId);
    const capabilityId = canonicalCapabilityId(sanitizeCapabilityId(item.capabilityId));
    if (!id || !subjectId || !capabilityId) continue;
    const grantKind = item.grantKind === "bundle" ? "bundle" : item.grantKind === "group" ? "group" : "capability";
    const grant: CapabilityGrant = {
      id,
      subjectId,
      capabilityId,
      grantKind,
      resource: normalizeGrantResourceForCapability(item.resource, capabilityId),
      actions: normalizeStringArray(item.actions, 20),
      source: normalizeGrantSource(item.source),
      grantedBy: sanitizeSubjectId(item.grantedBy) || "unknown",
      grantedAt: sanitizeIso(item.grantedAt, SEED_TIME),
      status: sanitizeGrantStatus(item.status),
      reason: sanitizeText(item.reason, "", 500),
      enforcement: "non_enforcing",
    };
    const bundleId = sanitizeBundleId(item.bundleId);
    if (bundleId) grant.bundleId = bundleId;
    const expiresAt = sanitizeIso(item.expiresAt, "");
    const revokedAt = sanitizeIso(item.revokedAt, "");
    if (expiresAt) grant.expiresAt = expiresAt;
    if (revokedAt) grant.revokedAt = revokedAt;
    out.push(grant);
  }
  return out.length ? out : fallback;
}

function normalizeAudit(value: unknown, fallback: CapabilityAuditShape): CapabilityAuditShape {
  if (!isRecord(value)) return fallback;
  return {
    appendOnly: true,
    writesEnabled: false,
    path: sanitizeText(value.path, fallback.path, 400),
    values: sanitizeText(value.values, fallback.values, 500),
    requiredFields: Array.isArray(value.requiredFields) ? normalizeStringArray(value.requiredFields, 50) : fallback.requiredFields,
    eventTypes: AUDIT_EVENT_TYPES,
    sampleEvent: fallback.sampleEvent,
  };
}

function buildEffectiveBySubject(subjects: CapabilitySubject[], grants: CapabilityGrant[], bundles: CapabilityGrantBundle[], catalog: CapabilityCatalogGroup[]): Record<string, CapabilityEffectiveSubject> {
  return Object.fromEntries(subjects.map((subject) => [subject.id, buildEffectiveForSubject(subject.id, grants, bundles, catalog)]));
}

function buildEffectiveByPerson(people: CapabilityPerson[], identities: CapabilityExternalIdentity[], channels: CapabilityCommunicationChannel[], effectiveBySubject: Record<string, CapabilityEffectiveSubject>): Record<string, CapabilityEffectivePerson> {
  const byPerson: Record<string, CapabilityEffectivePerson> = {};
  for (const person of people) {
    const identityIds = identities.filter((identity) => identity.personId === person.id).map((identity) => identity.id);
    const channelIds = channels.filter((channel) => channel.identityIds.some((identityId) => identityIds.includes(identityId))).map((channel) => channel.id);
    const subjectId = person.primarySubjectId;
    byPerson[person.id] = {
      personId: person.id,
      subjectId,
      identityIds,
      communicationChannelIds: channelIds,
      effective: effectiveBySubject[subjectId] ?? buildEffectiveForSubject(subjectId, [], [], CAPABILITY_CATALOG),
    };
  }
  return byPerson;
}

function buildEffectiveForSubject(subjectId: string, grants: CapabilityGrant[], bundles: CapabilityGrantBundle[], catalog: CapabilityCatalogGroup[]): CapabilityEffectiveSubject {
  const activeGrants = grants.filter((grant) => grant.subjectId === subjectId && (grant.status === "active" || grant.status === "example") && !grant.revokedAt);
  const directGrantIds: string[] = [];
  const directBundleGrantIds: string[] = [];
  const directBundleIds = new Set<string>();
  const directCapabilityIds = new Set<string>();
  const directGroupCapabilityIds = new Set<string>();
  const impliedGroupCapabilityIds = new Set<string>();
  const impliedCapabilityIds = new Set<string>();
  const byCapabilityId: Record<string, CapabilityEffectiveEntry> = {};
  const ensureEntry = (capabilityId: string): CapabilityEffectiveEntry => {
    byCapabilityId[capabilityId] ??= {
      capabilityId,
      effective: false,
      directGrantIds: [],
      directBundleGrantIds: [],
      directGroupGrantIds: [],
      impliedByBundleGrantIds: [],
      impliedByBundleIds: [],
      impliedByGroupGrantIds: [],
      impliedByCapabilityIds: [],
    };
    return byCapabilityId[capabilityId];
  };
  for (const bundle of bundles) ensureEntry(bundle.id);
  for (const groupItem of catalog) {
    ensureEntry(groupItem.id);
    for (const child of groupItem.children) ensureEntry(child.id);
  }
  for (const grant of activeGrants) {
    directGrantIds.push(grant.id);
    const bundle = grant.grantKind === "bundle" ? bundles.find((item) => item.id === (grant.bundleId || grant.capabilityId)) : undefined;
    if (bundle) {
      directBundleGrantIds.push(grant.id);
      directBundleIds.add(bundle.id);
      const bundleEntry = ensureEntry(bundle.id);
      bundleEntry.effective = true;
      bundleEntry.directGrantIds.push(grant.id);
      bundleEntry.directBundleGrantIds.push(grant.id);
      const groupIds = bundle.id === OWNER_ALL_BUNDLE_ID ? activeCatalogGroupIds(catalog) : bundle.includes.groupIds;
      const capabilityIds = new Set(bundle.id === OWNER_ALL_BUNDLE_ID ? activeCatalogCapabilityIds(catalog) : bundle.includes.capabilityIds);
      for (const groupId of groupIds) {
        const groupItem = catalog.find((item) => item.id === groupId);
        const groupEntry = ensureEntry(groupId);
        groupEntry.effective = true;
        groupEntry.impliedByBundleGrantIds.push(grant.id);
        groupEntry.impliedByBundleIds.push(bundle.id);
        impliedGroupCapabilityIds.add(groupId);
        if (groupItem) for (const child of groupItem.children) if (child.status !== "placeholder") capabilityIds.add(child.id);
      }
      for (const capabilityId of capabilityIds) {
        const childEntry = ensureEntry(capabilityId);
        childEntry.effective = true;
        childEntry.impliedByBundleGrantIds.push(grant.id);
        childEntry.impliedByBundleIds.push(bundle.id);
        childEntry.impliedByCapabilityIds.push(bundle.id);
        if (!catalog.some((item) => item.id === capabilityId)) impliedCapabilityIds.add(capabilityId);
      }
      continue;
    }
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
  const allCapabilityIds = catalogCapabilityIds(catalog);
  const activeCapabilityIds = activeCatalogCapabilityIds(catalog);
  const effectiveCapabilityCount = allCapabilityIds.filter((capabilityId) => byCapabilityId[capabilityId]?.effective).length;
  const effectiveActiveCapabilityCount = activeCapabilityIds.filter((capabilityId) => byCapabilityId[capabilityId]?.effective).length;
  return {
    subjectId,
    directGrantIds,
    directBundleGrantIds,
    directBundleIds: [...directBundleIds].sort(),
    directCapabilityIds: [...directCapabilityIds].sort(),
    directGroupCapabilityIds: [...directGroupCapabilityIds].sort(),
    impliedGroupCapabilityIds: [...impliedGroupCapabilityIds].sort(),
    impliedCapabilityIds: [...impliedCapabilityIds].sort(),
    byCapabilityId,
    summary: {
      activeGrantCount: activeGrants.length,
      effectiveCapabilityCount,
      effectiveActiveCapabilityCount,
      totalCapabilityCount: allCapabilityIds.length,
      activeCapabilityCount: activeCapabilityIds.length,
      placeholderCapabilityCount: allCapabilityIds.length - activeCapabilityIds.length,
      allCapabilities: effectiveCapabilityCount === allCapabilityIds.length,
      allActiveCapabilities: effectiveActiveCapabilityCount === activeCapabilityIds.length,
      bundles: [...directBundleIds].sort(),
      enforcement: "non_enforcing",
    },
  };
}

async function deriveObservedSlackState(codexChatPath?: string): Promise<ObservedSlackState> {
  if (!codexChatPath) return { status: "not_observed", observedIdentities: [] };
  const summaryPath = path.join(resolveEnvFilePath(codexChatPath), "data", "state", "slack_telemetry", "summary.json");
  const telemetryDir = path.dirname(summaryPath);
  const observations = new Map<string, { teamId: string; userId: string; channelIds: Set<string>; eventCount: number; firstSeenAt: string; lastSeenAt: string; correlationIds: Set<string> }>();
  const observe = (record: unknown, sourcePath: string): void => {
    if (!isRecord(record)) return;
    if (record.direction !== "inbound" || record.outcome !== "accepted") return;
    const teamId = sanitizeText(record.teamId, "", 80);
    const userId = sanitizeText(record.userId, "", 80);
    if (!teamId || !userId) return;
    const key = `${teamId}/${userId}`;
    const observedAt = sanitizeIso(record.observedAt, SEED_TIME);
    const entry = observations.get(key) ?? { teamId, userId, channelIds: new Set<string>(), eventCount: 0, firstSeenAt: observedAt, lastSeenAt: observedAt, correlationIds: new Set<string>() };
    entry.eventCount += 1;
    const channelId = sanitizeText(record.channelId, "", 80);
    const correlationId = sanitizeText(record.correlationId, "", 160);
    if (channelId) entry.channelIds.add(channelId);
    if (correlationId) entry.correlationIds.add(correlationId);
    if (observedAt < entry.firstSeenAt) entry.firstSeenAt = observedAt;
    if (observedAt > entry.lastSeenAt) entry.lastSeenAt = observedAt;
    observations.set(key, entry);
    void sourcePath;
  };
  try {
    const rawSummary = await readTextIfPresent(summaryPath);
    if (!rawSummary) return { status: "not_observed", observedIdentities: [], sourcePath: summaryPath };
    const summary = JSON.parse(rawSummary) as unknown;
    if (isRecord(summary)) {
      observe(summary.lastAcceptedEvent, summaryPath);
      observe(summary.lastInboundEvent, summaryPath);
    }
    const files = await readdir(telemetryDir).catch(() => [] as string[]);
    for (const file of files.filter((item) => item.endsWith(".jsonl")).sort().slice(-7)) {
      const filePath = path.join(telemetryDir, file);
      const text = await readTextIfPresent(filePath);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { observe(JSON.parse(line) as unknown, filePath); } catch { /* ignore corrupt telemetry line */ }
      }
    }
  } catch (error) {
    return { status: "unreadable", observedIdentities: [], sourcePath: summaryPath, error: error instanceof Error ? error.message : String(error) };
  }
  const observedIdentities: ObservedSlackIdentity[] = [...observations.values()].map((entry) => ({
    providerTeamId: entry.teamId,
    providerUserId: entry.userId,
    channelIds: [...entry.channelIds].sort(),
    eventCount: entry.eventCount,
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
    sourcePath: summaryPath,
    correlationIds: [...entry.correlationIds].sort().slice(0, 10),
  })).sort((a, b) => `${a.providerTeamId}/${a.providerUserId}`.localeCompare(`${b.providerTeamId}/${b.providerUserId}`));
  if (observedIdentities.length === 1) return { status: "single_signed_user", observedIdentities, linkableIdentity: observedIdentities[0], sourcePath: summaryPath };
  if (observedIdentities.length > 1) return { status: "multiple_signed_users", observedIdentities, sourcePath: summaryPath };
  return { status: "not_observed", observedIdentities: [], sourcePath: summaryPath };
}

function slackChannelsFromObserved(observed: ObservedSlackIdentity, identityId: string, status: "linked" | "observed"): CapabilityCommunicationChannel[] {
  if (!observed.channelIds.length) {
    return [{
      id: slackWorkspaceChannelId(observed.providerTeamId),
      provider: "slack",
      kind: "slack_workspace",
      label: `Slack workspace ${observed.providerTeamId}`,
      status,
      identityIds: [identityId],
      externalIds: { teamId: observed.providerTeamId },
      metadata: { source: "codex-chat-slack-telemetry", eventCount: String(observed.eventCount) },
      createdAt: observed.firstSeenAt,
      updatedAt: observed.lastSeenAt,
      lastSeenAt: observed.lastSeenAt,
    }];
  }
  return observed.channelIds.map((channelId) => ({
    id: slackChannelId(observed.providerTeamId, channelId),
    provider: "slack" as const,
    kind: "slack_channel" as const,
    label: `Slack channel ${observed.providerTeamId}/${channelId}`,
    status,
    identityIds: [identityId],
    externalIds: { teamId: observed.providerTeamId, channelId },
    metadata: { source: "codex-chat-slack-telemetry", eventCount: String(observed.eventCount) },
    createdAt: observed.firstSeenAt,
    updatedAt: observed.lastSeenAt,
    lastSeenAt: observed.lastSeenAt,
  }));
}

function defaultAdminWriteModel(): CapabilityAdminWriteModel {
  return {
    writesEnabled: false,
    plannedEndpoints: [
      { method: "POST", path: "/api/admin/brain/capabilities/people", purpose: "Create a person/user with no runtime enforcement side effect." },
      { method: "POST", path: "/api/admin/brain/capabilities/identity-links", purpose: "Link an external Telegram/Slack/Clerk identity to a person with proof metadata." },
      { method: "POST", path: "/api/admin/brain/capabilities/grants", purpose: "Apply a non-enforcing grant or bundle after explicit confirmation." },
      { method: "DELETE", path: "/api/admin/brain/capabilities/grants/{grantId}", purpose: "Revoke or expire a grant with an append-only audit event." },
    ],
    mutationShapes: {
      linkIdentity: { personId: TIM_PERSON_ID, provider: "telegram|slack", providerUserId: "external user id", proofSource: "admin_seed|slack_signed_event" },
      grantBundle: { subjectId: TIM_SUBJECT_ID, grantKind: "bundle", bundleId: OWNER_ALL_BUNDLE_ID, resource: "global:*" },
      grantCapability: { subjectId: "person:...", grantKind: "capability|group", capabilityId: "projects.files.write", resource: "project:* or project:<projectId>" },
      revokeGrant: { grantId: "grant_...", reason: "admin-reviewed reason" },
    },
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

async function readWorkspaceProjectResources(workspacePath?: string): Promise<CapabilityAdminSummary["projectResources"]> {
  if (!workspacePath) return { loaded: false, count: 0, projects: [] };
  const sourcePath = path.join(resolveEnvFilePath(workspacePath), "data", "projects.json");
  try {
    const raw = await readTextIfPresent(sourcePath);
    if (!raw) return { sourcePath, loaded: false, count: 0, projects: [] };
    const parsed = JSON.parse(raw) as unknown;
    const rows = isRecord(parsed) && Array.isArray(parsed.projects) ? parsed.projects : [];
    const projects = rows
      .filter(isRecord)
      .map((project) => {
        const id = sanitizeProjectId(project.id);
        if (!id) return undefined;
        return {
          id,
          name: sanitizeText(project.name, id, 180),
          status: sanitizeText(project.status, "active", 60),
          resourceScope: projectResourceId(id),
        } satisfies CapabilityProjectResourceOption;
      })
      .filter((item): item is CapabilityProjectResourceOption => Boolean(item))
      .sort((a, b) => `${a.status === "archived" ? "1" : "0"}:${a.name}`.localeCompare(`${b.status === "archived" ? "1" : "0"}:${b.name}`));
    return { sourcePath, loaded: true, count: projects.length, projects };
  } catch (error) {
    return { sourcePath, loaded: false, count: 0, projects: [], error: error instanceof Error ? sanitizeText(error.message, "unreadable projects store", 220) : "unreadable projects store" };
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

function normalizeGrantResourceForCapability(value: unknown, capabilityId: string): CapabilityGrant["resource"] {
  const resource = normalizeGrantResource(value);
  if (!isProjectCapabilityId(capabilityId) && capabilityId !== "projects") return resource;
  const rawProjectId = resource.selectors.projectId || (resource.id.startsWith("project:") ? resource.id.slice("project:".length) : resource.id === "*" ? "*" : "");
  const projectId = rawProjectId === "*" ? "*" : sanitizeProjectId(rawProjectId);
  if (projectId) return projectGrantResource(projectId);
  return projectGrantResource("*");
}

function canonicalCapabilityId(capabilityId: string): string {
  return PROJECT_CAPABILITY_ID_MIGRATIONS[capabilityId] ?? capabilityId;
}

function isProjectCapabilityId(capabilityId: string): boolean {
  return capabilityId === "projects" || capabilityId.startsWith("projects.");
}

function normalizeGrantSource(value: unknown): CapabilityGrant["source"] {
  const fallback = { kind: "seed" as const, id: "unknown" };
  if (!isRecord(value)) return fallback;
  const kind = value.kind === "admin" || value.kind === "bundle" || value.kind === "migration" || value.kind === "chat_approval" || value.kind === "system" || value.kind === "identity_proof" ? value.kind : "seed";
  return { kind, id: sanitizeText(value.id, "unknown", 120) };
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const safeKey = sanitizeText(key, "", 80);
    const safeValue = sanitizeText(item, "", 220);
    if (safeKey && safeValue) out[safeKey] = safeValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeEvidenceRecord(value: unknown): Record<string, string | number | boolean> {
  if (!isRecord(value)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    const safeKey = sanitizeText(key, "", 80);
    if (!safeKey) continue;
    if (typeof item === "boolean" || typeof item === "number") out[safeKey] = item;
    else {
      const safeValue = sanitizeText(item, "", 260);
      if (safeValue) out[safeKey] = safeValue;
    }
  }
  return out;
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => sanitizeText(item, "", 160)).filter(Boolean);
}

function sanitizePersonStatus(value: unknown): CapabilityPerson["status"] {
  return value === "inactive" || value === "observed" || value === "placeholder" ? value : "active";
}

function sanitizePersonSource(value: unknown): CapabilityPerson["source"] {
  return value === "telegram_allowlist_migration" || value === "migration" || value === "observed_runtime_metadata" || value === "manual_admin" ? value : "admin_seed";
}

function sanitizeIdentityProvider(value: unknown): CapabilityIdentityProvider {
  return value === "telegram" || value === "slack" || value === "clerk" || value === "system" ? value : "unknown";
}

function sanitizeIdentityStatus(value: unknown): CapabilityExternalIdentity["status"] {
  return value === "observed_unlinked" || value === "addable_placeholder" || value === "inactive" ? value : "linked";
}

function sanitizeProofSource(value: unknown): CapabilityIdentityProof["source"] {
  return value === "telegram_allowlist_migration" || value === "slack_signed_event" || value === "observed_runtime_metadata" || value === "manual_admin" || value === "migration" ? value : "admin_seed";
}

function sanitizeProofConfidence(value: unknown): CapabilityIdentityProof["confidence"] {
  return value === "medium" || value === "low" || value === "placeholder" ? value : "high";
}

function sanitizeChannelKind(value: unknown): CapabilityCommunicationChannel["kind"] {
  return value === "telegram_private_chat" || value === "slack_workspace" || value === "slack_channel" || value === "slack_dm" ? value : "unknown";
}

function sanitizeChannelStatus(value: unknown): CapabilityCommunicationChannel["status"] {
  return value === "observed" || value === "addable_placeholder" || value === "inactive" ? value : "linked";
}

function sanitizeSubjectKind(value: unknown): CapabilitySubject["kind"] | undefined {
  return value === "person" || value === "external_identity" || value === "admin_user" || value === "slack_workspace" || value === "slack_user" || value === "slack_channel" || value === "system" ? value : undefined;
}

function sanitizeGrantStatus(value: unknown): CapabilityGrant["status"] {
  return value === "revoked" || value === "expired" || value === "example" ? value : "active";
}

function sanitizePersonId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9:_-]{1,120}$/i);
}

function sanitizeIdentityId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9:_-]{1,180}$/i);
}

function sanitizeProofId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9:_-]{1,180}$/i);
}

function sanitizeChannelId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9:_-]{1,180}$/i);
}

function sanitizeSubjectId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9:_@./-]{1,180}$/i);
}

function sanitizeGrantId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9:_-]{1,180}$/i);
}

function sanitizeBundleId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9_.:-]{1,120}$/i);
}

function sanitizeCapabilityId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9_.:-]{1,120}$/i);
}

function sanitizeProjectId(value: unknown): string {
  return sanitizePattern(value, /^[a-z0-9_-]{1,120}$/i);
}

function projectResourceId(projectId: string): string {
  return `project:${projectId || "*"}`;
}

function sanitizePattern(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string") return "";
  const cleaned = sanitizeText(value, "", 240);
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

function compactRecord(value: Record<string, string | undefined>): Record<string, string> | undefined {
  const out = Object.fromEntries(Object.entries(value).filter(([, item]) => Boolean(item))) as Record<string, string>;
  return Object.keys(out).length ? out : undefined;
}

function mergeUniqueById<T extends { id: string }>(base: T[], additions: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...base, ...additions]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function catalogCapabilityIds(catalog: CapabilityCatalogGroup[]): string[] {
  return catalog.flatMap((groupItem) => groupItem.children.map((child) => child.id));
}

function activeCatalogCapabilityIds(catalog: CapabilityCatalogGroup[]): string[] {
  return catalog.flatMap((groupItem) => groupItem.children.filter((child) => child.status !== "placeholder").map((child) => child.id));
}

function activeCatalogGroupIds(catalog: CapabilityCatalogGroup[]): string[] {
  return catalog.filter((groupItem) => groupItem.status !== "placeholder").map((groupItem) => groupItem.id);
}

function slackIdentityId(teamId: string, userId: string): string {
  return `identity_slack_${teamId}_${userId}`;
}

function slackChannelId(teamId: string, channelId: string): string {
  return `channel_slack_${teamId}_${channelId}`;
}

function slackWorkspaceChannelId(teamId: string): string {
  return `channel_slack_${teamId}_workspace`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
