# @brain/web-ui

React + Vite operator console for Brain, served under `/admin` by default by
`apps/web/src/admin-service.ts` (plan `2026-07-04-brain-admin-ui-react-redesign`,
steps 7-8). `BRAIN_ADMIN_ROUTE_PATH` can override the mount. The legacy
server-rendered console has been removed, and old `/admin-v2` bookmarks redirect
permanently to the configured admin route.

This package ships the app shell, Clerk auth, and the **Home**, **Setup**,
**Settings**, **Users**, and **Operations** routes.

## Develop

```
pnpm --filter @brain/web-ui dev
```

The dev server serves the app at `/admin/` by default (or
`BRAIN_ADMIN_ROUTE_PATH`) and proxies `/api/admin/brain/*` to a local Brain
admin service (default `http://127.0.0.1:49347`; override with
`BRAIN_ADMIN_DEV_ORIGIN`). Provide a Clerk publishable key for dev via
`VITE_CLERK_PUBLISHABLE_KEY` (in production the key is injected into the SPA
shell by the admin service, so no rebuild is needed to change it).

## Build

```
pnpm --filter @brain/web-ui build
```

Type-checks (`tsc --noEmit`) then emits static assets to `dist/`. The repo-root
`pnpm run build` runs this after `tsc -b`, and `admin-service.ts` serves
`dist/` under `/admin` with SPA history fallback.

## Boundaries

- The client never computes health or authorization; it renders server
  decisions. The server allowlist (`authorizeBrainAdminRequest`) is the only
  gate — the SPA renders sign-in / access-denied states but grants nothing.
- Secrets are write-only end to end: inputs are never prefilled, values are
  never echoed, and only presence is shown.
