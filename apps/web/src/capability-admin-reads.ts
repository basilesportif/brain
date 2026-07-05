// Read-model builders for the Brain capability admin API (plan §5.4, §5.5,
// §6.5 READS): the /users people-and-grants summary and the merged /audit feed.
// Pure functions over already-loaded data so admin-service.ts stays thin and
// these are directly unit-testable.

import { CAPABILITY_GROUP_DEFINITIONS, mappedCatalogCapabilityIds, storeCapabilityVocabulary } from "./capability-catalog.js";
import { grantInForce, grantedCapabilityIds, type CapabilityStore, type StoreGrant, type StoreSubject } from "./capability-store.js";
import { SECRETISH_RE } from "./env-schema.js";

// --- GET /users --------------------------------------------------------------

export interface UserIdentitySummary {
  id: string;
  provider: string;
  externalId: string;
  teamId?: string;
  status?: string;
  linkedAt?: string;
}

export interface UserGroupSummary {
  id: string;
  label: string;
  status: "active" | "placeholder";
  childCount: number;
  grantedChildCount: number;
  granted: boolean;
}

export interface UserGrantExpiry {
  grantId: string;
  capabilityId: string;
  expiresAt: string;
}

// A subject the person owns whose status the authorizer will not resolve (status
// present and not "active"). Its grants are never in force; surfaced so the admin
// can see the grants exist but are inert.
export interface DisabledSubjectSummary {
  id: string;
  status?: string;
  grantCount: number;
  inForce: 0;
}

export interface UserSummary {
  id: string;
  displayName: string;
  status: string;
  personType: string;
  primarySubjectId?: string;
  subjectIds: string[];
  activeSubjectIds: string[];
  disabledSubjects: DisabledSubjectSummary[];
  identities: UserIdentitySummary[];
  grants: {
    total: number;
    inForce: number;
    grantedGroupCount: number;
    totalGroupCount: number;
    byGroup: UserGroupSummary[];
    expiring: UserGrantExpiry[];
  };
}

export interface SystemSubjectSummary {
  id: string;
  label?: string;
  kind?: string;
  grants: { total: number; inForce: number; capabilityIds: string[] };
}

export interface UsersResponse {
  schemaVersion: 1;
  storeAvailable: boolean;
  people: UserSummary[];
  systemSubjects: SystemSubjectSummary[];
  counts: { people: number; systemSubjects: number };
}

function subjectIdsForPerson(store: CapabilityStore, personId: string, seed: { primarySubjectId?: string; subjectIds?: string[]; identityIds?: string[] }): string[] {
  const ids = new Set<string>();
  if (seed.primarySubjectId) ids.add(seed.primarySubjectId);
  for (const id of seed.subjectIds ?? []) ids.add(id);
  for (const subject of store.subjects ?? []) {
    if (subject.personId === personId) ids.add(subject.id);
    if (subject.identityId && (seed.identityIds ?? []).includes(subject.identityId)) ids.add(subject.id);
  }
  return [...ids];
}

function subjectStatus(store: CapabilityStore, subjectId: string): string | undefined {
  return (store.subjects ?? []).find((subject) => subject.id === subjectId)?.status;
}

// Matches resolveActorSubjects: a subject resolves only when its status is absent
// or "active". A subject id with no matching subject record is treated as active
// (the person seed may reference a subject the store has not materialized).
function subjectIsActive(store: CapabilityStore, subjectId: string): boolean {
  const subject = (store.subjects ?? []).find((candidate) => candidate.id === subjectId);
  if (!subject) return true;
  return !subject.status || subject.status === "active";
}

function grantsForSubjects(store: CapabilityStore, subjectIds: string[]): StoreGrant[] {
  const subjectSet = new Set(subjectIds);
  return (store.grants ?? []).filter((grant) => subjectSet.has(grant.subjectId));
}

export function buildUsersResponse(store: CapabilityStore | undefined, now?: Date): UsersResponse {
  if (!store) {
    return { schemaVersion: 1, storeAvailable: false, people: [], systemSubjects: [], counts: { people: 0, systemSubjects: 0 } };
  }

  const identitiesByPerson = new Map<string, UserIdentitySummary[]>();
  for (const identity of store.externalIdentities ?? []) {
    if (!identity.personId) continue;
    const list = identitiesByPerson.get(identity.personId) ?? [];
    list.push({
      id: identity.id,
      provider: identity.provider,
      externalId: identity.providerUserId,
      teamId: identity.providerTeamId,
      status: identity.status,
      linkedAt: identity.createdAt,
    });
    identitiesByPerson.set(identity.personId, list);
  }

  const mapped = mappedCatalogCapabilityIds();
  const unmappedVocabulary = [...storeCapabilityVocabulary(store)].filter((id) => !mapped.has(id));
  const people: UserSummary[] = (store.people ?? []).map((person) => {
    const subjectIds = subjectIdsForPerson(store, person.id, person);
    // The authorizer only resolves subjects whose status is absent or "active";
    // grant/group summaries must count grants on those subjects only, matching
    // resolveActorSubjects and the dry-run endpoint.
    const activeSubjectIds = subjectIds.filter((id) => subjectIsActive(store, id));
    const grants = grantsForSubjects(store, activeSubjectIds);
    const inForceGrants = grants.filter((grant) => grantInForce(grant, now));
    const byGroup: UserGroupSummary[] = CAPABILITY_GROUP_DEFINITIONS.map((definition) => {
      const childIds = definition.capabilities.map((child) => child.id);
      const granted = grantedCapabilityIds(store, activeSubjectIds, childIds, now);
      return {
        id: definition.id,
        label: definition.label,
        status: definition.status,
        childCount: childIds.length,
        grantedChildCount: granted.size,
        granted: granted.size > 0,
      };
    });
    // Grants on capability ids the catalog does not map to a group must not
    // vanish from the summary; surface them under an explicit "other" group using
    // the same grouping logic the catalog uses.
    const grantedOther = grantedCapabilityIds(store, activeSubjectIds, unmappedVocabulary, now);
    if (grantedOther.size > 0) {
      byGroup.push({
        id: "other",
        label: "Other",
        status: "active",
        childCount: grantedOther.size,
        grantedChildCount: grantedOther.size,
        granted: true,
      });
    }
    // Non-active subjects are inert to the authorizer; list them so their grants
    // are visible but clearly marked not in force.
    const disabledSubjects: DisabledSubjectSummary[] = subjectIds
      .filter((id) => !subjectIsActive(store, id))
      .map((id) => ({ id, status: subjectStatus(store, id), grantCount: grantsForSubjects(store, [id]).length, inForce: 0 as const }));
    return {
      id: person.id,
      displayName: person.displayName ?? person.id,
      status: person.status ?? "unknown",
      personType: person.personType ?? "human",
      primarySubjectId: person.primarySubjectId,
      subjectIds,
      activeSubjectIds,
      disabledSubjects,
      identities: identitiesByPerson.get(person.id) ?? [],
      grants: {
        total: grants.length,
        inForce: inForceGrants.length,
        grantedGroupCount: byGroup.filter((group) => group.granted).length,
        totalGroupCount: byGroup.length,
        byGroup,
        expiring: inForceGrants
          .filter((grant) => grant.expiresAt)
          .map((grant) => ({ grantId: grant.id, capabilityId: grant.capabilityId, expiresAt: grant.expiresAt as string }))
          .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)),
      },
    };
  });

  const systemSubjects: SystemSubjectSummary[] = (store.subjects ?? [])
    .filter((subject) => isSystemSubject(subject))
    .map((subject) => {
      const grants = grantsForSubjects(store, [subject.id]);
      return {
        id: subject.id,
        label: subject.label,
        kind: subject.kind,
        grants: {
          total: grants.length,
          inForce: grants.filter((grant) => grantInForce(grant, now)).length,
          capabilityIds: [...new Set(grants.map((grant) => grant.capabilityId))].sort(),
        },
      };
    });

  return {
    schemaVersion: 1,
    storeAvailable: true,
    people,
    systemSubjects,
    counts: { people: people.length, systemSubjects: systemSubjects.length },
  };
}

function isSystemSubject(subject: StoreSubject): boolean {
  return subject.id.startsWith("system:") || subject.kind === "system";
}

// --- GET /audit --------------------------------------------------------------

export type AuditType = "capability" | "operations";
export type AuditOutcome = "allowed" | "denied";

export interface AuditRow {
  time?: string;
  timeMs: number;
  type: AuditType;
  actor: string;
  action: string;
  operation: string;
  target: string;
  result: string;
  reason?: string;
}

export interface AuditQuery {
  type?: AuditType;
  outcome?: AuditOutcome;
  actor?: string;
  operation?: string;
  offset: number;
  limit: number;
  // Snapshot anchor from the page-1 cursor: when set, only rows at or older than
  // this timestamp are paginated, so later pages see the same feed page 1 saw
  // even if newer records arrive between requests.
  anchorMs?: number | null;
}

export interface AuditFeedInput {
  operationsRecords: Record<string, unknown>[];
  capabilityDecisionRecords: Record<string, unknown>[];
  capabilityAuditRecords: Record<string, unknown>[];
  query: AuditQuery;
}

export interface AuditFeedResult {
  rows: AuditRow[];
  total: number;
  nextOffset: number | null;
  newestTimeMs: number | null;
}

const TARGET_MAX = 300;

// Secret-scrubbing pass applied to every string surfaced in an audit target.
// Belt-and-suspenders: codex-chat already redacts its decision resourceSummary,
// but the audit feed must never echo a token even from a malformed record.
function scrubSecrets(text: string): string {
  return text
    // Slack bot/user/app/refresh/session tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-/
    // xoxe-/xoxd- and app-level xapp- tokens.
    .replace(/\bxox[baprsed]-[A-Za-z0-9-]+/gi, "[redacted-slack-token]")
    .replace(/\bxapp-[A-Za-z0-9-]+/gi, "[redacted-slack-token]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-openai-key]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [redacted]");
}

function summarizeResourceTarget(resourceSummary: unknown): string {
  if (!resourceSummary || typeof resourceSummary !== "object" || Array.isArray(resourceSummary)) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(resourceSummary as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    // Drop any selector key whose name hints at a secret (shared heuristic).
    if (SECRETISH_RE.test(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    parts.push(`${key}=${scrubSecrets(String(value))}`);
  }
  return parts.join(" ").slice(0, TARGET_MAX);
}

const OPERATION_TARGET_KEYS = ["operation", "keys", "setupComplete", "itemId", "status", "envFile", "storePath"];

function summarizeOperationTarget(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of OPERATION_TARGET_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) parts.push(`${key}=${scrubSecrets(value.map((item) => String(item)).join(","))}`);
    else if (typeof value === "object") continue;
    else parts.push(`${key}=${scrubSecrets(String(value))}`);
  }
  return parts.join(" ").slice(0, TARGET_MAX);
}

function toMs(time: string | undefined): number {
  if (!time) return 0;
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? ms : 0;
}

function operationsRow(record: Record<string, unknown>): AuditRow {
  const time = typeof record.at === "string" ? record.at : undefined;
  const action = typeof record.action === "string" ? record.action : "operation";
  const status = record.status;
  const isError = (typeof status === "number" && status !== 0) || record.error !== undefined || record.ok === false;
  return {
    time,
    timeMs: toMs(time),
    type: "operations",
    actor: typeof record.adminEmail === "string" ? record.adminEmail : "system",
    action,
    operation: action,
    target: summarizeOperationTarget(record),
    result: isError ? "error" : "ok",
  };
}

function decisionRow(record: Record<string, unknown>): AuditRow {
  const time = typeof record.checkedAt === "string" ? record.checkedAt : typeof record.recordedAt === "string" ? record.recordedAt : undefined;
  const operation = typeof record.operation === "string" ? record.operation : "";
  return {
    time,
    timeMs: toMs(time),
    type: "capability",
    actor: typeof record.actorId === "string" ? record.actorId : "unknown",
    action: typeof record.action === "string" ? record.action : operation,
    operation,
    target: summarizeResourceTarget(record.resourceSummary),
    result: record.allowed === true ? "allowed" : "denied",
    reason: typeof record.reason === "string" ? scrubSecrets(record.reason) : undefined,
  };
}

function capabilityAuditRow(record: Record<string, unknown>): AuditRow {
  const time = typeof record.at === "string" ? record.at : undefined;
  const action = typeof record.action === "string" ? record.action : "capability.event";
  return {
    time,
    timeMs: toMs(time),
    type: "capability",
    actor: typeof record.actor === "string" ? record.actor : typeof record.adminEmail === "string" ? record.adminEmail : "admin",
    action,
    operation: action,
    target: summarizeOperationTarget(record),
    result: "ok",
    reason: typeof record.reason === "string" ? scrubSecrets(record.reason) : undefined,
  };
}

export function buildAuditFeed(input: AuditFeedInput): AuditFeedResult {
  const { query } = input;
  const rows: AuditRow[] = [];
  if (query.type !== "capability") {
    for (const record of input.operationsRecords) rows.push(operationsRow(record));
  }
  if (query.type !== "operations") {
    for (const record of input.capabilityDecisionRecords) rows.push(decisionRow(record));
    for (const record of input.capabilityAuditRecords) rows.push(capabilityAuditRow(record));
  }

  const actorNeedle = query.actor?.toLowerCase();
  const operationNeedle = query.operation?.toLowerCase();
  const filtered = rows.filter((row) => {
    if (query.outcome && row.result !== query.outcome) return false;
    if (actorNeedle && !row.actor.toLowerCase().includes(actorNeedle)) return false;
    if (operationNeedle && !row.operation.toLowerCase().includes(operationNeedle)) return false;
    return true;
  });

  filtered.sort((a, b) => b.timeMs - a.timeMs);

  // Anchor pagination: page 2+ carries the page-1 snapshot timestamp in its
  // cursor. Drop rows newer than the anchor before slicing so a record that
  // arrives between page fetches neither duplicates nor skips rows. Rows newer
  // than the anchor reappear only when the client restarts from page 1.
  const anchored = typeof query.anchorMs === "number" ? filtered.filter((row) => row.timeMs <= (query.anchorMs as number)) : filtered;

  const offset = Math.max(0, query.offset);
  const page = anchored.slice(offset, offset + query.limit);
  const nextOffset = offset + query.limit < anchored.length ? offset + query.limit : null;
  // Keep the anchor stable across pages: page 1 (no anchor) seeds it from the
  // newest row; later pages echo the anchor they were given.
  const newestTimeMs = typeof query.anchorMs === "number" ? query.anchorMs : anchored.length > 0 ? anchored[0].timeMs : null;
  return {
    rows: page,
    total: anchored.length,
    nextOffset,
    newestTimeMs,
  };
}
