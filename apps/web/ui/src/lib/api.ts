// Single data-fetching layer for the Brain admin API.
//
// Every call carries the Clerk session token as `Authorization: Bearer <token>`
// (mirrors the legacy console's `tokenHeaders()`). Authorization is decided
// entirely server-side by the allowlist in admin-service.ts / admin-auth.ts —
// this client never grants anything; it only renders sign-in / access-denied /
// data states based on the server's response.

import type { EnvFieldError } from "../api-types";

const API_BASE = "/api/admin/brain";

// One error taxonomy for the whole app (plan §6.6): field validation,
// store-unavailable, and auth are the meaningful classes; the rest are generic.
export type ApiErrorKind =
  | "auth" // 401 — not signed in / token invalid
  | "forbidden" // 403 — signed in but not on the server allowlist
  | "validation" // 400 validation_failed with field errors
  | "store_unavailable" // 503 / store load failure
  | "not_found"
  | "network"
  | "unknown";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code?: string;
  readonly fieldErrors?: EnvFieldError[];
  readonly payload?: unknown;

  constructor(kind: ApiErrorKind, status: number, message: string, opts: { code?: string; fieldErrors?: EnvFieldError[]; payload?: unknown } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = opts.code;
    this.fieldErrors = opts.fieldErrors;
    this.payload = opts.payload;
  }
}

export type TokenGetter = () => Promise<string | null>;

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function request<T>(path: string, getToken: TokenGetter, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let token: string | null = null;
  try {
    token = await getToken();
  } catch {
    token = null;
  }
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw new ApiError("network", 0, error instanceof Error ? error.message : "Network request failed");
  }

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) throw mapError(res.status, payload);
  return payload as T;
}

function mapError(status: number, payload: unknown): ApiError {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const code = typeof record.error === "string" ? record.error : undefined;
  const message = typeof record.message === "string" ? record.message : code || `Request failed (${status})`;

  if (status === 401) return new ApiError("auth", status, message, { code, payload });
  if (status === 403) {
    // Not every 403 is an allowlist rejection: env writes return 403 with an
    // env_key_not_allowed / slack_env_key_not_allowed code for a key the server
    // won't accept. Those are field-level validation problems (Retry stays
    // available, no access-denied screen), not auth. Only 403s without such a
    // code map to `forbidden`.
    if (code === "env_key_not_allowed" || code === "slack_env_key_not_allowed") {
      const key = typeof record.key === "string" ? record.key : "";
      const fieldMessage = key ? `${key} is not writable via this console.` : message;
      const fieldErrors: EnvFieldError[] = key ? [{ key, code: "invalid_format", message: fieldMessage }] : [];
      return new ApiError("validation", status, fieldMessage, { code, fieldErrors, payload });
    }
    return new ApiError("forbidden", status, message, { code, payload });
  }
  if (status === 404) return new ApiError("not_found", status, message, { code, payload });
  if (code === "validation_failed") {
    const fieldErrors = Array.isArray(record.fieldErrors) ? (record.fieldErrors as EnvFieldError[]) : [];
    return new ApiError("validation", status, message, { code, fieldErrors, payload });
  }
  if (status === 503 || (code ?? "").includes("store_unavailable")) {
    return new ApiError("store_unavailable", status, message, { code, payload });
  }
  return new ApiError("unknown", status, message, { code, payload });
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function createApiClient(getToken: TokenGetter): ApiClient {
  return {
    get: <T>(path: string) => request<T>(path, getToken, { method: "GET" }),
    post: <T>(path: string, body: unknown) => request<T>(path, getToken, { method: "POST", body }),
  };
}
