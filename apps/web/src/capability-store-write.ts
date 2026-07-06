// §6.5 WRITES: the atomic, schema-validated, backed-up write path for the
// ENFORCED capability store, plus the pure mutators the admin write endpoints
// apply (create person, link/unlink identity, grant/revoke). Every write hits
// the live fail-closed store, so the invariants (plan §9.3) are enforced here,
// not in the HTTP layer:
//
//   1. The resulting store is re-validated against the canonical schema BEFORE
//      it is persisted — an invalid result is REFUSED (an invalid store
//      fail-closes the whole assistant).
//   2. Self-lockout is refused — a mutation may never remove the last effective
//      capability-admin (a holder of an in-force capability-admin grant who
//      still has a linked identity).
//   3. Writes are atomic (temp-file mode 0600 -> rename) and retain a
//      last-known-good copy plus a timestamped backup for one-step rollback.
//   4. Optimistic concurrency: a content-hash change between load and write is
//      rejected with a retryable conflict (409-style) error.
//
// The mutators are pure over a cloned store so preview (dry-run) and commit run
// the exact same code; only commit persists.

import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  CAPABILITY_GROUP_DEFINITIONS,
  catalogDefinitionsForSource,
  defaultSelectorsForCapability,
  mappedCatalogCapabilityIds,
  storeCapabilityVocabulary,
  type CapabilityCatalogRegistrySource,
} from "./capability-catalog.js";
import {
  actorContextFromExternalId,
  evaluateAuthorization,
  grantedCapabilityIds,
  grantInForce,
  parseCapabilityStore,
  subjectExistsAndActive,
  subjectIdsForPerson,
  type ActorContext,
  type CapabilityStore,
  type StoreExternalIdentity,
  type StoreGrant,
  type StorePerson,
} from "./capability-store.js";

// --- Errors ------------------------------------------------------------------

// A typed write failure carrying the HTTP status the endpoint should surface.
export class CapabilityWriteError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "CapabilityWriteError";
  }
}

// --- Serialization + hashing -------------------------------------------------

// Serialize exactly like the existing store writer (2-space indent + trailing
// newline) so backups and rewrites are byte-stable.
export function serializeStore(store: CapabilityStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

export function hashStoreText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Re-validate a candidate store against the canonical schema (codex-chat's
// loadBrainCapabilityStore shape check, via parseCapabilityStore). Throws a
// refusal if the result would fail-close the assistant.
export function assertValidStore(store: CapabilityStore): void {
  let text: string;
  try {
    text = serializeStore(store);
  } catch (error) {
    throw new CapabilityWriteError("store_would_be_invalid", 422, "Resulting store is not serializable", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    parseCapabilityStore(text);
  } catch (error) {
    throw new CapabilityWriteError("store_would_be_invalid", 422, "Resulting store fails canonical schema validation", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

// --- Store load for write ----------------------------------------------------

export interface LoadedStore {
  text: string;
  hash: string;
  store: CapabilityStore;
}

// Load + validate the current store for a write. A missing/unreadable/invalid
// store fails closed (503) — never treated as an empty allow-list.
export async function loadStoreForWrite(storePath: string): Promise<LoadedStore> {
  let text: string;
  try {
    text = await readFile(storePath, "utf8");
  } catch {
    throw new CapabilityWriteError("capability_store_unavailable", 503, "Capability store is unreachable");
  }
  let store: CapabilityStore;
  try {
    store = parseCapabilityStore(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CapabilityWriteError("capability_store_unavailable", 503, "Capability store is invalid", { reason });
  }
  return { text, hash: hashStoreText(text), store };
}

// --- Backup + atomic write ---------------------------------------------------

export interface BackupPaths {
  lkgPath: string;
  bakPath: string;
}

function backupTimestamp(now: Date): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return iso; // e.g. 20260705T031500Z
}

// Retain a last-known-good copy (<store>.lkg.json, overwritten each write) plus
// a timestamped backup (<store>.<ts>.bak) of the pre-write content for one-step
// rollback. Called before the store is overwritten.
export async function backupStore(storePath: string, currentText: string, now: Date = new Date()): Promise<BackupPaths> {
  const lkgPath = `${storePath}.lkg.json`;
  const bakPath = `${storePath}.${backupTimestamp(now)}.bak`;
  await writeFile(lkgPath, currentText, { mode: 0o600 });
  await chmod(lkgPath, 0o600).catch(() => undefined);
  await writeFile(bakPath, currentText, { mode: 0o600 });
  await chmod(bakPath, 0o600).catch(() => undefined);
  return { lkgPath, bakPath };
}

// Atomic temp-file-then-rename write, mode 0600 (same contract as the existing
// env/store writers).
export async function atomicWriteStore(storePath: string, store: CapabilityStore): Promise<string> {
  const text = serializeStore(store);
  await mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, storePath);
  await chmod(storePath, 0o600).catch(() => undefined);
  return text;
}

export interface CapabilityStoreSeedResult {
  created: boolean;
  storePath: string;
  adminEmail?: string;
  storeHash?: string;
  backup?: BackupPaths;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function seedSuffix(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function capabilityAdminSeedCapabilityIds(): string[] {
  const group = CAPABILITY_GROUP_DEFINITIONS.find((definition) => definition.id === "capability-admin");
  return group?.capabilities.map((capability) => capability.id) ?? ["capability.catalog.read"];
}

function buildSeedStore(adminEmail: string | undefined, now: Date = new Date()): CapabilityStore {
  const at = now.toISOString();
  const store: CapabilityStore = {
    schemaVersion: 2,
    storeId: `brain_capability_store_${seedSuffix(at)}`,
    mode: "enforcing",
    createdAt: at,
    updatedAt: at,
    writesEnabled: true,
    enforcementEnabled: true,
    people: [],
    externalIdentities: [],
    subjects: [],
    grantBundles: [],
    grants: [],
  };
  if (!adminEmail) return store;

  const suffix = seedSuffix(adminEmail);
  const personId = `person_admin_${suffix}`;
  const subjectId = `person:${personId}`;
  const identityId = `identity_clerk_${suffix}`;
  store.people = [{
    id: personId,
    displayName: adminEmail,
    status: "active",
    personType: "human",
    primarySubjectId: subjectId,
    identityIds: [identityId],
    subjectIds: [subjectId],
  }];
  store.externalIdentities = [{
    id: identityId,
    provider: "clerk",
    providerUserId: adminEmail,
    personId,
    status: "linked",
    label: "Clerk admin email",
    createdAt: at,
    updatedAt: at,
  }];
  store.subjects = [{ id: subjectId, personId, status: "active", kind: "person", source: "startup_seed" }];
  store.grants = capabilityAdminSeedCapabilityIds().map((capabilityId) => ({
    id: `grant_startup_${capabilityId.replaceAll(".", "_")}_${suffix}`,
    subjectId,
    capabilityId,
    grantKind: "capability",
    resource: { selectors: defaultSelectorsForCapability(capabilityId) },
    actions: ["*"],
    status: "active",
    enforcement: "enforcing",
    grantedBy: "brain-admin-startup",
    grantedAt: at,
    source: { kind: "startup_seed", id: "brain-admin" },
    reason: "Seeded from first Clerk allowlisted admin email",
  }));
  return store;
}

export async function createCapabilityStoreIfMissing(options: { storePath: string; adminEmail?: string }): Promise<CapabilityStoreSeedResult> {
  return enqueueMutation(async () => {
    try {
      await readFile(options.storePath, "utf8");
      return { created: false, storePath: options.storePath };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new CapabilityWriteError("capability_store_unavailable", 503, "Capability store is unreachable");
      }
    }

    const store = buildSeedStore(options.adminEmail);
    assertValidStore(store);
    const writtenText = await atomicWriteStore(options.storePath, store);
    const backup = await backupStore(options.storePath, writtenText);
    return {
      created: true,
      storePath: options.storePath,
      adminEmail: options.adminEmail,
      storeHash: hashStoreText(writtenText),
      backup,
    };
  });
}

// Guard against a rare copyFile-based rollback needing the raw file; exported so
// callers can restore the last-known-good copy (plan's revert contract).
export async function restoreLastKnownGood(storePath: string): Promise<void> {
  await copyFile(`${storePath}.lkg.json`, storePath);
  await chmod(storePath, 0o600).catch(() => undefined);
}

// --- Mutation specs ----------------------------------------------------------

export type MutationSpec =
  | { kind: "create_person"; displayName: string; adminEmail: string }
  | { kind: "link_identity"; personId: string; provider: string; externalId: string; teamId?: string; adminEmail: string }
  | { kind: "unlink_identity"; personId: string; identityId: string; adminEmail: string }
  | { kind: "grant"; personId: string; target: string; selectors?: Record<string, unknown>; registry?: CapabilityCatalogRegistrySource; adminEmail: string }
  | { kind: "revoke"; personId: string; grantId: string; adminEmail: string }
  | { kind: "revoke_batch"; personId: string; grantIds: string[]; reason?: string; adminEmail: string };

export interface MutationOutcome {
  changed: boolean;
  personId?: string;
  // Capability ids the mutation directly touches (grant/revoke). Undefined lets
  // the impact preview union the person's whole in-force capability set (used
  // for identity link/unlink, which flips a whole surface).
  explicitCapabilityIds?: string[];
  // Representative resources for previewing selector-scoped grants. For grants,
  // each capability is evaluated against the exact selector bag that will be
  // stored, so a narrowed selector can deny/allow differently from a broad one.
  impactResources?: Record<string, Record<string, unknown>>;
  // Structured, secret-free audit payload appended on a successful commit.
  audit: Record<string, unknown>;
  // Response detail surfaced to the caller (ids that were created/changed).
  detail: Record<string, unknown>;
}

// --- Capability-admin holder / self-lockout model ----------------------------

// The capability-admin group id plus its child capability ids — the set that
// identifies a capability-admin grant regardless of whether it was granted as a
// group or as individual capabilities.
const CAPABILITY_ADMIN_IDS: string[] = (() => {
  const group = CAPABILITY_GROUP_DEFINITIONS.find((definition) => definition.id === "capability-admin");
  const ids = new Set<string>(["capability-admin"]);
  for (const child of group?.capabilities ?? []) ids.add(child.id);
  return [...ids];
})();

// A person's subject ids that would actually resolve at runtime for admin
// computation: codex-chat's resolveActorSubjects keeps only subjects that exist
// in store.subjects and are not explicitly inactive, so a grant on a missing or
// suspended subject can never reach the admin surface and must not count toward
// self-lockout.
function personActiveSubjectIds(store: CapabilityStore, person: StorePerson): string[] {
  return subjectIdsForPerson(store, person).filter((id) => subjectExistsAndActive(store, id));
}

function personLinkedIdentities(store: CapabilityStore, personId: string): StoreExternalIdentity[] {
  return (store.externalIdentities ?? []).filter(
    (identity) => identity.personId === personId && (!identity.status || ["linked", "active"].includes(identity.status)),
  );
}

// Persons who both hold an in-force capability-admin grant (on any of their
// subjects) AND still have at least one linked identity — i.e. can actually
// reach the admin surface. Removing the last of these is a self-lockout.
export function effectiveCapabilityAdmins(store: CapabilityStore, now?: Date): Set<string> {
  const admins = new Set<string>();
  for (const person of store.people ?? []) {
    if (person.status && person.status !== "active") continue;
    if (personLinkedIdentities(store, person.id).length === 0) continue;
    const subjectIds = personActiveSubjectIds(store, person);
    const granted = grantedCapabilityIds(store, subjectIds, CAPABILITY_ADMIN_IDS, now);
    if (granted.size > 0) admins.add(person.id);
  }
  return admins;
}

function guardSelfLockout(before: CapabilityStore, after: CapabilityStore): void {
  const adminsBefore = effectiveCapabilityAdmins(before);
  // Nothing to protect if the store already has no effective admin (never brick
  // further, but do not manufacture a lockout error on an already-broken store).
  if (adminsBefore.size === 0) return;
  const adminsAfter = effectiveCapabilityAdmins(after);
  if (adminsAfter.size === 0) {
    throw new CapabilityWriteError(
      "self_lockout",
      422,
      "Refused: this change removes the last capability-admin who can still reach the admin surface",
      { adminsBefore: [...adminsBefore] },
    );
  }
}

// --- Impact preview ----------------------------------------------------------

export interface SurfaceImpact {
  surface: string;
  newlyAllowed: string[];
  newlyDenied: string[];
}

export interface ImpactPreview {
  surfaces: SurfaceImpact[];
  summary: { newlyAllowedCount: number; newlyDeniedCount: number };
  // A fixed caveat: grant previews evaluate against the selector resource that
  // will be written, while non-grant previews use an empty resource. Live
  // requests still carry concrete resource keys that must be covered by the
  // grant's selectors (codex-chat's selectorsMatch requires explicit coverage).
  previewCaveat: string;
}

export const IMPACT_PREVIEW_CAVEAT =
  "preview evaluates grant selectors when available; live requests include concrete resource keys that must be covered by the grant's selectors";

// Representative actor contexts for a person's linked surfaces, in the canonical
// external form the enforcer resolves (telegram:user:<id>,
// slack:team:<team>:user:<user>).
function personSurfaceActors(store: CapabilityStore, personId: string): { surface: string; actor: ActorContext }[] {
  const out: { surface: string; actor: ActorContext }[] = [];
  const seen = new Set<string>();
  for (const identity of personLinkedIdentities(store, personId)) {
    let surface: string | undefined;
    if (identity.provider === "telegram") surface = `telegram:user:${identity.providerUserId}`;
    else if (identity.provider === "slack" && identity.providerTeamId) surface = `slack:team:${identity.providerTeamId}:user:${identity.providerUserId}`;
    if (!surface || seen.has(surface)) continue;
    seen.add(surface);
    out.push({ surface, actor: actorContextFromExternalId(surface) });
  }
  return out;
}

// In-force capability ids across a person's active subjects (group ids included:
// evaluating a group id as an operation exercises the group-level allow).
function personInForceCapabilityIds(store: CapabilityStore, personId: string): string[] {
  const person = (store.people ?? []).find((candidate) => candidate.id === personId);
  if (!person) return [];
  const subjectSet = new Set(personActiveSubjectIds(store, person));
  const ids = new Set<string>();
  for (const grant of store.grants ?? []) {
    if (!subjectSet.has(grant.subjectId)) continue;
    if (!grantInForce(grant)) continue;
    if (grant.capabilityId) ids.add(grant.capabilityId);
  }
  return [...ids];
}

// Compare authorization decisions for the affected capability ids across a
// person's linked surfaces before vs after the (simulated) mutation, using a
// representative empty resource so the diff reflects grant/identity presence
// rather than incidental selector coverage. Runs the SAME evaluator the enforcer
// uses (plan §6.5 dry-run parity).
export function computeImpact(
  before: CapabilityStore,
  after: CapabilityStore,
  personId: string | undefined,
  explicitCapabilityIds?: string[],
  impactResources: Record<string, Record<string, unknown>> = {},
): ImpactPreview {
  if (!personId) return { surfaces: [], summary: { newlyAllowedCount: 0, newlyDeniedCount: 0 }, previewCaveat: IMPACT_PREVIEW_CAVEAT };

  const capabilityIds = explicitCapabilityIds
    ? [...new Set(explicitCapabilityIds)]
    : [...new Set([...personInForceCapabilityIds(before, personId), ...personInForceCapabilityIds(after, personId)])];

  // Union of surfaces present before and after so an unlink (surface removed in
  // "after") and a link (surface added in "after") both show their diff.
  const surfaceActors = new Map<string, ActorContext>();
  for (const { surface, actor } of personSurfaceActors(before, personId)) surfaceActors.set(surface, actor);
  for (const { surface, actor } of personSurfaceActors(after, personId)) if (!surfaceActors.has(surface)) surfaceActors.set(surface, actor);

  const surfaces: SurfaceImpact[] = [];
  let newlyAllowedCount = 0;
  let newlyDeniedCount = 0;
  for (const [surface, actor] of surfaceActors) {
    const newlyAllowed: string[] = [];
    const newlyDenied: string[] = [];
    for (const capabilityId of capabilityIds) {
      const requirement = { operation: capabilityId, resource: impactResources[capabilityId] ?? {} };
      const wasAllowed = evaluateAuthorization(before, { actor, requirement }).allowed;
      const isAllowed = evaluateAuthorization(after, { actor, requirement }).allowed;
      if (isAllowed && !wasAllowed) newlyAllowed.push(capabilityId);
      else if (wasAllowed && !isAllowed) newlyDenied.push(capabilityId);
    }
    newlyAllowed.sort();
    newlyDenied.sort();
    newlyAllowedCount += newlyAllowed.length;
    newlyDeniedCount += newlyDenied.length;
    surfaces.push({ surface, newlyAllowed, newlyDenied });
  }
  return { surfaces, summary: { newlyAllowedCount, newlyDeniedCount }, previewCaveat: IMPACT_PREVIEW_CAVEAT };
}

// --- Mutators (pure; mutate the passed clone) --------------------------------

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CapabilityWriteError("invalid_request", 400, `${field} is required`);
  }
  return value.trim();
}

function findPerson(store: CapabilityStore, personId: string): StorePerson {
  const person = (store.people ?? []).find((candidate) => candidate.id === personId);
  if (!person) throw new CapabilityWriteError("person_not_found", 404, `Person ${personId} not found`);
  return person;
}

function ensureWritablePrimarySubject(store: CapabilityStore, person: StorePerson): { subjectId: string; materialized: boolean } {
  const subjectId = requireNonEmpty(person.primarySubjectId, "primarySubjectId");
  const subjects = (store.subjects ??= []);
  const subject = subjects.find((candidate) => candidate.id === subjectId);
  if (!subject) {
    subjects.push({ id: subjectId, personId: person.id, status: "active", kind: "person", source: "manual_admin" });
    person.subjectIds = [...new Set([...(person.subjectIds ?? []), subjectId])];
    return { subjectId, materialized: true };
  }
  if (subject.status && subject.status !== "active") {
    throw new CapabilityWriteError("primary_subject_unavailable", 400, "Person primary subject is not active", {
      personId: person.id,
      subjectId,
      status: subject.status,
    });
  }
  return { subjectId, materialized: false };
}

function externalIdentityId(provider: string, externalId: string, teamId?: string): string {
  if (provider === "telegram") return `identity_telegram_${externalId}`;
  if (provider === "slack") return `identity_slack_${teamId}_${externalId}`;
  return `identity_${provider}_${externalId}`;
}

function applyCreatePerson(store: CapabilityStore, spec: Extract<MutationSpec, { kind: "create_person" }>): MutationOutcome {
  const displayName = requireNonEmpty(spec.displayName, "displayName");
  const now = new Date().toISOString();
  const personId = `person_${shortId()}`;
  const subjectId = `person:${personId}`;
  const person: StorePerson = {
    id: personId,
    displayName,
    status: "active",
    personType: "human",
    primarySubjectId: subjectId,
    identityIds: [],
    subjectIds: [subjectId],
  };
  (store.people ??= []).push(person);
  (store.subjects ??= []).push({ id: subjectId, personId, status: "active", kind: "person", source: "manual_admin" });
  store.updatedAt = now;
  return {
    changed: true,
    personId,
    explicitCapabilityIds: [],
    audit: { action: "person.created", adminEmail: spec.adminEmail, personId, subjectId, displayName },
    detail: { personId, subjectId, displayName },
  };
}

function applyLinkIdentity(store: CapabilityStore, spec: Extract<MutationSpec, { kind: "link_identity" }>): MutationOutcome {
  const person = findPerson(store, spec.personId);
  const provider = requireNonEmpty(spec.provider, "provider");
  if (provider !== "telegram" && provider !== "slack") {
    throw new CapabilityWriteError("invalid_request", 400, "provider must be telegram or slack");
  }
  const externalId = requireNonEmpty(spec.externalId, "externalId");
  const teamId = provider === "slack" ? requireNonEmpty(spec.teamId, "teamId") : undefined;
  const identityId = externalIdentityId(provider, externalId, teamId);
  const now = new Date().toISOString();

  const identities = (store.externalIdentities ??= []);
  let identity = identities.find((candidate) => candidate.id === identityId);
  if (identity) {
    if (identity.personId && identity.personId !== person.id) {
      throw new CapabilityWriteError("identity_conflict", 409, "Identity is already linked to another person");
    }
    identity.personId = person.id;
    identity.status = "linked";
    identity.updatedAt = now;
  } else {
    identity = {
      id: identityId,
      provider,
      providerUserId: externalId,
      ...(teamId ? { providerTeamId: teamId } : {}),
      personId: person.id,
      status: "linked",
      label: `${provider} ${externalId}`,
      createdAt: now,
      updatedAt: now,
    };
    identities.push(identity);
  }

  person.identityIds = [...new Set([...(person.identityIds ?? []), identityId])];

  // Record a manual_admin proof (secret-free) alongside the store's existing
  // proof records, if the store tracks them.
  const proofsRaw = (store as Record<string, unknown>).identityProofs;
  if (Array.isArray(proofsRaw)) {
    const proofId = `proof_${identityId}_manual_admin`;
    if (!proofsRaw.some((proof) => (proof as Record<string, unknown>)?.id === proofId)) {
      proofsRaw.push({
        id: proofId,
        identityId,
        source: "manual_admin",
        confidence: "high",
        observedAt: now,
        summary: `Manually linked by admin ${spec.adminEmail}.`,
        personId: person.id,
        evidence: { provider, providerUserId: externalId, ...(teamId ? { teamId } : {}), payloadBodiesLogged: false, secretValuesLogged: false },
      });
    }
  }

  store.updatedAt = now;
  return {
    changed: true,
    personId: person.id,
    // A new surface flips the person's whole in-force capability set: union.
    explicitCapabilityIds: undefined,
    audit: { action: "identity.link.added", adminEmail: spec.adminEmail, personId: person.id, identityId, provider },
    detail: { personId: person.id, identityId, provider },
  };
}

function applyUnlinkIdentity(store: CapabilityStore, spec: Extract<MutationSpec, { kind: "unlink_identity" }>): MutationOutcome {
  const person = findPerson(store, spec.personId);
  const identityId = requireNonEmpty(spec.identityId, "identityId");
  const identity = (store.externalIdentities ?? []).find(
    (candidate) => candidate.id === identityId && candidate.personId === person.id,
  );
  if (!identity) throw new CapabilityWriteError("identity_not_found", 404, `Identity ${identityId} not linked to ${person.id}`);
  const now = new Date().toISOString();

  // Unlink preserves the record for history but denies that surface: detach the
  // person link and mark it unlinked (the authorizer denies non-linked/active
  // identities).
  identity.status = "unlinked";
  identity.personId = undefined;
  identity.updatedAt = now;
  person.identityIds = (person.identityIds ?? []).filter((id) => id !== identityId);
  store.updatedAt = now;

  return {
    changed: true,
    personId: person.id,
    explicitCapabilityIds: undefined,
    audit: { action: "identity.link.removed", adminEmail: spec.adminEmail, personId: person.id, identityId, provider: identity.provider },
    detail: { personId: person.id, identityId, provider: identity.provider },
  };
}

interface ExpandedGrantTarget {
  capabilityIds: string[];
  expandedFromGroup: boolean;
  vocabularyEntries: Map<string, { selectorKeys: string[]; deprecated?: boolean; provenance: "registry" | "curated" | "store" }>;
}

function grantVocabularyEntryMap(
  store: CapabilityStore | undefined,
  registry: CapabilityCatalogRegistrySource | undefined,
): Map<string, { selectorKeys: string[]; deprecated?: boolean; provenance: "registry" | "curated" | "store" }> {
  const source = registry ?? { available: false, registryVersion: null, capabilities: [] };
  const out = new Map<string, { selectorKeys: string[]; deprecated?: boolean; provenance: "registry" | "curated" | "store" }>();
  for (const group of catalogDefinitionsForSource(store, source)) {
    for (const child of group.capabilities) {
      if (out.has(child.id)) continue;
      out.set(child.id, {
        selectorKeys: child.selectorKeys ?? [],
        provenance: child.provenance ?? "curated",
        ...(child.deprecated === true ? { deprecated: true } : {}),
      });
    }
  }
  return out;
}

function legacySelectorTemplate(store: CapabilityStore, capabilityId: string): Record<string, string> {
  const keys = new Set<string>();
  for (const grant of store.grants ?? []) {
    if (grant.capabilityId !== capabilityId) continue;
    for (const key of Object.keys((grant.resource?.selectors ?? {}) as Record<string, unknown>)) keys.add(key);
  }
  if (keys.size > 0) return Object.fromEntries([...keys].sort().map((key) => [key, "*"]));
  return defaultSelectorsForCapability(capabilityId);
}

const FORBIDDEN_SELECTOR_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeSelectors(value: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const out = Object.create(null) as Record<string, string>;
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(value, key)) continue;
    const selectorKey = requireNonEmpty(key, "selector key");
    if (FORBIDDEN_SELECTOR_KEYS.has(selectorKey)) {
      throw new CapabilityWriteError("invalid_selector", 400, `Selector key ${selectorKey} is not allowed`, { selectorKey });
    }
    if (typeof raw !== "string" || !raw.trim()) {
      throw new CapabilityWriteError("invalid_selector", 400, `Selector ${selectorKey} must be a non-empty string`);
    }
    out[selectorKey] = raw.trim();
    count += 1;
  }
  if (count === 0) {
    throw new CapabilityWriteError("invalid_selector", 400, "Provide at least one selector key or omit selectors to use defaults");
  }
  return out;
}

function validateSelectorsForCapability(
  capabilityId: string,
  selectors: Record<string, string>,
  vocabularyEntries: Map<string, { selectorKeys: string[]; deprecated?: boolean; provenance: "registry" | "curated" | "store" }>,
): void {
  const entry = vocabularyEntries.get(capabilityId);
  if (!entry) {
    throw new CapabilityWriteError("unknown_capability", 400, `Unknown capability ${capabilityId}`);
  }
  const allowed = new Set(entry.selectorKeys);
  for (const key of Object.keys(selectors)) {
    if (!allowed.has(key)) {
      throw new CapabilityWriteError("invalid_selector", 400, `Selector ${key} is not valid for ${capabilityId}`, {
        capabilityId,
        selectorKey: key,
        allowedSelectorKeys: entry.selectorKeys,
      });
    }
  }
}

function defaultSelectorsForGrantEntry(
  store: CapabilityStore,
  capabilityId: string,
  entry: { selectorKeys: string[]; provenance: "registry" | "curated" | "store" },
): Record<string, string> {
  if (entry.provenance === "registry") return Object.fromEntries(entry.selectorKeys.map((key) => [key, "*"]));
  if (entry.provenance === "curated") return defaultSelectorsForCapability(capabilityId);
  if (entry.selectorKeys.length > 0) return Object.fromEntries(entry.selectorKeys.map((key) => [key, "*"]));
  return legacySelectorTemplate(store, capabilityId);
}

// Expand a grant target (registry family group OR individual capability id) into
// the capability ids to write. When the codex-chat registry is available it is
// the primary vocabulary. Store-only ids remain eligible as legacy ids only when
// the current store already references them; HTTP callers always pass a registry
// context, while older direct callers keep the legacy catalog fallback.
export function expandGrantTarget(
  target: string,
  store?: CapabilityStore,
  registry?: CapabilityCatalogRegistrySource,
): ExpandedGrantTarget {
  const source = registry ?? { available: false, registryVersion: null, capabilities: [] };
  const definitions = catalogDefinitionsForSource(store, source);
  const vocabularyEntries = grantVocabularyEntryMap(store, registry);
  const group = definitions.find((definition) => definition.id === target);
  if (group) {
    if (group.synthetic && registry?.available) {
      throw new CapabilityWriteError("unknown_capability", 400, `Capability group ${target} is not grantable as a group`);
    }
    const grantableChildren = group.capabilities.filter((child) => child.deprecated !== true && child.grantable !== false && child.provenance !== "store");
    if (grantableChildren.length === 0) {
      throw new CapabilityWriteError("invalid_request", 400, `Group ${target} has no grantable capabilities`);
    }
    return { capabilityIds: grantableChildren.map((child) => child.id), expandedFromGroup: true, vocabularyEntries };
  }

  const vocabularyEntry = vocabularyEntries.get(target);
  if (vocabularyEntry) {
    if (vocabularyEntry.deprecated) {
      throw new CapabilityWriteError("deprecated_capability", 400, `Capability ${target} is deprecated and cannot be granted`);
    }
    return { capabilityIds: [target], expandedFromGroup: false, vocabularyEntries };
  }

  const vocabulary = store ? storeCapabilityVocabulary(store) : new Set<string>();
  if (registry && vocabulary.has(target)) {
    return { capabilityIds: [target], expandedFromGroup: false, vocabularyEntries };
  }

  // Direct non-HTTP callers without a registry context keep the pre-registry
  // static catalog guard instead of being allowed to persist arbitrary strings.
  if (!registry && mappedCatalogCapabilityIds().has(target)) {
    return { capabilityIds: [target], expandedFromGroup: false, vocabularyEntries };
  }

  throw new CapabilityWriteError("unknown_capability", 400, `Unknown capability ${target}`);
}

function applyGrant(store: CapabilityStore, spec: Extract<MutationSpec, { kind: "grant" }>): MutationOutcome {
  const person = findPerson(store, spec.personId);
  const target = requireNonEmpty(spec.target, "target");
  const { capabilityIds, expandedFromGroup, vocabularyEntries } = expandGrantTarget(target, store, spec.registry);
  const { subjectId, materialized } = ensureWritablePrimarySubject(store, person);
  const now = new Date().toISOString();
  // An explicit selectors object in the request wins verbatim; otherwise each
  // granted capability defaults to the broad selector template for its group so
  // the grant actually covers the concrete resource keys the runtime sends.
  const explicitSelectors = normalizeSelectors(
    spec.selectors && typeof spec.selectors === "object" && !Array.isArray(spec.selectors) ? spec.selectors : undefined,
  );

  // Skip capabilities the person's active subjects already hold in force so a
  // re-grant is idempotent rather than piling duplicate rows.
  const alreadyGranted = grantedCapabilityIds(store, personActiveSubjectIds(store, person), capabilityIds);
  const toGrant = capabilityIds.filter((id) => !alreadyGranted.has(id));

  const grantIds: string[] = [];
  const impactResources: Record<string, Record<string, unknown>> = {};
  const grants = (store.grants ??= []);
  for (const capabilityId of toGrant) {
    const grantId = `grant_admin_${shortId()}`;
    const vocabularyEntry = vocabularyEntries.get(capabilityId);
    if (!vocabularyEntry) throw new CapabilityWriteError("unknown_capability", 400, `Unknown capability ${capabilityId}`);
    const selectors = explicitSelectors ?? defaultSelectorsForGrantEntry(store, capabilityId, vocabularyEntry);
    validateSelectorsForCapability(capabilityId, selectors, vocabularyEntries);
    const grant: StoreGrant = {
      id: grantId,
      subjectId,
      capabilityId,
      grantKind: "capability",
      resource: { selectors },
      actions: ["*"],
      status: "active",
      enforcement: "enforcing",
      grantedBy: spec.adminEmail,
      grantedAt: now,
      source: { kind: "admin_manual", id: spec.adminEmail },
      reason: expandedFromGroup ? `Granted via group ${target} by admin` : "Granted by admin",
    };
    grants.push(grant);
    grantIds.push(grantId);
    impactResources[capabilityId] = { ...selectors };
  }
  if (materialized || grantIds.length > 0) store.updatedAt = now;

  return {
    changed: materialized || grantIds.length > 0,
    personId: person.id,
    explicitCapabilityIds: capabilityIds,
    impactResources,
    audit: {
      action: "capability.grant.applied",
      adminEmail: spec.adminEmail,
      personId: person.id,
      subjectId,
      target,
      grantKind: expandedFromGroup ? "group" : "capability",
      grantIds,
      capabilityIds: toGrant,
      selectors: explicitSelectors ?? undefined,
      materializedPrimarySubject: materialized ? { personId: person.id, subjectId } : undefined,
    },
    detail: { personId: person.id, subjectId, target, expandedFromGroup, selectors: explicitSelectors ?? null, grantIds, grantedCapabilityIds: toGrant, alreadyGranted: [...alreadyGranted], materializedPrimarySubject: materialized },
  };
}

function applyRevoke(store: CapabilityStore, spec: Extract<MutationSpec, { kind: "revoke" }>): MutationOutcome {
  const person = findPerson(store, spec.personId);
  const grantId = requireNonEmpty(spec.grantId, "grantId");
  const subjectSet = new Set(subjectIdsForPerson(store, person));
  const grant = (store.grants ?? []).find((candidate) => candidate.id === grantId && subjectSet.has(candidate.subjectId));
  if (!grant) throw new CapabilityWriteError("grant_not_found", 404, `Grant ${grantId} not found for ${person.id}`);
  const now = new Date().toISOString();

  // Revoke = status change (preserve history), matching codex-chat's authorizer
  // which denies any grant whose status is not "active" or that carries a
  // revokedAt timestamp.
  // A second revoke must preserve the original revokedAt/reason (revocation
  // history is authoritative) — only mutate on the first, genuine revoke.
  const alreadyRevoked = grant.status === "revoked" || Boolean(grant.revokedAt);
  if (!alreadyRevoked) {
    grant.status = "revoked";
    grant.revokedAt = now;
    grant.reason = `Revoked by admin ${spec.adminEmail}`;
    store.updatedAt = now;
  }

  return {
    changed: !alreadyRevoked,
    personId: person.id,
    explicitCapabilityIds: [grant.capabilityId],
    audit: {
      action: "capability.grant.revoked",
      adminEmail: spec.adminEmail,
      personId: person.id,
      subjectId: grant.subjectId,
      grantId,
      capabilityId: grant.capabilityId,
    },
    detail: { personId: person.id, grantId, capabilityId: grant.capabilityId, subjectId: grant.subjectId, alreadyRevoked },
  };
}

// Atomic batch revoke: revoke every named grant in ONE mutation so the store is
// written once, ONE impact preview is computed for the combined change (fixing
// the understated per-grant merge), and one audit event covers the batch. An
// unknown grant id (not on any of the person's subjects) aborts the WHOLE batch
// with a 404 — the client sends exact ids from GET /users, so an unknown id means
// the store drifted and the operator must re-preview against the current store.
// Already-revoked ids are a per-grant no-op (idempotent, mirrors single revoke).
function applyRevokeBatch(store: CapabilityStore, spec: Extract<MutationSpec, { kind: "revoke_batch" }>): MutationOutcome {
  const person = findPerson(store, spec.personId);
  if (!Array.isArray(spec.grantIds) || spec.grantIds.length === 0) {
    throw new CapabilityWriteError("invalid_request", 400, "grantIds is required");
  }
  const subjectSet = new Set(subjectIdsForPerson(store, person));
  const now = new Date().toISOString();
  const requestedIds = [...new Set(spec.grantIds.map((grantId) => requireNonEmpty(grantId, "grantId")))];
  const capabilityIds = new Set<string>();
  const revokedGrantIds: string[] = [];
  const reasonSuffix = spec.reason && spec.reason.trim() ? `: ${spec.reason.trim()}` : "";
  for (const grantId of requestedIds) {
    const grant = (store.grants ?? []).find((candidate) => candidate.id === grantId && subjectSet.has(candidate.subjectId));
    if (!grant) throw new CapabilityWriteError("grant_not_found", 404, `Grant ${grantId} not found for ${person.id}`);
    capabilityIds.add(grant.capabilityId);
    const alreadyRevoked = grant.status === "revoked" || Boolean(grant.revokedAt);
    if (!alreadyRevoked) {
      grant.status = "revoked";
      grant.revokedAt = now;
      grant.reason = `Revoked by admin ${spec.adminEmail}${reasonSuffix}`;
      revokedGrantIds.push(grantId);
    }
  }
  const changed = revokedGrantIds.length > 0;
  if (changed) store.updatedAt = now;

  return {
    changed,
    personId: person.id,
    explicitCapabilityIds: [...capabilityIds],
    audit: {
      action: "capability.grant.revoked",
      adminEmail: spec.adminEmail,
      personId: person.id,
      batch: true,
      grantIds: requestedIds,
      revokedGrantIds,
      capabilityIds: [...capabilityIds],
    },
    detail: { personId: person.id, grantIds: requestedIds, revokedGrantIds, capabilityIds: [...capabilityIds] },
  };
}

export function applySpec(store: CapabilityStore, spec: MutationSpec): MutationOutcome {
  switch (spec.kind) {
    case "create_person":
      return applyCreatePerson(store, spec);
    case "link_identity":
      return applyLinkIdentity(store, spec);
    case "unlink_identity":
      return applyUnlinkIdentity(store, spec);
    case "grant":
      return applyGrant(store, spec);
    case "revoke":
      return applyRevoke(store, spec);
    case "revoke_batch":
      return applyRevokeBatch(store, spec);
    default: {
      const exhaustive: never = spec;
      throw new CapabilityWriteError("invalid_request", 400, `Unknown mutation ${String((exhaustive as { kind?: string }).kind)}`);
    }
  }
}

// --- Preview + commit orchestration ------------------------------------------

export interface MutationResult {
  outcome: MutationOutcome;
  impact: ImpactPreview;
  before: CapabilityStore;
  after: CapabilityStore;
  storeHash: string;
}

// Simulate a mutation over a clone of `before`: apply, re-validate the full
// resulting store, refuse self-lockout, and compute the impact preview. Shared
// by preview (no write) and commit (writes) so both run identical logic.
function simulate(before: CapabilityStore, spec: MutationSpec): { outcome: MutationOutcome; after: CapabilityStore; impact: ImpactPreview } {
  const after = structuredClone(before);
  const outcome = applySpec(after, spec);
  assertValidStore(after);
  guardSelfLockout(before, after);
  const impact = computeImpact(before, after, outcome.personId, outcome.explicitCapabilityIds, outcome.impactResources);
  return { outcome, after, impact };
}

// Preview: run the full simulation (including refusal rails) but never persist.
export async function previewMutation(storePath: string, spec: MutationSpec): Promise<MutationResult> {
  const loaded = await loadStoreForWrite(storePath);
  const { outcome, after, impact } = simulate(loaded.store, spec);
  return { outcome, impact, before: loaded.store, after, storeHash: loaded.hash };
}

// An in-process mutation queue (a serial promise chain) so every
// load-store-for-write -> mutate -> commit sequence runs to completion before
// the next begins WITHIN this server process. The content-hash re-check below
// still protects against a cross-process writer (e.g. the migration CLI), but
// two concurrent in-process commits would otherwise both pass the read-then-write
// hash check and silently lose one write; serializing them removes that race.
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task);
  // Keep the chain alive regardless of individual task success/failure.
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Commit: simulate, then atomically persist with backup + optimistic-concurrency
// checks. Refuses (throws CapabilityWriteError) on any safety-rail violation
// before the store is touched. The whole load->mutate->write sequence is
// serialized in-process via the mutation queue.
export async function commitMutation(storePath: string, spec: MutationSpec, opts: { expectedHash?: string } = {}): Promise<MutationResult> {
  return enqueueMutation(async () => {
    const loaded = await loadStoreForWrite(storePath);
    if (opts.expectedHash && opts.expectedHash !== loaded.hash) {
      throw new CapabilityWriteError("store_conflict", 409, "Store changed since it was read; retry with the current version", { retryable: true });
    }
    const { outcome, after, impact } = simulate(loaded.store, spec);

    // A no-op mutation (e.g. a double revoke) must not rewrite the store: skip
    // the disk write entirely so revocation history and the file's bytes/mtime
    // are preserved. Still a 200 success with the (unchanged) hash.
    if (!outcome.changed) {
      return { outcome, impact, before: loaded.store, after, storeHash: loaded.hash };
    }

    // Optimistic concurrency: re-read just before writing and reject if the store
    // changed between load and write (content-hash comparison).
    let currentText: string;
    try {
      currentText = await readFile(storePath, "utf8");
    } catch {
      throw new CapabilityWriteError("capability_store_unavailable", 503, "Capability store became unreachable before write");
    }
    if (hashStoreText(currentText) !== loaded.hash) {
      throw new CapabilityWriteError("store_conflict", 409, "Store changed since it was read; retry with the current version", { retryable: true });
    }

    await backupStore(storePath, currentText);
    const writtenText = await atomicWriteStore(storePath, after);
    return { outcome, impact, before: loaded.store, after, storeHash: hashStoreText(writtenText) };
  });
}

// --- Store migration (explicit command; plan §2 / §6.5) ----------------------

export interface MigrationChange {
  removedSubjectIds: string[];
  removedGrantIds: string[];
  removedIdentityIds: string[];
  convertedGrantIds: string[];
  enforcementTransitions: Array<{ grantId: string; from: string | null; to: "enforcing" }>;
}

export interface MigrationResult {
  changed: boolean;
  dryRun: boolean;
  changes: MigrationChange;
  backup?: BackupPaths;
  storePath: string;
  message: string;
}

// The literal zeroed placeholder tokens the plan's seed used for slack
// workspace/user/channel identifiers. Matched EXACTLY as whole id segments —
// never as a substring — so real ids that merely contain eight zeros (e.g. a
// Telegram id like 5000000003, or a synthetic token like T00SYNTH01) are never
// mistaken for placeholders and silently deleted.
const PLACEHOLDER_ZERO_TOKENS = new Set(["T00000000", "U00000000", "C00000000"]);

// A slack subject whose id is one of the zeroed seed placeholders — i.e. a
// slack:workspace:/slack:user:/slack:channel: id with a segment that is EXACTLY
// a zeroed token.
function isZeroedSeedSubjectId(id: string): boolean {
  if (!(id.startsWith("slack:workspace:") || id.startsWith("slack:user:") || id.startsWith("slack:channel:"))) return false;
  return id.split(":").some((segment) => PLACEHOLDER_ZERO_TOKENS.has(segment));
}

function isPlaceholderIdentity(identity: StoreExternalIdentity): boolean {
  if (identity.status === "addable_placeholder") return true;
  if (identity.providerUserId && PLACEHOLDER_ZERO_TOKENS.has(identity.providerUserId)) return true;
  if (identity.providerTeamId && PLACEHOLDER_ZERO_TOKENS.has(identity.providerTeamId)) return true;
  // Identity ids use `_`/`:` separated segments (e.g. identity_slack_T00000000_U00000000).
  if (identity.id.split(/[_:]/).some((segment) => PLACEHOLDER_ZERO_TOKENS.has(segment))) return true;
  return false;
}

// Compute the migrated store + a change summary. Pure over a clone so both the
// dry-run and the write share it.
export function planMigration(store: CapabilityStore): { store: CapabilityStore; changes: MigrationChange } {
  const migrated = structuredClone(store);
  const changes: MigrationChange = { removedSubjectIds: [], removedGrantIds: [], removedIdentityIds: [], convertedGrantIds: [], enforcementTransitions: [] };

  // Subjects that hold at least one ACTIVE grant must never be removed: an
  // active grant is a live authorization something depends on (e.g.
  // system:codex-chat-runtime holds the running assistant's result-deliver and
  // callback-enqueue grants). A subject is only a removable seed placeholder if
  // it matches the zeroed-seed id pattern AND holds no active grant.
  const subjectsWithActiveGrant = new Set<string>();
  for (const grant of migrated.grants ?? []) {
    if (grant.status === "active") subjectsWithActiveGrant.add(grant.subjectId);
  }

  const removedSubjectIds = new Set<string>();
  migrated.subjects = (migrated.subjects ?? []).filter((subject) => {
    if (isZeroedSeedSubjectId(subject.id) && !subjectsWithActiveGrant.has(subject.id)) {
      removedSubjectIds.add(subject.id);
      changes.removedSubjectIds.push(subject.id);
      return false;
    }
    return true;
  });

  // Drop placeholder / example grants and any grant orphaned to a removed
  // placeholder subject.
  migrated.grants = (migrated.grants ?? []).filter((grant) => {
    if (grant.status === "example" || removedSubjectIds.has(grant.subjectId)) {
      changes.removedGrantIds.push(grant.id);
      return false;
    }
    return true;
  });

  // Drop addable/zeroed placeholder identities and detach them from people.
  const removedIdentityIds = new Set<string>();
  migrated.externalIdentities = (migrated.externalIdentities ?? []).filter((identity) => {
    if (isPlaceholderIdentity(identity)) {
      removedIdentityIds.add(identity.id);
      changes.removedIdentityIds.push(identity.id);
      return false;
    }
    return true;
  });
  if (removedIdentityIds.size > 0) {
    for (const person of migrated.people ?? []) {
      if (person.identityIds) person.identityIds = person.identityIds.filter((id) => !removedIdentityIds.has(id));
    }
  }

  // Convert retained non-enforcing grants to enforcing form.
  for (const grant of migrated.grants ?? []) {
    if (grant.enforcement !== "enforcing") {
      const from = typeof grant.enforcement === "string" ? grant.enforcement : null;
      grant.enforcement = "enforcing";
      changes.convertedGrantIds.push(grant.id);
      changes.enforcementTransitions.push({ grantId: grant.id, from, to: "enforcing" });
    }
  }

  return { store: migrated, changes };
}

function migrationChanged(changes: MigrationChange): boolean {
  return (
    changes.removedSubjectIds.length > 0 ||
    changes.removedGrantIds.length > 0 ||
    changes.removedIdentityIds.length > 0 ||
    changes.convertedGrantIds.length > 0
  );
}

// Explicit, idempotent migration command: back up the pre-migration store, drop
// the plan's placeholder subjects/grants/identities, convert retained grants to
// enforcing, re-validate, and write atomically via the same safe write path.
// Running it on an already-migrated store is a no-op. `dryRun` reports without
// writing.
export async function migrateCapabilityStore(options: { storePath: string; dryRun?: boolean; allowZeroAdminsBefore?: boolean }): Promise<MigrationResult> {
  const dryRun = Boolean(options.dryRun);
  const loaded = await loadStoreForWrite(options.storePath);
  const { store: migrated, changes } = planMigration(loaded.store);
  const changed = migrationChanged(changes);

  if (!changed) {
    return { changed: false, dryRun, changes, storePath: options.storePath, message: "nothing to do (store already migrated)" };
  }

  // Refuse to persist a migration that would fail-close the assistant.
  assertValidStore(migrated);

  // Self-lockout rail (same effective-admin logic as guardSelfLockout, including
  // the suspended-subject rule): a migration must never leave the store with no
  // capability-admin who can still reach the admin surface — that would brick the
  // console. Refuse (and let the CLI exit non-zero); the dry-run reports it too.
  const adminsBefore = effectiveCapabilityAdmins(loaded.store);
  const allowAlreadyZeroAdmins = Boolean(options.allowZeroAdminsBefore && adminsBefore.size === 0);
  if (effectiveCapabilityAdmins(migrated).size === 0 && !allowAlreadyZeroAdmins) {
    throw new CapabilityWriteError(
      "migration_would_lock_out_admins",
      422,
      "Refused: this migration leaves no capability-admin who can still reach the admin surface",
    );
  }

  if (dryRun) {
    return { changed: true, dryRun: true, changes, storePath: options.storePath, message: "dry-run: changes computed, nothing written" };
  }

  const backup = await backupStore(options.storePath, loaded.text);
  await atomicWriteStore(options.storePath, migrated);
  return { changed: true, dryRun: false, changes, backup, storePath: options.storePath, message: "migration applied" };
}
