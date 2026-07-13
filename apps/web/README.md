# @brain/web

Home for Brain's web/admin service plus durable generated static page publisher
primitives. Brain is the external app/control plane; `codex-chat` remains the
internal runtime/adapter/engine.

Implemented now:

- `brain-web-admin` / `pnpm run brain-admin` HTTP service;
- Clerk-protected `/admin` and `/api/admin/brain/*` routes with fail-closed
  server-side allowlist checks;
- health/settings APIs for the selected Brain deployment and local
  `codex-chat` path/env/config/service metadata;
- write-only codex-chat env/config updates for allowlisted keys;
- approved plan/deploy/restart operation APIs for `codex-chat.service`;
- Slack settings presence/write APIs and Slack manifest rendering using Brain's
  public Events URL;
- Enforcing Capabilities tab/API with store schema v2 for people/users,
  Telegram/Slack identities, proofs, channels, subjects, grants, grouped catalog
  semantics, and audit schema. Grant/link/onboard mutations write atomically to
  the capability store, and codex-chat enforces those grants at runtime via the
  IPC `check_capability` path. (The admin seed creates a generic Clerk-admin
  person from `CLERK_ALLOWED_EMAILS`; it no longer seeds a specific owner or an
  `owner_all` bundle — owners are provisioned via `brainctl owner bootstrap`.)
- static generated page validation (`index.html`, static files only, no symlinks/path traversal);
- secret-like filename/content checks;
- TTL manifest entries and local runtime copy;
- expired scratch page pruning.

Not implemented yet: live capability grant/link management or enforcement,
channel-scoped approval flows, remote generated-page copy support, and generated
page promotion lifecycle beyond manifest status.

See `docs/brain-admin-service.md`, `docs/web-publisher.md`, and
`plans/brain-control-plane.md`.
