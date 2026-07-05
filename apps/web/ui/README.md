# @brain/web-ui

React + Vite operator console for Brain, served under `/admin-v2` by
`apps/web/src/admin-service.ts` (plan `2026-07-04-brain-admin-ui-react-redesign`,
step 4). The legacy server-rendered console at `/admin` is unchanged and remains
the default until later steps cut over.

Slice 4a (this package) ships the app shell, Clerk auth, and the **Home** and
**Settings** routes. `Setup`, `Users`, and `Operations` are stubs that point at
the legacy console until slice 4b.

## Develop

```
pnpm --filter @brain/web-ui dev
```

The dev server serves the app at `/admin-v2/` and proxies `/api/admin/brain/*`
to a local Brain admin service (default `http://127.0.0.1:49347`; override with
`BRAIN_ADMIN_DEV_ORIGIN`). Provide a Clerk publishable key for dev via
`VITE_CLERK_PUBLISHABLE_KEY` (in production the key is injected into the SPA
shell by the admin service, so no rebuild is needed to change it).

## Build

```
pnpm --filter @brain/web-ui build
```

Type-checks (`tsc --noEmit`) then emits static assets to `dist/`. The repo-root
`pnpm run build` runs this after `tsc -b`, and `admin-service.ts` serves
`dist/` under `/admin-v2` with SPA history fallback.

## Boundaries

- The client never computes health or authorization; it renders server
  decisions. The server allowlist (`authorizeBrainAdminRequest`) is the only
  gate — the SPA renders sign-in / access-denied states but grants nothing.
- Secrets are write-only end to end: inputs are never prefilled, values are
  never echoed, and only presence is shown.
