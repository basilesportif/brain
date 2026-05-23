---
name: setup-server
description: Prepare a generic Ubuntu server for a Brain self-host runtime without storing secrets or deploying automatically.
---

# setup-server

Use this skill when a user asks to prepare a fresh Ubuntu host for Brain.

## Safety rules

- Ask before contacting a host, changing SSH config, creating users, installing packages, writing env files, or enabling services.
- Use a dedicated non-root service user for Brain.
- Keep provider auth, entrypoint tokens, admin identifiers, webhook secrets, and workspace data outside the repository checkout.
- Print only metadata about secret files: existence, owner, permissions, size, and required-key presence.
- Do not deploy or start a public service unless the user explicitly requests it.
- Keep setup resume state in the private workspace/server state file
  `state/setup-progress.json`, not in the repo. It may contain only non-secret
  metadata such as completed setup steps, Codex auth status metadata, service
  install/start status, Telegram token configured metadata, and next recommended
  step. Use restrictive permissions and reconcile it with current checks instead
  of trusting it blindly.

## Baseline checklist

1. Confirm host label/address, repo path, workspace path, and provider choice.
   Ask for service-user/service details only when needed for bootstrap or when
   the user asks for advanced details.
2. Install base packages: Git, curl, build tools, certificates, Node, pnpm, and any provider CLI prerequisites the user selected.
3. Clone or update the user-confirmed Brain repository.
4. Run `pnpm install` and `pnpm run check`.
5. Create private workspace directories with owner-only permissions for secrets.
6. Copy example config into the private workspace and keep real values out of git.
7. Write/update metadata-only setup progress in private state, then use it on rerun to resume at the next incomplete step.
8. Configure/verify Codex auth before Telegram; require explicit confirmation before writing credentials or running live provider checks.
9. Prepare/install/start the service only after confirmation.
10. Then configure the Telegram BotFather token privately and complete first-user pairing.
11. Report remaining blockers in order: Codex auth, service install/start, Telegram token/admin pairing, firewall/webhook/TLS.
