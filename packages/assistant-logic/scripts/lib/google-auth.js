const { COMPOSIO_BASE, loadComposioConfig } = require("./config");

/**
 * Historical note: this module used to return OAuth access tokens that
 * scripts then used to hit Google APIs directly. As of April 2026 Composio
 * always returns "REDACTED" for stored tokens on the v3 connected_accounts
 * endpoint, so the direct-token path no longer works.
 *
 * Instead we route every Google API call through Composio's v2 proxy
 * endpoint (`/api/v2/actions/proxy`). The proxy accepts a connected-account
 * ID, a full upstream URL, an HTTP method, and an optional body, and
 * injects the stored OAuth credentials server-side. This keeps every
 * script's call-site identical — we just hand around an opaque client
 * object (`{ composio, connectedAccountId }`) where a raw token used to go.
 */

/**
 * Build an opaque Google client for a given Composio connected account.
 * Replaces the old `getAccessToken`; returns an object rather than a string.
 */
async function getAccessToken(connectedAccountId, options = {}) {
  const composio = options.composio || loadComposioConfig(options);
  if (!connectedAccountId) {
    throw new Error("getAccessToken: connectedAccountId is required");
  }
  return { composio, connectedAccountId };
}

/**
 * Call a Google API URL via the Composio v2 proxy.
 *
 * Signature matches the previous `googleFetch(token, url, options)` — the
 * first argument is now the opaque client returned by `getAccessToken`.
 * Accepts either an object client (`{composio, connectedAccountId}`) or,
 * for backwards compatibility with any stray caller, a raw connected
 * account ID string.
 */
async function googleFetch(client, url, options = {}) {
  const { composio, connectedAccountId } = normalizeClient(client);
  const method = (options.method || "GET").toUpperCase();

  const proxyBody = {
    connectedAccountId,
    endpoint: url,
    method,
  };

  // Attach body if provided. Composio expects a JSON object for writes;
  // the caller's options.body is a JSON string (matching the old fetch API)
  // which we parse back into an object.
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === "string") {
      try {
        proxyBody.body = JSON.parse(options.body);
      } catch {
        proxyBody.body = options.body;
      }
    } else {
      proxyBody.body = options.body;
    }
  }

  // Forward extra headers if any (rare — Authorization is handled by proxy).
  if (options.headers) {
    const extra = {};
    for (const [k, v] of Object.entries(options.headers)) {
      const lk = k.toLowerCase();
      if (lk === "authorization" || lk === "content-type") continue;
      extra[k] = v;
    }
    if (Object.keys(extra).length > 0) proxyBody.headers = extra;
  }

  const res = await fetch(
    `${composio.COMPOSIO_BASE || COMPOSIO_BASE}/api/v2/actions/proxy`,
    {
      method: "POST",
      headers: {
        "x-api-key": composio.COMPOSIO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(proxyBody),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Composio proxy HTTP ${res.status}: ${text}`);
  }

  const envelope = await res.json();

  // v2 proxy envelope: { data, error, successful, successfull, logId }
  if (envelope && envelope.successful === false) {
    const msg =
      (envelope.error && (envelope.error.message || envelope.error)) ||
      "Composio proxy call failed";
    throw new Error(`Google API via Composio proxy: ${msg}`);
  }

  // If upstream returned an error payload nested inside data, surface it.
  const data = envelope?.data;
  if (data && typeof data === "object" && data.error && data.error.code) {
    const e = data.error;
    throw new Error(`Google API ${e.code}: ${e.message || JSON.stringify(e)}`);
  }

  return data;
}

/**
 * Execute a named Composio action (v3 tools/execute). Useful for calls that
 * the proxy can't satisfy (e.g. Composio-managed helpers) or when a caller
 * prefers the action interface.
 */
async function composioExecute(action, connectedAccountId, input = {}, options = {}) {
  const composio = options.composio || loadComposioConfig(options);

  // Resolve user_id from the connected account — v3 execute requires it.
  let userId = options.userId;
  if (!userId) {
    const lookup = await fetch(
      `${composio.COMPOSIO_BASE || COMPOSIO_BASE}/api/v3/connected_accounts?connected_account_ids=${connectedAccountId}`,
      { headers: { "x-api-key": composio.COMPOSIO_API_KEY } }
    );
    if (lookup.ok) {
      const data = await lookup.json();
      userId = data?.items?.[0]?.user_id || undefined;
    }
  }

  const body = {
    connected_account_id: connectedAccountId,
    arguments: input,
  };
  if (userId) body.user_id = userId;

  const res = await fetch(
    `${composio.COMPOSIO_BASE || COMPOSIO_BASE}/api/v3/tools/execute/${action}`,
    {
      method: "POST",
      headers: {
        "x-api-key": composio.COMPOSIO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const envelope = await res.json();
  if (!res.ok) {
    const msg = envelope?.error?.message || JSON.stringify(envelope);
    throw new Error(`Composio execute ${action}: ${msg}`);
  }
  if (envelope && envelope.successful === false) {
    throw new Error(
      `Composio execute ${action}: ${envelope.error?.message || "unsuccessful"}`
    );
  }
  return envelope.data;
}

function normalizeClient(client) {
  if (!client) throw new Error("googleFetch: client is required");
  if (typeof client === "string") {
    // Legacy raw connected-account ID — build a transient composio config.
    return {
      composio: loadComposioConfig(),
      connectedAccountId: client,
    };
  }
  if (client.connectedAccountId && client.composio) {
    return client;
  }
  throw new Error(
    "googleFetch: client must be {composio, connectedAccountId} (from getAccessToken)"
  );
}

module.exports = { getAccessToken, googleFetch, composioExecute };
