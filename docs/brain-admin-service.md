# Brain admin service

Status: initial long-running control-plane skeleton.

Brain now includes a minimal HTTP admin service in `@brain/web`. It is intended
to run as Brain's own Clerk-protected control plane while `codex-chat` remains
the runtime adapter/executor.

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
BRAIN_CODEX_CHAT_ENV_FILE=~/.config/codex-chat/env \
BRAIN_CODEX_CHAT_SERVICE_NAME=codex-chat.service \
BRAIN_CODEX_CHAT_DEPLOY_COMMAND='cd ~/pkg/tim/codex-chat && git pull --ff-only && pnpm install --frozen-lockfile && pnpm run build' \
pnpm run brain-admin
```

Routes:

- `GET /healthz` — process liveness, no secrets.
- `GET /admin` — server-authenticated Clerk admin page.
- `GET /admin/auth/sign-in` — app-hosted Clerk sign-in.
- `GET /api/admin/brain/me` — current allowlisted admin.
- `GET /api/admin/brain/health` — Brain/codex-chat health/settings metadata.
- `GET /api/admin/brain/settings` — repo-registry and operation settings.
- `GET /api/admin/brain/codex-chat/env` — codex-chat env key presence only.
- `POST /api/admin/brain/codex-chat/env` — write allowlisted env/config keys.
- `POST /api/admin/brain/codex-chat/operation` — plan/deploy/restart operations.

The service fails closed when Clerk keys or `CLERK_ALLOWED_EMAILS` are missing.
Env values are write-only in API responses and audit records; responses expose
only key names and presence. Update the writable key allowlist with
`BRAIN_CODEX_CHAT_ENV_KEYS`.

## Operation approvals

Mutating API calls require exact approval strings:

- env writes: `write env` or `write codex-chat.service env`
- plan: `plan codex-chat.service`
- restart: `restart codex-chat.service`
- deploy: `deploy codex-chat.service`

`plan` is dry-run and only returns redacted commands. `restart` defaults to:

```bash
systemctl --user restart codex-chat.service || sudo systemctl restart codex-chat.service
```

Set `BRAIN_CODEX_CHAT_RESTART_COMMAND` to override it. `deploy` is disabled
until `BRAIN_CODEX_CHAT_DEPLOY_COMMAND` is configured. Brain refuses to operate
on its own service name.

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
  reverse_proxy /admin* 127.0.0.1:49347
  reverse_proxy /api/admin/brain* 127.0.0.1:49347
  reverse_proxy /healthz 127.0.0.1:49347
  respond "not found" 404
}
```

Do not restart `codex-chat.service` from inside this subagent process. The Brain
admin service can trigger codex-chat operations after it is separately installed
on the server and its env/Clerk policy has been reviewed.
