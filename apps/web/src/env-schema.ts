// Brain-side env metadata schema (interim; see plan §6.4).
//
// This is a DERIVED, minimal copy of the env keys the admin UI exposes. The
// real source of truth for which codex-chat config keys exist / are required is
// codex-chat's own `config.ts` zod schema; this module exists only until §6.7
// lets codex-chat validate its own config writes. Keep it small and clearly
// marked as derived. Secrets are presence-only end to end: this module tags a
// key `secret`, but never stores or echoes any value.

export type EnvKeyGroup = "slack" | "model" | "openrouter" | "feature_flags" | "other";

// How the value is validated on write. `string`/`secret` accept any non-empty
// value; the others enforce a light format so obviously-broken input is caught
// server-side and reported as a field-level error.
export type EnvKeyKind = "string" | "secret" | "boolean" | "url" | "path" | "enum";

export interface EnvKeySchemaEntry {
  key: string;
  group: EnvKeyGroup;
  required: boolean;
  secret: boolean;
  description: string;
  kind: EnvKeyKind;
  enumValues?: string[];
}

export interface EnvFieldError {
  key: string;
  code: "required" | "invalid_format" | "invalid_enum";
  message: string;
}

// Union of the env-schema and capability-admin-reads secretish heuristics: any
// key name hinting at a secret is treated as one (presence-only, never echoed).
export const SECRETISH_RE = /(SECRET|TOKEN|KEY|PASSWORD|COOKIE|SESSION|CREDENTIAL|SIGNATURE)/i;
const SERVICE_TIER_MODES = ["auto", "always", "omit"] as const;

// Static schema for the keys the current admin UI hardcodes. Unrecognized keys
// found in the env file are surfaced dynamically in the `other` group by
// `buildEnvSchema` below.
export const BRAIN_ENV_SCHEMA: EnvKeySchemaEntry[] = [
  // Feature flags
  entry("CODEX_CHAT_API_ENABLED", "feature_flags", false, "Enable the codex-chat loopback HTTP gateway (audio ingest, agent tail).", "boolean"),
  entry("CODEX_CHAT_SLACK_ENABLED", "feature_flags", false, "Enable codex-chat's Slack entrypoint.", "boolean"),
  // Slack connection
  entry("CODEX_CHAT_BASE_URL", "slack", true, "Public base URL where Slack reaches codex-chat's events endpoint.", "url"),
  entry("CODEX_CHAT_SLACK_EVENTS_PATH", "slack", false, "Path Slack posts events to (must start with '/').", "path"),
  entry("SLACK_SIGNING_SECRET", "slack", true, "Slack app signing secret used to verify inbound event signatures.", "secret"),
  entry("SLACK_BOT_TOKEN", "slack", true, "Slack bot token (xoxb-…) used to post replies.", "secret"),
  entry("SLACK_APP_TOKEN", "slack", false, "Slack app-level token (xapp-…) for Socket Mode, when used.", "secret"),
  // Main-loop model
  entry("CODEX_CHAT_CODEX_MODEL", "model", false, "Main-loop model slug (e.g. gpt-5.5 or z-ai/glm-5.2).", "string"),
  entry("CODEX_CHAT_CODEX_PROFILE", "model", false, "Codex profile name for the main loop (blank for the subscription default).", "string"),
  entry("CODEX_CHAT_CODEX_MODEL_PROVIDER", "model", false, "Model provider for the main loop (blank for the subscription default).", "string"),
  entry("CODEX_CHAT_CODEX_SERVICE_TIER", "model", false, "Requested service tier for the main loop (e.g. fast).", "string"),
  entry("CODEX_CHAT_CODEX_SERVICE_TIER_MODE", "model", false, "How the service tier is applied.", "enum", [...SERVICE_TIER_MODES]),
  // OpenRouter / subagents
  entry("OPENROUTER_API_KEY", "openrouter", false, "OpenRouter API key used by subagents / OpenRouter presets.", "secret"),
  entry("CODEX_CHAT_SUBAGENTS_BACKEND", "openrouter", false, "Subagent execution backend.", "enum", ["codex_exec", "codex_app_server"]),
  entry("CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL", "openrouter", false, "Default subagent model slug.", "string"),
  entry("CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE", "openrouter", false, "Default subagent Codex profile.", "string"),
  entry("CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER", "openrouter", false, "Default subagent model provider.", "string"),
  entry("CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE", "openrouter", false, "How the subagent service tier is applied.", "enum", [...SERVICE_TIER_MODES]),
  entry("CODEX_CHAT_SUBAGENTS_ALLOW_PROVIDER_OVERRIDE", "openrouter", false, "Allow subagents to override the model provider.", "boolean"),
  entry("CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES", "openrouter", false, "Comma/space list of Codex profiles subagents may use.", "string"),
  entry("CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS", "openrouter", false, "Comma/space list of model providers subagents may use.", "string"),
  // Other recognized secrets
  entry("TELEGRAM_BOT_TOKEN", "other", false, "Telegram bot token for the Telegram entrypoint.", "secret"),
  entry("OPENAI_API_KEY", "other", false, "OpenAI API key used by codex-chat when running against OpenAI.", "secret"),
];

const SCHEMA_BY_KEY = new Map(BRAIN_ENV_SCHEMA.map((item) => [item.key, item]));

function entry(key: string, group: EnvKeyGroup, required: boolean, description: string, kind: EnvKeyKind, enumValues?: string[]): EnvKeySchemaEntry {
  return { key, group, required, secret: kind === "secret" || SECRETISH_RE.test(key), description, kind, enumValues };
}

export function envKeySchemaEntry(key: string): EnvKeySchemaEntry | undefined {
  return SCHEMA_BY_KEY.get(key);
}

// Build the full schema for a UI: the static entries plus an `other` group row
// for every unrecognized key already present in the env file.
export function buildEnvSchema(presentKeys: Iterable<string>): EnvKeySchemaEntry[] {
  const schema = BRAIN_ENV_SCHEMA.map((item) => ({ ...item }));
  const known = new Set(BRAIN_ENV_SCHEMA.map((item) => item.key));
  const extras = new Set<string>();
  for (const key of presentKeys) {
    if (!known.has(key) && !extras.has(key)) extras.add(key);
  }
  for (const key of [...extras].sort()) {
    schema.push({
      key,
      group: "other",
      required: false,
      secret: SECRETISH_RE.test(key),
      description: "Unrecognized key present in the codex-chat env file; not managed by the Brain admin schema.",
      kind: SECRETISH_RE.test(key) ? "secret" : "string",
    });
  }
  return schema;
}

// Validate proposed env writes server-side against the schema. Returns
// field-level errors ([] when valid). `requireNonEmpty` rejects blank values on
// every supplied key (the free-form env editor and Slack settings form); the
// preset-driven writers pass it false so intentional blanks (e.g. clearing the
// main-loop profile) are allowed.
export function validateEnvUpdates(updates: Record<string, string>, options: { requireNonEmpty?: boolean } = {}): EnvFieldError[] {
  const errors: EnvFieldError[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const schema = SCHEMA_BY_KEY.get(key);
    const empty = value.length === 0;
    if (empty) {
      if (schema?.required || options.requireNonEmpty) {
        errors.push({ key, code: "required", message: `${key} requires a value.` });
      }
      continue;
    }
    const kind = schema?.kind ?? "string";
    if (kind === "boolean" && !/^(1|0|true|false|yes|no|on|off)$/i.test(value)) {
      errors.push({ key, code: "invalid_format", message: `${key} must be a boolean (true/false).` });
    } else if (kind === "url" && !isHttpUrl(value)) {
      errors.push({ key, code: "invalid_format", message: `${key} must be an http(s) URL.` });
    } else if (kind === "path" && !value.startsWith("/")) {
      errors.push({ key, code: "invalid_format", message: `${key} must be an absolute path starting with '/'.` });
    } else if (kind === "enum" && schema?.enumValues && !schema.enumValues.includes(value)) {
      errors.push({ key, code: "invalid_enum", message: `${key} must be one of: ${schema.enumValues.join(", ")}.` });
    }
  }
  return errors;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
