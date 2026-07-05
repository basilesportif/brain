// Canonical Brain-side view of codex-chat's ENFORCED capability store.
//
// SOURCE OF TRUTH: codex-chat/src/capabilities.ts (`loadBrainCapabilityStore`
// + `authorize()` and its private helpers). codex-chat is the live authorizer;
// Brain reads and (later) writes exactly this shape. The types and the pure
// evaluation functions below are a faithful transcription of that file so the
// admin dry-run answers match what codex-chat actually decides.
//
// KEEP IN SYNC: if codex-chat's store schema or authorize semantics change,
// this module must change with them. Divergence here silently lies to the
// operator about a fail-closed system. This is intentionally NOT the stale
// placeholder model in ./capabilities.ts (which models the old non-enforcing
// foundation and is removed in a later step).

// --- Canonical store shape (mirror of codex-chat BrainCapabilityStore) -------

export interface CapabilityStore {
  schemaVersion?: number;
  storeId?: string;
  mode?: string;
  createdAt?: string;
  updatedAt?: string;
  writesEnabled?: boolean;
  enforcementEnabled?: boolean;
  people?: StorePerson[];
  externalIdentities?: StoreExternalIdentity[];
  subjects?: StoreSubject[];
  grantBundles?: StoreGrantBundle[];
  grants?: StoreGrant[];
}

export interface StorePerson {
  id: string;
  displayName?: string;
  status?: string;
  personType?: string;
  primarySubjectId?: string;
  identityIds?: string[];
  subjectIds?: string[];
}

export interface StoreExternalIdentity {
  id: string;
  provider: string;
  providerUserId: string;
  providerTeamId?: string;
  providerChatId?: string;
  personId?: string;
  status?: string;
  label?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface StoreSubject {
  id: string;
  personId?: string;
  identityId?: string;
  status?: string;
  kind?: string;
  label?: string;
  description?: string;
  source?: string;
  externalIds?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface StoreGrantBundle {
  id: string;
  label?: string;
  includes?: { groupIds?: string[]; capabilityIds?: string[] };
  status?: string;
}

export interface StoreGrantResource {
  kind?: string;
  id?: string;
  selectors?: Record<string, unknown>;
}

export interface StoreGrant {
  id: string;
  subjectId: string;
  capabilityId: string;
  grantKind?: string;
  bundleId?: string;
  resource?: StoreGrantResource;
  actions?: unknown[];
  status?: string;
  enforcement?: string;
  source?: { kind?: string; id?: string } | string;
  grantedBy?: string;
  grantedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  reason?: string;
}

// A capability resource is a flat bag of selector keys (teamId, channelId,
// projectId, …). codex-chat's `CapabilityResource`.
export type CapabilityResource = Record<string, unknown>;

// Minimal actor context — the subset of codex-chat's `ActorContext` that the
// authorizer's identity resolution reads.
export interface ActorContext {
  id?: string;
  surfaceKind?: string;
  surfaceUserId?: string;
  teamId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthorizationRequirement {
  operation: string;
  action?: string;
  resource: CapabilityResource;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason: string;
  grantIds: string[];
  subjectIds: string[];
}

// --- Store parsing (mirror of loadBrainCapabilityStore) ----------------------

export function parseCapabilityStore(text: string): CapabilityStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Parity with codex-chat's loadBrainCapabilityStore: an unparseable store
    // reads as "unavailable" (the caller anchors the store path onto this).
    throw new Error("brain_store_unavailable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("brain_store_invalid");
  const store = parsed as CapabilityStore;
  if (!Array.isArray(store.grants) || !Array.isArray(store.subjects) || !Array.isArray(store.externalIdentities)) {
    throw new Error("brain_store_invalid_schema");
  }
  return store;
}

// --- External-identity actor strings ----------------------------------------

// codex-chat records decisions with an `actorId` string in a canonical external
// form (`telegram:user:<id>`, `slack:team:<team>:user:<user>`). The dry-run
// endpoint accepts that same form and reconstructs the ActorContext the
// authorizer resolves identities from. Unrecognized shapes (`system:system`,
// `telegram:system`) intentionally resolve to nothing → fail-closed deny.
export function actorContextFromExternalId(actorId: string): ActorContext {
  const trimmed = actorId.trim();
  const slack = /^slack:team:([^:]+):user:(.+)$/.exec(trimmed);
  if (slack) return { id: trimmed, surfaceKind: "slack", surfaceUserId: slack[2], teamId: slack[1] };
  const telegram = /^telegram:user:(.+)$/.exec(trimmed);
  if (telegram) return { id: trimmed, surfaceKind: "telegram", surfaceUserId: telegram[1] };
  return { id: trimmed };
}

// --- Authorization evaluation (transcribed from authorize()) -----------------

export function evaluateAuthorization(
  store: CapabilityStore,
  input: { actor: ActorContext; requirement: AuthorizationRequirement; now?: Date },
): AuthorizationResult {
  const { actor, requirement } = input;
  const now = input.now;
  const operation = requirement.operation;
  const action = requirement.action ?? actionFromOperation(operation);
  const resource = requirement.resource ?? {};

  const actorResolution = resolveActorSubjects(store, actor);
  if (!actorResolution.allowed) {
    return { allowed: false, reason: actorResolution.reason, grantIds: [], subjectIds: [] };
  }

  const matched: StoreGrant[] = [];
  const reasons: string[] = [];
  for (const grant of store.grants ?? []) {
    const result = grantMatches(store, grant, actorResolution.subjectIds, operation, action, resource, now);
    if (result.allowed) matched.push(grant);
    else if (result.reason) reasons.push(`${grant.id}:${result.reason}`);
  }

  if (matched.length === 0) {
    return {
      allowed: false,
      reason: reasons.length === 0 ? `No active Brain grant allows ${operation}/${action}` : `No matching Brain grant: ${reasons.slice(0, 5).join(", ")}`,
      grantIds: [],
      subjectIds: actorResolution.subjectIds,
    };
  }

  return { allowed: true, reason: "active_brain_grant", grantIds: matched.map((grant) => grant.id), subjectIds: actorResolution.subjectIds };
}

export function actionFromOperation(operation: string): string {
  const tail = operation.split(".").pop() ?? operation;
  return tail || operation;
}

// True when a grant is currently in force (active, not revoked, enforcing, not
// expired) — the state prefix of grantMatches, minus operation/action/resource.
// Used by grant *summaries* (does a subject hold this capability at all?),
// which are resource-independent unlike a full authorization decision.
export function grantInForce(grant: StoreGrant, now?: Date): boolean {
  if (grant.status !== "active") return false;
  if (grant.revokedAt) return false;
  if (grant.enforcement && grant.enforcement !== "enforcing") return false;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= (now?.getTime() ?? Date.now())) return false;
  return true;
}

// Of `candidateIds`, the capability ids that any in-force grant for one of
// `subjectIds` allows (honoring group prefix + bundle expansion, resource
// selectors aside). Powers per-group "granted x/y" summaries.
export function grantedCapabilityIds(store: CapabilityStore, subjectIds: string[], candidateIds: Iterable<string>, now?: Date): Set<string> {
  const subjectSet = new Set(subjectIds);
  const inForce = (store.grants ?? []).filter((grant) => subjectSet.has(grant.subjectId) && grantInForce(grant, now));
  const granted = new Set<string>();
  for (const capabilityId of candidateIds) {
    if (inForce.some((grant) => grantAllowsCapability(store, grant, capabilityId))) granted.add(capabilityId);
  }
  return granted;
}

function resolveActorSubjects(store: CapabilityStore, actor: ActorContext): { allowed: true; subjectIds: string[] } | { allowed: false; reason: string } {
  const candidateSubjectIds = new Set<string>();
  const metadataSubject = stringValue(actor.metadata?.brainSubjectId) ?? stringValue(actor.metadata?.brain_subject_id);
  if (metadataSubject) candidateSubjectIds.add(metadataSubject);
  if ((store.subjects ?? []).some((subject) => subject.id === actor.id)) candidateSubjectIds.add(actor.id as string);

  const identity = findExternalIdentity(store, actor);
  if (identity) {
    if (identity.status && !["active", "linked"].includes(identity.status)) return { allowed: false, reason: `identity_inactive:${identity.status}` };
    const person = findPersonForIdentity(store, identity);
    if (person?.status && person.status !== "active") return { allowed: false, reason: `person_inactive:${person.status}` };
    if (identity.personId) {
      for (const subject of store.subjects ?? []) if (subject.personId === identity.personId) candidateSubjectIds.add(subject.id);
    }
    for (const subject of store.subjects ?? []) if (subject.identityId === identity.id) candidateSubjectIds.add(subject.id);
    if (person?.primarySubjectId) candidateSubjectIds.add(person.primarySubjectId);
    for (const subjectId of person?.subjectIds ?? []) candidateSubjectIds.add(subjectId);
  }

  const activeSubjectIds = [...candidateSubjectIds].filter((id) => {
    const subject = (store.subjects ?? []).find((candidate) => candidate.id === id);
    return subject && (!subject.status || subject.status === "active");
  });
  if (activeSubjectIds.length === 0) return { allowed: false, reason: "actor_not_linked_to_brain_subject" };
  return { allowed: true, subjectIds: activeSubjectIds };
}

function findExternalIdentity(store: CapabilityStore, actor: ActorContext): StoreExternalIdentity | undefined {
  const identities = store.externalIdentities ?? [];
  if (actor.surfaceKind === "slack") {
    const userId = actor.surfaceUserId ?? stringValue(actor.metadata?.slackUserId);
    const teamId = actor.teamId ?? stringValue(actor.metadata?.slackTeamId);
    return identities.find((identity) => identity.provider === "slack" && identity.providerUserId === userId && (!identity.providerTeamId || identity.providerTeamId === teamId));
  }
  if (actor.surfaceKind === "telegram") {
    const userId = actor.surfaceUserId ?? stringValue(actor.metadata?.telegramUserId);
    return identities.find((identity) => identity.provider === "telegram" && identity.providerUserId === String(userId));
  }
  const provider = actor.surfaceKind;
  if (!provider) return undefined;
  return identities.find((identity) => identity.provider === provider && identity.providerUserId === actor.surfaceUserId);
}

function findPersonForIdentity(store: CapabilityStore, identity: StoreExternalIdentity): StorePerson | undefined {
  if (!identity.personId) return undefined;
  return (store.people ?? []).find((person) => person.id === identity.personId);
}

function grantMatches(
  store: CapabilityStore,
  grant: StoreGrant,
  subjectIds: string[],
  operation: string,
  action: string,
  resource: CapabilityResource,
  now: Date | undefined,
): { allowed: boolean; reason?: string } {
  if (!subjectIds.includes(grant.subjectId)) return { allowed: false };
  if (grant.status !== "active") return { allowed: false, reason: "inactive" };
  if (grant.revokedAt) return { allowed: false, reason: "revoked" };
  if (grant.enforcement && grant.enforcement !== "enforcing") return { allowed: false, reason: `non_enforcing:${grant.enforcement}` };
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= (now?.getTime() ?? Date.now())) return { allowed: false, reason: "expired" };
  if (!grantAllowsCapability(store, grant, operation)) return { allowed: false, reason: "operation" };
  if (!grantAllowsAction(grant, action)) return { allowed: false, reason: "action" };
  if (!selectorsMatch(grant.resource?.selectors ?? {}, resource)) return { allowed: false, reason: "resource" };
  return { allowed: true };
}

function grantAllowsCapability(store: CapabilityStore, grant: StoreGrant, operation: string): boolean {
  // Enforcement intentionally does not honor operation wildcards. Brain may grant
  // grouped capabilities through bundles/groups, but runtime-created '*' grants
  // are never accepted as a side-effect authorization.
  if (grant.capabilityId === operation) return true;
  if (grant.grantKind === "group" && operation.startsWith(`${grant.capabilityId}.`)) return true;
  if (grant.grantKind === "bundle") {
    const bundleId = grant.bundleId ?? grant.capabilityId;
    const bundle = (store.grantBundles ?? []).find((candidate) => candidate.id === bundleId && candidate.status === "active");
    if (!bundle) return false;
    if ((bundle.includes?.capabilityIds ?? []).includes(operation)) return true;
    return (bundle.includes?.groupIds ?? []).some((groupId) => operation === groupId || operation.startsWith(`${groupId}.`));
  }
  return false;
}

function grantAllowsAction(grant: StoreGrant, action: string): boolean {
  const actions = (grant.actions ?? []).map((item) => String(item));
  return actions.includes(action) || actions.includes("*");
}

function selectorsMatch(selectors: Record<string, unknown>, resource: CapabilityResource): boolean {
  const resourceRecord = resource as Record<string, unknown>;
  for (const [key, selector] of Object.entries(selectors)) {
    const actual = resourceRecord[key];
    if (!selectorMatches(selector, actual)) return false;
  }
  // Require explicit coverage for each concrete resource selector supplied by
  // the caller. Broad Brain grants must say '*' for that selector key.
  for (const [key, actual] of Object.entries(resourceRecord)) {
    if (actual === undefined || actual === null || actual === "") continue;
    if (!(key in selectors)) return false;
  }
  return true;
}

function selectorMatches(selector: unknown, actual: unknown): boolean {
  if (selector === "*") return true;
  if (Array.isArray(selector)) return selector.some((item) => selectorMatches(item, actual));
  if (actual === undefined || actual === null) return false;
  return String(selector) === String(actual);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
