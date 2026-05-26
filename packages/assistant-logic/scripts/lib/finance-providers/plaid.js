const fs = require("fs");
const path = require("path");
const { getWorkspaceContext, getWorkspacePaths } = require("../workspace");
const { loadWorkspaceEnv } = require("../runtime-env");
const { loadSources, saveSources, getSourcesPath } = require("../finance-sources");

const PROVIDER_ID = "plaid";
const PROVIDER_NAME = "Plaid";

const PLAID_ENVS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

function loadPlaidConfig(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const paths = getWorkspacePaths(context);
  const { env } = loadWorkspaceEnv({ context, processEnv: options.processEnv });

  const clientId = env.PLAID_CLIENT_ID;
  const secret = env.PLAID_SECRET;
  const plaidEnv = env.PLAID_ENV || "development";
  const baseUrl = PLAID_ENVS[plaidEnv] || PLAID_ENVS.development;

  if (!clientId || !secret) {
    return null;
  }

  const sourcesPath = path.join(paths.dataDir, "finance-sources.json");

  return {
    clientId,
    secret,
    baseUrl,
    plaidEnv,
    dataDir: paths.dataDir,
    sourcesPath,
  };
}

/**
 * Resolve all Plaid sources. Returns an array of
 * { accessToken, sourceId, sourceLabel, cursor } objects.
 *
 * Supports two storage formats:
 * 1. New per-source format: each plaid source has its own accessToken field
 * 2. Legacy grouped format: a single "plaid" source with accessTokens array
 */
function resolvePlaidSources(config) {
  const data = loadSources({ sourcesPath: config.sourcesPath });
  const plaidSources = data.sources.filter(
    (s) => s.provider === "plaid" && s.enabled !== false
  );

  const resolved = [];

  for (const source of plaidSources) {
    if (source.accessToken) {
      // New per-source format
      resolved.push({
        accessToken: source.accessToken,
        sourceId: source.id,
        sourceLabel: source.label || "Plaid",
        cursor: source.cursor || null,
      });
    } else if (Array.isArray(source.accessTokens)) {
      // Legacy grouped format
      for (let i = 0; i < source.accessTokens.length; i++) {
        resolved.push({
          accessToken: source.accessTokens[i],
          sourceId: source.id ? `${source.id}_item${i}` : `plaid_legacy_${i}`,
          sourceLabel: source.label || "Plaid",
          cursor: null, // cursors stored separately in syncCursors
        });
      }
    }
  }

  return resolved;
}

async function plaidFetch(config, endpoint, body = {}) {
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      secret: config.secret,
      ...body,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let errorMessage = `Plaid API ${response.status} on ${endpoint}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error_message) {
        errorMessage += `: ${parsed.error_message}`;
      }
    } catch {
      if (text) errorMessage += `: ${text}`;
    }
    throw new Error(errorMessage);
  }

  return response.json();
}

function isConfigured(options = {}) {
  try {
    const config = loadPlaidConfig(options);
    if (!config) return false;
    return resolvePlaidSources(config).length > 0;
  } catch {
    return false;
  }
}

function hasCredentials(options = {}) {
  try {
    const config = loadPlaidConfig(options);
    return config !== null;
  } catch {
    return false;
  }
}

async function listAccounts(options = {}) {
  const config = loadPlaidConfig(options);
  if (!config) return [];

  const sources = resolvePlaidSources(config);
  if (sources.length === 0) return [];

  const allAccounts = [];
  for (const { accessToken, sourceId, sourceLabel } of sources) {
    try {
      const data = await plaidFetch(config, "/accounts/get", {
        access_token: accessToken,
      });
      for (const account of data.accounts || []) {
        allAccounts.push({
          id: account.account_id,
          name: account.name,
          kind: account.subtype || account.type,
          status: "active",
          provider: PROVIDER_ID,
          sourceId,
          sourceLabel,
          institution: data.item ? data.item.institution_id : undefined,
          mask: account.mask,
        });
      }
    } catch (err) {
      allAccounts.push({
        id: null,
        name: `Error (${sourceLabel}): ${err.message}`,
        kind: "error",
        status: "error",
        provider: PROVIDER_ID,
        sourceId,
        sourceLabel,
      });
    }
  }

  return allAccounts;
}

async function getBalances(options = {}) {
  const config = loadPlaidConfig(options);
  if (!config) return [];

  const sources = resolvePlaidSources(config);
  if (sources.length === 0) return [];

  const allBalances = [];
  for (const { accessToken, sourceId, sourceLabel } of sources) {
    try {
      const data = await plaidFetch(config, "/accounts/balance/get", {
        access_token: accessToken,
      });
      for (const account of data.accounts || []) {
        allBalances.push({
          id: account.account_id,
          name: account.name,
          kind: account.subtype || account.type,
          currentBalance: account.balances.current,
          availableBalance: account.balances.available,
          provider: PROVIDER_ID,
          sourceId,
          sourceLabel,
          institution: data.item ? data.item.institution_id : undefined,
        });
      }
    } catch (err) {
      allBalances.push({
        id: null,
        name: `Error (${sourceLabel}): ${err.message}`,
        kind: "error",
        currentBalance: null,
        availableBalance: null,
        provider: PROVIDER_ID,
        sourceId,
        sourceLabel,
      });
    }
  }

  return allBalances;
}

function loadSyncCursors(sourcesPath) {
  try {
    const data = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));
    return data.syncCursors || {};
  } catch {
    return {};
  }
}

function saveSyncCursor(sourcesPath, accessToken, cursor) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));
  } catch {
    data = { version: 1, sources: [] };
  }
  if (!data.syncCursors) data.syncCursors = {};
  data.syncCursors[accessToken] = cursor;
  fs.writeFileSync(sourcesPath, JSON.stringify(data, null, 2));
}

/**
 * Also update the cursor field on per-source entries.
 */
function updateSourceCursor(sourcesPath, accessToken, cursor) {
  try {
    const data = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));
    for (const source of data.sources || []) {
      if (source.provider === "plaid" && source.accessToken === accessToken) {
        source.cursor = cursor;
      }
    }
    // Also update legacy syncCursors
    if (!data.syncCursors) data.syncCursors = {};
    data.syncCursors[accessToken] = cursor;
    fs.writeFileSync(sourcesPath, JSON.stringify(data, null, 2));
  } catch {
    // Fall back to legacy cursor storage
    saveSyncCursor(sourcesPath, accessToken, cursor);
  }
}

async function getTransactions(options = {}) {
  const config = loadPlaidConfig(options);
  if (!config) return [];

  const sources = resolvePlaidSources(config);
  if (sources.length === 0) return [];

  // Determine date range for filtering
  let startDate = options.start || null;
  let endDate = options.end || null;
  if (!startDate && !endDate) {
    const days = options.days || 30;
    const now = new Date();
    endDate = now.toISOString().split("T")[0];
    const sd = new Date(now);
    sd.setDate(sd.getDate() - days);
    startDate = sd.toISOString().split("T")[0];
  }

  const limit = options.limit || 50;
  const accountFilter = options.account || null;
  const legacyCursors = loadSyncCursors(config.sourcesPath);
  const allTransactions = [];

  for (const { accessToken, sourceId, sourceLabel, cursor: sourceCursor } of sources) {
    try {
      // Use per-source cursor first, then legacy cursor
      let cursor = sourceCursor || legacyCursors[accessToken] || undefined;
      let hasMore = true;
      const itemTransactions = [];

      while (hasMore) {
        const body = { access_token: accessToken, count: 500 };
        if (cursor) body.cursor = cursor;

        const data = await plaidFetch(config, "/transactions/sync", body);

        for (const txn of data.added || []) {
          itemTransactions.push(txn);
        }

        cursor = data.next_cursor;
        hasMore = data.has_more;
      }

      // Save updated cursor
      if (cursor) {
        updateSourceCursor(config.sourcesPath, accessToken, cursor);
      }

      // Filter and normalize transactions
      for (const txn of itemTransactions) {
        const txnDate = txn.date;
        if (startDate && txnDate < startDate) continue;
        if (endDate && txnDate > endDate) continue;
        if (accountFilter && txn.account_id !== accountFilter) continue;

        allTransactions.push({
          id: txn.transaction_id,
          date: txn.date,
          amount: txn.amount,
          description: txn.name || txn.merchant_name || "",
          category: txn.personal_finance_category
            ? txn.personal_finance_category.primary
            : (txn.category || []).join(", "),
          merchantName: txn.merchant_name || null,
          pending: txn.pending || false,
          accountId: txn.account_id,
          provider: PROVIDER_ID,
          sourceId,
          sourceLabel,
          institution: txn.institution_id || undefined,
        });
      }
    } catch (err) {
      allTransactions.push({
        id: null,
        date: null,
        amount: null,
        description: `Error (${sourceLabel}): ${err.message}`,
        provider: PROVIDER_ID,
        sourceId,
        sourceLabel,
      });
    }
  }

  return allTransactions;
}

// --- Plaid Link helpers ---

async function createLinkToken(config, options = {}) {
  const data = await plaidFetch(config, "/link/token/create", {
    user: { client_user_id: options.userId || "assistant-user" },
    client_name: "Assistant Finance",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
  });
  return data.link_token;
}

async function exchangePublicToken(config, publicToken) {
  const data = await plaidFetch(config, "/item/public_token/exchange", {
    public_token: publicToken,
  });
  return {
    accessToken: data.access_token,
    itemId: data.item_id,
  };
}

async function removeItem(config, accessToken) {
  return plaidFetch(config, "/item/remove", {
    access_token: accessToken,
  });
}

module.exports = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  isConfigured,
  hasCredentials,
  listAccounts,
  getBalances,
  getTransactions,
  loadPlaidConfig,
  plaidFetch,
  createLinkToken,
  exchangePublicToken,
  removeItem,
};
