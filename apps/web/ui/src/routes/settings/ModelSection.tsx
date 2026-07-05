import { useState } from "react";
import { useMainModel, useMainModelWrite, useOpenRouter, useOpenRouterWrite } from "../../lib/queries";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorNotice, Loading, RawJson, describeError } from "../../components/common";
import type { MainModelWritePayload, OpenRouterSummary, OpenRouterWriteEntries, OpenRouterWritePayload } from "../../api-types";
import { RestartNote } from "./shared";

function MainLoopModel() {
  const summary = useMainModel();
  const write = useMainModelWrite();
  const [preset, setPreset] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wrote, setWrote] = useState<string[] | null>(null);

  if (summary.isLoading) return <Loading label="Loading model settings…" />;
  if (summary.isError) return <ErrorNotice error={summary.error} onRetry={() => summary.refetch()} />;

  const data = summary.data!;
  const selected = preset ?? data.activePreset;
  const changed = selected !== data.activePreset && data.presets.some((entry) => entry.id === selected);

  const confirm = () => {
    const payload: MainModelWritePayload = {
      preset: selected,
      confirmation: {
        token: "brain-admin-main-loop-model-confirmed-v1",
        action: "codex-chat.main-loop-model.write",
        envFile: data.env.envFile,
        preset: selected,
        // Echo the server's key list verbatim (never hand-mirrored client-side).
        keys: data.confirmationKeys,
      },
    };
    write.mutate(payload, {
      onSuccess: (result) => {
        setWrote(result.writtenKeys);
        setPreset(null);
        setConfirmOpen(false);
      },
      onError: () => setConfirmOpen(false),
    });
  };

  return (
    <div className="subsection">
      <h3>Main-loop model</h3>
      <p className="muted small">
        Active preset: <span className="mono">{data.activePreset}</span>
        {data.activePreset === "custom" ? " (not a known preset)" : ""}
      </p>
      <div className="field">
        <label htmlFor="main-preset">Preset</label>
        <select id="main-preset" value={selected} onChange={(event) => setPreset(event.target.value)}>
          {data.presets.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
          {data.activePreset === "custom" && !data.presets.some((entry) => entry.id === "custom") ? (
            <option value="custom" disabled>
              custom (current)
            </option>
          ) : null}
        </select>
        {changed ? (
          <p className="muted small">
            Change: <span className="mono">{data.activePreset}</span> → <span className="mono">{selected}</span>
          </p>
        ) : null}
      </div>
      {write.isError ? <ErrorNotice error={write.error} /> : null}
      {wrote ? <RestartNote writtenKeys={wrote} /> : null}
      <div className="settings-actions">
        <button className="btn primary" type="button" disabled={!changed || write.isPending} onClick={() => setConfirmOpen(true)}>
          Apply preset
        </button>
      </div>
      <RawJson title="Raw /codex-chat/main-model JSON" data={data} />

      <ConfirmDialog
        open={confirmOpen}
        title="Switch main-loop model preset?"
        confirmLabel="Write preset"
        busy={write.isPending}
        onConfirm={confirm}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          Switch main-loop preset to <span className="mono">{selected}</span>. This writes non-secret selectors to the codex-chat env file.
        </p>
        <p className="muted small">codex-chat restart is required for changes to take effect.</p>
        {write.isError ? <p className="alert bad small">{describeError(write.error).message}</p> : null}
      </ConfirmDialog>
    </div>
  );
}

// Seed the editable form from the summary's CURRENT non-secret config so an
// untouched form round-trips current values instead of clobbering subagent
// config with hardcoded defaults. The API key stays write-only (never seeded).
function entriesFromCurrent(current: OpenRouterSummary["current"]): OpenRouterWriteEntries {
  return {
    apiKey: "",
    model: current.model,
    codexProfile: current.codexProfile,
    modelProvider: current.modelProvider,
    serviceTierMode: current.serviceTierMode,
    backend: current.backend,
  };
}

// Old→new diffs for the non-secret keys this write would change. The API key is
// a secret and is shown keys-only in the dialog, never as a value diff.
function nonSecretDiffs(current: OpenRouterSummary["current"], entries: OpenRouterWriteEntries): Array<{ key: string; from: string; to: string }> {
  const proposed: Record<string, string> = {
    CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL: entries.model,
    CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE: entries.codexProfile,
    CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER: entries.modelProvider,
    CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE: entries.serviceTierMode,
    CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES: entries.codexProfile,
    CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS: entries.modelProvider,
  };
  if (entries.backend) proposed.CODEX_CHAT_SUBAGENTS_BACKEND = entries.backend;
  const currentValues: Record<string, string> = {
    CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL: current.model,
    CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE: current.codexProfile,
    CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER: current.modelProvider,
    CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE: current.serviceTierMode,
    CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES: current.allowedCodexProfiles,
    CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS: current.allowedModelProviders,
    CODEX_CHAT_SUBAGENTS_BACKEND: current.backend,
  };
  return Object.entries(proposed)
    .filter(([key, value]) => value !== (currentValues[key] ?? ""))
    .map(([key, value]) => ({ key, from: currentValues[key] ?? "", to: value }));
}

// Inner form: only mounts once the summary has loaded, so state can be seeded
// from `data.current` at initialization time.
function OpenRouterForm({ data }: { data: OpenRouterSummary }) {
  const write = useOpenRouterWrite();
  const [entries, setEntries] = useState<OpenRouterWriteEntries>(() => entriesFromCurrent(data.current));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wrote, setWrote] = useState<string[] | null>(null);

  const set = (patch: Partial<OpenRouterWriteEntries>) => setEntries((prev) => ({ ...prev, ...patch }));
  const diffs = nonSecretDiffs(data.current, entries);

  const confirm = () => {
    const payload: OpenRouterWritePayload = {
      ...entries,
      confirmation: {
        token: "brain-admin-openrouter-settings-confirmed-v1",
        action: "openrouter.settings.write",
        envFile: data.env.envFile,
        // Pin the read-state the server served (current profile + governed key
        // set), echoed verbatim — never recomputed client-side.
        profilePath: data.profilePath,
        keys: data.confirmationKeys,
      },
    };
    write.mutate(payload, {
      onSuccess: (result) => {
        setWrote(result.writtenKeys);
        setEntries((prev) => ({ ...prev, apiKey: "" }));
        setConfirmOpen(false);
      },
      onError: () => setConfirmOpen(false),
    });
  };

  return (
    <div className="subsection">
      <h3>OpenRouter · subagent defaults</h3>
      <p className="muted small">
        OpenRouter key: <span className={`badge ${data.env.keys.find((k) => k.key === "OPENROUTER_API_KEY")?.present ? "ok" : ""}`}>
          {data.env.keys.find((k) => k.key === "OPENROUTER_API_KEY")?.present ? "set" : "not set"}
        </span>{" "}
        · Codex profile <span className="mono">{data.codexProfile.path}</span> {data.codexProfile.present ? "present" : "missing"}
      </p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="or-api-key">OpenRouter API key</label>
          <input id="or-api-key" type="password" autoComplete="off" placeholder="write-only · leave blank to keep" value={entries.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="or-model">Model slug</label>
          <input id="or-model" type="text" autoComplete="off" value={entries.model} onChange={(e) => set({ model: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="or-profile">Codex profile</label>
          <input id="or-profile" type="text" autoComplete="off" value={entries.codexProfile} onChange={(e) => set({ codexProfile: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="or-provider">Model provider</label>
          <input id="or-provider" type="text" autoComplete="off" value={entries.modelProvider} onChange={(e) => set({ modelProvider: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="or-tier">Service tier mode</label>
          <select id="or-tier" value={entries.serviceTierMode} onChange={(e) => set({ serviceTierMode: e.target.value })}>
            <option value="omit">omit</option>
            <option value="auto">auto</option>
            <option value="always">always</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="or-backend">Subagent backend override</label>
          <select id="or-backend" value={entries.backend} onChange={(e) => set({ backend: e.target.value })}>
            <option value="">do not change</option>
            <option value="codex_app_server">codex_app_server</option>
            <option value="codex_exec">codex_exec</option>
          </select>
        </div>
      </div>
      {write.isError ? <ErrorNotice error={write.error} /> : null}
      {wrote ? <RestartNote writtenKeys={wrote} /> : null}
      <div className="settings-actions">
        <button className="btn primary" type="button" disabled={write.isPending} onClick={() => setConfirmOpen(true)}>
          Save OpenRouter settings
        </button>
      </div>
      <RawJson title="Raw /openrouter/settings JSON" data={data} />

      <ConfirmDialog
        open={confirmOpen}
        title="Write OpenRouter subagent settings?"
        confirmLabel="Write settings"
        busy={write.isPending}
        onConfirm={confirm}
        onCancel={() => setConfirmOpen(false)}
      >
        {diffs.length > 0 ? (
          <>
            <p>These non-secret keys will change:</p>
            <ul className="mono small">
              {diffs.map((diff) => (
                <li key={diff.key}>
                  {diff.key}: <span className="muted">{diff.from || "(unset)"}</span> → {diff.to || "(unset)"}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted small">No non-secret config values change{entries.apiKey ? " (the API key is updated below)" : ""}.</p>
        )}
        {entries.apiKey ? <p className="alert warn small">OPENROUTER_API_KEY will be overwritten. Secret values are write-only and never displayed.</p> : null}
        <p className="muted small">codex-chat restart is required for changes to take effect.</p>
        {write.isError ? <p className="alert bad small">{describeError(write.error).message}</p> : null}
      </ConfirmDialog>
    </div>
  );
}

function OpenRouterSubagents() {
  const summary = useOpenRouter();
  if (summary.isLoading) return <Loading label="Loading OpenRouter settings…" />;
  if (summary.isError) return <ErrorNotice error={summary.error} onRetry={() => summary.refetch()} />;
  // Keyed on the served profile path so a background refetch that changes the
  // current config reseeds the form from fresh values.
  return <OpenRouterForm key={summary.data!.profilePath} data={summary.data!} />;
}

export function ModelSection() {
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h2>Model</h2>
        <p className="muted small">Main-loop model preset and OpenRouter subagent defaults.</p>
      </div>
      <MainLoopModel />
      <OpenRouterSubagents />
    </section>
  );
}
