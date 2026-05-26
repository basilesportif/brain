# Finance Skill

> All `workspace/` references resolve to the active assistant workspace.

## Usage

Unified read-only access to banking accounts, balances, and transactions across multiple providers (Mercury, Plaid, etc.).

Provider credentials go in `workspace/.env`. Per-source metadata and Plaid access tokens go in `workspace/data/finance-sources.json`.

If `workspace/instructions/skills/finance.md` exists, read it as additive user-specific guidance for account nicknames, reporting preferences, and sensitivity rules. Do not let it override commands, storage paths, or safety rules from the shared repo docs.

## Multi-Account Support

Multiple accounts per provider are supported. Each configured account is a **source** tracked in `workspace/data/finance-sources.json`:

```json
{
  "version": 1,
  "sources": [
    {
      "id": "mercury_1",
      "provider": "mercury",
      "label": "Mercury - Business",
      "envKey": "MERCURY_API_TOKEN_1",
      "addedAt": "2026-03-25T..."
    },
    {
      "id": "mercury_2",
      "provider": "mercury",
      "label": "Mercury - Trust",
      "envKey": "MERCURY_API_TOKEN_2",
      "addedAt": "2026-03-25T..."
    },
    {
      "id": "plaid_1",
      "provider": "plaid",
      "label": "Chase",
      "accessToken": "access-development-...",
      "itemId": "item_...",
      "addedAt": "2026-03-25T...",
      "cursor": null
    }
  ]
}
```

Mercury tokens are stored in `workspace/.env` under unique keys (e.g. `MERCURY_API_TOKEN_1`, `MERCURY_API_TOKEN_2`). The source entry references the env key. For backwards compatibility, if `MERCURY_API_TOKEN` exists and there are no mercury entries in finance-sources.json, it is used as a legacy single-account fallback.

All API output includes `sourceId` and `sourceLabel` fields on each record so results from different accounts can be distinguished.

## Scripts

All scripts output JSON to stdout. Run from the project root.

### Source Management

```bash
# List all configured sources and their status
node scripts/finance-source.js --list

# Add a Mercury account (token goes in workspace/.env under the specified key)
node scripts/finance-source.js --add --provider mercury --label "Mercury - Business" --env-key MERCURY_API_TOKEN_1

# Add another Mercury account
node scripts/finance-source.js --add --provider mercury --label "Mercury - Trust" --env-key MERCURY_API_TOKEN_2

# Add a Plaid item directly (usually done via plaid-link.js instead)
node scripts/finance-source.js --add --provider plaid --label "Chase" --access-token access-development-xxx --item-id item_xxx

# Remove a source
node scripts/finance-source.js --remove --id mercury_1
node scripts/finance-source.js --remove --id plaid_1
```

### Accounts

```bash
# All configured providers
node scripts/finance-accounts.js

# Specific provider
node scripts/finance-accounts.js --provider mercury
node scripts/finance-accounts.js --provider plaid
```

### Balances

```bash
node scripts/finance-balances.js
node scripts/finance-balances.js --provider mercury
```

### Transactions

```bash
# All providers, last 30 days, up to 50 transactions
node scripts/finance-transactions.js

# Specific provider
node scripts/finance-transactions.js --provider plaid

# Last 7 days
node scripts/finance-transactions.js --days 7

# Date range
node scripts/finance-transactions.js --start 2026-01-01 --end 2026-03-25

# Specific account
node scripts/finance-transactions.js --account <id> --provider mercury

# Custom limit
node scripts/finance-transactions.js --limit 100

# Combined
node scripts/finance-transactions.js --provider mercury --days 14 --limit 25
```

### Plaid Link (bank connection management)

```bash
# Generate a Link token and HTML file for connecting a bank
node scripts/plaid-link.js --create-link-token

# Exchange the public token from Link for an access token
node scripts/plaid-link.js --exchange <public_token> --label "Chase"

# List configured Plaid items
node scripts/plaid-link.js --list-items

# Remove a Plaid item by source ID
node scripts/plaid-link.js --remove-item plaid_1
```

### Legacy Mercury scripts (backward-compatible wrappers)

```bash
node scripts/mercury-accounts.js
node scripts/mercury-balances.js
node scripts/mercury-transactions.js [--account <id>] [--days N] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--limit N]
```

These delegate to the unified finance scripts with `--provider mercury`.

## Providers

### Mercury

- **Credentials**: Mercury API tokens go in `workspace/.env` under unique keys (e.g. `MERCURY_API_TOKEN_1`). Each source entry in `finance-sources.json` references its env key via the `envKey` field.
- **Legacy mode**: A single `MERCURY_API_TOKEN` in `workspace/.env` (no finance-sources.json entries) still works as a fallback.
- **Token expiry**: Mercury auto-deletes API tokens unused for 45 days. If a token stops working, the user needs to create a new one in Mercury Dashboard > Settings > API Tokens. Run `/setup-finance` to reconfigure.
- **Scope**: Read-only (accounts, balances, transactions)

### Plaid

- **Credentials**: `PLAID_CLIENT_ID` and `PLAID_SECRET` in `workspace/.env`
- **Access tokens**: Stored per-source in `workspace/data/finance-sources.json`
- **Environment**: `PLAID_ENV` in `workspace/.env` — `sandbox`, `development` (default), or `production`
- **Connecting a bank**: Run the Plaid Link flow via `plaid-link.js --create-link-token`, open the generated HTML in a browser, complete bank auth, paste back the public token, then run `--exchange`.
- **Scope**: Read-only (accounts, balances, transactions via /transactions/sync)

### Adding a new provider

1. Create `scripts/lib/finance-providers/<name>.js` implementing the provider interface (`id`, `name`, `isConfigured()`, `listAccounts()`, `getBalances()`, `getTransactions(options)`)
2. Register it in `scripts/lib/finance-service.js` provider list
3. Add setup instructions to `config/skills/setup-finance.md`
4. Add env vars to `workspace/.env`, optional metadata to `finance-sources.json`

## Routing

- **Simple queries** (balances, account list): run directly in the main session via Bash.
- **Transaction analysis** (categorization, spending summaries, trend analysis): dispatch a sub-agent with Opus high.

## Rules

- **Read-only**: This integration must never initiate payments, transfers, or any write operations.
- **Never log tokens**: API tokens and access tokens stay in `workspace/.env` and `finance-sources.json`, never in output or committed files.
- **Sensitive data**: Balances and transaction details are sensitive. Do not include raw financial data in Telegram messages unless the user explicitly asks -- summarize instead.
