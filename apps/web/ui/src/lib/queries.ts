// React Query hooks over the Brain admin API (plan §6.6: one data-fetching
// layer with cache + reconciliation; route-level loading/error boundaries).
// Writes invalidate the queries they affect so grant/settings toggles settle to
// what the server actually reports.

import { useAuth } from "@clerk/clerk-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiError, createApiClient, type ApiClient } from "./api";
import type {
  EnvPresenceSummary,
  EnvSchemaResponse,
  EnvWriteResponse,
  MainModelSummary,
  MainModelWritePayload,
  OpenRouterSummary,
  OpenRouterWritePayload,
  SlackSettingsSummary,
  SlackSettingsWritePayload,
  StatusResponse,
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
    for (const key of ["status", "env-summary", "slack-settings", "main-model", "openrouter"]) {
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
    // `confirmed: true` is the server-side confirmation gate the ConfirmDialog
    // stands in for (admin-service handleEnvWrite); without it the write is a
    // 400 approval_required.
    mutationFn: (entries: Record<string, string>) => api.post<EnvWriteResponse>("/codex-chat/env", { entries, confirmed: true }),
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
