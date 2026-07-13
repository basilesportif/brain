// Capability catalog: the canonical group -> child-capability vocabulary the
// admin UI renders. Groups are DATA served by GET /capabilities/catalog, never
// hardcoded client-side (plan §2.3, §5.4).
//
// The group taxonomy is a Brain-owned catalog *definition*; the child
// capability ids are the real ids codex-chat's authorizer evaluates (see the
// live store's grant/bundle vocabulary). `buildCapabilityCatalog` cross-checks
// the definition against a loaded store so every id the store actually grants
// is surfaced under a human group — anything unmapped falls into an explicit
// "other" group rather than being silently hidden.
//
// Plan §2.3 names Projects, CRM, Calendar, Slack, Todos, Finance, Health, and
// Capability-admin as the canonical group list; Finance/Health are
// not-yet-connected placeholder groups that stay in the catalog as ordinary
// empty groups. The remaining groups map codex-chat's runtime/operational
// capability ids (output, directive, subagents, service, employees, events,
// assistant, runtime) into human groups so the store vocabulary is fully
// covered.

import type { CapabilityStore } from "./capability-store.js";
import type { CodexChatCapabilityRegistryEntry } from "./codex-chat-ipc.js";

export interface CatalogCapabilityDefinition {
  id: string;
  label: string;
  description?: string;
  selectorKeys?: string[];
  riskTier?: "low" | "medium" | "high";
  deprecated?: boolean;
  grantable?: boolean;
  provenance?: "registry" | "curated" | "store";
}

export interface CatalogGroupDefinition {
  id: string;
  label: string;
  description: string;
  status: "active" | "placeholder";
  synthetic?: boolean;
  capabilities: CatalogCapabilityDefinition[];
}

export interface CatalogCapability {
  id: string;
  label: string;
  present: boolean;
  description?: string;
  selectorKeys: string[];
  riskTier?: "low" | "medium" | "high";
  deprecated?: boolean;
  grantable: boolean;
  registryKnown: boolean;
  provenance: "registry" | "curated" | "store";
}

export interface CatalogGroup {
  id: string;
  label: string;
  description: string;
  status: "active" | "placeholder";
  synthetic?: boolean;
  childCount: number;
  presentChildCount: number;
  children: CatalogCapability[];
}

export interface CapabilityCatalogResponse {
  schemaVersion: 1;
  storeAvailable: boolean;
  registryAvailable: boolean;
  registryVersion: number | null;
  registryCapabilityCount: number;
  groups: CatalogGroup[];
  counts: {
    groups: number;
    capabilities: number;
    activeGroups: number;
    placeholderGroups: number;
    uncategorized: number;
  };
}

export interface CapabilityCatalogRegistrySource {
  available: boolean;
  registryVersion: number | null;
  capabilities: CodexChatCapabilityRegistryEntry[];
}

function cap(id: string, label: string): CatalogCapabilityDefinition {
  return { id, label };
}

// Ordered so the plan §2.3 groups render first, then operational groups.
export const CAPABILITY_GROUP_DEFINITIONS: CatalogGroupDefinition[] = [
  {
    id: "projects",
    label: "Projects",
    description: "Project context, files, tasks, and published artifacts.",
    status: "active",
    capabilities: [
      cap("projects.read", "Read project context"),
      cap("projects.write", "Write project state"),
      cap("projects.files.write", "Write project files"),
      cap("projects.tasks.write", "Write project tasks"),
      cap("projects.artifacts.publish", "Publish project artifacts"),
    ],
  },
  {
    id: "crm",
    label: "CRM",
    description: "Contact and relationship data.",
    status: "active",
    capabilities: [
      cap("crm.contact.read", "Read contacts"),
      cap("crm.contact.write", "Write contacts"),
      cap("crm.note.write", "Write CRM notes"),
    ],
  },
  {
    id: "calendar",
    label: "Calendar",
    description: "Availability and calendar events.",
    status: "active",
    capabilities: [
      cap("calendar.availability.read", "Read availability"),
      cap("calendar.event.read", "Read events"),
      cap("calendar.event.write", "Write events"),
    ],
  },
  {
    id: "slack",
    label: "Slack",
    description: "Slack source, channel, and thread reads and posts.",
    status: "active",
    capabilities: [
      cap("slack.source.read", "Read source conversation"),
      cap("slack.channel.read", "Read channel context"),
      cap("slack.thread.read", "Read thread context"),
      cap("slack.history.read", "Read Slack history"),
      cap("slack.channel.post", "Post to channel"),
      cap("slack.thread.reply", "Reply in thread"),
    ],
  },
  {
    id: "todos",
    label: "Todos",
    description: "Todo lists and items.",
    status: "active",
    capabilities: [
      cap("todos.item.read", "Read todos"),
      cap("todos.item.write", "Write todos"),
      cap("todos.list.manage", "Manage todo lists"),
    ],
  },
  {
    id: "finance",
    label: "Finance",
    description: "High-sensitivity finance capabilities. Not connected yet.",
    status: "placeholder",
    capabilities: [],
  },
  {
    id: "health",
    label: "Health",
    description: "High-sensitivity health capabilities. Not connected yet.",
    status: "placeholder",
    capabilities: [],
  },
  {
    id: "capability-admin",
    label: "Capability administration",
    description: "Catalog, grant, and audit operations for managing capabilities.",
    status: "active",
    capabilities: [
      cap("capability.catalog.read", "Read capability catalog"),
      cap("capability.grant.propose", "Propose grants"),
      cap("audit.capability.read", "Read capability audit"),
    ],
  },
  {
    id: "output",
    label: "Messaging & output",
    description: "Assistant outputs sent to a surface (text, image, document, reactions).",
    status: "active",
    capabilities: [
      cap("output", "Send any output (group)"),
      cap("output.text.send", "Send text"),
      cap("output.image.send", "Send image"),
      cap("output.document.send", "Send document"),
      cap("output.reaction.add", "Add reaction"),
    ],
  },
  {
    id: "assistant",
    label: "Assistant runtime",
    description: "Run the assistant and read run context.",
    status: "active",
    capabilities: [
      cap("assistant.run", "Run the assistant"),
      cap("assistant.context.read", "Read run context"),
    ],
  },
  {
    id: "subagents",
    label: "Subagents",
    description: "Dispatch and control subagents.",
    status: "active",
    capabilities: [
      cap("subagents.control", "Control subagents (group)"),
      cap("subagents.control.cancel", "Cancel a subagent"),
      cap("subagents.control.steer", "Steer a subagent"),
      cap("subagents.dispatch", "Dispatch a subagent"),
      cap("subagents.backend.set", "Set subagent backend"),
      cap("subagents.result.deliver", "Deliver subagent result"),
    ],
  },
  {
    id: "directive",
    label: "Directives",
    description: "Execute operator directives.",
    status: "active",
    capabilities: [cap("directive", "Execute directives (group)")],
  },
  {
    id: "service",
    label: "Service control",
    description: "Runtime service commands and deploys.",
    status: "active",
    capabilities: [
      cap("service.command", "Service commands (group)"),
      cap("service.deploy", "Deploy the service"),
    ],
  },
  {
    id: "runtime",
    label: "Runtime administration",
    description: "Runtime administration and status.",
    status: "active",
    capabilities: [
      cap("runtime.admin", "Administer the runtime"),
      cap("runtime.status.read", "Read runtime status"),
    ],
  },
  {
    id: "employees",
    label: "Employees",
    description: "Manage assistant employees/personas.",
    status: "active",
    capabilities: [cap("employees.manage", "Manage employees (group)")],
  },
  {
    id: "events",
    label: "Event intake",
    description: "Inbound event receipt and internal callbacks.",
    status: "active",
    capabilities: [
      cap("telegram.event.receive", "Receive Telegram events"),
      cap("slack.event.receive", "Receive Slack events"),
      cap("system.callback.enqueue", "Enqueue system callbacks"),
    ],
  },
];

// Per-group default broad resource selector templates, mirroring the live seed
// conventions. When an admin grant supplies no explicit selectors, the grant is
// stored with the template for the capability's group so it actually matches the
// concrete resource keys the runtime sends (codex-chat's selectorsMatch requires
// every concrete key to be covered — an empty selector set matches nothing).
// Groups whose runtime resource keys are not yet known fall back to `{scope:"*"}`.
export const CAPABILITY_GROUP_DEFAULT_SELECTORS: Record<string, Record<string, string>> = {
  projects: { projectId: "*", repoAlias: "*", resourceScope: "*" },
  crm: { scope: "*", contactId: "*", businessId: "*", correspondenceId: "*" },
  calendar: { scope: "*", calendarId: "*" },
  slack: { scope: "*", teamId: "*", channelId: "*", threadTs: "*" },
  todos: { scope: "*", listId: "*" },
  events: runtimeSelectorDefaults(),
  assistant: runtimeSelectorDefaults(),
  output: runtimeSelectorDefaults(),
};

const DEFAULT_SELECTOR_FALLBACK: Record<string, string> = { scope: "*" };

function runtimeSelectorDefaults(): Record<string, string> {
  return Object.fromEntries([
    "source",
    "surfaceKind",
    "teamId",
    "channelId",
    "threadTs",
    "messageTs",
    "chatId",
    "messageId",
    "conversationSessionId",
    "actorId",
    "targetId",
    "targetPolicy",
    "outputType",
  ].map((key) => [key, "*"]));
}

function labelFromId(id: string): string {
  return id
    .replace(/[_-]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || id;
}

function fallbackFamilyForCapabilityId(capabilityId: string): string {
  const legacyGroup = groupIdForCapability(capabilityId, CAPABILITY_GROUP_DEFINITIONS);
  if (legacyGroup) return legacyGroup;
  return capabilityId.split(".")[0] || "store";
}

function selectorKeysForCuratedGroup(groupId: string): string[] {
  return Object.keys(CAPABILITY_GROUP_DEFAULT_SELECTORS[groupId] ?? DEFAULT_SELECTOR_FALLBACK);
}

export function curatedSelectorKeysForCapability(capabilityId: string): string[] {
  const groupId = groupIdForCapability(capabilityId, CAPABILITY_GROUP_DEFINITIONS);
  return groupId ? selectorKeysForCuratedGroup(groupId) : [];
}

function curatedDefinitions(): CatalogGroupDefinition[] {
  return CAPABILITY_GROUP_DEFINITIONS.map((definition) => {
    const selectorKeys = selectorKeysForCuratedGroup(definition.id);
    return {
      ...definition,
      capabilities: definition.capabilities.map((child) => ({
        ...child,
        selectorKeys,
        grantable: true,
        provenance: "curated" as const,
      })),
    };
  });
}

function registryDefinitions(registry: CapabilityCatalogRegistrySource): CatalogGroupDefinition[] {
  const groups = new Map<string, CatalogGroupDefinition>();
  for (const entry of registry.capabilities) {
    let group = groups.get(entry.family);
    if (!group) {
      const label = labelFromId(entry.family);
      group = {
        id: entry.family,
        label,
        description: `${label} capabilities from the codex-chat registry.`,
        status: "active",
        capabilities: [],
      };
      groups.set(entry.family, group);
    }
    group.capabilities.push({
      id: entry.id,
      label: entry.id,
      description: entry.description,
      selectorKeys: entry.selectorKeys,
      riskTier: entry.riskTier,
      deprecated: entry.deprecated,
      grantable: entry.deprecated !== true,
      provenance: "registry",
    });
  }
  return [...groups.values()];
}

function mergeGroupDefinition(groups: CatalogGroupDefinition[], incoming: CatalogGroupDefinition): void {
  const existing = groups.find((group) => group.id === incoming.id);
  if (!existing) {
    groups.push({ ...incoming, capabilities: incoming.capabilities.map((child) => ({ ...child })) });
    return;
  }
  const existingIds = new Set(existing.capabilities.map((child) => child.id));
  for (const child of incoming.capabilities) {
    if (existingIds.has(child.id)) continue;
    existing.capabilities.push({ ...child });
    existingIds.add(child.id);
  }
}

function appendStoreOnlyCapability(groups: CatalogGroupDefinition[], capabilityId: string, selectorKeys: string[]): void {
  const family = fallbackFamilyForCapabilityId(capabilityId);
  const curatedGroup = CAPABILITY_GROUP_DEFINITIONS.find((definition) => definition.id === family);
  const groupId = curatedGroup ? family : "other";
  let group = groups.find((candidate) => candidate.id === groupId);
  if (!group) {
    group = curatedGroup
      ? { ...curatedGroup, capabilities: [] }
      : {
          id: "other",
          label: "Other",
          description: "Capability ids granted in the store but absent from both the codex-chat registry and Brain curated vocabulary.",
          status: "active",
          synthetic: true,
          capabilities: [],
        };
    groups.push(group);
  }
  if (group.capabilities.some((child) => child.id === capabilityId)) return;
  group.capabilities.push({
    id: capabilityId,
    label: capabilityId,
    selectorKeys,
    grantable: true,
    provenance: "store",
  });
}

function storeSelectorKeys(store: CapabilityStore | undefined, capabilityId: string): string[] {
  const keys = new Set<string>();
  for (const grant of store?.grants ?? []) {
    if (grant.capabilityId !== capabilityId) continue;
    for (const key of Object.keys((grant.resource?.selectors ?? {}) as Record<string, unknown>)) keys.add(key);
  }
  return [...keys].sort();
}

export function catalogDefinitionsForSource(
  store: CapabilityStore | undefined,
  registry: CapabilityCatalogRegistrySource,
): CatalogGroupDefinition[] {
  const vocabulary = storeCapabilityVocabulary(store);
  const definitions: CatalogGroupDefinition[] = [];
  const registryIds = new Set(registry.capabilities.map((entry) => entry.id));
  const curatedIds = mappedCatalogCapabilityIds(CAPABILITY_GROUP_DEFINITIONS);

  if (registry.available) {
    for (const definition of registryDefinitions(registry)) mergeGroupDefinition(definitions, definition);
  }
  for (const definition of curatedDefinitions()) mergeGroupDefinition(definitions, definition);

  for (const id of [...vocabulary].sort()) {
    if (registryIds.has(id) || curatedIds.has(id)) continue;
    appendStoreOnlyCapability(definitions, id, storeSelectorKeys(store, id));
  }

  return definitions;
}

// The catalog group id a capability id belongs to (its own id when it is itself
// a group id, otherwise the group whose children include it).
export function groupIdForCapability(capabilityId: string, definitions: CatalogGroupDefinition[] = CAPABILITY_GROUP_DEFINITIONS): string | undefined {
  for (const definition of definitions) {
    if (definition.id === capabilityId) return definition.id;
    if (definition.capabilities.some((child) => child.id === capabilityId)) return definition.id;
  }
  return undefined;
}

// The default broad selector template for a capability id (fresh object per call
// so callers can store it without sharing references).
export function defaultSelectorsForCapability(capabilityId: string, registryEntry?: Pick<CodexChatCapabilityRegistryEntry, "selectorKeys">): Record<string, string> {
  if (registryEntry) return Object.fromEntries(registryEntry.selectorKeys.map((key) => [key, "*"]));
  const groupId = groupIdForCapability(capabilityId);
  const template = groupId ? CAPABILITY_GROUP_DEFAULT_SELECTORS[groupId] : undefined;
  return { ...(template ?? DEFAULT_SELECTOR_FALLBACK) };
}

// The set of ids the catalog definition "maps": every group id (group-level
// grants and bundle groupIds reference these, e.g. "projects") plus every child
// capability id. Shared by the catalog and the per-user summary so both agree on
// which store ids fall into the explicit "other" bucket.
export function mappedCatalogCapabilityIds(definitions: CatalogGroupDefinition[] = CAPABILITY_GROUP_DEFINITIONS): Set<string> {
  const mapped = new Set<string>();
  for (const definition of definitions) {
    mapped.add(definition.id);
    for (const child of definition.capabilities) mapped.add(child.id);
  }
  return mapped;
}

// All capability ids the store references (grant capabilityIds + bundle
// includes). This is the "grant/bundle vocabulary" the catalog is derived
// against.
export function storeCapabilityVocabulary(store: CapabilityStore | undefined): Set<string> {
  const ids = new Set<string>();
  if (!store) return ids;
  for (const grant of store.grants ?? []) if (grant.capabilityId) ids.add(grant.capabilityId);
  for (const bundle of store.grantBundles ?? []) {
    for (const id of bundle.includes?.capabilityIds ?? []) ids.add(id);
    for (const id of bundle.includes?.groupIds ?? []) ids.add(id);
  }
  return ids;
}

export function buildCapabilityCatalog(
  store: CapabilityStore | undefined,
  registry: CapabilityCatalogRegistrySource = { available: false, registryVersion: null, capabilities: [] },
): CapabilityCatalogResponse {
  const vocabulary = storeCapabilityVocabulary(store);
  const definitions = catalogDefinitionsForSource(store, registry);
  const registryIds = new Set(registry.capabilities.map((entry) => entry.id));
  const groups: CatalogGroup[] = definitions.map((definition) => {
    const children = definition.capabilities.map((child) => {
      const registryKnown = registryIds.has(child.id);
      return {
        id: child.id,
        label: child.label,
        present: vocabulary.has(child.id),
        selectorKeys: child.selectorKeys ?? [],
        grantable: child.grantable ?? !child.deprecated,
        registryKnown,
        provenance: child.provenance ?? (registryKnown ? "registry" : "curated"),
        ...(child.description ? { description: child.description } : {}),
        ...(child.riskTier ? { riskTier: child.riskTier } : {}),
        ...(child.deprecated === true ? { deprecated: true } : {}),
      };
    });
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      status: definition.status,
      ...(definition.synthetic === true ? { synthetic: true } : {}),
      childCount: children.length,
      presentChildCount: children.filter((child) => child.present).length,
      children,
    };
  });

  const uncategorized = groups.find((group) => group.id === "other")?.childCount ?? 0;

  return {
    schemaVersion: 1,
    storeAvailable: Boolean(store),
    registryAvailable: registry.available,
    registryVersion: registry.registryVersion,
    registryCapabilityCount: registry.capabilities.length,
    groups,
    counts: {
      groups: groups.length,
      capabilities: groups.reduce((sum, group) => sum + group.childCount, 0),
      activeGroups: groups.filter((group) => group.status === "active").length,
      placeholderGroups: groups.filter((group) => group.status === "placeholder").length,
      uncategorized,
    },
  };
}
