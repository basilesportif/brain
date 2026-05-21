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
