import { useState } from "react";
import { useAudit, useRequestRestartConfirmation, useRestart, useServiceInfo, type AuditFilters } from "../lib/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ApiError } from "../lib/api";
import { ErrorNotice, Loading, RawJson, describeError, relativeTime } from "../components/common";
import type { AuditOutcome, AuditRow, AuditType, LiveOperationConfirmation, OperationResult } from "../api-types";

// Operations (plan §5.5): restart + one merged, denial-centric audit feed.

// Map the server's refusal codes to specific, accurate operator messages instead
// of a generic "unknown error" (finding 10).
function describeRestartError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "refusing_to_operate_on_brain_service") {
      return "Refused: Brain will not restart its own admin service. Restart is available only for the codex-chat runtime.";
    }
    if (error.code === "operation_not_configured") {
      return "No restart command is configured for the codex-chat service on this instance.";
    }
  }
  return describeError(error).message;
}

function RestartSection() {
  // Target-service info comes from a read-only source (GET /settings). The
  // operation endpoint is only ever hit when the operator clicks Restart — never
  // on mount or window refocus (finding 10).
  const service = useServiceInfo();
  const requestConfirmation = useRequestRestartConfirmation();
  const restart = useRestart();
  const [confirmation, setConfirmation] = useState<LiveOperationConfirmation | null>(null);
  const [result, setResult] = useState<OperationResult | null>(null);

  const serviceName = service.data?.codexChat.serviceName;

  // First POST: harvest the server's confirmation_required token (side-effect
  // free) and open the confirm dialog. 409 refusals surface a specific message.
  const beginRestart = () => {
    setResult(null);
    requestConfirmation.mutate(undefined, {
      onSuccess: (confirmationRequired) => setConfirmation(confirmationRequired),
    });
  };

  // Second POST: the confirmed restart carrying the exact approval token.
  const confirm = () => {
    if (!confirmation) return;
    restart.mutate(confirmation, {
      onSuccess: (data) => {
        setResult(data);
        setConfirmation(null);
      },
      // Keep the dialog open on error so the failure stays visible (finding 8).
    });
  };

  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h2>Restart</h2>
        <p className="muted small">Restart the codex-chat runtime to apply configuration changes.</p>
      </div>

      {service.isLoading ? <Loading label="Loading restart target…" /> : null}
      {service.isError ? <ErrorNotice error={service.error} onRetry={() => service.refetch()} /> : null}
      {serviceName ? (
        <>
          <p className="small">
            Target service: <span className="mono">{serviceName}</span>
          </p>
          <div className="settings-actions">
            <button className="btn primary" type="button" onClick={beginRestart} disabled={requestConfirmation.isPending || restart.isPending}>
              {requestConfirmation.isPending ? "Preparing…" : "Restart codex-chat"}
            </button>
          </div>
        </>
      ) : null}

      {requestConfirmation.isError && !confirmation ? <p className="alert bad small">{describeRestartError(requestConfirmation.error)}</p> : null}
      {result ? (
        <div className={`alert ${result.ok ? "ok" : "bad"}`} role="status">
          <strong>{result.ok ? "Restart succeeded" : "Restart failed"}</strong>
          <p className="small">
            {result.operation} exited with status {String(result.status)}
            {result.timedOut ? " (timed out)" : ""}. The change is audited below.
          </p>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmation !== null}
        title="Restart codex-chat?"
        confirmLabel="Restart"
        busy={restart.isPending}
        onConfirm={confirm}
        onCancel={() => setConfirmation(null)}
      >
        <p>
          Restart <span className="mono">{confirmation?.serviceName ?? serviceName}</span>. In-flight assistant work is interrupted while the service restarts.
        </p>
        <p className="muted small">The exact approval is sent programmatically; this action is recorded in the audit feed.</p>
        {restart.isError ? <p className="alert bad small">{describeRestartError(restart.error)}</p> : null}
      </ConfirmDialog>
    </section>
  );
}

const RESULT_CLASS: Record<string, string> = { denied: "res-denied", error: "res-denied", allowed: "res-allowed", ok: "res-ok" };

function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <div className="audit-scroll">
      <table className="audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>Result</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.timeMs}-${index}`}>
              <td className="muted small" title={row.time ?? ""}>
                {row.time ? relativeTime(row.time) : "—"}
              </td>
              <td className="mono small">{row.actor}</td>
              <td className="mono small">{row.action}</td>
              <td className="mono small audit-target">{row.target || "—"}</td>
              <td>
                <span className={`badge ${RESULT_CLASS[row.result] ?? ""}`}>{row.result}</span>
              </td>
              <td className="muted small">{row.reason || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditSection() {
  // Default view = recent denials (the actionable signal in a fail-closed system).
  const [filters, setFilters] = useState<AuditFilters>({ outcome: "denied" });
  const audit = useAudit(filters);

  const rows = (audit.data?.pages ?? []).flatMap((page) => page.rows);
  const total = audit.data?.pages[0]?.total ?? 0;

  const set = (patch: Partial<AuditFilters>) => setFilters((prev) => ({ ...prev, ...patch }));

  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h2>Audit</h2>
        <p className="muted small">One merged feed: service operations and capability decisions. Default view is recent denials.</p>
      </div>

      <div className="audit-filters">
        <div className="field">
          <label htmlFor="audit-outcome">Outcome</label>
          <select id="audit-outcome" value={filters.outcome ?? ""} onChange={(event) => set({ outcome: (event.target.value || undefined) as AuditOutcome | undefined })}>
            <option value="denied">denied</option>
            <option value="allowed">allowed</option>
            <option value="">all</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-type">Type</label>
          <select id="audit-type" value={filters.type ?? ""} onChange={(event) => set({ type: (event.target.value || undefined) as AuditType | undefined })}>
            <option value="">all</option>
            <option value="capability">capability</option>
            <option value="operations">operations</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-actor">Actor contains</label>
          <input id="audit-actor" type="text" autoComplete="off" value={filters.actor ?? ""} onChange={(event) => set({ actor: event.target.value || undefined })} />
        </div>
        <div className="field">
          <label htmlFor="audit-operation">Operation contains</label>
          <input id="audit-operation" type="text" autoComplete="off" value={filters.operation ?? ""} onChange={(event) => set({ operation: event.target.value || undefined })} />
        </div>
      </div>

      {audit.isLoading ? <Loading label="Loading audit…" /> : null}
      {audit.isError ? <ErrorNotice error={audit.error} onRetry={() => audit.refetch()} /> : null}
      {audit.data ? (
        <>
          <p className="muted small">
            {rows.length} of {total} matching {total === 1 ? "row" : "rows"}.
          </p>
          {rows.length === 0 ? <p className="muted">No matching audit rows.</p> : <AuditTable rows={rows} />}
          {audit.hasNextPage ? (
            <div className="settings-actions">
              <button className="btn ghost" type="button" onClick={() => audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
                {audit.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      <RawJson title="Raw /audit JSON (first page)" data={audit.data?.pages[0]} />
    </section>
  );
}

export function Operations() {
  return (
    <div className="route operations">
      <div className="route-head">
        <h1>Operations</h1>
        <p className="muted">Restart the runtime and review the merged audit feed.</p>
      </div>
      <RestartSection />
      <AuditSection />
    </div>
  );
}
