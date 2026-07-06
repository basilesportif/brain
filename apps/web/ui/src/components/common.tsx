import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
import type { StatusComponentState } from "../api-types";
import { useDebug } from "../lib/debug";

export function StatusDot({ state, label }: { state: StatusComponentState; label?: string }) {
  return <span className={`dot dot-${state}`} role="img" aria-label={label ?? state} title={label ?? state} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

// Route-level error rendering keyed to the single API error taxonomy.
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { kind, message } = describeError(error);
  return (
    <div className={`alert bad`} role="alert">
      <strong>{titleForKind(kind)}</strong>
      <p className="muted small">{message}</p>
      {onRetry && kind !== "forbidden" && kind !== "auth" ? (
        <button className="btn ghost" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

function titleForKind(kind: string): string {
  switch (kind) {
    case "auth":
      return "Sign-in required";
    case "forbidden":
      return "Access denied";
    case "store_unavailable":
      return "Store unavailable";
    case "validation":
      return "Validation error";
    case "network":
      return "Network error";
    default:
      return "Something went wrong";
  }
}

export function describeError(error: unknown): { kind: string; message: string } {
  if (error instanceof ApiError) return { kind: error.kind, message: error.message };
  if (error instanceof Error) return { kind: "unknown", message: error.message };
  return { kind: "unknown", message: String(error) };
}

// Raw-JSON panel gated by the global Debug toggle (plan §4). Renders nothing
// unless Debug is on, so no raw data leaks into the default operator view.
export function RawJson({ title, data }: { title: string; data: unknown }) {
  const { debug } = useDebug();
  if (!debug) return null;
  return (
    <details className="details raw-json">
      <summary>{title}</summary>
      <pre className="code">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`card${className ? ` ${className}` : ""}`}>{children}</section>;
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(then).toLocaleString();
}
