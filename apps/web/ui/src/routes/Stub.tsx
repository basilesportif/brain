// Placeholder routes for Setup / Users / Operations. These land in slice 4b of
// the redesign; for now they exist so navigation and deep links never 404, and
// they direct the operator to the legacy console for the real workflow.

export function Stub({ title }: { title: string }) {
  return (
    <div className="route stub">
      <div className="route-head">
        <h1>{title}</h1>
      </div>
      <div className="alert">
        <strong>Coming in this redesign</strong>
        <p className="muted small">
          {title} is not part of this slice yet. Use the legacy console at <a href="/admin">/admin</a> for this workflow until it lands.
        </p>
      </div>
    </div>
  );
}
