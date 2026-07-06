import { useState } from "react";
import { useCatalog, useCreatePerson, useUsers } from "../lib/queries";
import { ErrorNotice, Loading, RawJson, describeError } from "../components/common";
import { UserDetail } from "./users/UserDetail";
import type { CapabilityCatalogResponse, UserSummary } from "../api-types";

// Users (plan §5.4): live authorization management. Store problems render as
// blocking errors from server state — never a silent degrade. The catalog and
// user summaries come entirely from the API; nothing is hardcoded.

function IdentityChips({ user }: { user: UserSummary }) {
  if (user.identities.length === 0) return <span className="muted small">no identities</span>;
  return (
    <span className="chips">
      {user.identities.map((identity) => (
        <span className="chip" key={identity.id}>
          {identity.provider} ✓
        </span>
      ))}
    </span>
  );
}

function UserRow({ user, catalog }: { user: UserSummary; catalog: CapabilityCatalogResponse }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`user-card ${open ? "open" : ""}`}>
      <button className="user-card-head" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="user-card-name">
          <strong>{user.displayName}</strong>
          <span className={`badge ${user.status === "active" ? "ok" : ""}`}>{user.status}</span>
        </span>
        <IdentityChips user={user} />
        <span className="muted small">
          {user.grants.grantedGroupCount}/{user.grants.totalGroupCount} groups
        </span>
        <span className="user-card-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? <UserDetail user={user} catalog={catalog} /> : null}
    </div>
  );
}

function AddUser() {
  const create = useCreatePerson();
  const [name, setName] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    create.mutate(name.trim(), { onSuccess: () => setName("") });
  };
  return (
    <div className="add-user">
      <input type="text" autoComplete="off" placeholder="New user display name" value={name} onChange={(event) => setName(event.target.value)} />
      <button className="btn primary" type="button" onClick={submit} disabled={!name.trim() || create.isPending}>
        {create.isPending ? "Adding…" : "Add user"}
      </button>
      {create.isError ? <p className="alert bad small">{describeError(create.error).message}</p> : null}
    </div>
  );
}

export function Users() {
  const users = useUsers();
  const catalog = useCatalog();

  if (users.isLoading || catalog.isLoading) return <Loading label="Loading users…" />;
  // A store problem is a blocking error (the assistant is fail-closed) — surface
  // it, never render a partial/degraded people list.
  if (users.isError) return <ErrorNotice error={users.error} onRetry={() => users.refetch()} />;
  if (catalog.isError) return <ErrorNotice error={catalog.error} onRetry={() => catalog.refetch()} />;

  const people = users.data!.people;
  // Each endpoint derives from one registry snapshot, but two independent HTTP
  // requests can straddle a TTL/recovery boundary. Surface that accepted race so
  // the operator can refresh instead of silently mixing vocabularies.
  const registryMismatch =
    users.data!.registryAvailable !== catalog.data!.registryAvailable ||
    users.data!.registryVersion !== catalog.data!.registryVersion ||
    users.data!.registryCapabilityCount !== catalog.data!.registryCapabilityCount;

  return (
    <div className="route users">
      <div className="route-head">
        <h1>Users</h1>
        <p className="muted">People, identities, and live capability grants. Every change takes effect at codex-chat's next side-effect check.</p>
        <p className="muted small registry-line">
          Registry: {catalog.data!.registryAvailable ? `v${catalog.data!.registryVersion} · ${catalog.data!.registryCapabilityCount} capabilities · reachable` : "unreachable · showing store-derived fallback"}
          {registryMismatch ? " · refresh recommended" : ""}
        </p>
      </div>

      <AddUser />

      {people.length === 0 ? (
        <p className="muted">No people yet. Add a user to link identities and grant capability groups.</p>
      ) : (
        <div className="user-list">
          {people.map((user) => (
            <UserRow key={user.id} user={user} catalog={catalog.data!} />
          ))}
        </div>
      )}

      {users.data!.systemSubjects.length > 0 ? (
        <details className="details">
          <summary>System subjects ({users.data!.systemSubjects.length})</summary>
          <ul className="cap-list">
            {users.data!.systemSubjects.map((subject) => (
              <li key={subject.id}>
                <span className="mono small">{subject.id}</span>
                <span className="muted small"> — {subject.grants.inForce} in force</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <RawJson title="Raw /users JSON" data={users.data} />
      <RawJson title="Raw /capabilities/catalog JSON" data={catalog.data} />
    </div>
  );
}
