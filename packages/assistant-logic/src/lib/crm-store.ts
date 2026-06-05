// @ts-nocheck
import * as crypto from "node:crypto";
import { createStateStore } from "./state-stores.js";

const SCHEMA_VERSION = 1;

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function createEmptyStore() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    people: [],
    businesses: [],
    correspondence: [],
  };
}

function getCrmStore(options = {}) {
  return createStateStore("crm", {
    ...options,
    defaultValue: createEmptyStore,
    onLoad(store) {
      const next = store && typeof store === "object" ? store : createEmptyStore();
      if (!Array.isArray(next.people)) next.people = [];
      if (!Array.isArray(next.businesses)) next.businesses = [];
      if (!Array.isArray(next.correspondence)) next.correspondence = [];
      return next;
    },
  });
}

function loadCrmStore(options = {}) {
  return getCrmStore(options).load();
}

function saveCrmStore(store, options = {}) {
  store.updatedAt = new Date().toISOString();
  return getCrmStore(options).save(store);
}

function addPerson(input, options = {}) {
  const name = (input.name || "").trim();
  if (!name) throw new Error("Name is required");
  return getCrmStore(options).transaction((store) => {
    const now = new Date().toISOString();
    const resolvedBusinessIds = Array.isArray(input.businessIds) ? input.businessIds : [];
    const person = {
      id: generateId("ct"),
      name,
      email: (input.email || "").trim() || null,
      phone: (input.phone || "").trim() || null,
      company: (input.company || "").trim() || null,
      title: (input.title || "").trim() || null,
      tags: Array.isArray(input.tags) ? input.tags : [],
      businessIds: resolvedBusinessIds,
      status: input.status || "active",
      priority: input.priority || "normal",
      source: (input.source || "").trim() || null,
      notes: (input.notes || "").trim() || null,
      lastContactedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    for (const businessId of resolvedBusinessIds) {
      const business = store.businesses.find((entry) => entry.id === businessId);
      if (business && !business.personIds.includes(person.id)) {
        business.personIds.push(person.id);
        business.updatedAt = now;
      }
    }

    store.people.push(person);
    store.updatedAt = now;
    return person;
  });
}

function listPeople({ query, status, businessId } = {}, options = {}) {
  const store = loadCrmStore(options);
  let people = store.people;
  if (query) {
    const lowerQuery = query.toLowerCase();
    people = people.filter(
      (person) =>
        person.name.toLowerCase().includes(lowerQuery) ||
        (person.email && person.email.toLowerCase().includes(lowerQuery)) ||
        (person.company && person.company.toLowerCase().includes(lowerQuery)) ||
        (person.notes && person.notes.toLowerCase().includes(lowerQuery))
    );
  }
  if (status) {
    people = people.filter((person) => person.status === status);
  }
  if (businessId) {
    people = people.filter((person) => person.businessIds.includes(businessId));
  }
  return people;
}

function updatePerson(id, updates, options = {}) {
  return getCrmStore(options).transaction((store, tx) => {
    const person = store.people.find((entry) => entry.id === id);
    if (!person) {
      tx.skipSave();
      return null;
    }
    const allowed = [
      "name",
      "email",
      "phone",
      "company",
      "title",
      "tags",
      "status",
      "priority",
      "source",
      "notes",
      "businessIds",
      "lastContactedAt",
    ];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        person[key] = updates[key];
      }
    }
    const now = new Date().toISOString();
    person.updatedAt = now;
    store.updatedAt = now;
    return person;
  });
}

function deletePerson(id, options = {}) {
  return getCrmStore(options).transaction((store, tx) => {
    const index = store.people.findIndex((person) => person.id === id);
    if (index === -1) {
      tx.skipSave();
      return { found: false };
    }
    const [removed] = store.people.splice(index, 1);
    const now = new Date().toISOString();
    for (const business of store.businesses) {
      business.personIds = business.personIds.filter((personId) => personId !== id);
      business.updatedAt = now;
    }
    store.updatedAt = now;
    return { found: true, deleted: { id: removed.id, name: removed.name } };
  });
}

function addBusiness(input, options = {}) {
  const name = (input.name || "").trim();
  if (!name) throw new Error("Name is required");
  return getCrmStore(options).transaction((store) => {
    const now = new Date().toISOString();
    const business = {
      id: generateId("bz"),
      name,
      description: (input.description || "").trim() || null,
      status: input.status || "prospecting",
      dealValue: input.dealValue != null ? Number(input.dealValue) : null,
      personIds: [],
      notes: (input.notes || "").trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    store.businesses.push(business);
    store.updatedAt = now;
    return business;
  });
}

function listBusinesses({ query, status } = {}, options = {}) {
  const store = loadCrmStore(options);
  let businesses = store.businesses;
  if (query) {
    const lowerQuery = query.toLowerCase();
    businesses = businesses.filter(
      (business) =>
        business.name.toLowerCase().includes(lowerQuery) ||
        (business.description && business.description.toLowerCase().includes(lowerQuery)) ||
        (business.notes && business.notes.toLowerCase().includes(lowerQuery))
    );
  }
  if (status) {
    businesses = businesses.filter((business) => business.status === status);
  }
  return businesses;
}

function updateBusiness(id, updates, options = {}) {
  return getCrmStore(options).transaction((store, tx) => {
    const business = store.businesses.find((entry) => entry.id === id);
    if (!business) {
      tx.skipSave();
      return null;
    }
    const allowed = ["name", "description", "status", "dealValue", "notes", "personIds"];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        business[key] = updates[key];
      }
    }
    const now = new Date().toISOString();
    business.updatedAt = now;
    store.updatedAt = now;
    return business;
  });
}

function deleteBusiness(id, options = {}) {
  return getCrmStore(options).transaction((store, tx) => {
    const index = store.businesses.findIndex((business) => business.id === id);
    if (index === -1) {
      tx.skipSave();
      return { found: false };
    }
    const [removed] = store.businesses.splice(index, 1);
    const now = new Date().toISOString();
    for (const person of store.people) {
      person.businessIds = person.businessIds.filter((businessId) => businessId !== id);
      person.updatedAt = now;
    }
    store.updatedAt = now;
    return { found: true, deleted: { id: removed.id, name: removed.name } };
  });
}

function addCorrespondence(input, options = {}) {
  if (!input.personId) throw new Error("personId is required");
  if (!input.type) throw new Error("type is required");
  if (!input.summary) throw new Error("summary is required");

  return getCrmStore(options).transaction((store) => {
    const person = store.people.find((entry) => entry.id === input.personId);
    if (!person) throw new Error(`Person not found: ${input.personId}`);
    if (input.businessId) {
      const business = store.businesses.find((entry) => entry.id === input.businessId);
      if (!business) throw new Error(`Business not found: ${input.businessId}`);
    }

    const now = new Date().toISOString();
    const entryDate = input.date || now;
    const entry = {
      id: generateId("co"),
      personId: input.personId,
      businessId: input.businessId || null,
      type: input.type,
      summary: input.summary.trim(),
      notes: input.notes ? input.notes.trim() : null,
      followUpNeeded: !!input.followUpNeeded,
      followUpDate: input.followUpDate || null,
      resolved: false,
      date: entryDate,
      createdAt: now,
    };
    store.correspondence.push(entry);

    const current = person.lastContactedAt;
    if (!current || entryDate > current) {
      person.lastContactedAt = entryDate;
      person.updatedAt = now;
    }

    store.updatedAt = now;
    return entry;
  });
}

function listCorrespondence({ personId, businessId } = {}, options = {}) {
  const store = loadCrmStore(options);
  let entries = store.correspondence;
  if (personId) entries = entries.filter((entry) => entry.personId === personId);
  if (businessId) entries = entries.filter((entry) => entry.businessId === businessId);
  return entries;
}

function listFollowUps({ dueOnly, personId, businessId } = {}, options = {}) {
  const store = loadCrmStore(options);
  let entries = store.correspondence.filter(
    (entry) => entry.followUpNeeded && !entry.resolved
  );
  if (dueOnly) {
    const today = new Date().toISOString().slice(0, 10);
    entries = entries.filter(
      (entry) => !entry.followUpDate || entry.followUpDate <= today
    );
  }
  if (personId) {
    entries = entries.filter((entry) => entry.personId === personId);
  }
  if (businessId) {
    entries = entries.filter((entry) => entry.businessId === businessId);
  }
  return entries.map((entry) => {
    const person = store.people.find((candidate) => candidate.id === entry.personId);
    const business = entry.businessId
      ? store.businesses.find((candidate) => candidate.id === entry.businessId)
      : null;
    return {
      ...entry,
      personName: person ? person.name : null,
      businessName: business ? business.name : null,
    };
  });
}

function resolveFollowUp(id, options = {}) {
  return getCrmStore(options).transaction((store, tx) => {
    const entry = store.correspondence.find((candidate) => candidate.id === id);
    if (!entry) {
      tx.skipSave();
      return null;
    }
    entry.resolved = true;
    store.updatedAt = new Date().toISOString();
    return entry;
  });
}

function linkPersonBusiness(personId, businessId, options = {}) {
  return getCrmStore(options).transaction((store) => {
    const person = store.people.find((entry) => entry.id === personId);
    if (!person) throw new Error(`Person not found: ${personId}`);
    const business = store.businesses.find((entry) => entry.id === businessId);
    if (!business) throw new Error(`Business not found: ${businessId}`);
    if (!person.businessIds.includes(businessId)) {
      person.businessIds.push(businessId);
    }
    if (!business.personIds.includes(personId)) {
      business.personIds.push(personId);
    }
    const now = new Date().toISOString();
    person.updatedAt = now;
    business.updatedAt = now;
    store.updatedAt = now;
    return {
      person: { id: person.id, name: person.name },
      business: { id: business.id, name: business.name },
    };
  });
}

function unlinkPersonBusiness(personId, businessId, options = {}) {
  return getCrmStore(options).transaction((store) => {
    const person = store.people.find((entry) => entry.id === personId);
    if (!person) throw new Error(`Person not found: ${personId}`);
    const business = store.businesses.find((entry) => entry.id === businessId);
    if (!business) throw new Error(`Business not found: ${businessId}`);
    person.businessIds = person.businessIds.filter((id) => id !== businessId);
    business.personIds = business.personIds.filter((id) => id !== personId);
    const now = new Date().toISOString();
    person.updatedAt = now;
    business.updatedAt = now;
    store.updatedAt = now;
    return {
      person: { id: person.id, name: person.name },
      business: { id: business.id, name: business.name },
    };
  });
}

function rescheduleFollowUp(id, newDate, options = {}) {
  return getCrmStore(options).transaction((store, tx) => {
    const entry = store.correspondence.find((candidate) => candidate.id === id);
    if (!entry) {
      tx.skipSave();
      return null;
    }
    if (!entry.followUpNeeded) {
      throw new Error("This correspondence has no follow-up to reschedule");
    }
    entry.followUpDate = newDate;
    entry.resolved = false;
    store.updatedAt = new Date().toISOString();
    return entry;
  });
}

function viewPerson(id, options = {}) {
  const store = loadCrmStore(options);
  const person = store.people.find((entry) => entry.id === id);
  if (!person) return null;
  const businesses = store.businesses.filter((business) =>
    person.businessIds.includes(business.id)
  );
  const correspondence = store.correspondence
    .filter((entry) => entry.personId === id)
    .sort((left, right) =>
      (right.date || right.createdAt).localeCompare(left.date || left.createdAt)
    );
  const pendingFollowUps = correspondence.filter(
    (entry) => entry.followUpNeeded && !entry.resolved
  );
  return { person, businesses, correspondence, pendingFollowUps };
}

function viewBusiness(id, options = {}) {
  const store = loadCrmStore(options);
  const business = store.businesses.find((entry) => entry.id === id);
  if (!business) return null;
  const people = store.people.filter((person) => business.personIds.includes(person.id));
  const correspondence = store.correspondence
    .filter((entry) => entry.businessId === id)
    .sort((left, right) =>
      (right.date || right.createdAt).localeCompare(left.date || left.createdAt)
    );
  const pendingFollowUps = correspondence.filter(
    (entry) => entry.followUpNeeded && !entry.resolved
  );
  return { business, people, correspondence, pendingFollowUps };
}

function stalePeople({ days = 30 } = {}, options = {}) {
  const store = loadCrmStore(options);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return store.people
    .filter((person) => person.status !== "inactive" && person.status !== "archived")
    .filter((person) => {
      if (person.lastContactedAt) return person.lastContactedAt < cutoff;
      return person.createdAt < cutoff;
    })
    .map((person) => ({
      ...person,
      daysSinceContact: person.lastContactedAt
        ? Math.floor(
            (Date.now() - new Date(person.lastContactedAt).getTime()) / 86400000
          )
        : Math.floor((Date.now() - new Date(person.createdAt).getTime()) / 86400000),
    }))
    .sort((left, right) => right.daysSinceContact - left.daysSinceContact);
}

function pipelineSummary(options = {}) {
  const store = loadCrmStore(options);
  const summary = {};
  for (const business of store.businesses) {
    const status = business.status || "unknown";
    if (!summary[status]) {
      summary[status] = { count: 0, totalDealValue: 0, businesses: [] };
    }
    summary[status].count += 1;
    if (business.dealValue) summary[status].totalDealValue += business.dealValue;
    summary[status].businesses.push({
      id: business.id,
      name: business.name,
      dealValue: business.dealValue,
    });
  }
  return summary;
}

function findDuplicates(name, options = {}) {
  const store = loadCrmStore(options);
  const query = (name || "").trim().toLowerCase();
  if (!query) return [];
  return store.people.filter((person) => {
    const personName = person.name.toLowerCase();
    if (personName === query) return true;
    if (personName.includes(query) || query.includes(personName)) return true;
    const queryParts = query.split(/\s+/);
    const personParts = personName.split(/\s+/);
    const overlap = queryParts.filter((part) => personParts.includes(part));
    return (
      overlap.length > 0 &&
      overlap.length >= Math.min(queryParts.length, personParts.length)
    );
  });
}

function contactsWithMissingFields(options = {}) {
  const store = loadCrmStore(options);
  return store.people
    .filter((person) => person.status !== "archived")
    .map((person) => {
      const missing = [];
      if (!person.email) missing.push("email");
      if (!person.phone) missing.push("phone");
      if (!person.company) missing.push("company");
      if (!person.title) missing.push("title");
      return missing.length > 0
        ? { id: person.id, name: person.name, status: person.status, missing }
        : null;
    })
    .filter(Boolean);
}

function deleteById(id, options = {}) {
  if (id.startsWith("ct_")) return deletePerson(id, options);
  if (id.startsWith("bz_")) return deleteBusiness(id, options);
  if (id.startsWith("co_")) {
    return getCrmStore(options).transaction((store, tx) => {
      const index = store.correspondence.findIndex((entry) => entry.id === id);
      if (index === -1) {
        tx.skipSave();
        return { found: false };
      }
      const [removed] = store.correspondence.splice(index, 1);
      store.updatedAt = new Date().toISOString();
      return {
        found: true,
        deleted: { id: removed.id, type: removed.type, summary: removed.summary },
      };
    });
  }
  return { found: false, error: "Unknown ID prefix" };
}

function updateCorrespondenceNotes(id, notes, options = {}) {
  return getCrmStore(options).transaction((store, tx) => {
    const entry = store.correspondence.find((candidate) => candidate.id === id);
    if (!entry) {
      tx.skipSave();
      return null;
    }
    entry.notes = notes ? notes.trim() : null;
    store.updatedAt = new Date().toISOString();
    return entry;
  });
}

export {
  getCrmStore,
  loadCrmStore,
  saveCrmStore,
  addPerson,
  listPeople,
  updatePerson,
  deletePerson,
  addBusiness,
  listBusinesses,
  updateBusiness,
  deleteBusiness,
  addCorrespondence,
  listCorrespondence,
  listFollowUps,
  resolveFollowUp,
  rescheduleFollowUp,
  linkPersonBusiness,
  unlinkPersonBusiness,
  deleteById,
  updateCorrespondenceNotes,
  viewPerson,
  viewBusiness,
  stalePeople,
  pipelineSummary,
  findDuplicates,
  contactsWithMissingFields,

};
