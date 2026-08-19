// @ts-nocheck
import * as path from "node:path";

const STATE_FILES = {
  todos: {
    key: "todos",
    relativePath: path.join("data", "todos.json"),
    legacyRelativePaths: ["todos.json"],
    label: "to-do store",
  },
  crm: {
    key: "crm",
    relativePath: path.join("data", "crm.json"),
    legacyRelativePaths: ["crm.json"],
    label: "CRM store",
  },
  calendarAllowlist: {
    key: "calendarAllowlist",
    relativePath: path.join("data", "calendar-allowlist.json"),
    legacyRelativePaths: ["calendar-allowlist.json"],
    label: "calendar allowlist",
  },
  seenInvites: {
    key: "seenInvites",
    relativePath: path.join("data", "seen-invites.json"),
    legacyRelativePaths: [],
    label: "seen invites state",
  },
  declinedInvitesLog: {
    key: "declinedInvitesLog",
    relativePath: path.join("data", "declined-invites-log.json"),
    legacyRelativePaths: [],
    label: "declined invites log",
  },
  dismissedEmails: {
    key: "dismissedEmails",
    relativePath: path.join("data", "dismissed-emails.json"),
    legacyRelativePaths: [],
    label: "dismissed emails state",
  },
  seenEmails: {
    key: "seenEmails",
    relativePath: path.join("data", "seen-emails.json"),
    legacyRelativePaths: [],
    label: "seen emails state",
  },
  urgentEmails: {
    key: "urgentEmails",
    relativePath: path.join("data", "urgent-emails.json"),
    legacyRelativePaths: [],
    label: "urgent emails state",
  },
  flaggedEvents: {
    key: "flaggedEvents",
    relativePath: path.join("data", "flagged-events.json"),
    legacyRelativePaths: [],
    label: "flagged events state",
  },
  dismissedMessages: {
    key: "dismissedMessages",
    relativePath: path.join("data", "dismissed-messages.json"),
    legacyRelativePaths: [],
    label: "dismissed messages state",
  },
  seenMessages: {
    key: "seenMessages",
    relativePath: path.join("data", "seen-messages.json"),
    legacyRelativePaths: [],
    label: "seen messages state",
  },
  urgentMessages: {
    key: "urgentMessages",
    relativePath: path.join("data", "urgent-messages.json"),
    legacyRelativePaths: [],
    label: "urgent messages state",
  },
  protonmailDrafts: {
    key: "protonmailDrafts",
    relativePath: path.join("data", "protonmail-drafts.json"),
    legacyRelativePaths: [],
    label: "ProtonMail drafts",
  },
  protonmailAudit: {
    key: "protonmailAudit",
    relativePath: path.join("data", "protonmail-audit.jsonl"),
    legacyRelativePaths: [],
    label: "ProtonMail audit log",
  },
  // The projects domain is NOT a single JSON document: notes live as markdown
  // files under data/projects/<slug>/notes/ and the JSON files are a
  // rebuildable index (see lib/project-md-store.ts). It therefore does not go
  // through createJsonStore/createStateStore; this descriptor exists so the
  // domain's paths stay declared in one place.
  projects: {
    key: "projects",
    kind: "directory",
    relativePath: path.join("data", "projects"),
    indexRelativePath: path.join("data", "projects", "index.json"),
    legacyStoreRelativePath: path.join("data", "projects.json"),
    retiredStoreRelativePath: path.join("data", "projects.legacy.json"),
    legacyRelativePaths: [],
    label: "projects store",
  },
  reminders: {
    key: "reminders",
    relativePath: path.join("data", "reminders.json"),
    legacyRelativePaths: [],
    label: "reminders store",
  },
  bets: {
    key: "bets",
    relativePath: path.join("data", "bets.json"),
    legacyRelativePaths: [],
    label: "bets store",
  },
};

function getStateDescriptor(key) {
  const descriptor = STATE_FILES[key];
  if (!descriptor) {
    throw new Error(`Unknown state file key: ${key}`);
  }
  return descriptor;
}

export {
  STATE_FILES,
  getStateDescriptor,

};
