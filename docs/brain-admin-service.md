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
pnpm run brain-admin
```

Routes:

- `GET /healthz` — process liveness, no secrets.
- `GET /admin` — server-authenticated Clerk admin page.
- `GET /admin/auth/sign-in` — app-hosted Clerk sign-in.
- `GET /api/admin/brain/me` — current allowlisted admin.
- `GET /api/admin/brain/health` — Brain instance and codex-chat health/settings metadata.
- `GET /api/admin/brain/settings` — Brain instance paths, local codex-chat host/IP/path/service, repo-registry read-only context, and operation settings.
- `GET /api/admin/brain/codex-chat/env` — codex-chat env key presence only.
- `POST /api/admin/brain/codex-chat/env` — write allowlisted env/config keys.
- `POST /api/admin/brain/codex-chat/operation` — plan/deploy/restart operations.
- `GET /api/admin/brain/slack/settings` — explicit Slack env key presence and public Events URL.
- `POST /api/admin/brain/slack/settings` — write Slack signing secret, bot token, optional app token, enabled flag, and URL/path env keys as write-only values.
- `GET /api/admin/brain/slack/manifest` — render the codex-chat-owned Slack manifest contract with Brain's public Events URL.
- `GET /api/admin/brain/slack/manifest/download` — download the rendered manifest JSON.

The service fails closed when Clerk keys or `CLERK_ALLOWED_EMAILS` are missing.
Env values are write-only in API responses and audit records; responses expose
only key names and presence. Update the writable key allowlist with
`BRAIN_CODEX_CHAT_ENV_KEYS`.

Auth UX rules:

- Every admin auth state must show the current Clerk account email when the
  server or Clerk.js can identify it.
- Every admin auth page or state must offer a sign-out/switch-account action,
  including sign-in, loading, access-denied, and allowed-admin states.
- A signed-in Clerk user who is not allowlisted must see a fail-closed access
  denied page that names the current account and offers a switch-account path,
  never an ambiguous generic sign-in screen.
- API auth failures may include the verified Clerk email for UX context, but
  must not expose Clerk secrets or env values.

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

## Slack setup ownership

Brain owns the user-facing Slack setup/install checklist. The canonical runbook
is `docs/slack-setup-runbook.md`; it covers Slack UI install steps, OAuth
scopes/events, where to find the signing secret and bot token, install-to-
workspace flow, Brain Events URL, manifest render/copy/download, write-only env
updates, restart semantics, and live canaries. codex-chat owns only the runtime
adapter and no-secret manifest contract/scripts that Brain renders for users.

Do not infer those values from remote repo-registry deployment records when the
Brain admin service is already running. Update the Brain admin env/settings for
the concrete instance instead.


## Slack callback telemetry boundary

The current admin UI is presence/config oriented for Slack health. It can show
that required Slack settings are present, render the codex-chat-owned manifest,
and guide manual Slack URL verification/canaries, but it does not yet provide
durable live callback or test-event telemetry.

Future callback/test-event telemetry is planned in
`plans/brain-control-plane.md`. That plan keeps Brain on the control-plane side:
Brain may proxy raw Slack requests, record redacted metadata, aggregate health,
and display canary/test outcomes, while `codex-chat` remains the Slack runtime
engine and signature verifier unless a later explicit architecture decision
changes that boundary.

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
