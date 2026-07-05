import { ConnectionsSection } from "./settings/ConnectionsSection";
import { ModelSection } from "./settings/ModelSection";
import { AllConfigSection } from "./settings/AllConfigSection";

// Settings (plan §5.3): three groups on one page — Connections (Slack),
// Model (main-loop preset + OpenRouter subagents), and All configuration.
export function Settings() {
  return (
    <div className="route settings">
      <div className="route-head">
        <h1>Settings</h1>
        <p className="muted">Connections, model, and all configuration. Secrets are write-only and never displayed.</p>
      </div>
      <ConnectionsSection />
      <ModelSection />
      <AllConfigSection />
    </div>
  );
}
