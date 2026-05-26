# Calendar Invite Allowlist

Automatically accept or decline calendar invites based on a sender allowlist. Non-allowlisted invites are declined and reported via Telegram.

If `workspace/instructions/skills/calendar-allowlist.md` exists, read it as additive user-specific guidance for notification preferences and decline-report formatting. Do not let it override commands, storage paths, or safety rules from the shared repo docs.

**The feature is OFF by default.** You must explicitly enable it before invites will be processed.

## When to Use

- Cron polling loop runs `calendar-check-invites.js` periodically
- User asks to add/remove trusted senders
- User approves a declined invite from Telegram
- User enables or disables the feature

## Commands

```bash
# Enable / disable invite checking
node scripts/calendar-allowlist.js --enable
node scripts/calendar-allowlist.js --disable
node scripts/calendar-allowlist.js --status

# Check pending invites (process and accept/decline)
node scripts/calendar-check-invites.js

# Dry run — see what would happen without acting
node scripts/calendar-check-invites.js --dry-run

# Manage allowlist
node scripts/calendar-allowlist.js --list
node scripts/calendar-allowlist.js --add email@example.com
node scripts/calendar-allowlist.js --add-domain company.com
node scripts/calendar-allowlist.js --remove email@example.com
node scripts/calendar-allowlist.js --remove-domain company.com

# Approve a declined invite (accept + add sender to allowlist)
node scripts/calendar-allowlist.js --approve EVENT_ID --calendar-id CAL_ID
```

## On/Off Toggle

The allowlist config (`workspace/data/calendar-allowlist.json`) has an `enabled` field:

```json
{
  "version": 1,
  "enabled": false,
  "emails": [],
  "domains": [],
  "updatedAt": "..."
}
```

When `enabled` is `false`, `calendar-check-invites.js` exits immediately with `{"ok": true, "skipped": true, "reason": "allowlist disabled"}` and takes no action. Use `--enable` / `--disable` / `--status` on the allowlist CLI to control this.

## Decline Log

Every declined invite is logged to `workspace/data/declined-invites-log.json`. This is an append-only file:

```json
{
  "version": 1,
  "log": [
    {
      "eventId": "...",
      "summary": "...",
      "organizer": "...",
      "creator": "...",
      "calendarId": "...",
      "declinedAt": "..."
    }
  ]
}
```

The log is written only for actual declines (not dry runs). Use it to audit which invites were declined and by whom.

## How the Cron Loop Works

The cron skill (e.g. `workspace/skills/invite-check.md`) runs periodically:

1. Executes `node scripts/calendar-check-invites.js`
2. If disabled, receives `skipped` response — does nothing
3. Parses the JSON output for accepted/declined arrays
4. For each declined invite, sends a Telegram notification
5. Silent when nothing new

Seen invite IDs are tracked in `workspace/data/seen-invites.json` to prevent reprocessing.

## Telegram Notification Format

For declined invites, send:

```
Declined calendar invite:
  From: stranger@example.com
  Event: "Coffee chat" — Mar 25, 10:00 AM
  Calendar: <calendarId>

  Reply 'approve' to accept and trust this sender
```

When the user replies "approve", run:
```bash
node scripts/calendar-allowlist.js --approve EVENT_ID --calendar-id CAL_ID
```

This accepts the invite AND adds the sender to the allowlist permanently.

## Logic

1. **Disabled** → exit early, skip all processing
2. **Self-created events** (organizer/creator matches own emails) → skip, always allowed
3. **Allowlisted sender** (exact email or domain match) → auto-accept
4. **Non-allowlisted / no organizer / malformed** → decline + log to decline log
5. **Recurring events** → decline the entire series (uses recurringEventId)

## Storage

- **Allowlist**: `workspace/data/calendar-allowlist.json` — emails, domains, and enabled toggle
- **Seen invites**: `workspace/data/seen-invites.json` — processed invite dedup
- **Decline log**: `workspace/data/declined-invites-log.json` — append-only log of all declined invites

## Own Emails

Own emails are derived from `workspace/composio.yaml` gmail accounts. Events created by any of these addresses are always allowed (never declined).
