# Brain control plane

Brain is the setup and operations control plane for Tim's assistant stack. The
production servant runtime remains `codex-chat`; Brain does not vendor or merge
runtime repositories.

Brain must not encode Tim-assistant domain workflows, prompts, skills, or intent
rules. It wraps deployment and control-plane operations for `codex-chat` and
`assistant-agent-logic`; assistant domain behavior belongs in
`assistant-agent-logic`, and runtime/channel behavior belongs in `codex-chat` or
generic Brain transport/entrypoint code only when it is domain-neutral.

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

Deployment state is **not** canonical in the local repo registry. The registry
answers "where are the repos and services?". The canonical deployment ledger
answers "what servant stacks are deployed here and what is their current
status?". That ledger lives on the Brain/control-plane host under the private
workspace state:

```text
<brain-workspace-root>/state/control-plane/deployments.json
```

For the current remote Brain workspace this resolves to:

```text
/home/brain/.brain/workspace/state/control-plane/deployments.json
```

If a local project note or registry entry mentions a deployment, treat it as a
secondary pointer only. `brainctl stack status` reports the canonical metadata
path plus a no-network read command; pass `--metadata-file` only for offline
tests or local mirrors.

## Current command surface

```bash
pnpm run brainctl stack status --workspace personal
pnpm run brainctl stack plan --workspace personal
pnpm run brainctl stack apply --workspace personal
pnpm run brainctl stack apply --workspace personal --executor mock --approve --approve-data --approve-config --approve-service --approve-health --metadata-file /tmp/deployments.json
```

`status` and `plan` are dry-run/no-network by design. They must not SSH to
hosts, pull repositories, write config/env files, start services, or print
secret values. `apply` is also dry-run by default; it executes only when
`--approve` is supplied with a non-dry executor. Additional gates are required
for private data, config/env rendering, systemd changes, and live health checks:
`--approve-data`, `--approve-config`, `--approve-service`, and
`--approve-health`.

The supported apply executors are:

- `dry-run` (default): render actions only.
- `mock`: simulate SSH/git/systemd/health actions and write only an explicit
  `--metadata-file`, useful for tests.
- `local`: run approved local shell actions.
- `ssh`: run approved remote shell actions through the resolved SSH identity.

All executor output is redacted before JSON output. Secret values are never read
from env files and are represented only as metadata (`value: "redacted"`).

## Planned servant stack flow

The generated plan is intentionally explicit and non-mutating:

1. Resolve repo registry and ignored setup context.
2. Assert repo boundaries before any setup/deploy action.
3. Clone/update `codex-chat` source/deploy checkouts.
4. Build `codex-chat` and render a systemd service plan.
5. Clone/update `assistant-agent-logic` as a separate checkout, install its
   Node dependencies using its lockfile/package manager (`npm ci` for
   `package-lock.json`, `pnpm install --frozen-lockfile` for `pnpm-lock.yaml`),
   and verify Composio workflow modules load without reading secrets or calling
   provider APIs.
6. Prompt/validate `assistant-agent-data` / workspace and leave migration as an
   operator-approved future step.
7. Render `codex-chat` config/env files with placeholders/metadata only.
8. Install/start the `codex-chat` service only after explicit service approval.
9. Record/update the canonical deployment ledger on the Brain/control-plane host.
10. Run `codex-chat` health checks only after explicit health approval.

Brain's in-repo runtime/provider/entrypoint packages are lab compatibility
surfaces. They can support tests and future experiments, but they do not replace
`codex-chat` as the servant runtime in this control-plane architecture.

## Deployment metadata schema

The ledger schema is:

```json
{
  "version": 1,
  "kind": "brain.control-plane.deployments",
  "updatedAt": "ISO-8601 timestamp",
  "canonical": {
    "sourceOfTruth": "remote-brain-workspace",
    "workspaceRoot": "/home/brain/.brain/workspace",
    "path": "/home/brain/.brain/workspace/state/control-plane/deployments.json",
    "relativePath": "state/control-plane/deployments.json"
  },
  "deployments": [
    {
      "id": "personal:production:codex-chat",
      "stack": "codex-chat",
      "workspace": "personal",
      "environment": "production",
      "status": "planned | blocked | partially_applied | applied | healthy | failed",
      "servantRuntime": { "repoName": "codex-chat", "serviceName": "codex-chat.service" },
      "assistantLogic": { "repoName": "assistant-agent-logic" },
      "assistantData": { "repoName": "assistant-agent-data", "migrationStatus": "placeholder" },
      "config": {
        "envVars": [{ "name": "TELEGRAM_BOT_TOKEN", "value": "redacted", "metadataOnly": true }]
      },
      "health": { "status": "not_run | planned | passed | failed" },
      "secretValuesStored": false
    }
  ],
  "secretValuesStored": false
}
```

The deployment list is keyed by `id` and records each servant stack status
without private filenames beyond configured paths and without secret values.

Guarded live validation may reconcile stale ledger blockers. When
`brainctl validate live --run-safe` confirms current config, secret-ref
metadata, provider/auth metadata, Telegram token metadata, runtime smoke, and
systemd service health, it removes obsolete `blocked_on_user_auth_or_secret`
blocker fields from existing deployment records and marks the record healthy.
This reconciliation never reads or prints secret values; it only updates the
private workspace ledger.
