const { simpleParser } = require("mailparser");
const { createImapClient, getAccountLabel } = require("./protonmail-auth");
const {
  createDismissedEmailsStore,
  getAfterDate,
  filterDismissedEmails,
} = require("./email-state");

async function getSnippet(source) {
  if (!source) return "";
  try {
    const parsed = await simpleParser(source, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
    });
    return (parsed.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

function normalizeImapMessage(message) {
  const envelope = message.envelope || {};
  const from = envelope.from?.[0]
    ? `${envelope.from[0].name || ""} <${envelope.from[0].address || ""}>`
    : "";
  const to = envelope.to?.[0]
    ? `${envelope.to[0].name || ""} <${envelope.to[0].address || ""}>`
    : "";

  return {
    id: String(message.uid),
    threadId: envelope.messageId || String(message.uid),
    account: getAccountLabel(),
    provider: "protonmail",
    subject: envelope.subject || "(no subject)",
    from: from.trim(),
    to: to.trim(),
    date: envelope.date ? envelope.date.toISOString() : "",
    flags: Array.from(message.flags || []),
  };
}

async function withInboxClient(work, options = {}) {
  const client = createImapClient(options);
  await client.connect();

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await work(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

function sortMessagesByDate(messages) {
  return messages.sort((left, right) => new Date(right.date) - new Date(left.date));
}

async function listRecentProtonmail(options = {}) {
  const maxResults = options.maxResults || 10;

  return withInboxClient(async (client) => {
    const totalMessages = client.mailbox.exists;
    if (totalMessages === 0) return [];

    const startSeq = Math.max(1, totalMessages - maxResults + 1);
    const range = `${startSeq}:*`;
    const messages = [];

    for await (const message of client.fetch(range, {
      envelope: true,
      bodyStructure: true,
      source: { maxBytes: 4096 },
      flags: true,
      uid: true,
    })) {
      messages.push({
        ...normalizeImapMessage(message),
        snippet: await getSnippet(message.source),
      });
    }

    return sortMessagesByDate(messages);
  }, options);
}

async function searchProtonmailMessages(options = {}) {
  const { query } = options;
  if (!query) throw new Error("query is required");
  const maxResults = options.maxResults || 10;

  return withInboxClient(async (client) => {
    const uids = await client.search({ text: query }, { uid: true });
    if (!uids || uids.length === 0) return [];

    const targetUids = uids.slice(-maxResults);
    const messages = [];
    for await (const message of client.fetch(
      targetUids,
      {
        envelope: true,
        source: { maxBytes: 4096 },
        flags: true,
        uid: true,
      },
      { uid: true }
    )) {
      messages.push({
        ...normalizeImapMessage(message),
        snippet: await getSnippet(message.source),
      });
    }

    return sortMessagesByDate(messages);
  }, options);
}

async function listActionableProtonmail(options = {}) {
  const maxResults = options.maxResults || 10;
  const dismissed = createDismissedEmailsStore(options).load();

  const messages = await withInboxClient(async (client) => {
    const uids = await client.search(
      {
        unseen: true,
        since: getAfterDate(options),
      },
      { uid: true }
    );
    if (!uids || uids.length === 0) return [];

    const targetUids = uids.slice(-maxResults);
    const unreadMessages = [];

    for await (const message of client.fetch(
      targetUids,
      {
        envelope: true,
        source: { maxBytes: 4096 },
        flags: true,
        uid: true,
      },
      { uid: true }
    )) {
      const normalized = normalizeImapMessage(message);
      unreadMessages.push({
        ...normalized,
        snippet: await getSnippet(message.source),
        reason: "unread",
        needsReply: !(normalized.flags || []).includes("\\Seen"),
      });
    }

    return unreadMessages;
  }, options);

  return filterDismissedEmails(sortMessagesByDate(messages), dismissed);
}

module.exports = {
  listRecentProtonmail,
  searchProtonmailMessages,
  listActionableProtonmail,
};
