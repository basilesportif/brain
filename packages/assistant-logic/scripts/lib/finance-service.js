const mercuryProvider = require("./finance-providers/mercury");
const plaidProvider = require("./finance-providers/plaid");

const PROVIDERS = [mercuryProvider, plaidProvider];

function getProviderRegistry() {
  return PROVIDERS;
}

function getProvider(id) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) {
    throw new Error(
      `Unknown finance provider: ${id}. Available: ${PROVIDERS.map((p) => p.id).join(", ")}`
    );
  }
  return provider;
}

function getConfiguredProviders(options = {}) {
  return PROVIDERS.filter((p) => p.isConfigured(options));
}

function resolveProviders(options = {}) {
  if (options.provider) {
    const provider = getProvider(options.provider);
    if (!provider.isConfigured(options)) {
      throw new Error(
        `Provider '${options.provider}' is not configured. Check workspace/.env and workspace/data/finance-sources.json.`
      );
    }
    return [provider];
  }
  const configured = getConfiguredProviders(options);
  if (configured.length === 0) {
    throw new Error(
      "No finance providers configured. Run /setup-finance to add a provider."
    );
  }
  return configured;
}

async function listAccounts(options = {}) {
  const providers = resolveProviders(options);
  const results = [];
  for (const provider of providers) {
    const accounts = await provider.listAccounts(options);
    results.push(...accounts);
  }
  return results;
}

async function getBalances(options = {}) {
  const providers = resolveProviders(options);
  const results = [];
  for (const provider of providers) {
    const balances = await provider.getBalances(options);
    results.push(...balances);
  }
  return results;
}

async function getTransactions(options = {}) {
  const providers = resolveProviders(options);
  const results = [];
  for (const provider of providers) {
    const transactions = await provider.getTransactions(options);
    results.push(...transactions);
  }

  // Sort by date descending across all providers
  results.sort((a, b) => {
    const dateA = a.date || a.postedDate || a.createdAt || "";
    const dateB = b.date || b.postedDate || b.createdAt || "";
    return dateB.localeCompare(dateA);
  });

  // Apply global limit if specified
  const limit = options.limit || 50;
  return results.slice(0, limit);

}

module.exports = {
  getProviderRegistry,
  getProvider,
  getConfiguredProviders,
  resolveProviders,
  listAccounts,
  getBalances,
  getTransactions,
};
