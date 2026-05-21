# Entrypoint protocol skeleton

Entrypoints are adapters at the boundary between external channels and Brain. They are not the core assistant runtime.

## Responsibilities

Each entrypoint should:

- Receive external channel activity, such as Telegram updates now or web/iOS events later.
- Convert that activity into generic Brain inbound events: message, attachment, command, callback/action, lifecycle event, or delivery update.
- Attach channel metadata without forcing prompts or workflows to depend on a specific channel.
- Convert Brain outbound actions back into channel behavior: reply, edit, upload artifact, show status, request clarification, mark done, or report failure.
- Implement the generic entrypoint adapter shape: an inbound event stream plus outbound action dispatcher. Fake/no-network adapters should use the same shape for smoke tests.

## Prompt and workflow language

Assistant packs should talk about generic entrypoints, inbound messages, user-visible replies, artifacts, and outbound actions. They should avoid Telegram-specific words like chat, bot token, or Telegram message except inside the Telegram entrypoint adapter docs and tests.

Telegram behavior is preserved by `entrypoints/telegram`, which maps Telegram chats, messages, threads, files, and API calls into and out of the generic protocol.

Current implementation includes a no-network fake entrypoint and a Telegram adapter wrapper. The Telegram adapter can still run with injected/no-network updates for tests, and it now also includes operator seams for token loading from literal/env/file refs, durable `getUpdates` offset storage, local file download/upload handling, voice/audio/video artifact mapping, delete-after-send cleanup for staged artifacts, and a small webhook HTTP server skeleton with Telegram secret-token validation. These pieces are inert unless explicitly configured; no bot token is required for default checks.

## Active entrypoint policy

Initial policy: one primary active entrypoint per workspace. This keeps identity, notification routing, conflict handling, and workspace permissions simple during the first runtime port.

Future-compatible protocol shape: include entrypoint IDs, channel kind, external conversation IDs, and routing metadata on inbound events and outbound actions. That lets a later workspace opt into multiple active entrypoints, such as Telegram plus web plus iOS, without changing prompt semantics.


## Runtime config expectations

The runtime should load entrypoints from a workspace-level `enabledEntrypoints` map keyed by stable entrypoint ID. A configured entrypoint is not active unless `enabled: true`; disabled entries can be kept for documentation or future rollout but must not receive traffic or outbound actions.

Each workspace must identify one `primaryEntrypointId` by default. In `single-primary` mode, validation should reject any workspace with zero active entrypoints or more than one active entrypoint. Future `multi-explicit` mode can allow multiple active entrypoints only after routing, identity, permissions, notification, and conflict policies are declared.

Inbound events should include generic active-entrypoint metadata: `entrypointId`, `channelKind`, display label, workspace ID, external conversation metadata, actor metadata, and correlation IDs. Prompt context may include this generic metadata and capability flags, but not adapter secrets or raw Telegram identifiers.

Outbound actions without an explicit target should default to the originating inbound event's `entrypointId`. If the runtime cannot determine an originating entrypoint, dispatch should fail closed rather than guessing Telegram or any other channel.
