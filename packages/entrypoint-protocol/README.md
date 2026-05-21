# @brain/entrypoint-protocol

Generic entrypoint protocol placeholder.

Entrypoints translate external channels into Brain-neutral contracts:

- **Inbound events**: user message, attachment, command, callback/action, lifecycle event, and delivery metadata.
- **Outbound actions**: reply, edit, upload artifact, show status, request clarification, mark done/failure, and channel-specific fallback metadata.

Initial policy should allow one primary entrypoint per workspace to keep routing, identity, and notification behavior simple. The protocol should still carry stable entrypoint IDs and channel metadata so multiple active entrypoints can be supported later without changing assistant packs.

## Active entrypoint config contract

The protocol package should eventually describe generic routing fields used by runtime config:

- stable `entrypointId`
- `channelKind` such as `telegram`, `web`, or `ios`
- workspace ID and external conversation metadata
- originating-entrypoint default routing for outbound actions
- capability flags safe to expose in prompt context

It should not define Telegram-specific secrets or SDK payloads as prompt-facing concepts.
