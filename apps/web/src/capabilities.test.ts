import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CAPABILITY_CATALOG, capabilityAdminSummary } from "./capabilities.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

function capabilityCount(): number {
  return CAPABILITY_CATALOG.reduce((sum, group) => sum + group.children.length, 0);
}

function activeCapabilityCount(): number {
  return CAPABILITY_CATALOG.reduce((sum, group) => sum + group.children.filter((child) => child.status !== "placeholder").length, 0);
}

test("capability store v2 seeds Tim, Telegram identity, Slack signed-event identity, and expanded owner grants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-cap-v2-"));
  try {
    const codexChatPath = path.join(root, "codex-chat");
    const telemetryDir = path.join(codexChatPath, "data/state/slack_telemetry");
    const accepted = {
      schemaVersion: 1,
      observedAt: "2026-06-30T21:46:57.656Z",
      direction: "inbound",
      outcome: "accepted",
      eventType: "app_mention",
      teamId: "TTESTTEAM",
      channelId: "CTESTCHAN",
      userId: "UTESTUSER",
      correlationId: "slack:EVTEST",
    };
    await writeJson(path.join(telemetryDir, "summary.json"), { schemaVersion: 1, updatedAt: accepted.observedAt, lastAcceptedEvent: accepted });
    await writeFile(path.join(telemetryDir, "2026-06-30.jsonl"), `${JSON.stringify(accepted)}\n`);

    const summary = await capabilityAdminSummary({
      storePath: path.join(root, "capabilities.json"),
      auditLogPath: path.join(root, "capability-audit.jsonl"),
      adminEmail: "tim.galebach@gmail.com",
      codexChatPath,
    });

    assert.equal(summary.schemaVersion, 2);
    assert.equal(summary.mode, "identity_capability_foundation");
    assert.equal(summary.defaultPersonId, "person_tim");
    assert.equal(summary.defaultSubjectId, "person:person_tim");
    assert.ok(summary.people.some((person) => person.id === "person_tim" && person.displayName === "Tim" && person.status === "active"));

    const telegram = summary.externalIdentities.find((identity) => identity.id === "identity_telegram_253768951");
    assert.ok(telegram);
    assert.equal(telegram.personId, "person_tim");
    assert.equal(telegram.provider, "telegram");
    assert.equal(telegram.providerUserId, "253768951");
    assert.equal(telegram.providerChatId, "253768951");
    assert.ok(summary.identityProofs.some((proof) => proof.identityId === telegram.id && proof.source === "telegram_allowlist_migration"));

    const slack = summary.externalIdentities.find((identity) => identity.provider === "slack" && identity.providerUserId === "UTESTUSER");
    assert.ok(slack);
    assert.equal(slack.personId, "person_tim");
    assert.equal(slack.status, "linked");
    assert.equal(slack.providerTeamId, "TTESTTEAM");
    assert.ok(summary.identityProofs.some((proof) => proof.identityId === slack.id && proof.source === "slack_signed_event"));
    assert.ok(summary.communicationChannels.some((channel) => channel.provider === "slack" && channel.externalIds.channelId === "CTESTCHAN"));

    const timGrants = summary.grants.filter((grant) => grant.subjectId === "person:person_tim");
    assert.equal(timGrants.length, activeCapabilityCount());
    assert.equal(timGrants.some((grant) => grant.grantKind === "bundle" || grant.capabilityId === "bundle.owner.all"), false);
    assert.ok(timGrants.some((grant) => grant.id === "grant_seed_tim_owner_projects_files_write" && grant.capabilityId === "projects.files.write" && grant.grantKind === "capability" && grant.enforcement === "non_enforcing"));
    assert.equal(timGrants.some((grant) => grant.capabilityId === "finance.summary.read" || grant.capabilityId === "health.record.read"), false);

    const effective = summary.effectiveByPerson.person_tim?.effective;
    assert.ok(effective);
    assert.equal(effective.summary.allCapabilities, false);
    assert.equal(effective.summary.allActiveCapabilities, true);
    assert.equal(effective.summary.effectiveCapabilityCount, activeCapabilityCount());
    assert.equal(effective.summary.effectiveActiveCapabilityCount, activeCapabilityCount());
    assert.equal(effective.summary.totalCapabilityCount, capabilityCount());
    assert.equal(effective.summary.placeholderCapabilityCount, capabilityCount() - activeCapabilityCount());
    assert.equal(effective.summary.activeGrantCount, activeCapabilityCount());
    assert.equal(effective.byCapabilityId["projects.files.write"]?.effective, true);
    assert.ok(effective.byCapabilityId["projects.files.write"]?.directGrantIds.includes("grant_seed_tim_owner_projects_files_write"));
    assert.equal(effective.byCapabilityId["finance.summary.read"]?.effective, false);
    assert.equal(summary.enforcement.enabled, false);
    assert.equal(summary.adminWriteModel.writesEnabled, false);

    const fileInfo = await stat(path.join(root, "capabilities.json"));
    assert.equal(`0${(fileInfo.mode & 0o777).toString(8)}`, "0600");
    const stored = JSON.parse(await readFile(path.join(root, "capabilities.json"), "utf8")) as { schemaVersion: number; people: unknown[]; grants: Array<{ id?: string }> };
    assert.equal(stored.schemaVersion, 2);
    assert.ok(stored.people.length >= 1);
    assert.ok(stored.grants.length >= activeCapabilityCount());
    assert.equal(stored.grants.some((grant) => grant.id === "grant_seed_tim_owner_all"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capability store migrates v1 read-only subjects and grants into v2", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-cap-migrate-"));
  try {
    const storePath = path.join(root, "capabilities.json");
    await writeJson(storePath, {
      schemaVersion: 1,
      storeId: "brain-local-capabilities-v1",
      mode: "read_only_seed",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      writesEnabled: false,
      enforcementEnabled: false,
      subjects: [{ id: "slack:channel:TLEGACY:CLEGACY", kind: "slack_channel", label: "Legacy channel", description: "legacy", source: "seed", externalIds: { teamId: "TLEGACY", channelId: "CLEGACY" } }],
      grants: [{
        id: "grant_legacy_slack_channel_read",
        subjectId: "slack:channel:TLEGACY:CLEGACY",
        capabilityId: "slack.channel.read",
        grantKind: "capability",
        resource: { kind: "slack_channel", id: "TLEGACY:CLEGACY", selectors: { teamId: "TLEGACY", channelId: "CLEGACY" } },
        actions: ["read"],
        source: { kind: "seed", id: "legacy" },
        grantedBy: "system:seed",
        grantedAt: "2026-06-29T00:00:00.000Z",
        status: "example",
        reason: "legacy example",
        enforcement: "non_enforcing",
      }],
      audit: { appendOnly: true, writesEnabled: false, path: path.join(root, "old-audit.jsonl"), values: "old", requiredFields: ["eventId"], eventTypes: [], sampleEvent: {} },
      notes: ["legacy"],
    });

    const summary = await capabilityAdminSummary({ storePath, auditLogPath: path.join(root, "capability-audit.jsonl"), adminEmail: "tim.galebach@gmail.com" });
    assert.equal(summary.schemaVersion, 2);
    assert.equal(summary.store.migratedThisRequest, true);
    assert.ok(summary.people.some((person) => person.id === "person_tim"));
    assert.ok(summary.subjects.some((subject) => subject.id === "slack:channel:TLEGACY:CLEGACY"));
    assert.ok(summary.grants.some((grant) => grant.id === "grant_legacy_slack_channel_read" && grant.enforcement === "non_enforcing"));
    assert.equal(summary.grants.some((grant) => grant.id === "grant_seed_tim_owner_all"), false);
    assert.ok(summary.grants.some((grant) => grant.id === "grant_seed_tim_owner_projects_files_write"));

    const stored = JSON.parse(await readFile(storePath, "utf8")) as { schemaVersion: number; legacyStoreIds?: string[]; notes: string[] };
    assert.equal(stored.schemaVersion, 2);
    assert.ok(stored.legacyStoreIds?.includes("brain-local-capabilities-v1"));
    assert.ok(stored.notes.some((note) => /Migrated from capability store schema v1/.test(note)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
