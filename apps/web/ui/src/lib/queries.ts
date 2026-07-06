// React Query hooks over the Brain admin API (plan §6.6: one data-fetching
// layer with cache + reconciliation; route-level loading/error boundaries).
// Writes invalidate the queries they affect so grant/settings toggles settle to
// what the server actually reports.

import { useAuth } from "@clerk/clerk-react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { ApiError, createApiClient, type ApiClient } from "./api";
import type {
  AuditOutcome,
  AuditResponse,
  AuditType,
  CapabilityCatalogResponse,
  CapabilityCheckResponse,
  EnvPresenceSummary,
  EnvSchemaResponse,
  EnvWritePayload,
  EnvWriteResponse,
  LiveOperationConfirmation,
  MainModelSummary,
  MainModelWritePayload,
  MutationResponse,
  OpenRouterSummary,
  OpenRouterWritePayload,
  OperationResult,
  ServiceInfoResponse,
  SlackManifestResponse,
  SlackSettingsSummary,
  SlackSettingsWritePayload,
  SlackSetupSummary,
  SlackSetupWriteResponse,
  StatusResponse,
  UsersResponse,
} from "../api-types";

export function useApiClient(): ApiClient {
  const { getToken } = useAuth();
  return useMemo(() => createApiClient(() => getToken()), [getToken]);
}

export function useStatus() {
  const api = useApiClient();
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.get<StatusResponse>("/status"),
    // Poll every 15s, but stop once the server has rejected us: on the
    // access-denied screen an auth/forbidden error must not keep polling
    // forever. (Retry is already disabled globally for these kinds.)
    refetchInterval: (query) => {
      const error = query.state.error;
      if (error instanceof ApiError && (error.kind === "auth" || error.kind === "forbidden")) return false;
      return 15_000;
    },
  });
}

export function useEnvSchema() {
  const api = useApiClient();
  return useQuery({ queryKey: ["env-schema"], queryFn: () => api.get<EnvSchemaResponse>("/env/schema") });
}

export function useEnvSummary() {
  const api = useApiClient();
  return useQuery({ queryKey: ["env-summary"], queryFn: () => api.get<EnvPresenceSummary>("/codex-chat/env") });
}

export function useSlackSettings() {
  const api = useApiClient();
  return useQuery({ queryKey: ["slack-settings"], queryFn: () => api.get<SlackSettingsSummary>("/slack/settings") });
}

export function useMainModel() {
  const api = useApiClient();
  return useQuery({ queryKey: ["main-model"], queryFn: () => api.get<MainModelSummary>("/codex-chat/main-model") });
}

export function useOpenRouter() {
  const api = useApiClient();
  return useQuery({ queryKey: ["openrouter"], queryFn: () => api.get<OpenRouterSummary>("/openrouter/settings") });
}

function useInvalidateSettings() {
  const client = useQueryClient();
  return () => {
    // Include slack-setup so writing Slack secrets in the wizard re-derives its
    // per-step done state (the setup summary reads live env presence).
    for (const key of ["status", "env-summary", "slack-settings", "main-model", "openrouter", "slack-setup"]) {
      void client.invalidateQueries({ queryKey: [key] });
    }
  };
}

export function useSlackSettingsWrite() {
  const api = useApiClient();
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (payload: SlackSettingsWritePayload) => api.post<EnvWriteResponse>("/slack/settings", payload),
    onSuccess: invalidate,
  });
}

export function useEnvWrite() {
  const api = useApiClient();
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (payload: EnvWritePayload) => api.post<EnvWriteResponse>("/codex-chat/env", payload),
    onSuccess: invalidate,
  });
}

export function useMainModelWrite() {
  const api = useApiClient();
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (payload: MainModelWritePayload) => api.post<EnvWriteResponse>("/codex-chat/main-model", payload),
    onSuccess: invalidate,
  });
}

export function useOpenRouterWrite() {
  const api = useApiClient();
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (payload: OpenRouterWritePayload) => api.post<EnvWriteResponse>("/openrouter/settings", payload),
    onSuccess: invalidate,
  });
}

// --- §5.2 Slack setup wizard -------------------------------------------------

export function useSlackSetup() {
  const api = useApiClient();
  return useQuery({ queryKey: ["slack-setup"], queryFn: () => api.get<SlackSetupSummary>("/slack/setup") });
}

export function useSlackManifest() {
  const api = useApiClient();
  // The manifest render shells out to a codex-chat script; it can fail in
  // environments without that repo, so this query is only enabled on demand.
  return useQuery({ queryKey: ["slack-manifest"], queryFn: () => api.get<SlackManifestResponse>("/slack/manifest"), enabled: false, retry: false });
}

// Persist / clear the Slack setup-complete flag (wizard completion + Reconfigure).
export function useSlackSetupWrite() {
  const api = useApiClient();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (complete: boolean) => api.post<SlackSetupWriteResponse>("/slack/setup", { complete }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["slack-setup"] });
      void client.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

// --- §5.4 Users / catalog / capabilities -------------------------------------

export function useUsers() {
  const api = useApiClient();
  return useQuery({ queryKey: ["users"], queryFn: () => api.get<UsersResponse>("/users") });
}

export function useCatalog() {
  const api = useApiClient();
  return useQuery({ queryKey: ["catalog"], queryFn: () => api.get<CapabilityCatalogResponse>("/capabilities/catalog") });
}

// Invalidate everything a capability/identity mutation can affect so grant
// toggles settle to what the enforcer actually reports (plan §6.6).
function useInvalidateCapabilities() {
  const client = useQueryClient();
  return () => {
    for (const key of ["users", "catalog", "status", "audit"]) {
      void client.invalidateQueries({ queryKey: [key] });
    }
  };
}

export function useCreatePerson() {
  const api = useApiClient();
  const invalidate = useInvalidateCapabilities();
  return useMutation({
    mutationFn: (displayName: string) => api.post<MutationResponse>("/users", { displayName }),
    onSuccess: invalidate,
  });
}

export interface LinkIdentityInput {
  personId: string;
  provider: string;
  externalId: string;
  teamId?: string;
}

export function useLinkIdentity() {
  const api = useApiClient();
  const invalidate = useInvalidateCapabilities();
  return useMutation({
    mutationFn: ({ personId, provider, externalId, teamId }: LinkIdentityInput) =>
      api.post<MutationResponse>(`/users/${encodeURIComponent(personId)}/identities`, { provider, externalId, ...(teamId ? { teamId } : {}) }),
    onSuccess: invalidate,
  });
}

// Grant a group id OR an individual capability id (the server expands a group).
// `preview` runs the dry-run diff without writing. `expectedStoreHash` (from the
// preview response) pins the commit to the store the preview was computed
// against — the server 409s store_conflict if the store changed since (A3).
export interface GrantInput {
  personId: string;
  target: string;
  isGroup: boolean;
  selectors?: Record<string, string>;
  preview?: boolean;
  expectedStoreHash?: string;
}

export function useGrant() {
  const api = useApiClient();
  const invalidate = useInvalidateCapabilities();
  return useMutation({
    mutationFn: ({ personId, target, isGroup, selectors, preview, expectedStoreHash }: GrantInput) => {
      const body: Record<string, unknown> = isGroup ? { groupId: target } : { capabilityId: target };
      if (selectors) body.selectors = selectors;
      if (expectedStoreHash) body.expectedStoreHash = expectedStoreHash;
      const query = preview ? "?preview=true" : "";
      return api.post<MutationResponse>(`/users/${encodeURIComponent(personId)}/grants${query}`, body);
    },
    onSuccess: (_data, variables) => {
      if (!variables.preview) invalidate();
    },
  });
}

// Atomic batch revoke of exact grant ids (from the /users grant entries). One
// server-side store write + ONE combined impact preview + one audit event; the
// client never resolves grant ids itself and never loops per-grant DELETEs.
export interface RevokeBatchInput {
  personId: string;
  grantIds: string[];
  reason?: string;
  preview?: boolean;
  expectedStoreHash?: string;
}

export function useRevokeBatch() {
  const api = useApiClient();
  const invalidate = useInvalidateCapabilities();
  return useMutation({
    mutationFn: ({ personId, grantIds, reason, preview, expectedStoreHash }: RevokeBatchInput) => {
      const body: Record<string, unknown> = { grantIds };
      if (reason) body.reason = reason;
      if (expectedStoreHash) body.expectedStoreHash = expectedStoreHash;
      const query = preview ? "?preview=true" : "";
      return api.post<MutationResponse>(`/users/${encodeURIComponent(personId)}/grants/revoke-batch${query}`, body);
    },
    onSuccess: (_data, variables) => {
      if (!variables.preview) invalidate();
    },
  });
}

export interface UnlinkInput {
  personId: string;
  identityId: string;
  preview?: boolean;
  expectedStoreHash?: string;
}

export function useUnlink() {
  const api = useApiClient();
  const invalidate = useInvalidateCapabilities();
  return useMutation({
    mutationFn: ({ personId, identityId, preview, expectedStoreHash }: UnlinkInput) => {
      const query = preview ? "?preview=true" : "";
      const body = expectedStoreHash ? { expectedStoreHash } : undefined;
      return api.del<MutationResponse>(`/users/${encodeURIComponent(personId)}/identities/${encodeURIComponent(identityId)}${query}`, body);
    },
    onSuccess: (_data, variables) => {
      if (!variables.preview) invalidate();
    },
  });
}

// Dry-run authorize (§5.4 debug/check). Retained as the standalone check endpoint
// for verifying decisions before/after a change; it is NOT used to resolve grant
// ids for revocation — the /users grant entries carry exact ids for that.
export function useCheckClient(): (subjectId: string, operation: string, resource?: Record<string, unknown>) => Promise<CapabilityCheckResponse> {
  const api = useApiClient();
  return useCallback(
    (subjectId: string, operation: string, resource: Record<string, unknown> = {}) =>
      api.post<CapabilityCheckResponse>("/capabilities/check", { subjectId, operation, resource }),
    [api],
  );
}

// --- §5.5 audit feed (server-side pagination) --------------------------------

export interface AuditFilters {
  type?: AuditType;
  outcome?: AuditOutcome;
  actor?: string;
  operation?: string;
}

export function useAudit(filters: AuditFilters) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: ["audit", filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (filters.type) params.set("type", filters.type);
      if (filters.outcome) params.set("outcome", filters.outcome);
      if (filters.actor) params.set("actor", filters.actor);
      if (filters.operation) params.set("operation", filters.operation);
      if (pageParam) params.set("cursor", pageParam);
      const qs = params.toString();
      return api.get<AuditResponse>(`/audit${qs ? `?${qs}` : ""}`);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

// --- §5.5 operations / restart ----------------------------------------------

// Read-only target-service info for display (GET /settings). Rendering the
// restart target must NOT post to the operation endpoint; the handshake POST
// happens only when the operator actually clicks Restart (below).
export function useServiceInfo() {
  const api = useApiClient();
  return useQuery({ queryKey: ["service-info"], queryFn: () => api.get<ServiceInfoResponse>("/settings") });
}

// On-demand restart handshake: POST with no confirmation never runs the command
// (it 400s `confirmation_required`), yielding the exact { token, operation,
// serviceName } the server demands. Invoked ONLY when the operator clicks
// Restart — not on mount or window refocus — so the operation endpoint is never
// hit eagerly. 409 refusals (refusing_to_operate_on_brain_service,
// operation_not_configured) surface verbatim for the caller to message.
export function useRequestRestartConfirmation() {
  const api = useApiClient();
  return useMutation<LiveOperationConfirmation, unknown, void>({
    mutationFn: async () => {
      try {
        await api.post<OperationResult>("/codex-chat/operation", { operation: "restart" });
        // A success here would mean the server accepted a restart with no
        // confirmation — it never does; treat as an unexpected contract change.
        throw new Error("restart accepted without confirmation (unexpected)");
      } catch (error) {
        if (error instanceof ApiError && error.code === "confirmation_required") {
          const payload = error.payload as { required?: LiveOperationConfirmation } | undefined;
          if (payload?.required?.token && payload.required.serviceName) return payload.required;
        }
        throw error;
      }
    },
  });
}

export function useRestart() {
  const api = useApiClient();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (confirmation: LiveOperationConfirmation) =>
      api.post<OperationResult>("/codex-chat/operation", { operation: confirmation.operation, confirmation }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["status"] });
      void client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}
