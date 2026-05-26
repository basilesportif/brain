# Setup Whoop

Interactive setup skill for configuring the WHOOP integration.

## Detection Phase

1. Check whether `WHOOP_CLIENT_ID` exists in `workspace/.env`.
2. If the env vars exist, verify the connection:
   ```bash
   node scripts/whoop-profile.js
   ```
3. Present status to the user and either continue setup or confirm the integration is already working.

## Prerequisites

Register a WHOOP developer app at:

`https://developer.whoop.com`

The app must have a redirect URI that matches `WHOOP_REDIRECT_URI`.

## Setup Steps

### Step 1: Save env vars

Add these values to `workspace/.env`:

```dotenv
WHOOP_CLIENT_ID=...
WHOOP_CLIENT_SECRET=...
WHOOP_REDIRECT_URI=http://localhost:8787/callback
```

Use the exact redirect URI configured in the WHOOP developer dashboard.

### Step 2: Run OAuth

Localhost mode is the default and is recommended:

```bash
node scripts/whoop-connect.js
```

Equivalent explicit command:

```bash
node scripts/whoop-connect.js --mode localhost
```

What localhost mode does:

1. Starts a temporary HTTP listener on the port from `WHOOP_REDIRECT_URI`
2. Prints an authorization URL
3. Waits up to 120 seconds for the WHOOP redirect callback
4. Exchanges the code for tokens and saves them to `workspace/data/whoop-auth.json`

Manual mode is available if a local callback is inconvenient:

```bash
node scripts/whoop-connect.js --mode manual
```

What manual mode does:

1. Prints the authorization URL
2. Prompts for either the full redirect URL or just the authorization code
3. Exchanges the code for tokens and saves them to `workspace/data/whoop-auth.json`

### Step 3: Verify

Run a smoke test:

```bash
node scripts/whoop-profile.js
```

Then test a collection endpoint:

```bash
node scripts/whoop-recovery.js --limit 5
```

## Post-Setup Smoke Test

Successful setup should allow:

- `node scripts/whoop-profile.js`
- `node scripts/whoop-recovery.js --limit 5`
- `node scripts/whoop-sleep.js --limit 5`
- `node scripts/whoop-workout.js --limit 5`

## Rules

- Never log access tokens or refresh tokens.
- `workspace/.env` and `workspace/data/whoop-auth.json` are workspace files, are gitignored, and must not be committed.
- Use read-only scopes only.
