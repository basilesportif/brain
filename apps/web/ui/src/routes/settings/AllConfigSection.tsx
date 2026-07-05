import { useMemo, useState } from "react";
import { useEnvSchema, useEnvSummary, useEnvWrite } from "../../lib/queries";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorNotice, Loading, RawJson, describeError } from "../../components/common";
import { ApiError } from "../../lib/api";
import type { EnvFieldError, EnvKeyGroup, EnvKeySchemaEntry } from "../../api-types";
import { RestartNote } from "./shared";

const GROUP_LABELS: Record<EnvKeyGroup, string> = {
  slack: "Slack",
  model: "Main-loop model",
  openrouter: "OpenRouter / subagents",
  feature_flags: "Feature flags",
  other: "Other",
};

// All-configuration expander (plan §5.3c): the full tagged env list, same row
// treatment as Connections, with inline API validation errors. Collapsed by
// default. Writes go through POST /codex-chat/env (server-side approval phrase
// removed in this slice; the confirm dialog below is the gate).

export function AllConfigSection() {
  const schema = useEnvSchema();
  const summary = useEnvSummary();
  const write = useEnvWrite();
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wrote, setWrote] = useState<string[] | null>(null);

  const fieldErrors = useMemo<Map<string, EnvFieldError>>(() => {
    const map = new Map<string, EnvFieldError>();
    if (write.error instanceof ApiError && write.error.kind === "validation") {
      for (const fieldError of write.error.fieldErrors ?? []) map.set(fieldError.key, fieldError);
    }
    return map;
  }, [write.error]);

  const grouped = useMemo(() => {
    const groups = new Map<EnvKeyGroup, EnvKeySchemaEntry[]>();
    for (const entry of schema.data ?? []) {
      const list = groups.get(entry.group) ?? [];
      list.push(entry);
      groups.set(entry.group, list);
    }
    return groups;
  }, [schema.data]);

  if (schema.isLoading || summary.isLoading) return <Loading label="Loading configuration…" />;
  if (schema.isError) return <ErrorNotice error={schema.error} onRetry={() => schema.refetch()} />;
  if (summary.isError) return <ErrorNotice error={summary.error} onRetry={() => summary.refetch()} />;

  const presenceByKey = new Map((summary.data?.keys ?? []).map((entry) => [entry.key, entry] as const));
  const pending = Object.entries(values).filter(([, value]) => value.trim() !== "");
  const secretOverwrites = pending.filter(([key]) => (schema.data ?? []).find((entry) => entry.key === key)?.secret);

  const confirm = () => {
    const entries = Object.fromEntries(pending.map(([key, value]) => [key, value.trim()]));
    write.mutate(entries, {
      onSuccess: (result) => {
        setWrote(result.writtenKeys);
        setValues({});
        setConfirmOpen(false);
      },
      // Close the dialog on any failure; validation errors then render inline
      // against the affected rows, other errors render as a notice.
      onError: () => setConfirmOpen(false),
    });
  };

  const groupOrder: EnvKeyGroup[] = ["slack", "model", "openrouter", "feature_flags", "other"];

  return (
    <details className="settings-group expander">
      <summary>
        <h2>All configuration</h2>
        <span className="muted small">Full tagged env list</span>
      </summary>

      <div className="expander-body">
        {groupOrder
          .filter((group) => grouped.has(group))
          .map((group) => (
            <div className="env-group" key={group}>
              <h3>{GROUP_LABELS[group]}</h3>
              <div className="env-rows">
                {(grouped.get(group) ?? []).map((entry) => {
                  const presence = presenceByKey.get(entry.key);
                  const error = fieldErrors.get(entry.key);
                  return (
                    <div className={`env-row${error ? " has-error" : ""}`} key={entry.key}>
                      <div className="env-row-meta">
                        <label className="mono" htmlFor={`env-${entry.key}`}>
                          {entry.key}
                          {entry.required ? <span className="req" title="required"> *</span> : null}
                        </label>
                        <p className="muted small">{entry.description}</p>
                      </div>
                      <div className="env-row-control">
                        <span className={`badge ${presence?.present ? "ok" : ""}`}>{presence?.present ? "set" : "not set"}</span>
                        {!entry.writable ? (
                          // Not accepted by POST /codex-chat/env (server allowlist): status only,
                          // no input — offering one would just earn a 403 (plan §6.4 / fix).
                          <span className="muted small" title="Not writable via this console">read-only</span>
                        ) : entry.kind === "enum" && entry.enumValues ? (
                          <select
                            id={`env-${entry.key}`}
                            value={values[entry.key] ?? ""}
                            onChange={(event) => setValues((prev) => ({ ...prev, [entry.key]: event.target.value }))}
                          >
                            <option value="">leave unchanged</option>
                            {entry.enumValues.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id={`env-${entry.key}`}
                            type={entry.secret ? "password" : "text"}
                            autoComplete="off"
                            placeholder={entry.secret ? "write-only · leave blank to keep" : presence?.present ? "leave blank to keep" : "not set"}
                            value={values[entry.key] ?? ""}
                            onChange={(event) => setValues((prev) => ({ ...prev, [entry.key]: event.target.value }))}
                          />
                        )}
                        {error ? <p className="field-error small">{error.message}</p> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

        {write.isError && !(write.error instanceof ApiError && write.error.kind === "validation") ? <ErrorNotice error={write.error} /> : null}
        {wrote ? <RestartNote writtenKeys={wrote} /> : null}

        <div className="settings-actions">
          <button className="btn primary" type="button" disabled={pending.length === 0 || write.isPending} onClick={() => setConfirmOpen(true)}>
            Save configuration
          </button>
        </div>

        <RawJson title="Raw /codex-chat/env JSON" data={summary.data} />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Write configuration?"
        confirmLabel="Write configuration"
        busy={write.isPending}
        onConfirm={confirm}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>The following keys will be written to the codex-chat env file:</p>
        <ul className="mono">
          {pending.map(([key]) => (
            <li key={key}>{key}</li>
          ))}
        </ul>
        {secretOverwrites.length > 0 ? (
          <p className="alert warn small">{secretOverwrites.length} secret value(s) will be overwritten. Secret values are write-only and never displayed.</p>
        ) : null}
        <p className="muted small">codex-chat restart is required for changes to take effect.</p>
        {write.isError ? <p className="alert bad small">{describeError(write.error).message}</p> : null}
      </ConfirmDialog>
    </details>
  );
}
