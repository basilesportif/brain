# Setup Composio Skill

Guides the user through Composio setup for Gmail and Google Calendar access.

Secrets belong exclusively in `workspace/.env`. Process env can override for a single command. There is no repo-root `.env` fallback.

## Pre-check

Check if `workspace/.env` or the shell has a non-empty `COMPOSIO_API_KEY` AND `workspace/composio.yaml` has at least one real `ca_` ID (not `ca_XXXX` placeholder).

If both are configured, print:
> Composio is already configured — API key and account IDs are set.

Then stop.

## Step 1: API Key

Check if `workspace/.env` or the shell has a non-empty `COMPOSIO_API_KEY`.

**If already set**, skip to Step 2:
> Composio API key already configured — skipping to account setup.

**If missing or empty:**
1. Tell the user:
   > You need a Composio API key:
   > 1. Go to https://app.composio.dev/settings
   > 2. Find the "API Keys" section
   > 3. Copy your API key
2. Prompt for the key via AskUserQuestion.
3. Write/append `COMPOSIO_API_KEY=<value>` to `workspace/.env`. If it exists, add the line or replace an existing empty `COMPOSIO_API_KEY=` line. If it doesn't exist, create it from `config/workspace-template/.env.example`.

## Step 2: Connect Google accounts

Tell the user:
> Now you need to connect your Google account(s) to Composio:
> 1. Go to https://app.composio.dev/connected_accounts
> 2. Click "Add Connection" and connect **Google Calendar**
> 3. Click "Add Connection" again and connect **Gmail** (repeat for each email account you want to monitor)
> 4. After connecting, each account will show a Connected Account ID starting with `ca_`

Wait for user to confirm they've connected their accounts.

## Step 3: Account IDs

Prompt for account details using AskUserQuestion:

1. Ask for the Google Calendar connected account ID (`ca_...`) and the email address associated with it.
2. Ask how many Gmail accounts they connected.
3. For each Gmail account, ask for the connected account ID (`ca_...`) and email address.
4. Optionally ask if they have named calendar aliases (e.g., "personal", "work") and their calendar IDs.

## Step 4: Write composio.yaml

Read `workspace/composio.yaml`, then overwrite it with the collected account information. Use this structure:

```yaml
accounts:
  google_calendar:
    id: <calendar_ca_id>
    email: <calendar_email>
  gmail:
    - id: <gmail_ca_id_1>
      email: <email_1>
    - id: <gmail_ca_id_2>
      email: <email_2>

calendars:
  # Named aliases (optional)
  personal: <email>
```

## Step 5: Verify

Run:
```bash
node -e "const c = require('./scripts/lib/config'); console.log('Composio OK:', Object.keys(c.ACCOUNTS))"
```

If it succeeds, print:
> Composio setup complete. Gmail and Calendar scripts are ready to use.

If it fails, show the error and suggest checking `workspace/.env` and `workspace/composio.yaml`.

## Google OAuth note

Google connections via Composio's managed OAuth app may have short-lived refresh tokens if the app is unverified (Google limits unverified apps to 7-day refresh token expiry). For production or long-term use, create a custom auth config in Composio using your own Google Cloud OAuth credentials (a verified app with appropriate scopes). This ensures stable, long-lived refresh tokens.

## Rules

- Never log the full API key in output — only confirm it was saved.
- `workspace/.env` is gitignored — never commit it.
