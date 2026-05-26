# Setup Finance

Interactive setup skill for configuring personal finance data sources.

## Detection Phase

1. List existing sources:
   ```bash
   node scripts/finance-source.js --list
   ```

2. If any sources are configured, verify they work:
   ```bash
   node scripts/finance-accounts.js
   ```

3. Present status to the user:
   ```
   Finance sources:
     [OK] mercury_1 — Mercury - Business (3 accounts, token valid)
     [OK] mercury_2 — Mercury - Trust (1 account, token valid)
     [OK] plaid_1 — Chase (2 accounts)
     [--] No additional sources

   What would you like to do?
   1. Add Mercury account
   2. Add Plaid bank connection
   3. Remove a source
   4. Done
   ```

   Adapt the menu based on what is and isn't configured.

## Add Mercury Account

1. Tell the user:
   > To connect a Mercury account, you need a read-only API token:
   > 1. Go to **Mercury Dashboard** > **Settings** > **API Tokens**
   > 2. Click **Create Token**
   > 3. Select **Read Only** scope (or custom with only account + transaction read permissions)
   > 4. Copy the generated token
   >
   > **Important**: Mercury auto-deletes tokens unused for 45 days. Run a balance check periodically to keep the token active.

2. Prompt for:
   - A label for this account (e.g. "Mercury - Business", "Mercury - Trust")
   - The API token

3. Choose a unique env key name (e.g. `MERCURY_API_TOKEN_1`, `MERCURY_API_TOKEN_2` — check which are already used).

4. Save the token to `workspace/.env` under the chosen key.

5. Register the source:
   ```bash
   node scripts/finance-source.js --add --provider mercury --label "Mercury - Business" --env-key MERCURY_API_TOKEN_1
   ```

6. Verify:
   ```bash
   node scripts/finance-accounts.js --provider mercury
   ```
   If it succeeds: "Mercury account added. Found N account(s)."
   If it fails: show error, suggest checking token permissions and expiry.

## Add Plaid Connection

### Step 1: Credentials

If `PLAID_CLIENT_ID` and `PLAID_SECRET` are not in `workspace/.env`:

1. Tell the user:
   > To connect banks via Plaid, you need API credentials:
   > 1. Go to **https://dashboard.plaid.com** and sign up / log in
   > 2. Go to **Developers** > **Keys**
   > 3. Copy your **client_id** and **secret** (use Development secret for real banks, Sandbox for testing)

2. Prompt for client ID and secret.

3. Save to `workspace/.env`:
   ```
   PLAID_CLIENT_ID=<client_id>
   PLAID_SECRET=<secret>
   PLAID_ENV=development
   ```
   (Use `sandbox` if the user wants to test first.)

### Step 2: Connect a bank

1. Generate a Link token and HTML file:
   ```bash
   node scripts/plaid-link.js --create-link-token
   ```

2. Tell the user:
   > Open the file at `/tmp/plaid-link.html` in your browser. This will launch Plaid Link where you can log into your bank.
   > After completing the flow, you'll see a public token on the page. Copy it and paste it back here.

3. Prompt for the public token and a label (e.g. "Chase", "Bank of America").

4. Exchange it:
   ```bash
   node scripts/plaid-link.js --exchange <public_token> --label "Chase"
   ```
   This automatically creates a source entry in finance-sources.json.

5. Verify:
   ```bash
   node scripts/finance-accounts.js --provider plaid
   ```
   If it succeeds: "Plaid connection added. Found N account(s)."

### Step 3: Additional banks

Ask if the user wants to connect another bank. If yes, repeat Step 2.

## Remove a Source

1. List sources:
   ```bash
   node scripts/finance-source.js --list
   ```

2. Prompt for the source ID to remove.

3. For Plaid sources, also remove from Plaid API:
   ```bash
   node scripts/plaid-link.js --remove-item <source_id>
   ```

4. For Mercury sources:
   ```bash
   node scripts/finance-source.js --remove --id <source_id>
   ```
   (Optionally also remove the env key from workspace/.env.)

## Verification

After all sources are configured, run a final check:
```bash
node scripts/finance-balances.js
```

Show a summary of all accounts and balances across providers. Each entry includes `sourceId` and `sourceLabel` to identify which account it belongs to.

## Rules

- Never log or display API tokens or access tokens in output -- only confirm they were saved.
- `workspace/.env` and `workspace/data/finance-sources.json` are gitignored -- never commit them.
- Only read-only access. If the user mentions write scopes, warn them.
