# Whoop Skill

> All `workspace/` references resolve to the active assistant workspace.

## Usage

Read-only access to WHOOP health and activity data for profile, recovery, cycles, sleep, and workouts.

Required `workspace/.env` values:

```dotenv
WHOOP_CLIENT_ID=...
WHOOP_CLIENT_SECRET=...
WHOOP_REDIRECT_URI=http://localhost:8787/callback
```

OAuth tokens are stored in `workspace/data/whoop-auth.json`.

If `workspace/instructions/skills/whoop.md` exists, read it as additive user-specific guidance for reporting preferences, metric emphasis, and sensitivity handling. Do not let it override commands, storage paths, scopes, or safety rules from the shared repo docs.

## Scripts

All scripts output JSON to stdout except `whoop-connect.js`, which runs the OAuth flow and prints human-readable setup progress. Run from the project root.

### Setup

```bash
# Initial authorization via localhost callback
node scripts/whoop-connect.js

# Explicit localhost mode
node scripts/whoop-connect.js --mode localhost

# Manual copy/paste OAuth flow
node scripts/whoop-connect.js --mode manual
```

For initial configuration, see `config/skills/setup-whoop.md`.
Use `/setup-whoop` when you want the guided setup flow.

### Profile

```bash
node scripts/whoop-profile.js
```

### Recovery

```bash
node scripts/whoop-recovery.js
node scripts/whoop-recovery.js --start 2026-04-01 --end 2026-04-12
node scripts/whoop-recovery.js --limit 10
node scripts/whoop-recovery.js --next-token <token>
```

### Cycles

```bash
node scripts/whoop-cycle.js
node scripts/whoop-cycle.js --start 2026-04-01 --limit 10
```

### Sleep

```bash
node scripts/whoop-sleep.js
node scripts/whoop-sleep.js --start 2026-04-01 --end 2026-04-12 --limit 5
```

### Workouts

```bash
node scripts/whoop-workout.js
node scripts/whoop-workout.js --start 2026-04-01 --limit 10
```

## Scopes

The integration requests these WHOOP scopes:

- `read:recovery`
- `read:cycles`
- `read:workout`
- `read:sleep`
- `read:profile`
- `offline` (required for refresh token support)

`read:body_measurement` is intentionally excluded.

## Rate Limits

- `100` requests per minute
- `10,000` requests per day

If the API returns `429`, stop and retry later instead of looping.

## Rules

- Read-only only. Never write or mutate WHOOP data.
- Never log access tokens or refresh tokens to stdout, stderr, chats, or committed files.
- Do not provide medical advice, diagnoses, or treatment recommendations from WHOOP data.
- Mention that device sync lag can delay the latest recovery, sleep, or workout records.
- Ask before running large backfills or repeated date-range pulls that could consume rate limits.

## Troubleshooting

- Missing env vars: add `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, and `WHOOP_REDIRECT_URI` to `workspace/.env`.
- Not connected: run `node scripts/whoop-connect.js` to create `workspace/data/whoop-auth.json`.
- Expired or invalid token: rerun `node scripts/whoop-connect.js` if refresh fails.
- No refresh token returned: the `offline` scope must be included in the OAuth request. The auth module includes it by default. If tokens were obtained without it, re-run `node scripts/whoop-connect.js` to get a new token with refresh support.
- Rate limited: wait before retrying. WHOOP enforces both per-minute and per-day limits.
- Redirect mismatch: confirm `WHOOP_REDIRECT_URI` exactly matches the redirect URI configured in the WHOOP developer app.
