const fs = require("fs");
const path = require("path");
const { getWorkspaceContext, getWorkspacePaths } = require("./workspace");
const { loadWorkspaceEnv } = require("./runtime-env");

/**
 * Shared helpers for reading/writing workspace/data/finance-sources.json.
 *
 * Schema (version 1):
 * {
 *   "version": 1,
 *   "sources": [ { id, provider, label, envKey|accessToken, addedAt, ... } ],
 *   "syncCursors": { ... }   // Plaid sync cursors (keyed by access token)
 * }
 */

function getSourcesPath(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const paths = getWorkspacePaths(context);
  return path.join(paths.dataDir, "finance-sources.json");
}

function loadSources(options = {}) {
  const sourcesPath = options.sourcesPath || getSourcesPath(options);
  if (!fs.existsSync(sourcesPath)) {
    return { version: 1, sources: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));
    if (!data.version) data.version = 1;
    if (!Array.isArray(data.sources)) data.sources = [];
    return data;
  } catch {
    return { version: 1, sources: [] };
  }
}

function saveSources(data, options = {}) {
  const sourcesPath = options.sourcesPath || getSourcesPath(options);
  const dir = path.dirname(sourcesPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sourcesPath, JSON.stringify(data, null, 2));
}

/**
 * Return sources filtered by provider, or all if no provider specified.
 */
function getSourcesByProvider(provider, options = {}) {
  const data = loadSources(options);
  return data.sources.filter(
    (s) => s.provider === provider && s.enabled !== false
  );
}

/**
 * Generate the next unique ID for a given provider.
 * E.g. mercury_1, mercury_2, plaid_1, etc.
 */
function generateId(provider, existingSources) {
  const providerSources = existingSources.filter(
    (s) => s.provider === provider
  );
  let max = 0;
  for (const s of providerSources) {
    const match = s.id && s.id.match(new RegExp(`^${provider}_(\\d+)$`));
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return `${provider}_${max + 1}`;
}

/**
 * Add a source entry. Returns the created source object.
 */
function addSource(entry, options = {}) {
  const data = loadSources(options);
  const id = entry.id || generateId(entry.provider, data.sources);
  const source = {
    id,
    provider: entry.provider,
    label: entry.label || `${entry.provider} account`,
    addedAt: new Date().toISOString(),
    enabled: true,
    ...entry,
    id, // ensure generated id wins
  };
  data.sources.push(source);
  saveSources(data, options);
  return source;
}

/**
 * Remove a source by ID. Returns the removed source or null.
 */
function removeSource(sourceId, options = {}) {
  const data = loadSources(options);
  const idx = data.sources.findIndex((s) => s.id === sourceId);
  if (idx === -1) return null;
  const [removed] = data.sources.splice(idx, 1);

  // Clean up Plaid sync cursors if applicable
  if (removed.provider === "plaid" && removed.accessToken && data.syncCursors) {
    delete data.syncCursors[removed.accessToken];
  }

  saveSources(data, options);
  return removed;
}

/**
 * Resolve the API token for a Mercury source entry by reading the env key.
 */
function resolveMercuryToken(source, options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const { env } = loadWorkspaceEnv({ context, processEnv: options.processEnv });
  return env[source.envKey] || null;
}

/**
 * Get the legacy MERCURY_API_TOKEN from env (for backwards compat).
 */
function getLegacyMercuryToken(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const { env } = loadWorkspaceEnv({ context, processEnv: options.processEnv });
  return env.MERCURY_API_TOKEN || null;
}

module.exports = {
  getSourcesPath,
  loadSources,
  saveSources,
  getSourcesByProvider,
  generateId,
  addSource,
  removeSource,
  resolveMercuryToken,
  getLegacyMercuryToken,
};
