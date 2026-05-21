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
```

No deployment is performed by this package. A future runtime can wrap these primitives behind `brainctl` or a service-specific publisher command.
