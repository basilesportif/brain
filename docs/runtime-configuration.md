# Runtime configuration

Status: schemas and validation exist in `@brain/workspace-schema`; `brainctl doctor` also runs a temporary runtime-core store/subagent lifecycle self-test. `brainctl run` and `brainctl start --foreground` resolve the provider and primary entrypoint from runtime config by default. Use `--fake` or explicit `--provider fake --entrypoint fake` for test/dev smoke, and use explicit Telegram polling/token flags for live polling.

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
    backup:
      strategy: private-git # none | local-snapshot | private-git
      privateGit:
        repoPath: /srv/brain/workspaces/personal/backups/private-git
        remote: git@github.com:example/private-brain-backup.git
        branch: main
        include: [config/**, state/**, artifacts/metadata/**]
        exclude: [secrets/**, logs/**, tmp/**, cache/**, caches/**, "**/.cache/**", "**/node_modules/**", "**/*.log"]
    webPublishing:
      enabled: false
      mode: disabled # disabled | domain | ip
      domain: me.example.test
      baseUrl: https://me.example.test/pages
      publishRoot: /srv/brain/pages
      reverseProxy:
        kind: caddy
        note: Operator configures Caddy/reverse proxy; brainctl does not change DNS.
    transcription:
      enabled: false
      provider: openai
      apiKeyRef: env:OPENAI_API_KEY
      model: gpt-4o-mini-transcribe
      scope:
        entrypointIds: [telegram-main]
        attachmentKinds: [voice, audio]
    integrations:
      composio:
        enabled: false
        apiKeyRef: env:COMPOSIO_API_KEY
        connectedAccountRef: file:/srv/brain/workspaces/personal/config/composio-connected-account.json
        dataSources:
          googleCalendar:
            enabled: false
            connectedAccountRef: file:/srv/brain/workspaces/personal/config/google-calendar-connected-account.json
            requiredEnvRefs: [env:COMPOSIO_API_KEY]
          chat:
            enabled: false
            connectedAccountRef: file:/srv/brain/workspaces/personal/config/chat-connected-account.json
            requiredEnvRefs: [env:COMPOSIO_API_KEY]
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

[workspaces.personal.backup]
strategy = "private-git"

[workspaces.personal.backup.privateGit]
repoPath = "/srv/brain/workspaces/personal/backups/private-git"
remote = "git@github.com:example/private-brain-backup.git"
branch = "main"
include = ["config/**", "state/**", "artifacts/metadata/**"]
exclude = ["secrets/**", "logs/**", "tmp/**", "cache/**", "caches/**", "**/.cache/**", "**/node_modules/**", "**/*.log"]

[workspaces.personal.webPublishing]
enabled = false
mode = "disabled"
domain = "me.example.test"
baseUrl = "https://me.example.test/pages"
publishRoot = "/srv/brain/pages"

[workspaces.personal.transcription]
enabled = false
provider = "openai"
apiKeyRef = "env:OPENAI_API_KEY"
model = "gpt-4o-mini-transcribe"

[workspaces.personal.transcription.scope]
entrypointIds = ["telegram-main"]
attachmentKinds = ["voice", "audio"]

[workspaces.personal.integrations.composio]
enabled = false
apiKeyRef = "env:COMPOSIO_API_KEY"
connectedAccountRef = "file:/srv/brain/workspaces/personal/config/composio-connected-account.json"
```

## Optional setup surfaces

These sections are optional and are reported by `brainctl setup inspect/status`
as missing optional pieces when absent or disabled:

- `backup`: `none`, `local-snapshot`, or `private-git`. `private-git` records a
  private repo path/remote/branch plus include/exclude policy. Safe defaults
  exclude secrets, logs, tmp, caches, `node_modules`, and `*.log`.
- `webPublishing`: domain or direct-IP publishing metadata. `domain` mode needs
  operator-managed DNS; `ip` mode does not. Brain records base URL, publish
  root, manifest path, and Caddy/reverse-proxy notes but never changes DNS.
- `integrations.composio`: optional Composio refs for Google Calendar and chat
  data sources. Store real API keys and connected-account metadata in env/file
  refs outside git; status commands print only metadata.
- `transcription`: optional voice/audio attachment transcription. The initial
  provider is `openai` with an `apiKeyRef` such as `env:OPENAI_API_KEY`, a model
  such as `gpt-4o-mini-transcribe`, optional language, optional prompt file
  path, and an explicit scope for entrypoint IDs and attachment kinds. Store the
  key and any private prompt file in the private workspace/host env, never in
  git; `brainctl secrets check` reports only presence metadata.

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
11. `backup.strategy: private-git` requires `backup.privateGit.repoPath`.
12. `backup.strategy: local-snapshot` requires `backup.localSnapshot.root`.
13. Enabled `webPublishing` requires `baseUrl` or `publicBaseUrl`.
14. Enabled `transcription.provider: openai` requires `transcription.apiKeyRef`;
    scoped entrypoint IDs must exist in `enabledEntrypoints`.

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
- Keep bot tokens, webhook secrets, polling config, chat allowlists, pairing
  state, and Telegram API details in the Telegram adapter config/secret
  boundary.
- For Telegram polling, persist only Telegram's provider-native update offset
  (for example under workspace `state/telegram-offset.json`). Do not build a
  separate durable turn replay or idempotency store.
- Telegram first-user pairing is the default adapter-owned bootstrap: when no
  explicit allowlist or paired identity exists, the first Telegram user/chat to
  message the bot is persisted as paired/admin state under the configured
  private state directory. Explicit allowlists and optional one-time
  `/pair <code>` remain advanced paths. Checks and docs report only
  presence/count metadata, not raw IDs or code values.
- Telegram attachment download is explicit runtime configuration. Downloaded files belong under private workspace artifacts/state, and voice/audio transcription can be configured through workspace `transcription` (OpenAI) or through the CLI command seam for private deployments. Brain stores successful transcript text on the inbound event/attachment metadata but does not copy transcription tokens or private prompts into the repo. For codex-chat parity at the Telegram edge, disabled/unavailable voice transcription replies `Voice transcription is not enabled.` and does not enter the provider queue, disabled audio remains an attachment-only event, and configured voice/audio transcription errors are suppressed before provider dispatch.
- Loop and monitor definitions are validated in-process. The default runtime/CLI behavior does not install crontabs, filesystem watchers, or shell monitors; explicit future operator commands should be required for host-level scheduling.
- Do not enable web or iOS in the migrated workspace until multi-entrypoint routing, identity, permissions, notifications, and conflict handling have explicit config and tests.
