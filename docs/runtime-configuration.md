# Runtime configuration skeleton

Status: initial schemas and validation exist in `@brain/workspace-schema`; `brainctl doctor` also runs a temporary runtime-core store/subagent lifecycle self-test. Live provider and entrypoint processes are still not wired.

Brain runtime configuration must make active entrypoints explicit so prompt packs and provider adapters do not accidentally depend on Telegram-specific behavior.

## Defaults

- Each workspace has exactly one **primary active entrypoint** by default.
- Entrypoints are addressed by stable IDs, such as `telegram-main`, not by channel-specific chat IDs.
- `enabledEntrypoints` is a map keyed by entrypoint ID. Disabled or missing entries must not receive inbound traffic or outbound actions.
- Inbound events carry `entrypointId`, `channelKind`, external conversation metadata, actor metadata, workspace ID, and correlation IDs.
- Outbound actions default to the originating inbound event's `entrypointId` unless a workflow deliberately overrides routing.
- Prompt context includes generic active-entrypoint metadata, not Telegram-specific tokens, bot names, or chat IDs.
- Multiple active entrypoints are possible later, but only when a workspace sets an explicit multi-entrypoint mode and passes validation.

## Example YAML

```yaml
runtime:
  activeEntrypointMode: single-primary # single-primary | multi-explicit

workspaces:
  personal:
    workspacePath: /srv/brain/workspaces/personal
    primaryEntrypointId: telegram-main
    enabledEntrypoints:
      telegram-main:
        kind: telegram
        enabled: true
        displayName: Personal Telegram
        configRef: env:TELEGRAM_MAIN_CONFIG
        capabilities:
          replies: true
          edits: true
          artifactUploads: true
          statusUpdates: true
      web-preview:
        kind: web
        enabled: false
        displayName: Web preview
        configRef: env:WEB_PREVIEW_CONFIG
    outboundDefaults:
      route: originating-entrypoint
      allowCrossEntrypointReplies: false
    promptContext:
      includeActiveEntrypointMetadata: true
      exposeChannelSecrets: false
```

## Example TOML

```toml
[runtime]
activeEntrypointMode = "single-primary"

[workspaces.personal]
workspacePath = "/srv/brain/workspaces/personal"
primaryEntrypointId = "telegram-main"

[workspaces.personal.enabledEntrypoints.telegram-main]
kind = "telegram"
enabled = true
displayName = "Personal Telegram"
configRef = "env:TELEGRAM_MAIN_CONFIG"

[workspaces.personal.enabledEntrypoints.telegram-main.capabilities]
replies = true
edits = true
artifactUploads = true
statusUpdates = true

[workspaces.personal.enabledEntrypoints.web-preview]
kind = "web"
enabled = false
displayName = "Web preview"
configRef = "env:WEB_PREVIEW_CONFIG"

[workspaces.personal.outboundDefaults]
route = "originating-entrypoint"
allowCrossEntrypointReplies = false

[workspaces.personal.promptContext]
includeActiveEntrypointMetadata = true
exposeChannelSecrets = false
```

## Validation rules

Runtime config validation should reject configurations that violate any of these rules:

1. Every workspace must declare `primaryEntrypointId`.
2. `primaryEntrypointId` must exist in `enabledEntrypoints` and have `enabled: true`.
3. In `single-primary` mode, exactly one entrypoint may have `enabled: true` for the workspace.
4. In `single-primary` mode, `allowCrossEntrypointReplies` must be `false`.
5. `multi-explicit` mode must be deliberate per workspace or global config; it must not be inferred from two enabled entries.
6. In `multi-explicit` mode, each enabled entrypoint must declare routing capabilities and conflict-handling policy before it can receive traffic.
7. Outbound actions without an explicit target must route to `originating-entrypoint`; if no originating entrypoint exists, validation or runtime dispatch must fail closed.
8. Prompt context may include `entrypointId`, `channelKind`, `displayName`, capability flags, workspace ID, and external conversation labels, but must not expose channel secrets, raw bot tokens, or credential file paths.
9. Disabled entrypoints may appear as configured but unavailable metadata; they must not be used for sends, edits, uploads, or status updates.
10. Telegram-specific identifiers may be stored inside the Telegram adapter config boundary, but generic runtime config should reference them only through `configRef` or adapter-owned metadata.

## Prompt context shape

Provider prompts and assistant packs should receive generic metadata like:

```json
{
  "workspaceId": "personal",
  "activeEntrypoint": {
    "entrypointId": "telegram-main",
    "channelKind": "telegram",
    "displayName": "Personal Telegram",
    "capabilities": {
      "replies": true,
      "edits": true,
      "artifactUploads": true,
      "statusUpdates": true
    }
  },
  "outboundDefaults": {
    "route": "originating-entrypoint"
  }
}
```

Prompts should say "reply to the user" or "emit a user-visible outbound action" rather than "send a Telegram message" unless the prompt is inside Telegram adapter documentation or tests.

## Current Telegram migration notes

Current `codex-chat` behavior should migrate as a single-primary workspace configuration:

- Define one Telegram entrypoint ID, for example `telegram-main`.
- Mark it as `primaryEntrypointId` and the only `enabled: true` entry in `enabledEntrypoints`.
- Preserve existing Telegram chat/thread/file behavior inside `entrypoints/telegram` translation code, not in runtime-core prompts.
- Map Telegram replies, edits, uploads, typing/status updates, and failures to generic Brain outbound actions.
- Ensure any outbound action created while handling a Telegram inbound event defaults back to `telegram-main`.
- Keep bot tokens, webhook secrets, polling config, chat allowlists, and Telegram API details in the Telegram adapter config/secret boundary.
- Do not enable web or iOS in the migrated workspace until multi-entrypoint routing, identity, permissions, notifications, and conflict handling have explicit config and tests.
