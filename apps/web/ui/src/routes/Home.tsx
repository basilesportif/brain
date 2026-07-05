import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSlackSetup, useSlackSetupWrite, useStatus } from "../lib/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorNotice, Loading, RawJson, StatusDot, describeError, relativeTime } from "../components/common";
import type { StatusComponent } from "../api-types";

// Home (plan §5.1): renders exactly GET /status as five status cards. No raw
// telemetry, no computed health — the server decides each component's state,
// message, timestamp, and (at most one) contextual action.

const CARD_TITLES: Record<StatusComponent["id"], string> = {
  brain: "Brain service",
  slack: "Slack",
  model: "Model / OpenRouter",
  service: "Service",
  capability_enforcement: "Capability enforcement",
};

// Preserve the canonical order even if the endpoint reorders components.
const CARD_ORDER: StatusComponent["id"][] = ["brain", "slack", "model", "service", "capability_enforcement"];

function StatusCard({ component, extraAction }: { component: StatusComponent; extraAction?: React.ReactNode }) {
  return (
    <section className={`status-card state-${component.state}`}>
      <header className="status-card-head">
        <StatusDot state={component.state} label={component.state} />
        <h2>{CARD_TITLES[component.id] ?? component.id}</h2>
      </header>
      <p className="status-card-message">{component.message}</p>
      <footer className="status-card-foot">
        <span className="muted small">Checked {relativeTime(component.lastChecked)}</span>
        <span className="status-card-actions">
          {component.action ? (
            <Link className="btn ghost sm" to={component.action.route}>
              {component.action.label}
            </Link>
          ) : null}
          {extraAction}
        </span>
      </footer>
    </section>
  );
}

// Deliberate "Reconfigure" affordance on the Slack card once setup is complete
// (plan §5.2): clears the setup-complete flag and re-opens the wizard. It is a
// live write (POST /slack/setup {complete:false}) that reverts the console to
// setup mode, so it is gated behind an explicit confirm dialog rather than firing
// on a single click (finding 9).
function ReconfigureSlack() {
  const setup = useSlackSetup();
  const reset = useSlackSetupWrite();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!setup.data?.setupComplete) return null;
  const reconfigure = () =>
    reset.mutate(false, {
      onSuccess: () => {
        setOpen(false);
        navigate("/setup");
      },
      // Keep the dialog open on error so the failure stays visible (finding 8).
    });
  return (
    <>
      <button className="btn ghost sm" type="button" onClick={() => setOpen(true)} disabled={reset.isPending}>
        Reconfigure
      </button>
      <ConfirmDialog
        open={open}
        title="Reconfigure Slack?"
        confirmLabel="Reconfigure"
        busy={reset.isPending}
        onConfirm={reconfigure}
        onCancel={() => setOpen(false)}
      >
        <p>
          This clears the Slack setup-complete flag and reopens the setup wizard. The console reverts to <strong>setup mode</strong> for Slack until
          you complete the wizard again.
        </p>
        {reset.isError ? <p className="alert bad small">{describeError(reset.error).message}</p> : null}
      </ConfirmDialog>
    </>
  );
}

export function Home() {
  const status = useStatus();

  if (status.isLoading) return <Loading label="Loading status…" />;
  if (status.isError) return <ErrorNotice error={status.error} onRetry={() => status.refetch()} />;

  const byId = new Map((status.data?.components ?? []).map((component) => [component.id, component] as const));
  const ordered = CARD_ORDER.map((id) => byId.get(id)).filter((component): component is StatusComponent => Boolean(component));
  const extras = (status.data?.components ?? []).filter((component) => !CARD_ORDER.includes(component.id));
  const cards = [...ordered, ...extras];

  return (
    <div className="route home">
      <div className="route-head">
        <h1>Status</h1>
        <p className="muted">At-a-glance health for the Brain control plane.</p>
      </div>
      <div className="status-grid">
        {cards.map((component) => (
          <StatusCard key={component.id} component={component} extraAction={component.id === "slack" ? <ReconfigureSlack /> : undefined} />
        ))}
      </div>
      <RawJson title="Raw /status JSON" data={status.data} />
    </div>
  );
}
