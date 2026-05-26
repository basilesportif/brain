const { getAccessToken, refreshAccessToken } = require("./whoop-auth");

const WHOOP_BASE_URL = "https://api.prod.whoop.com/developer";
const DEFAULT_LIMIT = 25;
const MAX_PAGE_LIMIT = 25;

function parseRequestedLimit(limit) {
  if (limit == null) return DEFAULT_LIMIT;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit: ${limit}`);
  }
  return parsed;
}

function normalizePageLimit(limit) {
  return Math.min(parseRequestedLimit(limit), MAX_PAGE_LIMIT);
}

function buildCollectionUrl(path, params = {}) {
  const searchParams = new URLSearchParams();

  if (params.limit != null) {
    searchParams.set("limit", String(normalizePageLimit(params.limit)));
  }
  if (params.start) {
    searchParams.set("start", params.start);
  }
  if (params.end) {
    searchParams.set("end", params.end);
  }
  if (params.nextToken) {
    searchParams.set("nextToken", params.nextToken);
  }

  const query = searchParams.toString();
  return `${WHOOP_BASE_URL}${path}${query ? `?${query}` : ""}`;
}

async function parseError(response) {
  const body = await response.text();
  if (response.status === 429) {
    throw new Error(
      "WHOOP API rate limit reached (100 requests/minute, 10,000 requests/day). Wait before retrying."
    );
  }
  throw new Error(`WHOOP API ${response.status}: ${body}`);
}

async function authenticatedFetch(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };

  const token = await getAccessToken(options.authOptions);
  let response = await fetch(`${WHOOP_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    await refreshAccessToken(options.authOptions);
    const refreshedToken = await getAccessToken(options.authOptions);
    response = await fetch(`${WHOOP_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...headers,
        Authorization: `Bearer ${refreshedToken}`,
      },
    });
  }

  if (!response.ok) {
    await parseError(response);
  }

  return response;
}

async function fetchPaginated(path, params = {}) {
  const requestedLimit = parseRequestedLimit(params.limit);
  const records = [];
  let nextToken = params.nextToken || null;
  let hasStarted = false;

  while (records.length < requestedLimit) {
    const remaining = requestedLimit - records.length;
    const response = await authenticatedFetch(
      buildCollectionUrl(path, {
        start: params.start,
        end: params.end,
        nextToken,
        limit: remaining,
      }).replace(WHOOP_BASE_URL, "")
    );
    const payload = await response.json();
    const pageRecords = Array.isArray(payload.records) ? payload.records : [];

    records.push(...pageRecords);
    nextToken = payload.next_token || null;
    hasStarted = true;

    if (!nextToken || pageRecords.length === 0) {
      break;
    }
  }

  return {
    data: records,
    nextToken: hasStarted ? nextToken : params.nextToken || null,
  };
}

async function getProfile(options = {}) {
  const response = await authenticatedFetch("/v2/user/profile/basic", {
    authOptions: options.authOptions,
  });
  return response.json();
}

async function getRecovery(options = {}) {
  return fetchPaginated("/v2/recovery", options);
}

async function getCycles(options = {}) {
  return fetchPaginated("/v2/cycle", options);
}

async function getSleep(options = {}) {
  return fetchPaginated("/v2/activity/sleep", options);
}

async function getWorkouts(options = {}) {
  return fetchPaginated("/v2/activity/workout", options);
}

module.exports = {
  WHOOP_BASE_URL,
  DEFAULT_LIMIT,
  authenticatedFetch,
  fetchPaginated,
  getProfile,
  getRecovery,
  getCycles,
  getSleep,
  getWorkouts,
};
