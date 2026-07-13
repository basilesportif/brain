import { commitMutation, createCapabilityStoreIfMissing, CapabilityWriteError, type MutationResult } from "./capability-store-write.js";

export const OWNER_CHANNEL_BASELINE = [
  "telegram.event.receive",
  "assistant.run",
  "output.text.send",
] as const;

export const OWNER_DOMAIN_BASELINE = [
  "crm.contact.read",
  "crm.contact.write",
  "crm.note.write",
  "calendar.event.read",
  "calendar.event.write",
  "calendar.availability.read",
  "projects.read",
  "projects.write",
  "projects.tasks.write",
  "todos.item.read",
  "todos.item.write",
  "todos.list.manage",
] as const;

export interface BootstrapTelegramOwnerOptions {
  storePath: string;
  telegramUserId: string;
  telegramChatId?: string;
  ownerEmail: string;
  displayName: string;
}

export interface BootstrapTelegramOwnerResult {
  createdStore: boolean;
  seededFirstAdmin: boolean;
  mutation: MutationResult;
  telegramUserId: string;
  pairingNote: string;
}

export async function bootstrapTelegramOwner(options: BootstrapTelegramOwnerOptions): Promise<BootstrapTelegramOwnerResult> {
  const telegramUserId = requireIdentifier(options.telegramUserId, "telegramUserId", /^\d+$/);
  const telegramChatId = options.telegramChatId === undefined
    ? undefined
    : requireIdentifier(options.telegramChatId, "telegramChatId", /^-?\d+$/);
  const ownerEmail = options.ownerEmail.trim().toLowerCase();
  if (!/^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/.test(ownerEmail)) {
    throw new CapabilityWriteError("invalid_request", 400, "ownerEmail must be a valid email address");
  }
  const displayName = options.displayName.trim();
  if (!displayName) throw new CapabilityWriteError("invalid_request", 400, "displayName is required");

  const seed = await createCapabilityStoreIfMissing({ storePath: options.storePath, adminEmail: ownerEmail });
  const grants = [
    ...OWNER_CHANNEL_BASELINE.map((capabilityId) => ({ capabilityId, selectors: { surfaceKind: "telegram" } })),
    ...OWNER_DOMAIN_BASELINE.map((capabilityId) => ({ capabilityId })),
  ];
  const mutation = await commitMutation(options.storePath, {
    kind: "onboard_person",
    displayName,
    ownerEmail,
    identity: {
      provider: "telegram",
      externalId: telegramUserId,
      ...(telegramChatId ? { chatId: telegramChatId } : {}),
    },
    grants,
    adminEmail: ownerEmail,
  });
  return {
    createdStore: seed.created,
    seededFirstAdmin: seed.adminSeeded === true,
    mutation,
    telegramUserId,
    pairingNote: `codex-chat's /pair allowlist must also include Telegram user id ${telegramUserId}`,
  };
}

function requireIdentifier(value: string, field: string, pattern: RegExp): string {
  const normalized = value.trim();
  if (!normalized || !pattern.test(normalized)) {
    throw new CapabilityWriteError("invalid_request", 400, `${field} is invalid`);
  }
  return normalized;
}
