import { type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { SignOutButton, useUser } from "@clerk/clerk-react";
import { useStatus } from "../lib/queries";
import { useDebug } from "../lib/debug";
import { StatusDot } from "./common";
import type { StatusComponentState } from "../api-types";

const NAV_ITEMS: Array<{ to: string; label: string }> = [
  { to: "/", label: "Home" },
  { to: "/setup", label: "Setup" },
  { to: "/settings", label: "Settings" },
  { to: "/users", label: "Users" },
  { to: "/operations", label: "Operations" },
];

const STATE_RANK: Record<StatusComponentState, number> = { ok: 0, warn: 1, error: 2 };

// Header shows a single worst-state summary indicator (plan §5.1). This is pure
// presentation over server-decided component states — the client never computes
// health, it only picks which server verdict to surface as the summary.
function worstState(states: StatusComponentState[]): StatusComponentState {
  return states.reduce<StatusComponentState>((worst, next) => (STATE_RANK[next] > STATE_RANK[worst] ? next : worst), "ok");
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const status = useStatus();
  const { user } = useUser();
  const { debug, setDebug } = useDebug();

  const components = status.data?.components ?? [];
  const summary = components.length > 0 ? worstState(components.map((component) => component.state)) : "ok";
  const summaryLabel = status.isError ? "status unavailable" : components.length === 0 ? "checking…" : `${summary}`;

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => navigate("/")} aria-label="Go to Home">
          <span className="logo" aria-hidden="true">
            B
          </span>
          <span className="brand-text">
            <span className="brand-title">Brain</span>
            <span className="brand-status">
              <StatusDot state={status.isError ? "error" : summary} label={summaryLabel} />
              <span className="muted small">{summaryLabel}</span>
            </span>
          </span>
        </button>

        <div className="header-actions">
          <label className="debug-toggle" title="Reveal raw-JSON panels (persisted)">
            <input type="checkbox" checked={debug} onChange={(event) => setDebug(event.target.checked)} />
            Debug
          </label>
          <span className="muted small account-email">{user?.primaryEmailAddress?.emailAddress ?? ""}</span>
          <SignOutButton>
            <button className="btn ghost" type="button">
              Sign out
            </button>
          </SignOutButton>
        </div>
      </header>

      <div className="layout">
        <aside className="side">
          <nav className="nav" aria-label="Console sections">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
