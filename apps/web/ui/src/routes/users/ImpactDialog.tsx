import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { describeError } from "../../components/common";
import { ApiError } from "../../lib/api";
import type { ImpactPreview } from "../../api-types";
import type { PreviewResult } from "./actions";

// A confirm dialog that first fetches the server-computed impact preview for a
// grant/revoke/unlink, renders the newly allowed/denied operations per surface
// plus the previewCaveat, and only commits on confirm (plan §5.4, §6.5). The
// impact is the enforcer's own decision diff — the client renders it verbatim.
//
// SAFETY RAILS:
//  - Confirm is disabled until a SUCCESSFUL preview is loaded (finding 7). A
//    failed preview shows the error and a "Retry preview" action only — never a
//    committable dialog with no rendered impact.
//  - The preview's storeHash pins the commit (A3). On a store_conflict (409) the
//    dialog re-previews against the current store and explains the change; it
//    never auto-commits against a moved target.
//  - Store-unavailable / any preview failure is a blocking error (§5.4), not an
//    empty "no changes" confirm.

export interface ImpactDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  // Short human summary of the action (e.g. "Grant group CRM to Beta Operator").
  description: React.ReactNode;
  loadPreview: () => Promise<PreviewResult>;
  onCommit: (expectedStoreHash: string) => Promise<void>;
  onClose: () => void;
}

function ImpactBody({ impact }: { impact: ImpactPreview }) {
  if (impact.surfaces.length === 0) {
    return <p className="muted small">No authorization changes for any linked surface.</p>;
  }
  return (
    <div className="impact">
      {impact.surfaces.map((surface) => (
        <div className="impact-surface" key={surface.surface}>
          <h4 className="mono small">{surface.surface}</h4>
          {surface.newlyAllowed.length > 0 ? (
            <p className="small">
              <span className="impact-allow">+ allows</span> {surface.newlyAllowed.join(", ")}
            </p>
          ) : null}
          {surface.newlyDenied.length > 0 ? (
            <p className="small">
              <span className="impact-deny">− denies</span> {surface.newlyDenied.join(", ")}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ImpactDialog({ open, title, confirmLabel, danger, description, loadPreview, onCommit, onClose }: ImpactDialogProps) {
  const [impact, setImpact] = useState<ImpactPreview | null>(null);
  const [storeHash, setStoreHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Set when a commit was rejected because the store moved and we re-previewed.
  const [conflict, setConflict] = useState(false);

  const runPreview = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setImpact(null);
    setStoreHash(null);
    loadPreview()
      .then((result) => {
        if (cancelled) return;
        setImpact(result.impact);
        setStoreHash(result.storeHash);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadPreview]);

  useEffect(() => {
    if (!open) {
      setImpact(null);
      setStoreHash(null);
      setError(null);
      setConflict(false);
      return;
    }
    setConflict(false);
    const cancel = runPreview();
    return cancel;
    // loadPreview identity changes per open; keyed by `open` intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const confirm = () => {
    if (!storeHash) return; // no committing without a rendered, pinned preview
    setCommitting(true);
    setError(null);
    setConflict(false);
    onCommit(storeHash)
      .then(() => onClose())
      .catch((err) => {
        // The store moved between preview and commit: re-preview against the
        // current store and let the operator review the fresh impact. Never
        // auto-commit against a store the preview no longer describes.
        if (err instanceof ApiError && err.code === "store_conflict") {
          setConflict(true);
          runPreview();
          return;
        }
        setError(err);
      })
      .finally(() => setCommitting(false));
  };

  const previewFailed = Boolean(error) && !impact;

  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={confirmLabel}
      busy={committing}
      confirmDisabled={loading || !impact}
      onConfirm={confirm}
      onCancel={onClose}
    >
      <p>{description}</p>
      {loading ? <p className="muted small">Computing impact…</p> : null}
      {conflict ? (
        <p className="alert warn small">The store changed since the preview. The impact below was recomputed against the current store — review it and confirm again.</p>
      ) : null}
      {impact ? (
        <>
          <p className="small">
            <strong>Impact:</strong> {impact.summary.newlyAllowedCount} newly allowed, {impact.summary.newlyDeniedCount} newly denied.
          </p>
          <ImpactBody impact={impact} />
          <p className="muted small impact-caveat">{impact.previewCaveat}</p>
        </>
      ) : null}
      {error ? <p className={`alert ${danger ? "bad" : "warn"} small`}>{describeError(error).message}</p> : null}
      {previewFailed ? (
        <div className="settings-actions">
          <button className="btn ghost sm" type="button" onClick={() => runPreview()} disabled={loading}>
            Retry preview
          </button>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
