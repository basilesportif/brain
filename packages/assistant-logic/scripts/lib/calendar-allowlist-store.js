const { createStateStore } = require("./state-stores");

function createCalendarAllowlistStore(options = {}) {
  return createStateStore("calendarAllowlist", {
    ...options,
    defaultValue: () => ({
      version: 1,
      enabled: false,
      emails: [],
      domains: [],
      updatedAt: null,
    }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!Array.isArray(next.emails)) next.emails = [];
      if (!Array.isArray(next.domains)) next.domains = [];
      if (!Object.prototype.hasOwnProperty.call(next, "enabled")) next.enabled = false;
      if (!Object.prototype.hasOwnProperty.call(next, "updatedAt")) next.updatedAt = null;
      if (!Object.prototype.hasOwnProperty.call(next, "version")) next.version = 1;
      return next;
    },
  });
}

function createSeenInvitesStore(options = {}) {
  return createStateStore("seenInvites", {
    ...options,
    defaultValue: () => ({ version: 1, seenIds: {}, updatedAt: null }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!next.seenIds || typeof next.seenIds !== "object") next.seenIds = {};
      if (!Object.prototype.hasOwnProperty.call(next, "updatedAt")) next.updatedAt = null;
      if (!Object.prototype.hasOwnProperty.call(next, "version")) next.version = 1;
      return next;
    },
  });
}

function createDeclinedInvitesLogStore(options = {}) {
  return createStateStore("declinedInvitesLog", {
    ...options,
    defaultValue: () => ({ version: 1, log: [] }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!Array.isArray(next.log)) next.log = [];
      if (!Object.prototype.hasOwnProperty.call(next, "version")) next.version = 1;
      return next;
    },
  });
}

module.exports = {
  createCalendarAllowlistStore,
  createSeenInvitesStore,
  createDeclinedInvitesLogStore,
};
