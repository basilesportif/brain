const { getWorkspaceContext, getWorkspacePaths } = require("./workspace");
const { loadWorkspaceEnv, requireEnv } = require("./runtime-env");

const MERCURY_BASE_URL = "https://api.mercury.com/api/v1";

function loadMercuryConfig(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const paths = getWorkspacePaths(context);
  const { env } = loadWorkspaceEnv({
    context,
    processEnv: options.processEnv,
  });

  // Allow callers to supply the token directly (multi-account support)
  const MERCURY_API_TOKEN =
    options.token ||
    requireEnv(
      env,
      "MERCURY_API_TOKEN",
      `MERCURY_API_TOKEN not set. Add it to ${paths.workspaceEnvPath} or run /setup-finance.`
    );

  return {
    context,
    paths,
    env,
    MERCURY_API_TOKEN,
    MERCURY_BASE_URL,
  };
}

async function mercuryFetch(config, path, query = {}) {
  const url = new URL(`${config.MERCURY_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.MERCURY_API_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Mercury API ${response.status} ${response.statusText} on ${path}: ${body}`
    );
  }

  return response.json();
}

async function listAccounts(options = {}) {
  const config = options.config || loadMercuryConfig(options);
  const data = await mercuryFetch(config, "/accounts");
  return data.accounts || [];
}

async function getAccount(accountId, options = {}) {
  const config = options.config || loadMercuryConfig(options);
  return mercuryFetch(config, `/account/${accountId}`);
}

async function getTransactions(accountId, options = {}) {
  const config = options.config || loadMercuryConfig(options);
  const query = {};
  if (options.limit !== undefined) query.limit = options.limit;
  if (options.offset !== undefined) query.offset = options.offset;
  if (options.start) query.start = options.start;
  if (options.end) query.end = options.end;
  if (options.status) query.status = options.status;
  if (options.search) query.search = options.search;

  const data = await mercuryFetch(
    config,
    `/account/${accountId}/transactions`,
    query
  );
  return data.transactions || [];
}

async function getAllBalances(options = {}) {
  const config = options.config || loadMercuryConfig(options);
  const accounts = await listAccounts({ config });
  const results = [];

  for (const account of accounts) {
    const details = await getAccount(account.id, { config });
    results.push({
      id: account.id,
      name: account.name,
      kind: account.kind,
      status: account.status,
      currentBalance: details.currentBalance,
      availableBalance: details.availableBalance,
    });
  }

  return results;
}

module.exports = {
  MERCURY_BASE_URL,
  loadMercuryConfig,
  mercuryFetch,
  listAccounts,
  getAccount,
  getTransactions,
  getAllBalances,
};
