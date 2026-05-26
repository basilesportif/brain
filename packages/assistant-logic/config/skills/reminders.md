# Reminders Skill

> All `workspace/` references below resolve to the active assistant workspace.
> Brain integration: run these commands through `pnpm run brainctl workspace run --path <workspace> <script>.js -- <args>` from the Brain checkout. Historical `node scripts/...` examples below map to compiled native CLI commands under `packages/assistant-logic/dist/cli/`.

## Usage

Use this skill when the user wants to add, list, update, or delete reminders. Reminders are scheduled notifications delivered via Telegram.

Reminders are stored in `workspace/data/reminders.json` (created lazily on first add). A loop runs every 5 minutes to check for due reminders and send Telegram notifications.

## Schedule Types

- **daily** — fires at a specific time every day
- **weekly** — fires at a specific time on a specific day every week
- **once** — fires at a specific datetime, then auto-disables
- **cron** — fires on a cron expression (advanced use)

## Commands

All commands output JSON to stdout. Run them from the Brain checkout through `brainctl workspace run`.

### Add a reminder

```bash
# Daily at 9:00 AM
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-add.js -- --title "Take medicine" --daily --time "09:00"

# Weekly on Friday at 5:00 PM
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-add.js -- --title "Weekly review" --weekly friday --time "17:00"

# One-time
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-add.js -- --title "Dentist appointment" --once "2026-04-15T10:00:00-04:00"

# Cron (weekdays at 9 AM)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-add.js -- --title "Morning standup" --cron "0 9 * * 1-5"

# With timezone (default: America/New_York)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-add.js -- --title "Call London office" --daily --time "14:00" --timezone "Europe/London"
```

### List reminders

```bash
# All enabled reminders
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-list.js --

# Include disabled reminders
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-list.js -- --all

# Search by title
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-list.js -- --query "medicine"
```

### Update a reminder

```bash
# Change title
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-update.js -- --id rm_xxx --title "New title"

# Change time
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-update.js -- --id rm_xxx --time "10:00"

# Disable / enable
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-update.js -- --id rm_xxx --disable
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-update.js -- --id rm_xxx --enable
```

### Delete a reminder

```bash
# By exact ID
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-delete.js -- --id rm_xxx

# By title match (deletes if exactly one match)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-delete.js -- --title "medicine"
```

If `--title` matches multiple reminders, the script exits with code 2 and lists the matches on stderr. Use `--id` to disambiguate.

### Check due reminders (loop use)

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" reminder-check.js --
```

Returns JSON with any triggered reminders. Used by the `reminder-check` loop.

## Routing

All reminder operations (add, list, update, delete) should run directly in the main session — do **not** dispatch a sub-agent. Use **Sonnet medium** effort. Reminder operations are fast, deterministic, and don't benefit from backgrounding.

## Interaction Rules

- When adding: require a title and schedule type. Default timezone is `America/New_York`.
- When listing: display a numbered list (1., 2., 3.) with title and human-readable schedule (e.g. "daily at 9:00 AM", "every Friday at 5:00 PM"). Do **not** show internal IDs (e.g. `rm_abc123`) to the user — they are for internal use only. When the user refers to a reminder by number, map it back to the internal ID from the last listing.
- When the user asks to delete without specifying an ID: use `--title` with a substring. If the script exits 2 (ambiguous), show the matches and ask the user which one to delete.
- Only ask for confirmation when the match is ambiguous. Single matches proceed without confirmation.
- After adding, updating, or deleting a reminder, always run `reminder-list.js` and include the updated full reminder list in the response alongside the confirmation.
- Show schedules in human-friendly format: "daily at 9:00 AM", "every Friday at 5:00 PM", "April 15, 2026 at 10:00 AM".
