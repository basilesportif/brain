import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLinkIdentity } from "../../lib/queries";
import { RawJson, describeError } from "../../components/common";
import { useDebug } from "../../lib/debug";
import { useCapabilityActions, type PreviewResult } from "./actions";
import { ImpactDialog } from "./ImpactDialog";
import type { CapabilityCatalogResponse, CatalogCapability, CatalogGroup, UserGrantEntry, UserSummary } from "../../api-types";

interface ActionState {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  description: ReactNode;
  selectorKeys?: string[];
  loadPreview: (selectors?: Record<string, string>) => Promise<PreviewResult>;
  onCommit: (expectedStoreHash: string, selectors?: Record<string, string>) => Promise<void>;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function SelectorFields({
  selectorKeys,
  values,
  onChange,
}: {
  selectorKeys: string[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (selectorKeys.length === 0) return <p className="muted small">No registry selector keys for this capability.</p>;
  return (
    <div className="selector-fields">
      {selectorKeys.map((key) => (
        <div className="field selector-field" key={key}>
          <label htmlFor={`selector-${key}`}>{key}</label>
          <input
            id={`selector-${key}`}
            type="text"
            autoComplete="off"
            value={values[key] ?? "*"}
            onChange={(event) => onChange(key, event.target.value)}
            placeholder="*"
          />
        </div>
      ))}
    </div>
  );
}

function IdentitiesSection({ user, onUnlink }: { user: UserSummary; onUnlink: (identityId: string, label: string) => void }) {
  const { debug } = useDebug();
  const link = useLinkIdentity();
  const [provider, setProvider] = useState("telegram");
  const [externalId, setExternalId] = useState("");
  const [teamId, setTeamId] = useState("");

  const submit = () => {
    if (!externalId.trim()) return;
    link.mutate(
      { personId: user.id, provider, externalId: externalId.trim(), teamId: provider === "slack" ? teamId.trim() : undefined },
      {
        onSuccess: () => {
          setExternalId("");
          setTeamId("");
        },
      },
    );
  };

  return (
    <div className="detail-section">
      <h3>Identities</h3>
      {user.identities.length === 0 ? <p className="muted small">No linked identities.</p> : null}
      <div className="identity-rows">
        {user.identities.map((identity) => (
          <div className="identity-row" key={identity.id}>
            <div>
              <span className="badge">{identity.provider}</span> <span className="mono small">{identity.externalId}</span>
              {identity.teamId ? <span className="mono small muted"> · {identity.teamId}</span> : null}
              {identity.linkedAt ? <span className="muted small"> · linked {new Date(identity.linkedAt).toLocaleDateString()}</span> : null}
            </div>
            <button className="btn ghost sm" type="button" onClick={() => onUnlink(identity.id, `${identity.provider} ${identity.externalId}`)}>
              Unlink
            </button>
          </div>
        ))}
      </div>

      <div className="link-form">
        <div className="field">
          <label htmlFor={`link-provider-${user.id}`}>Provider</label>
          <select id={`link-provider-${user.id}`} value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="telegram">telegram</option>
            <option value="slack">slack</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`link-ext-${user.id}`}>External ID</label>
          <input id={`link-ext-${user.id}`} type="text" autoComplete="off" value={externalId} onChange={(event) => setExternalId(event.target.value)} placeholder={provider === "slack" ? "Slack user id (U…)" : "Telegram user id"} />
        </div>
        {provider === "slack" ? (
          <div className="field">
            <label htmlFor={`link-team-${user.id}`}>Team ID</label>
            <input id={`link-team-${user.id}`} type="text" autoComplete="off" value={teamId} onChange={(event) => setTeamId(event.target.value)} placeholder="Slack team id (T…)" />
          </div>
        ) : null}
        <div className="settings-actions">
          <button className="btn" type="button" onClick={submit} disabled={!externalId.trim() || (provider === "slack" && !teamId.trim()) || link.isPending}>
            Link identity
          </button>
        </div>
      </div>
      {link.isError ? <p className="alert bad small">{describeError(link.error).message}</p> : null}
      {debug ? <RawJson title="Raw identity records" data={user.identities} /> : null}
    </div>
  );
}

interface GroupRowProps {
  user: UserSummary;
  group: CatalogGroup;
  onGrantGroup: (group: CatalogGroup) => void;
  onRevokeGroup: (group: CatalogGroup) => void;
  onGrantCapability: (capability: CatalogCapability) => void;
  onRevokeCapability: (capabilityId: string, label: string, grantIds: string[]) => void;
}

// How a capability is currently provided to a person, derived from its grant
// entries: directly revocable (grantKind "capability") vs. only via a broader
// group/bundle grant (read-only, so a single-capability revoke can never delete
// the broader grant — finding 4).
function describeChildGrant(entries: UserGrantEntry[]): { directGrantIds: string[]; via: UserGrantEntry | null } {
  const direct = entries.filter((entry) => entry.grantKind === "capability");
  const broader = entries.find((entry) => entry.grantKind !== "capability") ?? null;
  return { directGrantIds: direct.map((entry) => entry.grantId), via: broader };
}

function GroupRow({ user, group, onGrantGroup, onRevokeGroup, onGrantCapability, onRevokeCapability }: GroupRowProps) {
  const [advanced, setAdvanced] = useState(false);
  const byGroup = user.grants.byGroup.find((entry) => entry.id === group.id);
  const granted = byGroup?.granted ?? false;
  const grantedChild = byGroup?.grantedChildCount ?? 0;
  const syntheticGroup = group.synthetic === true || group.id === "other";
  const grantableChildren = group.children.filter((child) => child.grantable !== false && child.deprecated !== true);
  // The exact grant entries a group revoke would delete (bundles excluded server-
  // side); no directly-revocable entries means the group is provided only via a
  // bundle, so the group Revoke is disabled rather than silently deleting it.
  const groupGrantEntries = byGroup?.grantEntries ?? [];

  return (
    <div className={`group-row ${granted ? "granted" : ""}`}>
      <div className="group-row-main">
        <div className="group-row-meta">
          <strong>{group.label}</strong>
          {group.status === "placeholder" ? <span className="badge">not connected</span> : null}
          <p className="muted small">
            {grantedChild}/{group.childCount} granted · {group.description}
          </p>
        </div>
        <div className="group-row-control">
          {granted ? (
            <button
              className="btn ghost sm danger"
              type="button"
              onClick={() => onRevokeGroup(group)}
              disabled={groupGrantEntries.length === 0}
              title={groupGrantEntries.length === 0 ? "Granted via a bundle; revoke that grant individually" : undefined}
            >
              Revoke group
            </button>
          ) : (
            <button
              className="btn sm"
              type="button"
              onClick={() => onGrantGroup(group)}
              disabled={grantableChildren.length === 0 || syntheticGroup}
              title={syntheticGroup ? "Unregistered store capabilities cannot be granted as a group" : undefined}
            >
              Grant group
            </button>
          )}
        </div>
      </div>
      {group.children.length > 0 ? (
        <details className="details group-children" open={advanced} onToggle={(event) => setAdvanced((event.target as HTMLDetailsElement).open)}>
          <summary>Child capabilities · Advanced: edit individual grants</summary>
          <div className="group-children-body">
            {group.children.map((child) => {
              const childSummary = byGroup?.children.find((entry) => entry.capabilityId === child.id);
              const { directGrantIds, via } = describeChildGrant(childSummary?.entries ?? []);
              const childGranted = childSummary?.granted ?? false;
              return (
                <div className="cap-advanced-row" key={child.id}>
                  <span className="cap-advanced-label">
                    <span className="cap-title">
                      <span className="mono small">{child.id}</span>
                      {child.provenance !== "registry" ? <span className="badge">{child.provenance}</span> : null}
                      {child.riskTier ? <span className={`badge risk-${child.riskTier}`}>{child.riskTier}</span> : null}
                      {child.deprecated ? <span className="badge warn">deprecated</span> : null}
                    </span>
                    {child.description ? <span className="muted small">{child.description}</span> : <span className="muted small">{child.label}</span>}
                  </span>
                  <span className="cap-advanced-actions">
                    {!childGranted ? (
                      <button
                        className="btn ghost sm"
                        type="button"
                        onClick={() => onGrantCapability(child)}
                        disabled={syntheticGroup || child.grantable === false || child.deprecated === true}
                        title={child.deprecated ? "Deprecated capabilities cannot be granted" : syntheticGroup ? "Unregistered store capabilities cannot be granted from the catalog" : undefined}
                      >
                        Grant
                      </button>
                    ) : directGrantIds.length > 0 ? (
                      <button className="btn ghost sm danger" type="button" onClick={() => onRevokeCapability(child.id, child.label, directGrantIds)}>
                        Revoke
                      </button>
                    ) : (
                      <span className="muted small">granted via {via ? `${via.grantKind} ${via.capabilityId}` : "a broader grant"}</span>
                    )}
                  </span>
                </div>
              );
            })}
            <p className="muted small">Revoke is offered only on directly-granted capabilities. Each action shows its exact impact preview before committing.</p>
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function UserDetail({ user, catalog }: { user: UserSummary; catalog: CapabilityCatalogResponse }) {
  const actions = useCapabilityActions(user);
  const [action, setAction] = useState<ActionState | null>(null);
  const [selectorDraft, setSelectorDraft] = useState<Record<string, string>>({});

  const selectorKeys = action?.selectorKeys ?? [];
  const normalizedSelectors = selectorKeys.length > 0
    ? Object.fromEntries(selectorKeys.map((key) => [key, selectorDraft[key]?.trim() || "*"]))
    : undefined;
  const previewKey = normalizedSelectors ? JSON.stringify(normalizedSelectors) : "";
  const debouncedPreviewKey = useDebouncedValue(previewKey, 400);
  const debouncedSelectors = useMemo(
    () => (debouncedPreviewKey ? JSON.parse(debouncedPreviewKey) as Record<string, string> : undefined),
    [debouncedPreviewKey],
  );
  const previewRequestPending = previewKey !== debouncedPreviewKey;
  const loadDialogPreview = useCallback(async () => {
    if (!action) throw new Error("No action selected.");
    return action.loadPreview(debouncedSelectors);
  }, [action, debouncedSelectors]);
  const commitDialogAction = useCallback(async (hash: string) => {
    if (!action) throw new Error("No action selected.");
    return action.onCommit(hash, debouncedSelectors);
  }, [action, debouncedSelectors]);

  const onGrantGroup = (group: CatalogGroup) => {
    setAction({
      title: `Grant ${group.label}?`,
      confirmLabel: "Grant group",
      description: (
        <>
          Grant group <strong>{group.label}</strong> to <strong>{user.displayName}</strong>.
        </>
      ),
      loadPreview: () => actions.previewGrant(group.id, true),
      onCommit: (hash) => actions.commitGrant(group.id, true, hash),
    });
  };

  const onRevokeGroup = (group: CatalogGroup) => {
    const byGroup = user.grants.byGroup.find((entry) => entry.id === group.id);
    const grantIds = (byGroup?.grantEntries ?? []).map((entry) => entry.grantId);
    setAction({
      title: `Revoke ${group.label}?`,
      confirmLabel: "Revoke group",
      danger: true,
      description: (
        <>
          Revoke group <strong>{group.label}</strong> from <strong>{user.displayName}</strong>. This denies these operations at the next
          side-effect check.
        </>
      ),
      // A5: if the group is granted but carries no revocable grant entries the
      // state is inconsistent (or it is provided only via a bundle) — surface a
      // blocking error, never an empty "no changes" confirm.
      loadPreview: async () => {
        if (grantIds.length === 0) {
          throw new Error(`No revocable grant entries for ${group.label}. It may be granted via a bundle — revoke that grant individually in Debug.`);
        }
        return actions.previewRevoke(grantIds);
      },
      onCommit: (hash) => actions.commitRevoke(grantIds, hash),
    });
  };

  const onGrantCapability = (capability: CatalogCapability) => {
    const initialSelectors = Object.fromEntries(capability.selectorKeys.map((key) => [key, "*"]));
    setSelectorDraft(initialSelectors);
    setAction({
      title: `Grant ${capability.id}?`,
      confirmLabel: "Grant capability",
      description: (
        <>
          Grant <span className="mono">{capability.id}</span> to <strong>{user.displayName}</strong>.
        </>
      ),
      selectorKeys: capability.selectorKeys,
      loadPreview: (selectors) => actions.previewGrant(capability.id, false, selectors),
      onCommit: (hash, selectors) => actions.commitGrant(capability.id, false, hash, selectors),
    });
  };

  const onRevokeCapability = (capabilityId: string, label: string, grantIds: string[]) => {
    setAction({
      title: `Revoke ${label}?`,
      confirmLabel: "Revoke capability",
      danger: true,
      description: (
        <>
          Revoke <span className="mono">{capabilityId}</span> from <strong>{user.displayName}</strong>.
        </>
      ),
      loadPreview: async () => {
        if (grantIds.length === 0) {
          throw new Error(`No revocable grant entries for ${capabilityId}.`);
        }
        return actions.previewRevoke(grantIds);
      },
      onCommit: (hash) => actions.commitRevoke(grantIds, hash),
    });
  };

  const onUnlink = (identityId: string, label: string) => {
    setAction({
      title: "Unlink identity?",
      confirmLabel: "Unlink",
      danger: true,
      description: (
        <>
          Unlink <span className="mono">{label}</span> from <strong>{user.displayName}</strong>. This denies that surface for the person.
        </>
      ),
      loadPreview: () => actions.previewUnlink(identityId),
      onCommit: (hash) => actions.commitUnlink(identityId, hash),
    });
  };

  return (
    <div className="user-detail">
      <IdentitiesSection user={user} onUnlink={onUnlink} />

      <div className="detail-section">
        <h3>Capabilities</h3>
        <p className="muted small">Grant or revoke broad capability groups. Every change shows its server-computed impact before it commits.</p>
        <div className="group-rows">
          {catalog.groups.map((group) => (
            <GroupRow
              key={group.id}
              user={user}
              group={group}
              onGrantGroup={onGrantGroup}
              onRevokeGroup={onRevokeGroup}
              onGrantCapability={onGrantCapability}
              onRevokeCapability={onRevokeCapability}
            />
          ))}
        </div>
      </div>

      {action ? (
        <ImpactDialog
          open
          title={action.title}
          confirmLabel={action.confirmLabel}
          danger={action.danger}
          description={
            <>
              {action.description}
              {selectorKeys.length > 0 ? (
                <SelectorFields
                  selectorKeys={selectorKeys}
                  values={selectorDraft}
                  onChange={(key, value) => setSelectorDraft((current) => ({ ...current, [key]: value }))}
                />
              ) : null}
            </>
          }
          previewKey={debouncedPreviewKey}
          requestPending={previewRequestPending}
          loadPreview={loadDialogPreview}
          onCommit={commitDialogAction}
          onClose={() => {
            setAction(null);
            setSelectorDraft({});
          }}
        />
      ) : null}
    </div>
  );
}
