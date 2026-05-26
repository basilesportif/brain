const fs = require("fs");
const path = require("path");
const { getWorkspaceContext, getWorkspacePaths } = require("./workspace");
const { loadWorkspaceEnv, requireEnv } = require("./runtime-env");

const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_SCOPES = [
  "read:recovery",
  "read:cycles",
  "read:workout",
  "read:sleep",
  "read:profile",
  "offline",
];
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function getWhoopConfig(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const paths = getWorkspacePaths(context);
  const { env } = loadWorkspaceEnv({
    context,
    processEnv: options.processEnv,
  });

  return {
    context,
    paths,
    env,
    authFilePath: path.join(paths.dataDir, "whoop-auth.json"),
    clientId: requireEnv(
      env,
      "WHOOP_CLIENT_ID",
      `WHOOP_CLIENT_ID not set. Add it to ${paths.workspaceEnvPath}.`
    ),
    clientSecret: requireEnv(
      env,
      "WHOOP_CLIENT_SECRET",
      `WHOOP_CLIENT_SECRET not set. Add it to ${paths.workspaceEnvPath}.`
    ),
    redirectUri: requireEnv(
      env,
      "WHOOP_REDIRECT_URI",
      `WHOOP_REDIRECT_URI not set. Add it to ${paths.workspaceEnvPath}.`
    ),
  };
}

function loadTokenData(options = {}) {
  const config = options.config || getWhoopConfig(options);
  if (!fs.existsSync(config.authFilePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(config.authFilePath, "utf-8"));
}

function saveTokenData(tokenData, options = {}) {
  const config = options.config || getWhoopConfig(options);
  fs.mkdirSync(path.dirname(config.authFilePath), { recursive: true });
  const tmpPath = `${config.authFilePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(tokenData, null, 2)}\n`);
  fs.renameSync(tmpPath, config.authFilePath);
  return tokenData;
}

function isTokenExpiring(tokenData, skewMs = REFRESH_SKEW_MS) {
  if (!tokenData?.expiresAt) return true;
  const expiresAtMs = Date.parse(tokenData.expiresAt);
  if (Number.isNaN(expiresAtMs)) return true;
  return expiresAtMs - Date.now() <= skewMs;
}

function buildAuthRecord(tokenResponse, existingToken = null) {
  const expiresInSeconds = Number(tokenResponse.expires_in);
  const expiresAt = Number.isFinite(expiresInSeconds)
    ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    : existingToken?.expiresAt || null;

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || existingToken?.refreshToken || null,
    tokenType: tokenResponse.token_type || existingToken?.tokenType || "Bearer",
    scope: tokenResponse.scope || existingToken?.scope || WHOOP_SCOPES.join(" "),
    expiresAt,
    updatedAt: new Date().toISOString(),
  };
}

async function postTokenForm(params, options = {}) {
  const config = options.config || getWhoopConfig(options);
  const body = new URLSearchParams(params);
  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`WHOOP token request failed (${response.status}): ${errorBody}`);
  }

  return response.json();
}

async function exchangeAuthorizationCode(code, options = {}) {
  if (!code) {
    throw new Error("Authorization code is required.");
  }

  const config = options.config || getWhoopConfig(options);
  const tokenResponse = await postTokenForm(
    {
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    },
    { config }
  );

  const authRecord = buildAuthRecord(tokenResponse);
  saveTokenData(authRecord, { config });
  return authRecord;
}

async function refreshAccessToken(options = {}) {
  const config = options.config || getWhoopConfig(options);
  const existingToken = options.tokenData || loadTokenData({ config });
  const refreshToken = options.refreshToken || existingToken?.refreshToken;

  if (!refreshToken) {
    throw new Error(
      `WHOOP refresh token is unavailable. Reconnect with node scripts/whoop-connect.js and ensure tokens were saved to ${config.authFilePath}.`
    );
  }

  const tokenResponse = await postTokenForm(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
    { config }
  );

  const authRecord = buildAuthRecord(tokenResponse, existingToken);
  saveTokenData(authRecord, { config });
  return authRecord;
}

async function getAccessToken(options = {}) {
  const config = options.config || getWhoopConfig(options);
  const tokenData = loadTokenData({ config });

  if (!tokenData?.accessToken) {
    throw new Error(
      `WHOOP is not connected. Run node scripts/whoop-connect.js first to create ${config.authFilePath}.`
    );
  }

  if (isTokenExpiring(tokenData)) {
    const refreshed = await refreshAccessToken({ config, tokenData });
    return refreshed.accessToken;
  }

  return tokenData.accessToken;
}

module.exports = {
  WHOOP_AUTHORIZE_URL,
  WHOOP_TOKEN_URL,
  WHOOP_SCOPES,
  REFRESH_SKEW_MS,
  getWhoopConfig,
  loadTokenData,
  saveTokenData,
  isTokenExpiring,
  exchangeAuthorizationCode,
  refreshAccessToken,
  getAccessToken,
};
