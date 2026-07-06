import { Link } from "react-router-dom";

// Shared "restart required" note shown after a settings write (plan §5.3),
// linking to Operations where the restart is performed.
export function RestartNote({ writtenKeys }: { writtenKeys: string[] }) {
  return (
    <div className="alert warn" role="status">
      <strong>Restart required</strong>
      <p className="small">
        Wrote {writtenKeys.length > 0 ? <span className="mono">{writtenKeys.join(", ")}</span> : "settings"}. Changes take effect after a codex-chat
        restart. <Link to="/operations">Open Operations</Link> to restart.
      </p>
    </div>
  );
}
