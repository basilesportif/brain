# Brain control plane

Brain is the setup and operations control plane for Tim's assistant stack. The
production servant runtime remains `codex-chat`; Brain does not vendor or merge
runtime repositories.

## Source of truth

`brainctl stack status` and `brainctl stack plan` read repo-registry metadata and
local setup context to resolve:

- `codex-chat` source/deploy checkout, deploy host, service name, env file,
  config path, runtime user, SSH identity, and health checks;
- `assistant-agent-logic` as a separate reusable logic repository;
- `assistant-agent-data` / workspace as a separate private data repository and
  repo-registry owner; and
- Brain's own checkout as the control-plane repo.

The registry is a link map, not vendored source. Paths and remotes are metadata;
secret-bearing files are checked only by presence/mode/size or env-key metadata.
Commands rendered by `stack plan` are reviewable plans and are not executed.

## Current command surface

```bash
pnpm run brainctl stack status --workspace personal
pnpm run brainctl stack plan --workspace personal
```

Both commands are dry-run/no-network by design. They must not SSH to hosts, pull
repositories, write config/env files, start services, or print secret values.

## Planned servant stack flow

The generated plan is intentionally explicit and non-mutating:

1. Resolve repo registry and ignored setup context.
2. Assert repo boundaries before any setup/deploy action.
3. Clone/update `codex-chat` source/deploy checkouts.
4. Clone/update `assistant-agent-logic` as a separate checkout.
5. Prompt/validate `assistant-agent-data` / workspace and leave migration as an
   operator-approved future step.
6. Render `codex-chat` config/env paths and secret metadata checks only.
7. Install/start the `codex-chat` service only after explicit operator approval
   in a future executor.
8. Run `codex-chat` health checks only in a future explicit live/execution mode.

Brain's in-repo runtime/provider/entrypoint packages are lab compatibility
surfaces. They can support tests and future experiments, but they do not replace
`codex-chat` as the servant runtime in this control-plane architecture.
