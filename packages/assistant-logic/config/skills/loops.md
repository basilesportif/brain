# Persistent Loops

Session-scoped cron loops whose definitions persist across sessions in `workspace/tasks/loops.json`.

## How It Works

- **Definitions** live in `workspace/tasks/loops.json` (version-controlled in the workspace repo).
- **Execution** uses `CronCreate` / `CronDelete` — these are session-only, so loops must be started each session.
- Each loop has: `name`, `cron` schedule, `prompt` to execute, and `enabled` flag.

## Starting Loops

**Automatic on session start.** A `SessionStart` hook at `.claude/settings.json` runs `scripts/register-loops.sh` on every `startup|resume|clear|compact` event. That script emits a directive telling Claude to diff `loops.json` against `CronList` and register anything missing. This happens silently. The manual flow below still applies when the user explicitly asks to start loops, or as a fallback if the hook ever fails to fire.

When the user says **"start loops"**:

1. Read `workspace/tasks/loops.json`.
2. For each entry where `enabled` is `true`, call `CronCreate` with:
   - `schedule`: the `cron` value
   - `prompt`: the `prompt` value
   - `durable`: `true` (persists to `.claude/scheduled_tasks.json` so jobs survive harness restarts)
3. Report which loops were started.

If the file does not exist, tell the user no loops are defined and suggest adding one.

## Adding a Loop

When the user asks to add a loop:

1. Read the current `workspace/tasks/loops.json`.
2. Append the new loop object to the `loops` array with `enabled: true`.
3. Write the updated file.
4. Call `CronCreate` (with `durable: true`) to start the loop immediately.
5. Commit and push the workspace repo.

## Removing a Loop

When the user asks to remove a loop:

1. Read `workspace/tasks/loops.json`.
2. Remove the matching entry from the `loops` array.
3. Write the updated file.
4. Call `CronDelete` with the loop name to stop it.
5. Commit and push the workspace repo.

## Enabling / Disabling a Loop

When the user asks to enable or disable a loop:

1. Read `workspace/tasks/loops.json`.
2. Set `enabled` to `true` or `false` on the matching entry.
3. Write the updated file.
4. If enabling: `CronCreate` the loop with `durable: true`. If disabling: `CronDelete` the loop.
5. Commit and push the workspace repo.

## Listing Loops

When the user asks to list loops:

1. Read `workspace/tasks/loops.json`.
2. Display each loop with its name, schedule, enabled status, and prompt summary.

## File Format

```json
{
  "version": 1,
  "loops": [
    {
      "name": "unique-loop-name",
      "cron": "*/10 * * * *",
      "prompt": "The prompt text that CronCreate will execute on each tick.",
      "enabled": true
    }
  ]
}
```

## Health Check

Loops auto-expire after 7 days in a session. To prevent silent failures, a background health check runs automatically:

1. On each incoming message, read `workspace/tasks/loop-health.json` for the `lastChecked` ISO timestamp.
2. If the file doesn't exist or `lastChecked` is more than 6 hours ago, perform a health check:
   a. Call `CronList` to get all currently active cron jobs.
   b. Read `workspace/tasks/loops.json` and collect all entries where `enabled` is `true`.
   c. For each enabled loop that is **not** present in the `CronList` output, call `CronCreate` with `durable: true` to re-create it.
3. Write the current ISO timestamp to `workspace/tasks/loop-health.json`:
   ```json
   {
     "lastChecked": "2026-03-25T12:00:00.000Z"
   }
   ```
4. Do this silently — no output to the user unless a re-creation fails.

## Notes

- The `workspace-sync` loop prompt should reference the resolved workspace path, not a hardcoded path.
- Loops are session-only at runtime. If the session restarts, they must be re-started from the definitions file.
- Always commit and push `loops.json` after any change.
- Loop names must be unique within the file.
