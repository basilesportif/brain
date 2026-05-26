const {
  loadComposioConfig,
  requireGmailAccounts,
} = require("./config");
const { getAccessToken, googleFetch } = require("./google-auth");
const {
  createDismissedEmailsStore,
  getAfterTimestamp,
  extractSenderEmail,
  filterDismissedEmails,
} = require("./email-state");

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

function getMessageMetadataUrl(token, messageId) {
  return googleFetch(
    token,
    `${GMAIL_BASE}/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`
  );
}

function normalizeGmailMessage(accountId, accountLabels, message) {
  const headers = {};
  (message.payload?.headers || []).forEach((header) => {
    headers[header.name.toLowerCase()] = header.value;
  });
  return {
    id: message.id,
    threadId: message.threadId,
    account: accountLabels[accountId] || accountId,
    provider: "gmail",
    subject: headers.subject || "(no subject)",
    from: headers.from || "",
    to: headers.to || "",
    date: headers.date || "",
    snippet: message.snippet || "",
    labelIds: message.labelIds || [],
  };
}

async function fetchMessageList(accountId, params, options = {}) {
  const composio = options.composio || loadComposioConfig(options);
  const token = await getAccessToken(accountId, { composio });
  const searchParams = new URLSearchParams(params);
  const list = await googleFetch(token, `${GMAIL_BASE}/users/me/messages?${searchParams}`);
  if (!list.messages || list.messages.length === 0) return [];

  const messages = await Promise.all(
    list.messages.map((entry) =>
      getMessageMetadataUrl(token, entry.id).then((message) =>
        normalizeGmailMessage(accountId, composio.ACCOUNT_LABELS, message)
      )
    )
  );

  return messages;
}

/**
 * Fetch thread metadata (message list with From headers) to determine
 * whether the last message in a thread was sent by someone other than the user.
 */
async function fetchThreadLastSender(token, threadId) {
  const thread = await googleFetch(
    token,
    `${GMAIL_BASE}/users/me/threads/${threadId}?format=metadata&metadataHeaders=From`
  );
  const messages = thread.messages || [];
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const fromHeader = (last.payload?.headers || []).find(
    (h) => h.name.toLowerCase() === "from"
  );
  return fromHeader ? fromHeader.value : null;
}

/**
 * For a set of read inbox messages, check which threads are awaiting a reply
 * (last message is from someone other than the account owner).
 */
async function filterAwaitingReply(token, messages, userEmail) {
  const userLower = userEmail.toLowerCase();
  const results = await Promise.all(
    messages.map(async (message) => {
      try {
        const lastFrom = await fetchThreadLastSender(token, message.threadId);
        if (!lastFrom) return null;
        const senderEmail = extractSenderEmail({ from: lastFrom });
        if (senderEmail === userLower) return null;
        return message;
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

function sortMessagesByDate(messages) {
  return messages.sort((left, right) => new Date(right.date) - new Date(left.date));
}

function resolveAccountIds(arg, composio, fallbackMax) {
  const gmailAccounts = requireGmailAccounts(composio);
  if (!arg || arg === "all") {
    return { accountIds: gmailAccounts, maxResults: fallbackMax };
  }
  if (arg.startsWith("ca_")) {
    return { accountIds: [arg], maxResults: fallbackMax };
  }
  return { accountIds: gmailAccounts, maxResults: parseInt(arg || String(fallbackMax), 10) };
}

async function listRecentGmail(options = {}) {
  const composio = options.composio || loadComposioConfig(options);
  const accountIds = options.accountIds || requireGmailAccounts(composio);
  const maxResults = options.maxResults || 10;

  const results = await Promise.all(
    accountIds.map((accountId) =>
      fetchMessageList(
        accountId,
        { labelIds: "INBOX", maxResults: String(maxResults) },
        { composio }
      ).catch((error) => {
        process.stderr.write(
          `Error fetching ${composio.ACCOUNT_LABELS[accountId] || accountId}: ${error.message}\n`
        );
        return [];
      })
    )
  );

  return sortMessagesByDate(results.flat());
}

async function searchGmailMessages(options = {}) {
  const { query } = options;
  if (!query) throw new Error("query is required");
  const composio = options.composio || loadComposioConfig(options);
  const accountIds = options.accountIds || requireGmailAccounts(composio);
  const maxResults = options.maxResults || 10;

  const results = await Promise.all(
    accountIds.map((accountId) =>
      fetchMessageList(
        accountId,
        { q: query, maxResults: String(maxResults) },
        { composio }
      ).catch((error) => {
        process.stderr.write(
          `Error searching ${composio.ACCOUNT_LABELS[accountId] || accountId}: ${error.message}\n`
        );
        return [];
      })
    )
  );

  return sortMessagesByDate(results.flat());
}

async function listActionableGmail(options = {}) {
  const composio = options.composio || loadComposioConfig(options);
  const gmailAccounts = requireGmailAccounts(composio);
  const afterTimestamp = getAfterTimestamp(options);

  const noiseExclusions = [
    "-from:noreply@accounts.dev",
    "-from:no-reply@google.com",
    "-from:notifications@vercel.com",
    "-from:no.reply.alerts@chase.com",
    "-from:rakutenaffiliatenetwork.com",
    "-from:smcp.com",
    '-subject:"New device signed in"',
    '-subject:"payment is scheduled"',
    '-subject:"payment is confirmed"',
    '-subject:"Friends & Family"',
    '-subject:"% off"',
    '-subject:"archive sale"',
    '-subject:"booster sale"',
  ];

  const configuredNoiseExclusions = [
    ...String(composio.env.ASSISTANT_GMAIL_QUERY_EXCLUDES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...(Array.isArray(composio.composioConfig.gmail_query_excludes)
      ? composio.composioConfig.gmail_query_excludes.map((value) => String(value).trim()).filter(Boolean)
      : []),
  ];

  const categoryExclusions =
    "-category:promotions -category:social -category:updates";

  const unreadQuery = [
    `is:unread ${categoryExclusions} label:inbox after:${afterTimestamp}`,
    ...noiseExclusions,
    ...configuredNoiseExclusions,
  ].join(" ");

  // For awaiting-reply: read emails from the last 7 days in inbox
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const awaitingQuery = [
    `is:read ${categoryExclusions} label:inbox after:${sevenDaysAgo}`,
    ...noiseExclusions,
  ].join(" ");

  const maxResults = options.maxResults || 10;
  const results = await Promise.all(
    gmailAccounts.map(async (accountId) => {
      const token = await getAccessToken(accountId, { composio });
      const userEmail = (composio.ACCOUNT_LABELS[accountId] || "").toLowerCase();

      // Fetch unread actionable messages
      const unreadMessages = await fetchMessageList(
        accountId,
        { q: unreadQuery, maxResults: String(maxResults) },
        { composio }
      )
        .then((messages) =>
          messages.map((message) => {
            const labels = message.labelIds || [];
            const isUnread = labels.includes("UNREAD");
            const isInbox = labels.includes("INBOX");
            const isPromo = labels.includes("CATEGORY_PROMOTIONS");
            const isSocial = labels.includes("CATEGORY_SOCIAL");
            const isUpdate = labels.includes("CATEGORY_UPDATES");
            const isForum = labels.includes("CATEGORY_FORUMS");
            return {
              ...message,
              reason: "unread",
              needsReply:
                isUnread && isInbox && !isPromo && !isSocial && !isUpdate && !isForum,
            };
          })
        )
        .catch((error) => {
          process.stderr.write(
            `Error fetching unread ${composio.ACCOUNT_LABELS[accountId] || accountId}: ${error.message}\n`
          );
          return [];
        });

      // Collect threadIds from unread results to avoid duplicates
      const unreadThreadIds = new Set(unreadMessages.map((m) => m.threadId));

      // Fetch read inbox messages for awaiting-reply check
      let awaitingMessages = [];
      try {
        const readCandidates = await fetchMessageList(
          accountId,
          { q: awaitingQuery, maxResults: String(maxResults) },
          { composio }
        );
        // Remove any threads already in the unread set
        const uniqueReadCandidates = readCandidates.filter(
          (m) => !unreadThreadIds.has(m.threadId)
        );
        // Deduplicate by threadId — keep only the most recent message per thread
        const threadMap = new Map();
        for (const m of uniqueReadCandidates) {
          const existing = threadMap.get(m.threadId);
          if (!existing || new Date(m.date) > new Date(existing.date)) {
            threadMap.set(m.threadId, m);
          }
        }
        const deduped = Array.from(threadMap.values());

        if (deduped.length > 0) {
          const needsReply = await filterAwaitingReply(token, deduped, userEmail);
          awaitingMessages = needsReply.map((message) => ({
            ...message,
            reason: "awaiting_reply",
            needsReply: true,
          }));
        }
      } catch (error) {
        process.stderr.write(
          `Error fetching awaiting-reply ${composio.ACCOUNT_LABELS[accountId] || accountId}: ${error.message}\n`
        );
      }

      return [...unreadMessages, ...awaitingMessages];
    })
  );

  const dismissed = createDismissedEmailsStore(options).load();
  return filterDismissedEmails(sortMessagesByDate(results.flat()), dismissed);
}

module.exports = {
  resolveAccountIds,
  listRecentGmail,
  searchGmailMessages,
  listActionableGmail,
};
