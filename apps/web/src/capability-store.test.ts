import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAuthorization, type CapabilityStore } from "./capability-store.js";

test("operation-level wildcard and empty actions preserve concrete grant actions and selector scoping", () => {
  const store: CapabilityStore = {
    schemaVersion: 2,
    externalIdentities: [],
    people: [],
    subjects: [{ id: "person:owner", kind: "person", status: "active" }],
    grants: [{
      id: "grant-crm-read",
      subjectId: "person:owner",
      capabilityId: "crm.contact.read",
      actions: ["read"],
      resource: { selectors: { scope: "owner_all", contactId: "*" } },
      status: "active",
      enforcement: "enforcing",
    }],
  };
  const actor = { id: "person:owner", metadata: { brainSubjectId: "person:owner" } };
  const resource = { scope: "owner_all", contactId: "contact-1" };

  assert.equal(evaluateAuthorization(store, {
    actor,
    requirement: { operation: "crm.contact.read", action: "*", resource },
  }).allowed, true);
  assert.equal(evaluateAuthorization(store, {
    actor,
    requirement: { operation: "crm.contact.read", action: "", resource },
  }).allowed, true);
  assert.equal(evaluateAuthorization(store, {
    actor,
    requirement: { operation: "crm.contact.read", action: "write", resource },
  }).allowed, false);
  assert.equal(evaluateAuthorization(store, {
    actor,
    requirement: { operation: "crm.contact.read", action: "*", resource: { scope: "shared", contactId: "contact-1" } },
  }).allowed, false);
});
