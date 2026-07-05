import { Link } from "react-router-dom";
import { useStatus } from "../lib/queries";
import { ErrorNotice, Loading, RawJson, StatusDot, relativeTime } from "../components/common";
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

function StatusCard({ component }: { component: StatusComponent }) {
  return (
    <section className={`status-card state-${component.state}`}>
      <header className="status-card-head">
        <StatusDot state={component.state} label={component.state} />
        <h2>{CARD_TITLES[component.id] ?? component.id}</h2>
      </header>
      <p className="status-card-message">{component.message}</p>
      <footer className="status-card-foot">
        <span className="muted small">Checked {relativeTime(component.lastChecked)}</span>
        {component.action ? (
          <Link className="btn ghost sm" to={component.action.route}>
            {component.action.label}
          </Link>
        ) : null}
      </footer>
    </section>
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
          <StatusCard key={component.id} component={component} />
        ))}
      </div>
      <RawJson title="Raw /status JSON" data={status.data} />
    </div>
  );
}
