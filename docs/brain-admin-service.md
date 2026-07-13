# Brain admin service

`brain-admin` is Brain's Clerk-protected system control plane. It manages the
shared capability store and provides the operator UI while `codex-chat` remains
the deployed assistant runtime.

## Stack deployment

Deploy `brain-admin` through `brainctl stack`, alongside `codex-chat`:

```bash
pnpm run brainctl stack plan --workspace personal
pnpm run brainctl stack apply --workspace personal --executor <local-or-ssh> --approve --approve-config
```

The config gate writes a private `brain-admin.env` placeholder template and the
generic system unit at `/etc/systemd/system/brain-admin.service`. Before first
start, fill `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` on the target with a
one-use hidden-input secret helper. Never put Clerk secret values in a command,
deployment plan, setup context, log, or checked-in file.

The saved private setup context must contain `ownerAdminEmail`. The stack
renderer writes it as `CLERK_ALLOWED_EMAILS`. It must be present before the
first service start because a missing capability store is initialized then and
the first allowlisted email is seeded with capability-admin access.

After the Clerk values have been filled and reviewed, the service and health
gates enable/start both system services and check brain-admin's liveness route:

```bash
pnpm run brainctl stack apply --workspace personal --executor <local-or-ssh> \
  --approve --approve-service --approve-health
```

`stack status` and `stack plan` remain no-network and non-mutating. Inspect the
rendered unit, env paths, approval gates, and first-start requirements before
applying them.

## System-service contract

The rendered unit uses the same system service-manager namespace as
`codex-chat.service`:

```ini
[Unit]
Description=Brain admin control plane (deployed by brainctl stack)
After=network-online.target codex-chat.service
Wants=network-online.target

[Service]
Type=simple
User=brain
WorkingDirectory=/home/brain/brain
EnvironmentFile=/home/brain/.brain/workspace/config/brain-admin.env
ExecStart=/usr/bin/env node /home/brain/brain/apps/web/dist/brain-admin.js
Restart=always
RestartSec=5s
UMask=0077
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=-/home/brain/.brain/control-plane
ReadWritePaths=-/home/brain/.brain/workspace

[Install]
WantedBy=multi-user.target
```

The paths and user above show the generic defaults. The actual unit is rendered
from setup context and repo-registry deployment metadata.

The former `~/.config/systemd/user/brain-admin.service` and `systemctl --user`
sketch is superseded. Production stack deployment must not mix a user unit for
brain-admin with the system-managed `codex-chat.service`.

## Environment contract

The stack renderer sets non-secret values and secret placeholders only:

- `BRAIN_CAPABILITY_STORE_PATH` exactly equals the path rendered as
  `codex-chat` `[brain].storePath`.
- `BRAIN_CODEX_CHAT_IPC_SOCKET` exactly equals the path rendered as
  `codex-chat` `[service].ipcSocket`.
- `BRAIN_ADMIN_AUDIT_LOG` is `audit.jsonl` in the same instance control-plane
  directory as the capability store.
- `BRAIN_ADMIN_HOST` and `BRAIN_ADMIN_PORT` default to `127.0.0.1:49347` and
  can be overridden by brain-admin deployment metadata.
- `BRAIN_ADMIN_ROUTE_PATH` defaults to `/admin`.
- `CLERK_ALLOWED_EMAILS` comes from the saved setup-context owner email.
- `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` remain placeholders until the
  operator fills them privately on the target.
- `BRAIN_REPO_REGISTRY_PATH`, `BRAIN_ADMIN_UI_DIR`, workspace, logic checkout,
  and codex-chat checkout/config/env paths are resolved deployment values.

When `BRAIN_ADMIN_AUDIT_LOG` is omitted at runtime, brain-admin derives it from
the configured capability-store directory, or from the running service user's
`~/.brain/control-plane` directory when neither path is configured.

## Startup and routes

Brain admin initializes `BRAIN_CAPABILITY_STORE_PATH` before listening. A
missing store is created through the validated, atomic writer. With a non-empty
`CLERK_ALLOWED_EMAILS`, the first normalized email is seeded as an active owner
with a linked Clerk identity and enforcing capability-admin grants. An empty
allowlist creates no admin and logs a warning.

Key routes are:

- `GET /healthz` — unauthenticated process liveness used by stack health.
- `GET /admin` and `/admin/*` — the React SPA shell by default.
- `GET /api/admin/brain/me` — current allowlisted admin.
- `GET /api/admin/brain/health` — instance and runtime health metadata.
- `GET /api/admin/brain/settings` — resolved non-secret deployment settings.
- `GET/POST /api/admin/brain/codex-chat/*` — guarded runtime settings and
  operations.
- `GET/POST /api/admin/brain/users*` — guarded identity, link, and grant
  management.
- `GET /api/admin/brain/capabilities/catalog` — capability catalog.
- `POST /api/admin/brain/capabilities/check` — authorization decision check.
- `GET /api/admin/brain/audit` — recent capability mutation/audit events.

All admin APIs fail closed when Clerk configuration or the allowlist is
missing. Secret/env values are write-only; responses and audit records expose
only names and presence metadata.

## Reverse proxy

Terminate TLS in a separately reviewed reverse proxy and forward the admin SPA,
admin API, and health route to `127.0.0.1:49347`. Slack Events API traffic must
be forwarded unchanged to the configured `codex-chat` HTTP endpoint so the
runtime remains responsible for signature verification, idempotency, and event
handling.
