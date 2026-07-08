import { useEffect, useMemo, useState } from "react";
import { useCatalog, useCreatePerson, useOnboardPerson, usePendingPeople, useUsers } from "../lib/queries";
import { ErrorNotice, Loading, RawJson, describeError } from "../components/common";
import { UserDetail } from "./users/UserDetail";
import { ImpactDialog } from "./users/ImpactDialog";
import type { CapabilityCatalogResponse, CatalogCapability, CatalogGroup, OnboardPersonPayload, PendingPersonSummary, UserSummary } from "../api-types";

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

const BASELINE_GRANTS = ["slack.event.receive", "assistant.run", "output.text.send"] as const;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function pendingLabel(person: PendingPersonSummary): string {
  return person.displayName?.trim() || person.userId;
}

function catalogCapability(catalog: CapabilityCatalogResponse, capabilityId: string): CatalogCapability | undefined {
  for (const group of catalog.groups) {
    const capability = group.children.find((child) => child.id === capabilityId);
    if (capability) return capability;
  }
  return undefined;
}

function registrySelectorsFor(catalog: CapabilityCatalogResponse, capabilityId: string, desired: Record<string, string>): Record<string, string> | undefined {
  const capability = catalogCapability(catalog, capabilityId);
  if (!capability || capability.provenance !== "registry") return undefined;
  const selectors = Object.fromEntries(Object.entries(desired).filter(([key]) => capability.selectorKeys.includes(key)));
  return Object.keys(selectors).length > 0 ? selectors : undefined;
}

function grantPayload(catalog: CapabilityCatalogResponse, person: PendingPersonSummary, includeBaseline: boolean, groups: string[]): OnboardPersonPayload["grants"] {
  const baseline = includeBaseline
    ? [
        { capabilityId: "slack.event.receive", selectors: registrySelectorsFor(catalog, "slack.event.receive", { teamId: person.teamId }) },
        { capabilityId: "assistant.run", selectors: registrySelectorsFor(catalog, "assistant.run", { teamId: person.teamId }) },
        { capabilityId: "output.text.send", selectors: registrySelectorsFor(catalog, "output.text.send", { surfaceKind: "slack", teamId: person.teamId }) },
      ].map((grant) => grant.selectors ? grant : { capabilityId: grant.capabilityId })
    : [];
  return [...baseline, ...groups.map((groupId) => ({ groupId }))];
}

function grantableOptionalGroups(catalog: CapabilityCatalogResponse): Array<Pick<CatalogGroup, "id" | "label">> {
  return catalog.groups
    .filter((group) => group.synthetic !== true && group.id !== "other")
    .filter((group) => group.children.some((child) => child.grantable !== false && child.deprecated !== true && child.provenance !== "store"))
    .map((group) => ({ id: group.id, label: group.label }));
}

function OnboardPendingDialog({ person, catalog, onClose }: { person: PendingPersonSummary; catalog: CapabilityCatalogResponse; onClose: () => void }) {
  const onboard = useOnboardPerson();
  const [displayName, setDisplayName] = useState(pendingLabel(person));
  const [includeBaseline, setIncludeBaseline] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);

  const optionalGroups = useMemo(() => grantableOptionalGroups(catalog), [catalog]);
  const selectedGroups = useMemo(() => optionalGroups.map((group) => group.id).filter((groupId) => groups.includes(groupId)), [groups, optionalGroups]);
  const grants = useMemo(() => grantPayload(catalog, person, includeBaseline, selectedGroups), [catalog, includeBaseline, person, selectedGroups]);
  const identity = { provider: "slack" as const, externalId: person.userId, teamId: person.teamId };
  const request: OnboardPersonPayload = useMemo(() => ({ displayName: displayName.trim(), identity, grants }), [displayName, identity, grants]);
  const requestKey = useMemo(() => JSON.stringify(request), [request]);
  const debouncedRequestKey = useDebouncedValue(requestKey, 400);
  const debouncedRequest = useMemo(() => JSON.parse(debouncedRequestKey) as OnboardPersonPayload, [debouncedRequestKey]);
  const previewRequestPending = requestKey !== debouncedRequestKey;
  const toggleGroup = (groupId: string) => {
    setGroups((current) => current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]);
  };
  const loadPreview = async () => {
    if (!debouncedRequest.displayName) throw new Error("Display name is required.");
    if (debouncedRequest.grants.length === 0) throw new Error("Select at least one grant.");
    const result = await onboard.mutateAsync({ ...debouncedRequest, preview: true });
    return { impact: result.impact, storeHash: result.storeHash };
  };
  const commit = async (expectedStoreHash: string) => {
    await onboard.mutateAsync({ ...debouncedRequest, expectedStoreHash });
  };

  return (
    <ImpactDialog
      open
      title="Onboard Slack person?"
      confirmLabel="Onboard"
      previewKey={debouncedRequestKey}
      requestPending={onboard.isPending || previewRequestPending}
      loadPreview={loadPreview}
      onCommit={commit}
      onClose={onClose}
      description={
        <>
          <div className="field">
            <label htmlFor={`onboard-name-${person.teamId}-${person.userId}`}>Display name</label>
            <input id={`onboard-name-${person.teamId}-${person.userId}`} type="text" autoComplete="off" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </div>
          <p className="muted small">
            Identity <span className="mono">{person.userId}@{person.teamId}</span>
          </p>
          <div className="onboard-grants">
            <label>
              <input type="checkbox" checked={includeBaseline} onChange={(event) => setIncludeBaseline(event.target.checked)} />
              <span>Slack conversation baseline</span>
            </label>
            <p className="muted small mono">{BASELINE_GRANTS.join(" + ")}</p>
            <div className="onboard-group-checks">
              {optionalGroups.map((group) => (
                <label key={group.id}>
                  <input type="checkbox" checked={selectedGroups.includes(group.id)} onChange={() => toggleGroup(group.id)} />
                  <span>{group.label}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      }
    />
  );
}

function PendingPeoplePanel({ catalog }: { catalog: CapabilityCatalogResponse }) {
  const pending = usePendingPeople();
  const [selected, setSelected] = useState<PendingPersonSummary | null>(null);

  if (pending.isLoading) return <p className="muted small">Loading pending Slack people...</p>;
  if (pending.isError) {
    return (
      <div className="alert bad">
        <strong>Pending Slack people unavailable</strong>
        <p className="small">{describeError(pending.error).message}</p>
        <button className="btn ghost sm" type="button" onClick={() => pending.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const people = pending.data!.people;
  return (
    <section className="pending-people">
      <div className="pending-people-head">
        <div>
          <h2>Pending Slack people</h2>
          <p className="muted small">{people.length === 0 ? "No denied unlinked Slack actors in the recent decision tail." : `${people.length} Slack actor${people.length === 1 ? "" : "s"} awaiting onboarding.`}</p>
        </div>
        <span className="mono small muted">store {pending.data!.storeHash.slice(0, 8)}</span>
      </div>
      {people.length > 0 ? (
        <div className="pending-list">
          {people.map((person) => (
            <div className="pending-row" key={person.actorId}>
              <div className="pending-person-main">
                <strong>{pendingLabel(person)}</strong>
                <span className="mono small">{person.userId}@{person.teamId}</span>
              </div>
              <span className="muted small">{person.channelIds.length} channel{person.channelIds.length === 1 ? "" : "s"}</span>
              <span className="muted small">{person.lastReason}</span>
              <span className="muted small">last {new Date(person.lastSeen).toLocaleString()}</span>
              <span className="muted small">{person.count} denial{person.count === 1 ? "" : "s"}</span>
              <button className="btn sm" type="button" onClick={() => setSelected(person)}>
                Onboard
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {selected ? <OnboardPendingDialog key={selected.actorId} person={selected} catalog={catalog} onClose={() => setSelected(null)} /> : null}
    </section>
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
      <PendingPeoplePanel catalog={catalog.data!} />

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
