# Composio Connect Skill

Generates shareable OAuth connection links for Composio integrations. Use this when a user needs to connect a new service (Gmail, Google Calendar, etc.) without visiting the Composio dashboard.

## Flow

### 1. Ask what to connect

Ask the user which app/service they want to connect. Common options:
- `gmail` — Gmail access
- `google_calendar` — Google Calendar access
- `googlesheets` — Google Sheets
- `slack` — Slack
- `github` — GitHub

Also ask for a user identifier (name or email) to tag the connection.

### 2. Generate the link

```bash
node scripts/composio-connect.js --generate --app <app_name> --user-id "<user_id>"
```

This returns JSON with:
- `redirectUrl` — the shareable OAuth link
- `connectedAccountId` — the pre-assigned `ca_` ID
- `connectionStatus` — should be `INITIATED`

### 3. Share the link

Present the `redirectUrl` to the user. Tell them:
> Open this link to authorize access. After completing the OAuth flow, let me know and I'll verify the connection.

If communicating via Telegram, send the link as a message.

### 4. Wait and verify

After the user confirms they completed auth, check the status:

```bash
node scripts/composio-connect.js --check --id <connectedAccountId>
```

If status is `ACTIVE`, the connection succeeded. If still `INITIATED`, ask them to try again or check for errors.

### 5. Update composio.yaml

Once active, tell the user to add the new account to `workspace/composio.yaml`:

```yaml
# Example for a new Gmail account
accounts:
  gmail:
    - id: <connectedAccountId>
      email: user@example.com
```

Or offer to update it for them if they confirm the email address.

## Utility commands

```bash
# List available integrations (to find app names)
node scripts/composio-connect.js --list-configs
node scripts/composio-connect.js --list-configs --app gmail

# List all connected accounts and their status
node scripts/composio-connect.js --list

# Check a specific connection
node scripts/composio-connect.js --check --id ca_xxxxx
```

## App name aliases

The script maps common names to Composio's actual app names:
- `google_calendar` → `googlecalendar`
- `google_sheets` → `googlesheets`
- `google_drive` → `googledrive`
- `google_docs` → `googledocs`
- `gmail` works as-is

You can use either form with `--app`.

## v3 API endpoint

The script uses the current v3.1 endpoint (`POST /api/v3.1/connected_accounts/link`) to generate connection links. The legacy `--v3` flag is still accepted for compatibility, but v3.1 is always used.

Additional v3.1 endpoints:
- **Check status**: `GET /api/v3.1/connected_accounts/{nanoid}`
- **Manual refresh**: `POST /api/v3.1/connected_accounts/{nanoid}/refresh` (also available via `--refresh --id <ca_id>`)

## Notes

- The script uses `COMPOSIO_API_KEY` from the environment (loaded via `scripts/lib/config.js`).
- **Connection links expire in ~10 minutes** (status stays `INITIATED`). The user must complete OAuth promptly. Generate a fresh link if they miss the window.
- After OAuth completion, Composio auto-refreshes tokens. Connections only expire if the provider revokes the refresh token.
- **If connections keep expiring immediately after auth**, the likely cause is Composio's managed OAuth app being unverified with Google. The fix is to create a custom auth config in the Composio dashboard using the user's own Google Cloud OAuth client credentials (client ID + secret).
- The `--user-id` flag tags the connection in Composio for identification. Use a consistent ID per user.
- If `--list-configs` returns no results for an app, the integration may need to be created first in the Composio dashboard.
