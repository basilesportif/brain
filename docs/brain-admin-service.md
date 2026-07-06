# Brain admin service

Status: initial long-running control-plane skeleton, deployed for this local Brain instance.

Brain is the abstract project/repo. A Brain instance is a concrete web service
running on a host with its own env/settings for where `codex-chat`,
`assistant-agent-logic`, workspaces, env files, and services live. The workspace
repo registry can still be shown as read-only context, but it is not the source
of truth for this running Brain instance. The instance env/defaults are.

This instance runs on the same server as the active `codex-chat.service`, so its
admin UI should show and control the local codex-chat checkout/service on this
server (`codex-chat-assistant-1`, `178.104.208.141`) rather than historical
repo-registry remote deploy targets.

Brain now includes a minimal HTTP admin service in `@brain/web`. It is intended
to run as Brain's own Clerk-protected control plane and external app surface while `codex-chat` remains
the internal runtime adapter/executor. Slack users configure and visit Brain; raw signed Slack Events API requests are reverse-proxied unchanged to codex-chat for verification and runtime handling.

## Local run

```bash
pnpm run build
BRAIN_ADMIN_ENABLED=true \
BRAIN_ADMIN_HOST=127.0.0.1 \
BRAIN_ADMIN_PORT=49347 \
BRAIN_ADMIN_ROUTE_PATH=/admin \
BRAIN_ADMIN_PUBLIC_BASE_URL=https://brain.decisive-outcomes.com \
CLERK_PUBLISHABLE_KEY=pk_... \
CLERK_SECRET_KEY=sk_... \
CLERK_ALLOWED_EMAILS=timgalebachukraine@gmail.com,tim.galebach@gmail.com \
BRAIN_INSTANCE_NAME=local-brain \
BRAIN_INSTANCE_HOST=codex-chat-assistant-1 \
BRAIN_INSTANCE_IP=178.104.208.141 \
BRAIN_WORKSPACE_PATH=/home/tim/.assistant-claude/workspace \
BRAIN_ASSISTANT_AGENT_LOGIC_PATH=/home/tim/pkg/tim/assistant-agent-logic \
BRAIN_CODEX_CHAT_HOST=codex-chat-assistant-1 \
BRAIN_CODEX_CHAT_IP=178.104.208.141 \
BRAIN_CODEX_CHAT_PATH=/home/tim/pkg/tim/codex-chat \
BRAIN_CODEX_CHAT_ENV_FILE=/home/tim/.config/codex-chat/env \
BRAIN_CODEX_CHAT_CONFIG_FILE=/home/tim/pkg/tim/codex-chat/config/codex-chat.toml \
BRAIN_CODEX_CHAT_SERVICE_NAME=codex-chat.service \
BRAIN_CODEX_CHAT_DEPLOY_COMMAND='cd /home/tim/pkg/tim/codex-chat && git pull --ff-only && pnpm install --frozen-lockfile && pnpm run build' \
BRAIN_CODEX_CHAT_RESTART_COMMAND='systemctl --user restart codex-chat.service' \
BRAIN_CAPABILITY_STORE_PATH=/home/tim/.brain/control-plane/capabilities.json \
BRAIN_CAPABILITY_AUDIT_LOG=/home/tim/.brain/control-plane/capability-audit.jsonl \
pnpm run brain-admin
```

Routes:

- `GET /healthz` — process liveness, no secrets.
- `GET /admin` and `/admin/*` — unauthenticated React SPA shell by default.
  Override with `BRAIN_ADMIN_ROUTE_PATH`; Clerk signs in client-side and all
  admin data remains server-gated under `/api/admin/brain/*`.
- `GET /admin-v2` and `/admin-v2/*` — permanent redirects to the matching
  configured admin route path for old bookmarks.
- `GET /api/admin/brain/me` — current allowlisted admin.
- `GET /api/admin/brain/health` — Brain instance and codex-chat health/settings metadata.
- `GET /api/admin/brain/settings` — Brain instance paths, local codex-chat host/IP/path/service, repo-registry read-only context, and operation settings.
- `GET /api/admin/brain/codex-chat/env` — codex-chat env key presence only.
- `POST /api/admin/brain/codex-chat/env` — write allowlisted env/config keys.
- `GET /api/admin/brain/codex-chat/main-model` — read current main-loop model/provider/profile/tier selectors from the codex-chat env/config sources that Brain can safely inspect.
- `POST /api/admin/brain/codex-chat/main-model` — write non-secret `CODEX_CHAT_CODEX_*` main-loop selector presets (Codex/OpenAI rollback or OpenRouter GLM 5.2); restart is required.
- `POST /api/admin/brain/codex-chat/operation` — plan/deploy/restart operations.
- `GET /api/admin/brain/slack/settings` — explicit Slack env key presence and public Events URL.
- `POST /api/admin/brain/slack/settings` — write Slack signing secret, bot token, optional app token, enabled flag, and URL/path env keys as write-only values.
- `GET /api/admin/brain/slack/telemetry` — read-only Slack runtime telemetry summary from codex-chat state; redacted metadata only.
- `GET /api/admin/brain/slack/manifest` — render the codex-chat-owned Slack manifest contract with Brain's public Events URL.
- `GET /api/admin/brain/slack/manifest/download` — download the rendered manifest JSON.
- `GET /api/admin/brain/capabilities/catalog` — enforcing Phase 5 v2 capability catalog.
- `GET /api/admin/brain/users` — people/users, external identities, proofs,
  channels, grants, and effective capability views.
- `POST /api/admin/brain/users...` — guarded identity/link/grant mutations
  through Brain's canonical validated, backed-up write path.
- `POST /api/admin/brain/capabilities/check` — observe an authorization
  decision against the live capability store.
- `GET /api/admin/brain/audit` — recent capability mutation/audit events.

The service fails closed when Clerk keys or `CLERK_ALLOWED_EMAILS` are missing.
Env values are write-only in API responses and audit records; responses expose
only key names and presence. Update the writable key allowlist with
`BRAIN_CODEX_CHAT_ENV_KEYS`.

Auth UX rules:

- The React SPA owns sign-in, loading, and denied states through Clerk.
- Server-rendered admin sign-in and denied pages have been removed with the
  legacy console; `/admin/auth/sign-in` is just a client-side SPA route.
- A signed-in Clerk user who is not allowlisted must see a fail-closed denied
  state that names the current account and offers a switch-account path.
- API auth failures may include the verified Clerk email for UX context, but
  must not expose Clerk secrets or env values.

## Capability store startup

Brain admin initializes the configured `BRAIN_CAPABILITY_STORE_PATH` before it
starts listening, but initialization failure never crash-loops the admin service.
The console remains available as the repair surface; capability data endpoints
fail closed with `503 capability_store_unavailable` until the store is fixed.

Startup behavior:

- If the store is missing, Brain creates a schema-v2 store through the canonical
  validated, atomic, backed-up writer.
- If `CLERK_ALLOWED_EMAILS` / `BRAIN_CLERK_ALLOWED_EMAILS` contains at least
  one email, the first normalized email is seeded as an active person with a
  linked Clerk-email identity, a materialized primary subject, and enforcing
  capability-admin child grants.
- If the allowlist is empty, Brain creates a valid empty store with no admins
  and logs a warning. Configure the allowlist and restart to bootstrap the first
  admin.
- If the store exists, Brain runs the canonical placeholder cleanup and
  non-enforcing-to-enforcing normalization. It writes only when the migration
  plan has real changes, and appends a secret-free capability audit event for
  startup normalization changes.
- If the existing store is invalid or unreadable, Brain logs a structured error
  without store contents and leaves the store and last-known-good backup
  untouched.

## Operation approvals

Mutating API calls require exact approval strings:

- env writes: `write env` or `write codex-chat.service env`
- Slack settings writes: `write Slack settings`
- plan: `plan codex-chat.service`
- restart: `restart codex-chat.service`
- deploy: `deploy codex-chat.service`

`plan` is dry-run and only returns redacted commands. `restart` defaults to:

```bash
systemctl --user restart codex-chat.service || sudo systemctl restart codex-chat.service
```

Set `BRAIN_CODEX_CHAT_RESTART_COMMAND` to override it. `deploy` is disabled
until `BRAIN_CODEX_CHAT_DEPLOY_COMMAND` is configured. Brain refuses to operate
on its own service name. For this instance the reviewed defaults are the local
checkout `/home/tim/pkg/tim/codex-chat`, local env
`/home/tim/.config/codex-chat/env`, local config
`/home/tim/pkg/tim/codex-chat/config/codex-chat.toml`, and local
`codex-chat.service`.


## Main-loop model switcher

The **Deploy / Restart** panel includes a main-loop model switcher for
`codex-chat.service`. It is separate from the OpenRouter subagent settings:

- Main-loop selectors written by Brain: `CODEX_CHAT_CODEX_MODEL`,
  `CODEX_CHAT_CODEX_PROFILE`, `CODEX_CHAT_CODEX_MODEL_PROVIDER`,
  `CODEX_CHAT_CODEX_SERVICE_TIER`, and
  `CODEX_CHAT_CODEX_SERVICE_TIER_MODE`.
- Subagent settings remain under `CODEX_CHAT_SUBAGENTS_*` and the
  `[subagents]` config section. The main-loop switcher does not write those
  keys.
- API keys are not part of this switcher. OpenRouter readiness is shown as
  presence-only metadata for `OPENROUTER_API_KEY` and the user-level Codex
  profile file.
- Changes are audited as `codex-chat.main_loop_model.write` with values
  redacted and require a `codex-chat.service` restart to take effect.

Presets:

- **Codex/OpenAI subscription default**: `gpt-5.5`, empty profile/provider,
  `serviceTier=fast`, `serviceTierMode=auto`. This is the rollback path.
- **OpenRouter GLM 5.2**: `z-ai/glm-5.2`, profile/provider `openrouter`,
  `serviceTier=fast`, `serviceTierMode=omit`. Requires the existing
  OpenRouter key/profile setup; configure those in the OpenRouter section if
  readiness is not green.

## Slack setup ownership

Brain owns the user-facing Slack setup/install checklist. The canonical runbook
is `docs/slack-setup-runbook.md`; it covers Slack UI install steps, OAuth
scopes/events, where to find the signing secret and bot token, install-to-
workspace flow, Brain Events URL, manifest render/copy/download, write-only env
updates, restart semantics, and manual live canaries. codex-chat owns the
runtime adapter, runtime event telemetry, and no-secret manifest
contract/scripts that Brain renders for users.

Do not infer those values from remote repo-registry deployment records when the
Brain admin service is already running. Update the Brain admin env/settings for
the concrete instance instead.


## Slack callback telemetry boundary

The admin UI now includes an initial read-only telemetry slice. Brain reads
`codex-chat`'s `slack_telemetry/summary.json` from the configured state
directory, sanitizes it again, and displays last inbound/accepted/ignored or
rejected/outbound attempt/success/failure metadata plus a health summary.

This is observational only. Brain does not send Slack requests, verify Slack
signatures, parse Slack business payloads for runtime behavior, enqueue work,
retry outbound sends, change message routing, or persist operator canary notes.
`codex-chat` remains the Slack runtime engine, signature verifier, and source
of runtime event telemetry. Dedicated active canary/test-event telemetry is
runtime-owned future work in `plans/brain-control-plane.md`.

Telemetry responses must not include Slack tokens, signing secrets, signatures,
headers, request bodies, challenge values, message text, channel names, or user
names. Slack IDs and timestamps are operational metadata only and are exposed
through the Clerk-protected admin UI.

## Capabilities tab boundary

The admin UI includes a dedicated **Capabilities** tab for the first Phase 5
slice. It is intentionally separate from Slack setup, Mission Control, Runtime
Config, and Audit Log.

Implemented in this slice:

- Brain-owned read-only catalog groups for Projects, CRM, Calendar, Slack,
  Todos, Finance placeholders, Health placeholders, and capability
  administration.
- Store schema **v2** at `BRAIN_CAPABILITY_STORE_PATH` (default
  `/home/tim/.brain/control-plane/capabilities.json`) with `people`, external
  identities, identity proofs, communication channels, subjects, bundles,
  grants, and audit schema/storage metadata. Schema v1 read-only
  subject/grant stores are migrated forward while preserving their example
  semantics.
- Seeded `person_tim` / Tim as an active person with linked Telegram identity
  `user_id=253768951` and `chat_id=253768951`, proof source
  `telegram_allowlist_migration`.
- Slack identity support in the same model. If codex-chat signed Slack event
  telemetry exposes exactly one accepted Slack user/team pair, the store links
  that identity to Tim with proof source `slack_signed_event`; otherwise the UI
  shows addable or observed-unlinked Slack identity rows for admin review.
- Stable capability IDs, labels, descriptions, actions, resource selectors, and
  group inheritance semantics. A top-level `projects` group grant visibly
  implies child project capabilities such as `projects.files.write` while
  preserving child rows/details.
- Project-specific access is modeled as resource-scoped grants on generic
  project capability IDs. Use `projects.read`, `projects.write`,
  `projects.files.write`, `projects.tasks.write`, and
  `projects.artifacts.publish` with `resource.id: "project:*"` for all
  projects or `resource.id: "project:<projectId>"` for one project. Do not
  generate per-project capability IDs.
- Enforcing owner/all bundle grant for Tim. The effective view expands the
  bundle into ordinary group/child capabilities; it is not a runtime bypass.
- Enforcing seed grants plus guarded admin grant/identity mutations exposed
  through `/api/admin/brain/users...`; runtime Telegram/Slack authorization
  reads the same store.
- Audit event schema persisted in the private store, including
  `identity.link.seeded`, `identity.proof.observed`,
  `capability.bundle.granted`, `capability.catalog.viewed`,
  `capability.grant.proposed`, and `capability.check.observed`. Append-only
  link/grant mutation audit records are written to `BRAIN_CAPABILITY_AUDIT_LOG`.

Capability responses must not include secrets, Slack message bodies, raw health
or finance data, tokens, cookies, or credential values.

## Systemd and Caddy sketch

Example user service:

```ini
# ~/.config/systemd/user/brain-admin.service
[Unit]
Description=Brain admin control plane
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/tim/pkg/tim/brain
EnvironmentFile=%h/.config/brain-admin/env
ExecStart=/usr/bin/pnpm run brain-admin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Install/start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now brain-admin.service
systemctl --user status brain-admin.service
```

Example Caddy route:

```caddyfile
brain.decisive-outcomes.com {
  handle /api/slack/events {
    # Raw Slack body and headers must reach codex-chat unchanged so its
    # Slack verifier owns signatures, challenges, idempotency, and runtime behavior.
    reverse_proxy 127.0.0.1:49346
  }

  reverse_proxy /admin* 127.0.0.1:49347
  reverse_proxy /api/admin/brain* 127.0.0.1:49347
  reverse_proxy /healthz 127.0.0.1:49347
  respond "not found" 404
}
```

Do not restart `codex-chat.service` from inside this subagent process. The Brain
admin service can trigger codex-chat operations after it is separately installed
on the server and its env/Clerk policy has been reviewed.

## codex-chat admin cleanup boundary

Brain owns `/admin` and `/api/admin/brain/*`. The codex-chat-hosted
`/admin/codex-chat`, `/admin`, and `/api/admin/codex-chat/*` surfaces are not
part of the local-instance model and should not be preserved through redirects
or env compatibility. Brain may write codex-chat runtime env keys such as
`CODEX_CHAT_API_ENABLED`, `CODEX_CHAT_SLACK_ENABLED`, `CODEX_CHAT_SLACK_EVENTS_PATH`,
`CODEX_CHAT_BASE_URL`, Slack tokens, Telegram token, OpenAI key, and ingest keys.
The deployed Slack manifest request URL is `https://brain.decisive-outcomes.com/api/slack/events`; the legacy `me.galebach.com` Slack route should not be preserved unless an operator explicitly needs a short rollback window.
Brain's Clerk keys remain in the Brain admin env file and are not codex-chat
runtime settings.
