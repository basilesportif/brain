# Brain web publisher

The `@brain/web` package now contains the initial generated-page publisher port. It preserves the generic behavior of the earlier static-page publisher while removing maintainer-specific default paths and domains.

## Boundary

Generated pages are scratch runtime artifacts by default. They should be built outside durable source repos, validated as static packages, copied through the publisher boundary, recorded in a manifest, and pruned by TTL unless explicitly promoted.

The package rejects:

- missing root `index.html`, unsupported file extensions, path traversal, and symlinks;
- secret-like file names such as env/token/key/database files;
- secret-like text content such as private keys, provider token assignments, and common token patterns;
- packages exceeding file count or byte limits.

## Defaults

Portable defaults are intentionally local and non-deploying:

- public base URL: `http://localhost:8080/pages`
- runtime root: `.brain/pages`
- manifest path: `.brain/web-pages/manifest.json`

Operators should override these through `BRAIN_WEB_PUBLIC_BASE_URL`, `BRAIN_WEB_RUNTIME_ROOT`, `BRAIN_WEB_MANIFEST_PATH`, or explicit CLI/options.

## Commands

```bash
pnpm --filter @brain/web run build
pnpm --filter @brain/web run publish:page -- --dir /path/to/static-page --id demo-page --dry-run
pnpm --filter @brain/web run prune:pages -- --dry-run
pnpm run brainctl web setup --config examples/config/runtime.yaml --workspace personal \
  --base-url http://203.0.113.10/pages --publish-root ~/.brain/pages
pnpm run brainctl web status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl web validate --dir /path/to/static-page
pnpm run brainctl web publish --dir /path/to/static-page --id demo-page --dry-run
pnpm run brainctl web manifest --manifest-path .brain/web-pages/manifest.json
pnpm run brainctl web prune --dry-run
```

No deployment is performed by this package. `brainctl web` is now the operator wrapper for validation, publish, manifest inspection, and TTL pruning; it still only copies into the configured runtime root/manifest and does not hand-copy files to a host or bypass the publisher boundary.

`brainctl web setup/status` is also non-mutating. It reports whether a chosen
base URL is direct IP publishing (DNS not needed) or domain publishing (DNS
records needed as operator work), echoes the publish root and public base URL,
and includes a Caddy/reverse-proxy note. It never changes DNS or proxy config.
