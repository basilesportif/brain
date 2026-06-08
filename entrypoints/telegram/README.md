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
- first-user bootstrap that persists up to two distinct Telegram user/chat
  pairs as exact paired admin state when no explicit allowlist exists, with a
  configurable cap for single-admin deployments;
- optional advanced one-time `/pair <code>` bootstrap state for paired user/chat
  identities before allowlist filtering;
- immediate best-effort `👀` receipt reactions for authorized user-originated
  Telegram messages at ingress, before attachment download/transcription or
  provider work starts. The adapter tracks message/emoji reactions already sent
  during ingress so later `react` outbound actions for the same Telegram
  message do not duplicate the receipt reaction;
- opt-in attachment download plus configurable voice/audio transcription from
  runtime config (`transcription.provider: openai` with a private `apiKeyRef`,
  model, optional language, and optional prompt file) or an injectable command
  seam, storing downloaded files under private runtime paths and appending
  transcript text to inbound events. Telegram voice/audio edge behavior follows
  `codex-chat` parity in live Brain wiring: disabled voice transcription sends
  `Voice transcription is not enabled.` and suppresses the provider event;
  disabled audio transcription remains an attachment-only inbound event; and
  configured transcription failures suppress the voice/audio provider event like
  `codex-chat` handler failures;
- outbound mapping for replies, edits, photo/document/voice/audio/video
  artifacts, status actions, reactions, and delete-after-send cleanup for staged
  local artifacts;
- plain-text Telegram replies by default. The adapter intentionally does not
  enable Telegram's brittle legacy Markdown parser for default or `markdown`
  text actions; rich formatting must opt into `markdownv2` with correctly
  escaped text.

It is suitable for runtime smoke tests and mapping checks. Live polling/webhook startup is still intentionally a skeleton: no process manager, reverse proxy, token file, or deployment side effects are installed by this package.

## Pairing state schema

`FileTelegramPairingStore` writes private state under the configured
`state/telegram-pairing` directory:

- `telegram_admins.json`: versioned exact admin pairs,
  `{ "version": 1, "admins": [{ "userId": "...", "chatId": "...", "isAdmin": true, "pairedAt": "..." }] }`.
- `telegram_users.json` and `telegram_chats.json`: legacy mirror files kept for
  single-admin deployments and metadata checks. When `telegram_admins.json` is
  absent, Brain synthesizes one exact pair from the first legacy user/chat entry
  so existing single-admin state remains valid.
- `pairing_code.txt`: optional one-time `/pair <code>` state; it is removed
  after successful pairing and when the configured admin-pair cap is reached.

Checks report only counts and code presence, never raw IDs or code values.

## Voice/audio transcription parity with codex-chat

Brain keeps provider prompts generic, but the Telegram adapter owns the
user-visible Telegram boundary. For voice/audio, live Brain wiring sets
`transcriptionFailureMode: "codex-chat"` so ingress matches the legacy service
as closely as possible without leaking Telegram concepts into runtime-core:

- Voice + transcription disabled or unavailable before a transcriber exists:
  send a Telegram reply `Voice transcription is not enabled.` and do not yield
  a generic inbound event.
- Audio + transcription disabled: yield the generic inbound event with the audio
  attachment and no transcript text.
- Voice/audio + configured transcription error, including a missing OpenAI key
  at transcribe time or an OpenAI API failure: do not yield a provider event.
  `codex-chat` logs these as Telegram handler failures before enqueue; Brain
  preserves the same no-provider-event result at the adapter edge.
- Successful voice transcription appends `Voice transcript:` followed by the
  transcript and `Audio path: ...` after any caption. Successful audio
  transcription uses `Audio transcript:` and, like `codex-chat`, ignores the
  Telegram audio caption in the provider text.

The adapter still exposes `transcriptionFailureMode: "generic-metadata"` for
experiments that need Brain events carrying transcription error metadata, but
that is not the codex-chat parity mode used by `brainctl` Telegram runtime
wiring.

## Bootstrap minimum

The setup flow should make Telegram usable enough for future configuration work:

1. Create or provide the BotFather token. To create a new bot, open Telegram,
   message `@BotFather`, send `/newbot`, choose a display name, choose a unique
   username ending in `bot`, and store the returned token only through a
   one-use private temporary script that prompts with hidden input and writes to
   Brain's private `secrets.env` or configured secret-store reference. Never
   commit, print, echo, log, paste into chat, or leave the token in shell
   history.
2. Configure `telegram-main` as the only enabled entrypoint in `single-primary` mode.
3. Pair admins with default first-user pairing: after the bot token is
   configured, up to two distinct Telegram user/chat pairs that message the bot
   are stored as exact paired/admin state. Pairing is no longer pending once
   the configured maximum is reached; set `maxAdminPairs: 1` or pass
   `--telegram-max-admin-pairs 1` when deliberately keeping a single-admin
   deployment. Explicit private allowlists and optional one-time `/pair <code>`
   are advanced alternatives. Paired identities and any temporary code live
   under private adapter state; checks report only counts/presence, not raw IDs
   or code values.
4. Prefer polling for first bootstrap because it only requires outbound HTTPS.
5. Leave webhook URL, reverse proxy, TLS, generated pages, and additional integrations disabled unless the user explicitly enables them.
6. After admin pairing, allow future integration setup commands to be received through Telegram.

If the bot token is leaked, rotate it immediately in `@BotFather` with
`/revoke`, update the private Brain secret, restart Brain, and re-run
metadata-only checks. Check output must stay redacted.

Composio and other optional integration tokens are not required for this bootstrap.
