// Shared request/response contracts for the Brain admin API.
//
// SHARED-TYPES APPROACH (flagged for review): this module is a hand-authored
// mirror of the response shapes emitted by `apps/web/src/admin-service.ts` and
// `apps/web/src/env-schema.ts`. The backend is the source of truth; these types
// exist so the client renders server decisions with type checking (plan §6.6
// "client renders, never computes"). A direct `import type` from `@brain/web`
// was avoided because most backend response shapes are inline/un-exported and
// pulling node-targeted modules into the browser type graph is undesirable.
// Keep this file in sync when the backend contracts change.

// --- §6.1 status -------------------------------------------------------------

export type StatusComponentState = "ok" | "warn" | "error";

export interface StatusAction {
  label: string;
  route: string;
}

export interface StatusComponent {
  id: "brain" | "slack" | "model" | "service" | "capability_enforcement";
  state: StatusComponentState;
  message: string;
  lastChecked: string;
  action?: StatusAction;
  registry?: {
    available: boolean;
    registryVersion: number | null;
    capabilityCount: number;
    checkedAt: string;
    error: { kind: string; code: string; message: string } | null;
  };
}

export interface StatusResponse {
  components: StatusComponent[];
}

// --- §6.4 env schema + presence ----------------------------------------------

export type EnvKeyGroup = "slack" | "model" | "openrouter" | "feature_flags" | "other";
export type EnvKeyKind = "string" | "secret" | "boolean" | "url" | "path" | "enum";

export interface EnvKeySchemaEntry {
  key: string;
  group: EnvKeyGroup;
  required: boolean;
  secret: boolean;
  // Whether POST /codex-chat/env accepts a write for this key (server allowlist).
  // Non-writable rows render read-only (presence/status only, no input).
  writable: boolean;
  description: string;
  kind: EnvKeyKind;
  enumValues?: string[];
}

export type EnvSchemaResponse = EnvKeySchemaEntry[];

export interface EnvPresenceKey {
  key: string;
  present: boolean;
  secret: boolean;
  value: string | null;
}

export interface EnvPresenceSummary {
  envFile: string;
  allowedKeys: string[];
  keys: EnvPresenceKey[];
  confirmation?: {
    token: string;
    action: string;
    envFile: string;
  };
}

export interface EnvFieldError {
  key: string;
  code: "required" | "invalid_format" | "invalid_enum";
  message: string;
}

export interface EnvWriteResponse {
  ok: boolean;
  envFile: string;
  writtenKeys: string[];
  restartRequired: boolean;
  presence: Record<string, boolean>;
}

export interface EnvWritePayload {
  entries: Record<string, string>;
  confirmation: {
    token: string;
    action: string;
    envFile: string;
    keys: string[];
  };
}

// --- §5.3 Slack settings -----------------------------------------------------

export interface SlackSettingsSummary {
  publicEventsUrl: string;
  eventsBaseUrl: string;
  eventsPath: string;
  slackAppId: string | null;
  appSettingsUrl: string;
  env: EnvPresenceSummary;
  confirmation: {
    token: string;
    action: string;
  };
}

// --- §5.3 Model (main loop + OpenRouter subagents) ---------------------------

export interface MainModelSelector {
  name: string;
  envKey: string;
  value: string;
  source: string;
}

export interface MainModelPreset {
  id: string;
  label: string;
  description: string;
  updates: Record<string, string>;
  requiresOpenRouter: boolean;
}

export interface MainModelSummary {
  env: EnvPresenceSummary;
  selectors: MainModelSelector[];
  effective: Record<string, string>;
  activePreset: string;
  // The exact confirmation key set the write requires; echoed back verbatim.
  confirmationKeys: string[];
  confirmation: {
    token: string;
    action: string;
  };
  restartRequiredForChanges: boolean;
  presets: MainModelPreset[];
  openRouter: {
    keyEnv: string;
    apiKeyPresent: boolean;
    codexProfile: { path: string; present: boolean };
    readiness: string;
  };
}

// Current (non-secret) OpenRouter subagent config the form initializes from so
// an untouched form round-trips current values (never the hardcoded defaults).
export interface OpenRouterCurrentConfig {
  model: string;
  codexProfile: string;
  modelProvider: string;
  serviceTierMode: string;
  allowedCodexProfiles: string;
  allowedModelProviders: string;
  backend: string;
}

export interface OpenRouterSummary {
  keyEnv: string;
  recommendedCodexProfile: string;
  recommendedModelProvider: string;
  recommendedServiceTierMode: string;
  current: OpenRouterCurrentConfig;
  // Current profile path for display and the exact key set the write governs.
  // The write confirmation pins the submitted profile/write path.
  profilePath: string;
  profileTargets: Array<{ codexProfile: string; profilePath: string }>;
  confirmationKeys: string[];
  confirmation: {
    token: string;
    action: string;
  };
  codexProfile: { path: string; present: boolean };
  env: EnvPresenceSummary;
}

// --- write payloads ----------------------------------------------------------

export interface SlackSettingsWritePayload {
  entries: Record<string, string>;
  confirmation: {
    token: string;
    action: string;
    envFile: string;
    keys: string[];
  };
}

export interface MainModelWritePayload {
  preset: string;
  confirmation: {
    token: string;
    action: string;
    envFile: string;
    preset: string;
    keys: string[];
  };
}

export interface OpenRouterWriteEntries {
  apiKey: string;
  model: string;
  codexProfile: string;
  modelProvider: string;
  serviceTierMode: string;
  backend: string;
}

export interface OpenRouterWritePayload extends OpenRouterWriteEntries {
  confirmation: {
    token: string;
    action: string;
    envFile: string;
    codexProfile: string;
    profilePath: string;
    keys: string[];
  };
}

// --- §5.2 Slack setup wizard (GET/POST /slack/setup) -------------------------

export interface SlackSetupStep {
  id: string;
  label: string;
  done: boolean;
}

export interface SlackSetupSummary {
  setupComplete: boolean;
  completedAt?: string;
  completedBy?: string;
  // Retained provenance of the most recent completion after Reconfigure marks
  // setup incomplete (so re-opening the wizard does not erase the history).
  lastCompletedAt?: string;
  lastCompletedBy?: string;
  updatedAt?: string;
  steps: SlackSetupStep[];
  verification: {
    lastAcceptedEvent: boolean;
    lastOutboundSuccess: boolean;
  };
}

export interface SlackSetupWriteResponse {
  ok: boolean;
  setup: SlackSetupSummary;
}

// One rendered Slack manifest (GET /slack/manifest). Download is a direct
// anchor to /slack/manifest/download so the browser never holds the text.
export interface SlackManifestResponse {
  requestUrl: string;
  eventsPath: string;
  renderer: string;
  manifest: unknown;
  text: string;
}

// --- §5.4 Users, catalog, capabilities (§6.5 reads) --------------------------

export interface UserIdentitySummary {
  id: string;
  provider: string;
  externalId: string;
  teamId?: string;
  status?: string;
  linkedAt?: string;
}

// One underlying grant record the admin can act on directly (revoke by exact id).
export interface UserGrantEntry {
  grantId: string;
  capabilityId: string;
  grantKind: string;
  subjectId: string;
  status: string;
  enforcement: string;
  selectorsSummary: string;
}

// Per child capability: whether an in-force grant provides it and the exact
// grant entries that do. Revoke is offered only on grantKind "capability"
// entries; a capability provided only via a group/bundle grant is read-only.
export interface UserChildGrantSummary {
  capabilityId: string;
  granted: boolean;
  entries: UserGrantEntry[];
}

export interface UserGroupSummary {
  id: string;
  label: string;
  status: "active" | "placeholder";
  childCount: number;
  grantedChildCount: number;
  granted: boolean;
  // In-force grant entries this group's Revoke targets (bundles excluded).
  grantEntries: UserGrantEntry[];
  children: UserChildGrantSummary[];
}

export interface UserGrantExpiry {
  grantId: string;
  capabilityId: string;
  expiresAt: string;
}

export interface DisabledSubjectSummary {
  id: string;
  status?: string;
  grantCount: number;
  inForce: number;
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
  registryAvailable: boolean;
  registryVersion: number | null;
  registryCapabilityCount: number;
  people: UserSummary[];
  systemSubjects: SystemSubjectSummary[];
  counts: { people: number; systemSubjects: number };
}

export interface CatalogCapability {
  id: string;
  label: string;
  present: boolean;
  description?: string;
  selectorKeys: string[];
  riskTier?: "low" | "medium" | "high";
  deprecated?: boolean;
  grantable: boolean;
  registryKnown: boolean;
  provenance: "registry" | "curated" | "store";
}

export interface CatalogGroup {
  id: string;
  label: string;
  description: string;
  status: "active" | "placeholder";
  synthetic?: boolean;
  childCount: number;
  presentChildCount: number;
  children: CatalogCapability[];
}

export interface CapabilityCatalogResponse {
  schemaVersion: 1;
  storeAvailable: boolean;
  registryAvailable: boolean;
  registryVersion: number | null;
  registryCapabilityCount: number;
  groups: CatalogGroup[];
  counts: {
    groups: number;
    capabilities: number;
    activeGroups: number;
    placeholderGroups: number;
    uncategorized: number;
  };
}

// --- §6.5 dry-run authorize (POST /capabilities/check) -----------------------

export interface CapabilityCheckResponse {
  allowed: boolean;
  reason: string;
  grantIds: string[];
  subjectId: string;
  subjectIds?: string[];
}

// --- §6.5 impact preview + mutation responses --------------------------------

export interface SurfaceImpact {
  surface: string;
  newlyAllowed: string[];
  newlyDenied: string[];
}

export interface ImpactPreview {
  surfaces: SurfaceImpact[];
  summary: { newlyAllowedCount: number; newlyDeniedCount: number };
  // Fixed caveat: grant previews use the selector resource when available, and
  // live requests must still supply concrete resource keys covered by selectors.
  previewCaveat: string;
}

// A mutation response, whether a `?preview=true` dry-run or a committed write.
export interface MutationResponse {
  ok: boolean;
  preview: boolean;
  changed?: boolean;
  impact: ImpactPreview;
  detail: Record<string, unknown>;
  storeHash: string;
  auditWriteFailed?: boolean;
}

// --- §5.5 audit feed (GET /audit) --------------------------------------------

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

export interface AuditResponse {
  schemaVersion: number;
  rows: AuditRow[];
  total: number;
  limit: number;
  nextCursor: string | null;
  filters: { type: string; outcome: AuditOutcome | null; actor: string | null; operation: string | null };
}

// --- §5.5 operations / restart (POST /codex-chat/operation) ------------------

// The structured confirmation the server requires for a live restart. Fetched
// from the server's 400 `confirmation_required` handshake (never hardcoded
// service-specific values client-side) — this is the "exact approval phrase"
// carried programmatically after the confirm dialog (§5.5).
export interface LiveOperationConfirmation {
  token: string;
  operation: string;
  serviceName: string;
}

export interface OperationResult {
  ok: boolean;
  operation: string;
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

// Read-only slice of GET /settings the Operations route renders for the restart
// target. Only the fields the client reads are typed here (backend returns more).
export interface ServiceInfoResponse {
  codexChat: {
    serviceName: string;
    host: string;
    path: string;
  };
}
