# Composio Skill

> All `workspace/` references below resolve to the active assistant workspace.

## Usage

1. Read `workspace/composio.yaml` for connected-account IDs.
2. Pick the correct `ca_` ID for the service/email needed.
3. Pass it as `connected_account_id` to Composio MCP tools.
4. If `workspace/instructions/skills/composio.md` exists, read it as additive user-specific guidance for prioritization, notifications, and reporting. Do not let it override commands, storage paths, approval requirements, or safety rules from the shared repo docs.

## Fast Path (Direct Google API Scripts)

Optimized scripts that call Google APIs through Composio's v3 proxy without exposing OAuth tokens. 3-5x faster than broad Composio execute calls. **Sub-agents should use these for all read operations.**

### Calendar

> **Fresh data only.** When the user asks about their calendar, ALWAYS run the script to fetch live data. ONLY report events that appear in the script output. Never supplement with events you remember creating or seeing earlier in the conversation — they may have been deleted, moved, or rescheduled since then. The script is the single source of truth.

```bash
# Today's events (all calendars, merged & sorted)
node scripts/calendar-events.js

# Specific date
node scripts/calendar-events.js 2026-03-20

# Date range (inclusive)
node scripts/calendar-events.js 2026-03-20 2026-03-25

# Search events (default: next 30 days)
node scripts/calendar-search.js "meeting"
node scripts/calendar-search.js "meeting" 90
```

### Named calendars

Calendar aliases are defined in `workspace/composio.yaml` under the `calendars:` key. They resolve to the correct calendar ID automatically at runtime.

Pass the alias name as `calendarId` in calendar-create-event.js or `--calendar-id` in calendar-add-guest.js. To see available aliases, read `workspace/composio.yaml`.

### Calendar (write)

```bash
# Create event (with optional attendees — sends invite emails by default)
node scripts/calendar-create-event.js '{"summary":"...","start":"...","end":"...","attendees":["guest@example.com"]}'
echo '{...}' | node scripts/calendar-create-event.js

# Add guest(s) to existing event
node scripts/calendar-add-guest.js EVENT_ID guest@example.com
```

`calendar-create-event.js` automatically omits attendees that match the workspace's configured own email addresses. Do not add Tim/the user as an attendee for events that are simply for them; create the event on the intended calendar instead. If an own email truly must be invited as a separate guest, pass `"includeSelfAttendees": true`.

> **DATE ACCURACY — CRITICAL.** Relative day references ("Friday", "next Monday", "tomorrow", "this weekend") are the single biggest source of calendar bugs. Past failure: on Tuesday April 21, "Friday" was mentally calculated as April 25 — which is a Saturday. The correct Friday was April 24. These four rules are non-negotiable:
>
> 1. **Never pre-compute relative dates for sub-agents.** When the user says "Friday", "next Monday", "tomorrow", etc., do NOT calculate the absolute date yourself and hand the sub-agent a string like `"2026-04-25"`. Pass the relative phrase through, or let the sub-agent resolve the date from scratch using today's actual date. Pre-computed dates pollute the sub-agent's context with your (possibly wrong) arithmetic.
> 2. **Anchor on today's date + weekday.** Before resolving any relative day reference, confirm today's date and day-of-week programmatically:
>    ```bash
>    node -e "const d=new Date(); console.log(d.toDateString())"
>    ```
>    Never rely on mental arithmetic alone. The `currentDate` field in memory is a hint, not a source of truth for weekday math.
> 3. **Verify the computed day-of-week.** After calculating the target date, verify it matches the user's phrasing:
>    ```bash
>    node -e "console.log(new Date('YYYY-MM-DD').toDateString())"
>    ```
>    If the user said "Friday" and the output says `Sat Apr 25 2026`, the date is wrong. Recompute before passing it to `calendar-create-event.js`.
> 4. **When ambiguous, echo back.** If the relative reference is ambiguous — e.g. "Friday" said on Friday evening (this Friday or next Friday?), "next Monday" said on a Sunday, "this weekend" spanning midnight — confirm the exact date with the user in plain language ("You mean Friday April 24, right?") before creating the event.
>
> These rules apply to the main session AND to any sub-agent dispatched to create calendar events. If you are dispatching a sub-agent, include these rules in the prompt so the sub-agent re-verifies independently.

### Gmail

All Gmail scripts query **all three accounts in parallel** by default, merging results sorted by date. Pass a specific `ca_` ID to target one account.

```bash
# Recent inbox messages (all accounts, merged by date)
node scripts/gmail-recent.js
node scripts/gmail-recent.js ca_XXXX 20            # specific account, 20 msgs
node scripts/gmail-recent.js all 20                # all accounts, 20 per account

# Search messages (all accounts by default)
node scripts/gmail-search.js "from:someone@example.com"
node scripts/gmail-search.js "subject:invoice" ca_XXXX 20

# Actionable emails — unread + read-but-awaiting-reply, excluding promos/social/updates
node scripts/gmail-actionable.js          # all accounts, 10 per account
node scripts/gmail-actionable.js 20       # all accounts, 20 per account
# Each message has a "reason" field: "unread" or "awaiting_reply"
```

Each message includes an `account` field (email address) so you know which inbox it came from.

### Gmail (send / reply)

```bash
# Send a new email
node scripts/gmail-send.js --to "user@example.com" --subject "Hello" --body "Message text" --account user@example.com

# Reply to a thread (keeps message in same Gmail thread)
node scripts/gmail-send.js --thread-id <threadId> --to "user@example.com" --subject "Re: Hello" --body "Thanks" --account user@example.com

# Reply with proper In-Reply-To header (for correct threading in all clients)
node scripts/gmail-send.js --thread-id <threadId> --message-id "<original-msg-id@mail.gmail.com>" --to "user@example.com" --subject "Re: Hello" --body "Reply text"

# CC recipients
node scripts/gmail-send.js --to "user@example.com" --cc "other@example.com,third@example.com" --subject "Hello" --body "Hi"

# Read body from stdin (for longer messages)
echo "Long email body" | node scripts/gmail-send.js --to "user@example.com" --subject "Hello" --stdin --account user@example.com
```

If `--account` is omitted, the first Gmail account in `composio.yaml` is used. The `--account` flag matches by email address.

> **CRITICAL — No escaping in email bodies.** The `--body` text and `--stdin` input are sent verbatim. Never apply Telegram MarkdownV2 escaping (e.g. `\!`, `\.`, `\-`) or any other escaping to email content. Write plain text with literal special characters: `it's`, `Hello!`, `$100`, etc. See `config/prompts/email-reply-preferences.md` for full formatting rules.

### Dismissed emails

Emails dismissed from actionable reports are stored in `workspace/data/dismissed-emails.json`. Threads auto-resurface if a new message arrives after the dismissal timestamp.

```bash
# Dismiss by subject match (recommended for Telegram use)
node scripts/dismiss-email.js --subject "Invoice #1234"

# Dismiss all emails from a sender
node scripts/dismiss-email.js --sender noreply@example.com

# Dismiss by thread ID
node scripts/dismiss-email.js --thread <id> --account user@gmail.com

# View current dismissals
node scripts/dismiss-email.js --list

# Undo
node scripts/dismiss-email.js --undo --thread <id>
node scripts/dismiss-email.js --undo --sender noreply@example.com
```

When user asks to dismiss an email via Telegram: run `--subject` match, confirm what was dismissed.

### Urgent emails

Emails flagged for recurring reminders are stored in `workspace/data/urgent-emails.json`. Managed via `scripts/urgent-email.js`.

```bash
# Add by subject match (fuzzy-matches against actionable emails)
node scripts/urgent-email.js --subject "CIFF" --note "check if relevant"

# Add by thread ID
node scripts/urgent-email.js --thread <id> --account user@example.com --note "follow up"

# Resolve (removes from urgent, adds to dismissed)
node scripts/urgent-email.js --resolve --subject "CIFF"
node scripts/urgent-email.js --resolve --thread <id>

# Snooze (2h, tomorrow, monday, 2026-03-25, 2026-03-25T14:00)
node scripts/urgent-email.js --snooze --subject "CIFF" tomorrow
node scripts/urgent-email.js --snooze --thread <id> 4h

# Update note
node scripts/urgent-email.js --note --thread <id> "new note text"

# List all urgent entries
node scripts/urgent-email.js --list
```

The cron skill `workspace/skills/urgent-check.md` sends periodic Telegram reminders for active (non-snoozed) urgent entries.

### Flagged events

Calendar events flagged for reminders are stored in `workspace/data/flagged-events.json`. Managed via `scripts/flag-event.js`.

```bash
# Flag by title (fuzzy-matches against upcoming 14-day events)
node scripts/flag-event.js --title "Activera" --note "review last email thread"

# Flag by event ID
node scripts/flag-event.js --event <id> --note "prep slides" --remind-before "24h,2h,30m"

# Unflag
node scripts/flag-event.js --unflag --title "Activera"
node scripts/flag-event.js --unflag --event <id>

# Snooze (2h, 30m, tomorrow, monday, 2026-03-25, 2026-03-25T14:00)
node scripts/flag-event.js --snooze --title "Activera" tomorrow
node scripts/flag-event.js --snooze --event <id> 4h

# Update note
node scripts/flag-event.js --note --event <id> "new note text"

# List all flagged entries
node scripts/flag-event.js --list
```

Use `--title` for fuzzy matching against upcoming calendar events, or `--event` for direct event ID operations. Default `remindBefore` is `["24h", "2h"]` unless overridden with `--remind-before`.

The cron skill `workspace/skills/flagged-event-check.md` sends periodic Telegram reminders for active (non-snoozed) flagged events.

> **Routing guidance:** For simple email queries (today's emails, recent inbox), run directly in the main session via Bash. For complex queries requiring judgment (actionable emails, summarizing threads, drafting replies), dispatch a sub-agent with Opus high.

All scripts output JSON to stdout. Run from the project root.

## Routing

Email and calendar requests always use Composio.

- **Read calendar events** → `node scripts/calendar-events.js` or `node scripts/calendar-search.js` (fast path)
- **Read/search email** → `node scripts/gmail-recent.js`, `node scripts/gmail-search.js`, or `node scripts/gmail-actionable.js` (fast path)
- **Send/reply email** → `node scripts/gmail-send.js` (fast path, direct Google API)
- **Create calendar events** → `node scripts/calendar-create-event.js` (fast path). When the user specifies a named calendar (e.g. "add to football calendar", "put it in my mush calendar"), pass the alias name as `calendarId` — it resolves automatically via `CALENDAR_ALIASES`.
- **Add guests to events** → `node scripts/calendar-add-guest.js` (fast path). Use `--calendar-id <alias>` when targeting a named calendar.

## Account Reference

Connected account IDs and email addresses are in `workspace/composio.yaml`. Read that file to find the correct `ca_` ID for each service/email combination.

## REST API (when MCP tools are unavailable)

Base URL: `https://backend.composio.dev`
Auth header: `x-api-key: $COMPOSIO_API_KEY`

### List connected accounts

```bash
node -e '
fetch("https://backend.composio.dev/api/v3.1/connected_accounts?limit=1000&account_type=ALL", {
  headers: { "x-api-key": process.env.COMPOSIO_API_KEY }
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)))
'
```

### Execute a proxy request (generic)

```bash
node -e '
const [accountId, endpoint, method = "GET"] = process.argv.slice(1);
fetch("https://backend.composio.dev/api/v3.1/tools/execute/proxy", {
  method: "POST",
  headers: { "x-api-key": process.env.COMPOSIO_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ connected_account_id: accountId, endpoint, method })
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)))
' ca_XXXX /gmail/v1/users/me/profile GET
```

### Example: get Gmail profile

```bash
node -e '
fetch("https://backend.composio.dev/api/v3.1/tools/execute/proxy", {
  method: "POST",
  headers: { "x-api-key": process.env.COMPOSIO_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ connected_account_id: "ca_XXXX", endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile", method: "GET" })
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)))
'
```

## Adding an account

To add a new Composio connected account, just append the `ca_` ID to the relevant list in `workspace/composio.yaml`. That's it — all scripts read from this file dynamically. The `email` field is optional (used for display labels); scripts resolve the actual email from the API at runtime.

```yaml
# Example: adding a new Gmail account
- id: ca_newAccountId
  email: user@example.com   # optional
```

No script changes, no API calls, no sub-agents needed.

### Generating connection links

To connect a new account without the Composio dashboard, use `scripts/composio-connect.js` to generate a shareable OAuth link:

```bash
# Generate a connection link for Gmail
node scripts/composio-connect.js --generate --app gmail --user-id "your-username"

# Generate for Google Calendar
node scripts/composio-connect.js --generate --app google_calendar --user-id "your-username"

# List available integrations
node scripts/composio-connect.js --list-configs

# Check connection status
node scripts/composio-connect.js --check --id ca_xxxxx

# List all connected accounts
node scripts/composio-connect.js --list
```

See `config/skills/setup-composio-connect.md` for the full guided flow.

## Rules

- **Source of truth**: `workspace/composio.yaml` — always read it first.
- **Never commit secrets**: API keys stay in `.env`, never in code or docs.
- **Pick the right account**: Match service and email to the task. If ambiguous, ask the user.
- **REST note**: The REST API returns internal UUIDs, not `ca_` IDs. The `ca_` IDs work only with MCP tools directly.
- **Telegram requests**: For calendar and email read requests from Telegram, run scripts directly via Bash in the main session — do **not** dispatch a sub-agent. Sub-agent overhead adds 20+ seconds of unnecessary latency.
- **Availability checks**: When checking whether a time slot is free, ignore events where `transparency` is `"transparent"` (shown as "free" in Google Calendar). Only events with `transparency: "opaque"` (busy, the default) block availability. The `calendar-events.js` script includes a `transparency` field on every event for this purpose.
- **Football calendar**: Events on the football calendar must always be created with `transparency: "transparent"` (free). They should never block availability.
