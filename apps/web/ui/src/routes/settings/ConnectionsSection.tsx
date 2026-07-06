import { useMemo, useState } from "react";
import { useEnvSchema, useSlackSettings, useSlackSettingsWrite } from "../../lib/queries";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorNotice, Loading, RawJson, describeError } from "../../components/common";
import type { EnvKeySchemaEntry, SlackSettingsWritePayload } from "../../api-types";
import { RestartNote } from "./shared";

// Connections group (plan §5.3a): the Slack keys only. Which keys are
// secret/required comes entirely from the §6.4 env schema — nothing hardcoded
// here. Secret inputs are write-only and never prefilled.

export function ConnectionsSection() {
  const slack = useSlackSettings();
  const schema = useEnvSchema();
  const write = useSlackSettingsWrite();
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wrote, setWrote] = useState<string[] | null>(null);

  const schemaByKey = useMemo(() => {
    const map = new Map<string, EnvKeySchemaEntry>();
    for (const entry of schema.data ?? []) map.set(entry.key, entry);
    return map;
  }, [schema.data]);

  if (slack.isLoading || schema.isLoading) return <Loading label="Loading connections…" />;
  if (slack.isError) return <ErrorNotice error={slack.error} onRetry={() => slack.refetch()} />;
  if (schema.isError) return <ErrorNotice error={schema.error} onRetry={() => schema.refetch()} />;

  const env = slack.data!.env;
  const presenceByKey = new Map(env.keys.map((entry) => [entry.key, entry] as const));
  const keys = env.allowedKeys;

  const pending = Object.entries(values).filter(([, value]) => value.trim() !== "");
  const secretOverwrites = pending.filter(([key]) => schemaByKey.get(key)?.secret);

  const submit = () => {
    if (pending.length === 0) return;
    setConfirmOpen(true);
  };

  const confirm = () => {
    const entries = Object.fromEntries(pending.map(([key, value]) => [key, value.trim()]));
    const payload: SlackSettingsWritePayload = {
      entries,
      confirmation: {
        token: slack.data!.confirmation.token,
        action: slack.data!.confirmation.action,
        envFile: env.envFile,
        keys: Object.keys(entries),
      },
    };
    write.mutate(payload, {
      onSuccess: (result) => {
        setWrote(result.writtenKeys);
        setValues({});
        setConfirmOpen(false);
      },
      onError: () => setConfirmOpen(false),
    });
  };

  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h2>Connections</h2>
        <p className="muted small">
          Slack keys for the codex-chat runtime. Public Events URL: <span className="mono">{slack.data!.publicEventsUrl}</span>
        </p>
      </div>

      <div className="env-rows">
        {keys.map((key) => {
          const entry = schemaByKey.get(key);
          const presence = presenceByKey.get(key);
          const isSecret = entry?.secret ?? false;
          return (
            <div className="env-row" key={key}>
              <div className="env-row-meta">
                <label className="mono" htmlFor={`conn-${key}`}>
                  {key}
                  {entry?.required ? <span className="req" title="required"> *</span> : null}
                </label>
                <p className="muted small">{entry?.description ?? "Slack setting."}</p>
              </div>
              <div className="env-row-control">
                <span className={`badge ${presence?.present ? "ok" : ""}`}>{presence?.present ? "set" : "not set"}</span>
                <input
                  id={`conn-${key}`}
                  type={isSecret ? "password" : "text"}
                  autoComplete="off"
                  placeholder={isSecret ? "write-only · leave blank to keep" : presence?.present ? "leave blank to keep" : "not set"}
                  value={values[key] ?? ""}
                  onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
                />
              </div>
            </div>
          );
        })}
      </div>

      {write.isError ? <ErrorNotice error={write.error} /> : null}
      {wrote ? <RestartNote writtenKeys={wrote} /> : null}

      <div className="settings-actions">
        <button className="btn primary" type="button" onClick={submit} disabled={pending.length === 0 || write.isPending}>
          Save connections
        </button>
      </div>

      <RawJson title="Raw /slack/settings JSON" data={slack.data} />

      <ConfirmDialog
        open={confirmOpen}
        title="Write Slack connection settings?"
        confirmLabel="Write settings"
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
          <p className="alert warn small">
            {secretOverwrites.length} secret value(s) will be overwritten. Secret values are write-only and never displayed.
          </p>
        ) : null}
        <p className="muted small">codex-chat restart is required for changes to take effect.</p>
        {write.isError ? <p className="alert bad small">{describeError(write.error).message}</p> : null}
      </ConfirmDialog>
    </section>
  );
}
