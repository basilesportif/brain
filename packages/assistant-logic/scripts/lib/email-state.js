const { createStateStore } = require("./state-stores");
const { loadWorkspaceEnv } = require("./runtime-env");

function createDismissedEmailsStore(options = {}) {
  return createStateStore("dismissedEmails", {
    ...options,
    defaultValue: () => ({ threads: {}, senders: {} }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!next.threads || typeof next.threads !== "object") next.threads = {};
      if (!next.senders || typeof next.senders !== "object") next.senders = {};
      return next;
    },
  });
}

function createSeenEmailsStore(options = {}) {
  return createStateStore("seenEmails", {
    ...options,
    defaultValue: () => ({ version: 1, seenIds: {}, lastCheckedAt: null, updatedAt: null }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!next.seenIds || typeof next.seenIds !== "object") next.seenIds = {};
      if (!Object.prototype.hasOwnProperty.call(next, "lastCheckedAt")) next.lastCheckedAt = null;
      if (!Object.prototype.hasOwnProperty.call(next, "updatedAt")) next.updatedAt = null;
      return next;
    },
  });
}

function createUrgentEmailsStore(options = {}) {
  return createStateStore("urgentEmails", {
    ...options,
    defaultValue: () => ({ threads: {} }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!next.threads || typeof next.threads !== "object") next.threads = {};
      return next;
    },
  });
}

function getAfterTimestamp(options = {}) {
  const seen = createSeenEmailsStore(options).load();
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  if (!seen.lastCheckedAt) return sevenDaysAgo;
  const timestamp = Math.floor(new Date(seen.lastCheckedAt).getTime() / 1000);
  return Number.isFinite(timestamp) ? timestamp : sevenDaysAgo;
}

function getAfterDate(options = {}) {
  return new Date(getAfterTimestamp(options) * 1000);
}

function configuredNoiseSenders() {
  try {
    const { env } = loadWorkspaceEnv();
    return String(env.ASSISTANT_EMAIL_NOISE_SENDERS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return String(process.env.ASSISTANT_EMAIL_NOISE_SENDERS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
}

function isNoiseEmail(message) {
  const fromRaw = (message.from || "").toLowerCase();
  const subject = (message.subject || "").toLowerCase();

  if (/\b(noreply@|no-reply@|no\.reply@)/.test(fromRaw)) return true;
  if (/^(accepted|declined):/i.test(subject)) return true;
  if (/welcome (offer|code)/i.test(subject)) return true;
  if (/\bsale\b/.test(subject)) return true;
  if (/\d+%\s*off\b/.test(subject)) return true;
  if (/% off\b/.test(subject)) return true;
  if (/\barchive sale\b/.test(subject)) return true;
  if (/\bbooster sale\b/.test(subject)) return true;
  if (/\badditional\s+\d+%/i.test(subject)) return true;
  if (configuredNoiseSenders().some((sender) => sender && fromRaw.includes(sender))) return true;
  if (/@rakuten\.com\b/.test(fromRaw)) return true;
  if (/@.*rakutenaffiliatenetwork\.com\b/.test(fromRaw)) return true;
  if (/@.*smcp\.com\b/.test(fromRaw)) return true;
  if (/terms of service/i.test(subject) && /\b(noreply|no-reply|no\.reply)/.test(fromRaw)) {
    return true;
  }

  return false;
}

function extractSenderEmail(message) {
  const senderMatch = (message.from || "").match(/<([^>]+)>/);
  return senderMatch
    ? senderMatch[1].toLowerCase()
    : (message.from || "").toLowerCase().trim();
}

function filterDismissedEmails(messages, dismissals) {
  return messages.filter((message) => {
    if (isNoiseEmail(message)) return false;

    const senderEmail = extractSenderEmail(message);
    if (dismissals.senders[senderEmail]) return false;

    const threadEntry = dismissals.threads[message.threadId];
    if (threadEntry) {
      const messageDate = new Date(message.date);
      const dismissedAt = new Date(threadEntry.dismissedAt);
      if (!(messageDate > dismissedAt)) return false;
    }

    return true;
  });
}

module.exports = {
  createDismissedEmailsStore,
  createSeenEmailsStore,
  createUrgentEmailsStore,
  getAfterTimestamp,
  getAfterDate,
  isNoiseEmail,
  extractSenderEmail,
  filterDismissedEmails,
};
