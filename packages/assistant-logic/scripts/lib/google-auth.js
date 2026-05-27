const { COMPOSIO_BASE, loadComposioConfig } = require("./config");

/**
 * Historical note: this module used to return OAuth access tokens that
 * scripts then used to hit Google APIs directly. As of April 2026 Composio
 * always returns "REDACTED" for stored tokens on the v3 connected_accounts
 * endpoint, so the direct-token path no longer works.
 *
 * Instead we route every Google API call through Composio's current v3.1
 * proxy endpoint (`/api/v3.1/tools/execute/proxy`). The proxy accepts a
 * connected-account ID, an upstream URL or path, an HTTP method, optional
 * query/header parameters, and an optional body, then injects the stored
 * OAuth credentials server-side. This keeps every script's call-site
 * identical — we just hand around an opaque client object
 * (`{ composio, connectedAccountId }`) where a raw token used to go.
 */

const COMPOSIO_API_VERSION = "v3.1";
const COMPOSIO_PROXY_PATH = `/api/${COMPOSIO_API_VERSION}/tools/execute/proxy`;

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
  const proxyBody = buildProxyRequest(connectedAccountId, url, options);

  const res = await fetch(
    `${composio.COMPOSIO_BASE || COMPOSIO_BASE}${COMPOSIO_PROXY_PATH}`,
    {
      method: "POST",
      headers: {
        "x-api-key": composio.COMPOSIO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(proxyBody),
    }
  );

  let errorPayload;
  if (!res.ok) {
    const text = await res.text();
    try {
      errorPayload = JSON.parse(text);
    } catch {
      errorPayload = { raw: text };
    }
    if (shouldFallbackFromProxy(res.status, errorPayload)) {
      return executeMappedGoogleTool(composio, connectedAccountId, url, options);
    }
    throw new Error(`Composio proxy HTTP ${res.status}: ${text}`);
  }

  const envelope = await res.json();

  // v3.1 proxy envelope: { data, status, headers, binary_data }.
  if (envelope && (envelope.successful === false || envelope.error)) {
    const msg =
      (envelope.error && (envelope.error.message || envelope.error)) ||
      "Composio proxy call failed";
    throw new Error(`Google API via Composio proxy: ${msg}`);
  }

  if (envelope && envelope.status && envelope.status >= 400) {
    const data = envelope.data;
    const detail =
      data?.error?.message ||
      data?.message ||
      (typeof data === "string" ? data : JSON.stringify(data));
    throw new Error(`Google API ${envelope.status}: ${detail}`);
  }

  // If upstream returned an error payload nested inside data, surface it.
  const data = envelope?.data;
  if (data && typeof data === "object" && data.error && data.error.code) {
    const e = data.error;
    throw new Error(`Google API ${e.code}: ${e.message || JSON.stringify(e)}`);
  }

  return data;
}

function shouldFallbackFromProxy(status, payload) {
  const slug = payload?.error?.slug;
  return status === 410 || slug === "ExternalProxy_OrgNotAllowed";
}

async function executeMappedGoogleTool(composio, connectedAccountId, url, options = {}) {
  const mapped = mapGoogleApiToComposioTool(url, options);
  if (!mapped) {
    throw new Error(
      "Composio proxy is unavailable and no v3 tool mapping exists for this Google API call"
    );
  }
  const data = await composioExecute(mapped.toolSlug, connectedAccountId, mapped.arguments, {
    composio,
  });
  return normalizeMappedToolResult(mapped.toolSlug, data);
}

function normalizeMappedToolResult(toolSlug, data) {
  if (toolSlug === "GOOGLECALENDAR_LIST_CALENDARS" && data?.calendars) {
    return {
      ...data,
      items: data.calendars,
      nextPageToken: data.next_page_token,
      nextSyncToken: data.next_sync_token,
    };
  }
  return data;
}

function mapGoogleApiToComposioTool(rawUrl, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const parsed = parseUrl(rawUrl).url;
  const pathname = parsed.pathname;
  const params = parsed.searchParams;

  if (isGoogleCalendarHost(parsed.hostname)) {
    return mapCalendarCall(method, pathname, params, options);
  }
  if (parsed.hostname === "gmail.googleapis.com") {
    return mapGmailCall(method, pathname, params, options);
  }
  return null;
}

function mapCalendarCall(method, pathname, params, options) {
  if (method === "GET" && pathname === "/calendar/v3/users/me/calendarList") {
    return {
      toolSlug: "GOOGLECALENDAR_LIST_CALENDARS",
      arguments: cleanObject({
        max_results: intParam(params, "maxResults"),
        page_token: params.get("pageToken") || undefined,
        sync_token: params.get("syncToken") || undefined,
        show_hidden: boolParam(params, "showHidden"),
        show_deleted: boolParam(params, "showDeleted"),
        min_access_role: params.get("minAccessRole") || undefined,
      }),
    };
  }

  const eventMatch = pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (!eventMatch) return null;
  const calendarId = decodeURIComponent(eventMatch[1]);
  const eventId = eventMatch[2] ? decodeURIComponent(eventMatch[2]) : null;

  if (method === "GET" && eventId) {
    return {
      toolSlug: "GOOGLECALENDAR_EVENTS_GET",
      arguments: cleanObject({
        calendar_id: calendarId,
        event_id: eventId,
        time_zone: params.get("timeZone") || undefined,
        max_attendees: intParam(params, "maxAttendees"),
      }),
    };
  }

  if (method === "GET") {
    return {
      toolSlug: "GOOGLECALENDAR_EVENTS_LIST",
      arguments: cleanObject({
        calendarId,
        q: params.get("q") || undefined,
        iCalUID: params.get("iCalUID") || undefined,
        orderBy: params.get("orderBy") || undefined,
        timeMax: params.get("timeMax") || undefined,
        timeMin: params.get("timeMin") || undefined,
        timeZone: params.get("timeZone") || undefined,
        pageToken: params.get("pageToken") || undefined,
        syncToken: params.get("syncToken") || undefined,
        eventTypes: params.get("eventTypes") || undefined,
        maxResults: intParam(params, "maxResults"),
        updatedMin: params.get("updatedMin") || undefined,
        showDeleted: boolParam(params, "showDeleted"),
        maxAttendees: intParam(params, "maxAttendees"),
        singleEvents: boolParam(params, "singleEvents"),
        showHiddenInvitations: boolParam(params, "showHiddenInvitations"),
        sharedExtendedProperty: params.get("sharedExtendedProperty") || undefined,
        privateExtendedProperty: params.get("privateExtendedProperty") || undefined,
      }),
    };
  }

  if (method === "POST" && !eventId) {
    return {
      toolSlug: "GOOGLECALENDAR_CREATE_EVENT",
      arguments: googleEventToCreateArgs(calendarId, params, parseBody(options.body)),
    };
  }

  if (method === "PATCH" && eventId) {
    return {
      toolSlug: "GOOGLECALENDAR_PATCH_EVENT",
      arguments: googleEventToPatchArgs(calendarId, eventId, params, parseBody(options.body)),
    };
  }

  return null;
}

function mapGmailCall(method, pathname, params, options) {
  if (method === "GET" && pathname === "/gmail/v1/users/me/profile") {
    return { toolSlug: "GMAIL_GET_PROFILE", arguments: { user_id: "me" } };
  }

  if (method === "GET" && pathname === "/gmail/v1/users/me/messages") {
    return {
      toolSlug: "GMAIL_LIST_MESSAGES",
      arguments: cleanObject({
        user_id: "me",
        q: params.get("q") || undefined,
        label_ids: params.getAll("labelIds").length ? params.getAll("labelIds") : undefined,
        page_token: params.get("pageToken") || undefined,
        max_results: intParam(params, "maxResults"),
        include_spam_trash: boolParam(params, "includeSpamTrash"),
      }),
    };
  }

  const messageMatch = pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
  if (method === "GET" && messageMatch) {
    return {
      toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      arguments: cleanObject({
        user_id: "me",
        message_id: decodeURIComponent(messageMatch[1]),
        format: params.get("format") || undefined,
      }),
    };
  }

  const threadMatch = pathname.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/);
  if (method === "GET" && threadMatch) {
    return {
      toolSlug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      arguments: cleanObject({
        user_id: "me",
        thread_id: decodeURIComponent(threadMatch[1]),
        page_token: params.get("pageToken") || undefined,
      }),
    };
  }

  if (method === "POST" && pathname === "/gmail/v1/users/me/messages/send") {
    const parsed = parseRawGmailSend(parseBody(options.body));
    if (parsed) {
      return { toolSlug: parsed.toolSlug, arguments: parsed.arguments };
    }
  }

  return null;
}

function googleEventToCreateArgs(calendarId, params, body) {
  const times = extractEventTimes(body);
  return cleanObject({
    calendar_id: calendarId,
    summary: body.summary,
    location: body.location,
    description: body.description,
    transparency: body.transparency,
    visibility: body.visibility,
    recurrence: body.recurrence,
    reminders: body.reminders,
    attendees: normalizeAttendees(body.attendees),
    start_datetime: times.start,
    end_datetime: times.end,
    timezone: times.timezone,
    send_updates: params.get("sendUpdates") || undefined,
  });
}

function googleEventToPatchArgs(calendarId, eventId, params, body) {
  const times = extractEventTimes(body);
  return cleanObject({
    calendar_id: calendarId,
    event_id: eventId,
    summary: body.summary,
    location: body.location,
    description: body.description,
    transparency: body.transparency,
    visibility: body.visibility,
    recurrence: body.recurrence,
    reminders: body.reminders,
    attendees: normalizeAttendees(body.attendees),
    start_time: times.start,
    end_time: times.end,
    timezone: times.timezone,
    status: body.status,
    send_updates: params.get("sendUpdates") || undefined,
  });
}

function extractEventTimes(body) {
  const start = body.start || {};
  const end = body.end || {};
  return {
    start: start.dateTime || start.date,
    end: end.dateTime || end.date,
    timezone: start.timeZone || end.timeZone,
  };
}

function normalizeAttendees(attendees) {
  if (!Array.isArray(attendees)) return undefined;
  return attendees
    .map((attendee) => (typeof attendee === "string" ? attendee : attendee?.email))
    .filter(Boolean);
}

function parseRawGmailSend(body) {
  if (!body || !body.raw) return null;
  const raw = Buffer.from(String(body.raw).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const splitAt = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  if (splitAt < 0) return null;
  const headerText = raw.slice(0, splitAt);
  const messageBody = raw.slice(splitAt).replace(/^\r?\n\r?\n/, "");
  const headers = parseRfcHeaders(headerText);
  if (body.threadId) {
    return {
      toolSlug: "GMAIL_REPLY_TO_THREAD",
      arguments: cleanObject({
        user_id: "me",
        thread_id: body.threadId,
        recipient_email: firstEmail(headers.to),
        cc: emailList(headers.cc),
        message_body: messageBody,
        is_html: /html/i.test(headers["content-type"] || ""),
      }),
    };
  }
  return {
    toolSlug: "GMAIL_SEND_EMAIL",
    arguments: cleanObject({
      user_id: "me",
      recipient_email: firstEmail(headers.to),
      cc: emailList(headers.cc),
      subject: headers.subject,
      body: messageBody,
      from_email: firstEmail(headers.from),
      is_html: /html/i.test(headers["content-type"] || ""),
    }),
  };
}

function parseRfcHeaders(headerText) {
  const headers = {};
  let current = null;
  for (const line of headerText.split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    current = line.slice(0, idx).trim().toLowerCase();
    headers[current] = line.slice(idx + 1).trim();
  }
  return headers;
}

function firstEmail(value) {
  const emails = emailList(value);
  return emails ? emails[0] : undefined;
}

function emailList(value) {
  if (!value) return undefined;
  const emails = String(value)
    .split(",")
    .map((part) => {
      const match = part.match(/<([^>]+)>/);
      return (match ? match[1] : part).trim();
    })
    .filter(Boolean);
  return emails.length ? emails : undefined;
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function intParam(params, key) {
  const value = params.get(key);
  return value === null ? undefined : parseInt(value, 10);
}

function boolParam(params, key) {
  const value = params.get(key);
  if (value === null) return undefined;
  return value === "true";
}

function cleanObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== null)
  );
}

function isGoogleCalendarHost(hostname) {
  return hostname === "www.googleapis.com";
}

function buildProxyRequest(connectedAccountId, url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const { endpoint, queryParameters } = splitEndpointAndQuery(url);

  const proxyBody = {
    connected_account_id: connectedAccountId,
    endpoint,
    method,
  };

  const parameters = [...queryParameters];

  // Attach body if provided. Composio expects a JSON object for writes;
  // the caller's options.body is a JSON string (matching the fetch API)
  // which we parse back into an object when possible.
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
    for (const [name, value] of Object.entries(options.headers)) {
      const lower = name.toLowerCase();
      if (lower === "authorization" || lower === "content-type") continue;
      parameters.push({ name, value: String(value), type: "header" });
    }
  }

  if (parameters.length > 0) proxyBody.parameters = parameters;
  return proxyBody;
}

function splitEndpointAndQuery(rawUrl) {
  const parsed = parseUrl(rawUrl);
  const endpoint = parsed.absolute
    ? `${parsed.url.origin}${parsed.url.pathname}`
    : parsed.url.pathname;
  const queryParameters = [];
  for (const [name, value] of parsed.url.searchParams.entries()) {
    queryParameters.push({ name, value, type: "query" });
  }
  return { endpoint, queryParameters };
}

function parseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new Error("googleFetch: url must be a non-empty string");
  }
  try {
    return { absolute: true, url: new URL(rawUrl) };
  } catch {
    return { absolute: false, url: new URL(rawUrl, "https://placeholder.local") };
  }
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
      `${composio.COMPOSIO_BASE || COMPOSIO_BASE}/api/${COMPOSIO_API_VERSION}/connected_accounts?connected_account_ids=${connectedAccountId}`,
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
    `${composio.COMPOSIO_BASE || COMPOSIO_BASE}/api/${COMPOSIO_API_VERSION}/tools/execute/${action}`,
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

module.exports = {
  getAccessToken,
  googleFetch,
  composioExecute,
  buildProxyRequest,
  mapGoogleApiToComposioTool,
};
