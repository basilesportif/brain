# Setup Telegram Skill

Interactive setup for Telegram user-account authentication. Guides the user through API credentials and login.

> All `workspace/` references below resolve to the active assistant workspace.

## Pre-check

Read `workspace/messaging.yaml`. If the `telegram.session` field is already non-empty, print:

> Telegram is already configured -- your session is active. Nothing to do.

Then stop. Do not proceed.

## Step 1: API credentials

Read `workspace/messaging.yaml` and check `telegram.api_id` and `telegram.api_hash`.

**If both are already filled in** (non-empty strings), skip to Step 2 and tell the user:

> API credentials already present -- skipping to login.

**If either is missing or empty:**

1. Tell the user:
   > You need Telegram API credentials. Here's how to get them:
   > 1. Go to https://my.telegram.org and log in with your phone number.
   > 2. Click "API development tools".
   > 3. Create an application (the app name/description don't matter).
   > 4. Copy the `api_id` (a number) and `api_hash` (a hex string).

2. Use `AskUserQuestion` to prompt for `api_id`.
3. Use `AskUserQuestion` to prompt for `api_hash`.
4. Read `workspace/messaging.yaml`, update the `telegram.api_id` and `telegram.api_hash` fields with the provided values, and write the file back. Use the Edit tool to replace the placeholder values in the YAML.

## Step 2: Interactive login

Tell the user:

> Now you need to authenticate with Telegram. The login script is interactive (it needs your phone number and a verification code), so you must run it yourself.
>
> Type this in your terminal:
> ```
> ! node scripts/telegram-login.js
> ```
>
> The script will prompt you for:
> 1. **Phone number** -- include the country code (e.g. `+1234567890`)
> 2. **Verification code** -- Telegram will send it to your account
> 3. **2FA password** -- only if you have two-factor authentication enabled
>
> Once login succeeds, the session string is saved automatically to `workspace/messaging.yaml`.

Then wait for the user to confirm they have run the script.

## Step 3: Verify

After the user indicates the script has been run:

1. Read `workspace/messaging.yaml`.
2. Check that `telegram.session` is now a non-empty string.

**If populated**, print:

> Telegram authentication is complete. Your session has been saved to `workspace/messaging.yaml`.
>
> You can now use messaging commands (e.g. read unread Telegram messages).

**If still empty**, print:

> The session field is still empty -- the login may not have completed successfully. Try running the script again:
> ```
> ! node scripts/telegram-login.js
> ```

## Rules

- **Never log secrets**: Do not print api_hash or session strings in output.
- **Never commit auth data**: Session strings stay local, never in git.
- **Interactive only**: The login script requires stdin -- always instruct the user to run it via `!` prefix, never run it directly.
