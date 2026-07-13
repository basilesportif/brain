import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateAuthorization, parseCapabilityStore } from "./capability-store.js";
import { createCapabilityStoreIfMissing, effectiveCapabilityAdmins } from "./capability-store-write.js";
import { bootstrapTelegramOwner, OWNER_CHANNEL_BASELINE, OWNER_DOMAIN_BASELINE } from "./owner-bootstrap.js";

const OWNER_EMAIL = "owner@example.test";
const OWNER_TELEGRAM_ID = "900000777";
const OWNER_CHAT_ID = "900000778";

test("owner bootstrap authorizes the canary baseline and denies a stranger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-owner-bootstrap-"));
  try {
    const storePath = path.join(root, "control-plane", "capabilities.json");
    const result = await bootstrapTelegramOwner({
      storePath,
      telegramUserId: OWNER_TELEGRAM_ID,
      telegramChatId: OWNER_CHAT_ID,
      ownerEmail: OWNER_EMAIL,
      displayName: "Synthetic Owner",
    });
    assert.equal(result.mutation.outcome.changed, true);

    const store = parseCapabilityStore(await readFile(storePath, "utf8"));
    const subjectId = result.mutation.outcome.personId
      ? `person:${result.mutation.outcome.personId}`
      : assert.fail("bootstrap did not return a person id");
    const actor = {
      id: `telegram:user:${OWNER_TELEGRAM_ID}`,
      surfaceKind: "telegram",
      surfaceUserId: OWNER_TELEGRAM_ID,
    };
    for (const operation of ["telegram.event.receive", "assistant.run", "output.text.send", "crm.contact.read"] as const) {
      const allowed = evaluateAuthorization(store, {
        actor,
        requirement: { operation, action: "*", resource: representativeBaselineResource(operation) },
      });
      assert.equal(allowed.allowed, true, `${operation}: ${allowed.reason}`);
    }
    const stranger = evaluateAuthorization(store, {
      actor: { id: "telegram:user:900000999", surfaceKind: "telegram", surfaceUserId: "900000999" },
      requirement: { operation: "telegram.event.receive", action: "*", resource: representativeBaselineResource("telegram.event.receive") },
    });
    assert.equal(stranger.allowed, false);
    assert.equal(effectiveCapabilityAdmins(store).has(result.mutation.outcome.personId as string), true);
    assert.equal(store.subjects?.some((subject) => subject.id === subjectId), true);

    const telegramGrant = store.grants?.find((grant) => grant.subjectId === subjectId && grant.capabilityId === "telegram.event.receive");
    assert.equal(telegramGrant?.resource?.selectors?.surfaceKind, "telegram");
    for (const key of ["source", "chatId", "actorId", "messageId", "conversationSessionId"]) {
      assert.equal(telegramGrant?.resource?.selectors?.[key], "*", key);
    }
    const identity = store.externalIdentities?.find((candidate) => candidate.id === `identity_telegram_${OWNER_TELEGRAM_ID}`);
    assert.equal(identity?.providerChatId, OWNER_CHAT_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner bootstrap is byte-stable and does not duplicate people, identities, or grants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-owner-bootstrap-idempotent-"));
  try {
    const storePath = path.join(root, "capabilities.json");
    const options = {
      storePath,
      telegramUserId: OWNER_TELEGRAM_ID,
      ownerEmail: OWNER_EMAIL,
      displayName: "Synthetic Owner",
    };
    const first = await bootstrapTelegramOwner(options);
    const firstText = await readFile(storePath, "utf8");
    const second = await bootstrapTelegramOwner(options);
    const secondText = await readFile(storePath, "utf8");
    const store = parseCapabilityStore(secondText);

    assert.equal(first.mutation.outcome.changed, true);
    assert.equal(second.mutation.outcome.changed, false);
    assert.equal(secondText, firstText);
    assert.equal(store.people?.length, 1);
    assert.equal(store.externalIdentities?.length, 2);
    const baseline = new Set<string>([...OWNER_CHANNEL_BASELINE, ...OWNER_DOMAIN_BASELINE]);
    const baselineGrants = (store.grants ?? []).filter((grant) => baseline.has(grant.capabilityId));
    assert.equal(baselineGrants.length, baseline.size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing admin-less store gains exactly one first administrator on restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-first-admin-recovery-"));
  try {
    const storePath = path.join(root, "capabilities.json");
    const empty = await createCapabilityStoreIfMissing({ storePath });
    assert.equal(empty.created, true);
    assert.equal(empty.effectiveAdminCount, 0);

    const recovered = await createCapabilityStoreIfMissing({ storePath, adminEmail: OWNER_EMAIL });
    assert.equal(recovered.created, false);
    assert.equal(recovered.adminSeeded, true);
    assert.equal(recovered.effectiveAdminCount, 1);
    const recoveredText = await readFile(storePath, "utf8");

    const repeated = await createCapabilityStoreIfMissing({ storePath, adminEmail: OWNER_EMAIL });
    assert.equal(repeated.adminSeeded, false);
    assert.equal(repeated.effectiveAdminCount, 1);
    assert.equal(await readFile(storePath, "utf8"), recoveredText);
    const store = parseCapabilityStore(recoveredText);
    assert.equal(store.people?.length, 1);
    assert.equal(store.externalIdentities?.length, 1);
    assert.equal(effectiveCapabilityAdmins(store).size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function representativeBaselineResource(operation: "telegram.event.receive" | "assistant.run" | "output.text.send" | "crm.contact.read"): Record<string, unknown> {
  if (operation === "crm.contact.read") return {};
  const resource = {
    source: "telegram",
    surfaceKind: "telegram",
    chatId: OWNER_CHAT_ID,
    actorId: OWNER_TELEGRAM_ID,
    messageId: "canary",
    conversationSessionId: "canary",
  };
  return operation === "output.text.send" ? { ...resource, outputType: "text" } : resource;
}
