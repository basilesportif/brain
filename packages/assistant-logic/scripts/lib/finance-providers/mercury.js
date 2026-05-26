const {
  listAccounts: mercuryListAccounts,
  getAllBalances: mercuryGetAllBalances,
  getTransactions: mercuryGetTransactions,
  loadMercuryConfig,
} = require("../mercury-service");
const { getWorkspaceContext } = require("../workspace");
const { loadWorkspaceEnv } = require("../runtime-env");
const {
  getSourcesByProvider,
  resolveMercuryToken,
  getLegacyMercuryToken,
} = require("../finance-sources");

const PROVIDER_ID = "mercury";
const PROVIDER_NAME = "Mercury";

/**
 * Resolve all Mercury token configs: returns an array of
 * { token, sourceId, sourceLabel } objects.
 *
 * - If finance-sources.json has mercury entries, use those.
 * - Otherwise fall back to the legacy MERCURY_API_TOKEN env var.
 */
function resolveTokenConfigs(options = {}) {
  const sources = getSourcesByProvider("mercury", options);

  if (sources.length > 0) {
    const configs = [];
    for (const source of sources) {
      const token = resolveMercuryToken(source, options);
      if (token) {
        configs.push({
          token,
          sourceId: source.id,
          sourceLabel: source.label,
        });
      }
    }
    return configs;
  }

  // Legacy fallback: single MERCURY_API_TOKEN
  const legacyToken = getLegacyMercuryToken(options);
  if (legacyToken) {
    return [
      {
        token: legacyToken,
        sourceId: "mercury_legacy",
        sourceLabel: "Mercury",
      },
    ];
  }

  return [];
}

function isConfigured(options = {}) {
  try {
    return resolveTokenConfigs(options).length > 0;
  } catch {
    return false;
  }
}

async function listAccounts(options = {}) {
  const tokenConfigs = resolveTokenConfigs(options);
  const allAccounts = [];

  for (const { token, sourceId, sourceLabel } of tokenConfigs) {
    try {
      const config = loadMercuryConfig({ ...options, token });
      const accounts = await mercuryListAccounts({ config });
      for (const a of accounts) {
        allAccounts.push({
          id: a.id,
          name: a.name,
          kind: a.kind,
          status: a.status,
          provider: PROVIDER_ID,
          sourceId,
          sourceLabel,
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
  const tokenConfigs = resolveTokenConfigs(options);
  const allBalances = [];

  for (const { token, sourceId, sourceLabel } of tokenConfigs) {
    try {
      const config = loadMercuryConfig({ ...options, token });
      const balances = await mercuryGetAllBalances({ config });
      for (const b of balances) {
        allBalances.push({
          id: b.id,
          name: b.name,
          kind: b.kind,
          currentBalance: b.currentBalance,
          availableBalance: b.availableBalance,
          provider: PROVIDER_ID,
          sourceId,
          sourceLabel,
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

async function getTransactions(options = {}) {
  const tokenConfigs = resolveTokenConfigs(options);

  // Determine date range
  let start = options.start || null;
  let end = options.end || null;
  if (!start && !end) {
    const days = options.days || 30;
    const now = new Date();
    end = now.toISOString().split("T")[0];
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - days);
    start = startDate.toISOString().split("T")[0];
  }

  const limit = options.limit || 50;
  const allTransactions = [];

  for (const { token, sourceId, sourceLabel } of tokenConfigs) {
    try {
      const config = loadMercuryConfig({ ...options, token });

      // Determine accounts to query
      let accountIds;
      if (options.account) {
        accountIds = [options.account];
      } else {
        const accounts = await mercuryListAccounts({ config });
        accountIds = accounts.map((a) => a.id);
      }

      for (const accountId of accountIds) {
        const transactions = await mercuryGetTransactions(accountId, {
          config,
          start,
          end,
          limit,
        });
        for (const txn of transactions) {
          allTransactions.push({
            ...txn,
            accountId,
            provider: PROVIDER_ID,
            sourceId,
            sourceLabel,
          });
        }
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

module.exports = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  isConfigured,
  listAccounts,
  getBalances,
  getTransactions,
};
