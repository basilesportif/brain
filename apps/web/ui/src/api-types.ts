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

// --- §5.3 Slack settings -----------------------------------------------------

export interface SlackSettingsSummary {
  publicEventsUrl: string;
  eventsBaseUrl: string;
  eventsPath: string;
  slackAppId: string | null;
  appSettingsUrl: string;
  env: EnvPresenceSummary;
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
  // Current profile path the confirmation pins (read-state), and the exact key
  // set the write requires — both echoed back verbatim in the write payload.
  profilePath: string;
  confirmationKeys: string[];
  codexProfile: { path: string; present: boolean };
  env: EnvPresenceSummary;
}

// --- write payloads ----------------------------------------------------------

export interface SlackSettingsWritePayload {
  entries: Record<string, string>;
  confirmation: {
    token: "brain-admin-slack-settings-confirmed-v1";
    action: "slack.settings.write";
    envFile: string;
    keys: string[];
  };
}

export interface MainModelWritePayload {
  preset: string;
  confirmation: {
    token: "brain-admin-main-loop-model-confirmed-v1";
    action: "codex-chat.main-loop-model.write";
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
    token: "brain-admin-openrouter-settings-confirmed-v1";
    action: "openrouter.settings.write";
    envFile: string;
    profilePath: string;
    keys: string[];
  };
}
