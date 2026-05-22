# @brain/entrypoint-telegram

Placeholder for the Telegram entrypoint adapter extracted from `codex-chat` bot/server behavior.

Responsibilities:

- Receive Telegram updates and normalize them into generic Brain inbound events.
- Translate Brain outbound actions, such as replies, edits, uploads, and status updates, back to Telegram APIs.
- Own Telegram-specific auth, webhook/polling setup, rate-limit handling, and chat/thread metadata mapping.

This is an entrypoint adapter into the system, not the core runtime. Do not port `codex-chat` runtime code until the migration phase explicitly allows it.

## Runtime config role

The first migration should register Telegram as the single primary active entrypoint for the workspace, for example `telegram-main` in `enabledEntrypoints` with `enabled: true` and `primaryEntrypointId: telegram-main`.

This adapter should preserve current Telegram behavior by translating chats, messages, threads, files, webhooks/polling, sends, edits, uploads, status updates, and failures into generic Brain protocol events/actions. Bot tokens, allowlists, webhook secrets, and raw Telegram IDs stay inside the adapter config or secret boundary.

Current implementation includes:

- a no-network `TelegramEntrypointAdapter` wrapper over supplied update
  iterables and outbound dispatch hooks;
- injectable Telegram Bot API boundary for outbound sends, multipart local
  uploads, file metadata, and download resolution;
- token loading from literal/env/file refs with redacted metadata only;
- durable polling offset storage for Telegram `getUpdates` without any Brain
  turn replay/idempotency store;
- polling and a small webhook HTTP server skeleton that do not require a real token in tests;
- private admin allowlist filtering by Telegram user/chat id;
- first-user bootstrap that persists the first Telegram user/chat as paired
  admin state when no explicit allowlist exists;
- optional advanced one-time `/pair <code>` bootstrap state for paired user/chat
  identities before allowlist filtering;
- opt-in attachment download plus configurable voice/audio transcription from
  runtime config (`transcription.provider: openai` with a private `apiKeyRef`,
  model, optional language, and optional prompt file) or an injectable command
  seam, storing downloaded files under private runtime paths and appending
  transcript text to inbound events; and
- outbound mapping for replies, edits, photo/document/voice/audio/video
  artifacts, status actions, reactions, and delete-after-send cleanup for staged
  local artifacts.

It is suitable for runtime smoke tests and mapping checks. Live polling/webhook startup is still intentionally a skeleton: no process manager, reverse proxy, token file, or deployment side effects are installed by this package.

## Bootstrap minimum

The setup flow should make Telegram usable enough for future configuration work:

1. Create or provide the BotFather token. To create a new bot, open Telegram,
   message `@BotFather`, send `/newbot`, choose a display name, choose a unique
   username ending in `bot`, and copy the returned token into Brain's private
   `secrets.env` or configured secret-store reference. Never commit, print, or
   log the token.
2. Configure `telegram-main` as the only enabled entrypoint in `single-primary` mode.
3. Pair the initial admin with default first-user pairing: after the bot token is
   configured, the first Telegram user/chat to message the bot is stored as
   paired/admin state. Explicit private allowlists and optional one-time
   `/pair <code>` are advanced alternatives. Paired identities and any temporary
   code live under private adapter state; checks report only counts/presence,
   not raw IDs or code values.
4. Prefer polling for first bootstrap because it only requires outbound HTTPS.
5. Leave webhook URL, reverse proxy, TLS, generated pages, and additional integrations disabled unless the user explicitly enables them.
6. After admin pairing, allow future integration setup commands to be received through Telegram.

If the bot token is leaked, rotate it immediately in `@BotFather` with
`/revoke`, update the private Brain secret, restart Brain, and re-run
metadata-only checks. Check output must stay redacted.

Composio and other optional integration tokens are not required for this bootstrap.
