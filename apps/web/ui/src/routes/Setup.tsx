import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useEnvSchema, useSlackManifest, useSlackSettings, useSlackSetup, useSlackSetupWrite, useSlackSettingsWrite } from "../lib/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorNotice, Loading, RawJson, describeError } from "../components/common";
import type { EnvKeySchemaEntry, SlackSetupStep, SlackSettingsSummary, SlackSettingsWritePayload } from "../api-types";

// Setup (plan §5.2): a five-step Slack wizard, routable only while
// slack.setupComplete === false. Step done/not-done is binary and derived from
// backend state (the /slack/setup summary), never client-computed. Secrets are
// write-only. One "Skip setup" link exits Home; the wizard reappears while
// incomplete.

function StepShell({ step, index, children }: { step: SlackSetupStep; index: number; children: React.ReactNode }) {
  return (
    <section className={`setup-step ${step.done ? "done" : ""}`}>
      <header className="setup-step-head">
        <span className="setup-step-num" aria-hidden="true">
          {step.done ? "✓" : index + 1}
        </span>
        <h2>{step.label}</h2>
        <span className={`badge ${step.done ? "ok" : ""}`}>{step.done ? "done" : "not done"}</span>
      </header>
      <div className="setup-step-body">{children}</div>
    </section>
  );
}

// Step 2 — write-only required Slack secrets. Reuses the same slack settings
// write + confirm-dialog contract as Settings › Connections.
function SecretsStep({ slack, schemaByKey }: { slack: SlackSettingsSummary; schemaByKey: Map<string, EnvKeySchemaEntry> }) {
  const write = useSlackSettingsWrite();
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wrote, setWrote] = useState<string[] | null>(null);

  const env = slack.env;
  const presenceByKey = new Map(env.keys.map((entry) => [entry.key, entry] as const));
  const pending = Object.entries(values).filter(([, value]) => value.trim() !== "");

  const confirm = () => {
    const entries = Object.fromEntries(pending.map(([key, value]) => [key, value.trim()]));
    const payload: SlackSettingsWritePayload = {
      entries,
      confirmation: {
        token: "brain-admin-slack-settings-confirmed-v1",
        action: "slack.settings.write",
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
    <>
      <p className="muted small">Enter the Slack secrets the runtime needs. Values are write-only and never displayed back.</p>
      <div className="env-rows">
        {env.allowedKeys.map((key) => {
          const entry = schemaByKey.get(key);
          const presence = presenceByKey.get(key);
          const isSecret = entry?.secret ?? true;
          return (
            <div className="env-row" key={key}>
              <div className="env-row-meta">
                <label className="mono" htmlFor={`setup-${key}`}>
                  {key}
                  {entry?.required ? <span className="req" title="required"> *</span> : null}
                </label>
                <p className="muted small">{entry?.description ?? "Slack secret."}</p>
              </div>
              <div className="env-row-control">
                <span className={`badge ${presence?.present ? "ok" : ""}`}>{presence?.present ? "set" : "not set"}</span>
                <input
                  id={`setup-${key}`}
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
      {wrote ? <p className="alert ok small" role="status">Wrote {wrote.join(", ") || "settings"}. A codex-chat restart applies them (step 5).</p> : null}
      <div className="settings-actions">
        <button className="btn primary" type="button" onClick={() => setConfirmOpen(true)} disabled={pending.length === 0 || write.isPending}>
          Write secrets
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Write Slack secrets?"
        confirmLabel="Write secrets"
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
        <p className="alert warn small">Secret values are write-only and never displayed.</p>
        {write.isError ? <p className="alert bad small">{describeError(write.error).message}</p> : null}
      </ConfirmDialog>
    </>
  );
}

// Step 3 — download/copy the manifest and open Slack App Settings. The manifest
// is fetched through the authenticated API client (a plain anchor to the gated
// /api route would not carry the Clerk bearer token), then offered as a blob
// download / clipboard copy so the browser never navigates the gated route.
function InstallStep({ slack }: { slack: SlackSettingsSummary }) {
  const manifest = useSlackManifest();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    setCopied(false);
    const result = await manifest.refetch();
    const text = result.data?.text;
    if (text && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      } catch {
        // Clipboard blocked (permissions) — the download button is the fallback.
      }
    }
  };

  const download = async () => {
    const result = await manifest.refetch();
    const text = result.data?.text;
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "brain.slack.manifest.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <p className="muted small">Download or copy the app manifest, then create/configure the app in Slack.</p>
      <div className="setup-actions">
        <button className="btn" type="button" onClick={download} disabled={manifest.isFetching}>
          {manifest.isFetching ? "Rendering…" : "Download Slack manifest"}
        </button>
        <button className="btn ghost" type="button" onClick={copy} disabled={manifest.isFetching}>
          {manifest.isFetching ? "Rendering…" : copied ? "Copied ✓" : "Copy manifest"}
        </button>
        <a className="btn ghost" href={slack.appSettingsUrl} target="_blank" rel="noreferrer">
          Open Slack App Settings
        </a>
      </div>
      {manifest.isError ? <ErrorNotice error={manifest.error} onRetry={() => manifest.refetch()} /> : null}
      <RawJson title="Raw /slack/manifest JSON" data={manifest.data} />
    </>
  );
}

const STEP_IDS = ["public_url", "secrets", "install_app", "event_subscriptions", "restart"] as const;

export function Setup() {
  const setup = useSlackSetup();
  const slack = useSlackSettings();
  const schema = useEnvSchema();
  const complete = useSlackSetupWrite();
  const navigate = useNavigate();

  const schemaByKey = useMemo(() => {
    const map = new Map<string, EnvKeySchemaEntry>();
    for (const entry of schema.data ?? []) map.set(entry.key, entry);
    return map;
  }, [schema.data]);

  if (setup.isLoading || slack.isLoading) return <Loading label="Loading setup…" />;
  if (setup.isError) return <ErrorNotice error={setup.error} onRetry={() => setup.refetch()} />;
  if (slack.isError) return <ErrorNotice error={slack.error} onRetry={() => slack.refetch()} />;

  // Once complete, /setup redirects Home; Home's Slack card offers Reconfigure.
  if (setup.data!.setupComplete) return <Navigate to="/" replace />;

  const steps = setup.data!.steps;
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  const ordered = STEP_IDS.map((id) => byId.get(id)).filter((step): step is SlackSetupStep => Boolean(step));
  const allDone = steps.filter((step) => step.id !== "restart").every((step) => step.done);

  const markComplete = () => {
    complete.mutate(true, { onSuccess: () => navigate("/") });
  };

  return (
    <div className="route setup">
      <div className="route-head setup-head">
        <div>
          <h1>Slack setup</h1>
          <p className="muted">Five steps to connect Slack. Each step is marked done from live backend state.</p>
        </div>
        <Link className="btn ghost sm" to="/">
          Skip setup
        </Link>
      </div>

      {ordered.map((step, index) => (
        <StepShell key={step.id} step={step} index={index}>
          {step.id === "public_url" ? (
            <>
              <p className="muted small">The runtime receives Slack events at this public URL. Confirm it matches your deployment.</p>
              <ul className="setup-facts">
                <li>
                  Public events URL: <span className="mono">{slack.data!.publicEventsUrl}</span>
                </li>
                <li>
                  Base URL: <span className="mono">{slack.data!.eventsBaseUrl}</span>
                </li>
                <li>
                  Events path: <span className="mono">{slack.data!.eventsPath}</span>
                </li>
              </ul>
            </>
          ) : step.id === "secrets" ? (
            <SecretsStep slack={slack.data!} schemaByKey={schemaByKey} />
          ) : step.id === "install_app" ? (
            <InstallStep slack={slack.data!} />
          ) : step.id === "event_subscriptions" ? (
            <>
              <p className="muted small">
                In Slack, set the Request URL to <span className="mono">{slack.data!.publicEventsUrl}</span>, subscribe to events, then send a
                test message. Verification is automatic from runtime telemetry.
              </p>
              <p className="small">
                Last accepted inbound event: <span className={`badge ${setup.data!.verification.lastAcceptedEvent ? "ok" : ""}`}>{setup.data!.verification.lastAcceptedEvent ? "observed" : "not yet"}</span>
              </p>
              <div className="settings-actions">
                <button className="btn ghost" type="button" onClick={() => setup.refetch()} disabled={setup.isFetching}>
                  {setup.isFetching ? "Rechecking…" : "Recheck"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">Env changes take effect after a codex-chat restart. Restart from Operations, then mark setup complete.</p>
              <div className="setup-actions">
                <Link className="btn" to="/operations">
                  Open Operations
                </Link>
                <button className="btn primary" type="button" onClick={markComplete} disabled={!allDone || complete.isPending}>
                  {complete.isPending ? "Saving…" : "Mark setup complete"}
                </button>
              </div>
              {!allDone ? <p className="muted small">Finish the earlier steps to enable completion.</p> : null}
              {complete.isError ? <ErrorNotice error={complete.error} /> : null}
            </>
          )}
        </StepShell>
      ))}

      <RawJson title="Raw /slack/setup JSON" data={setup.data} />
    </div>
  );
}
