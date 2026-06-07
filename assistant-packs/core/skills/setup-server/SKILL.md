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
- Keep user instructions direct-action first. If the user must do something,
  provide the full copy-paste command or the exact UI action. Do not say "SSH
  into the server", "run this on the host", "configure auth", "check logs", or
  "start the service" unless the exact command follows immediately.
- Ask confirmation questions in plain English and accept natural yes/no replies;
  do not require an exact reply phrase unless the user must run a command
  verbatim.
- Print only metadata about secret files: existence, owner, permissions, size, and required-key presence.
- Provide copy-paste commands that input or store secrets only as one-use
  private temporary scripts. Use a temp directory outside version control
  (`/private/tmp` on macOS callers, or a `0700` `mktemp -d`/`/run/user/<uid>`
  path on Linux servers), prompt/read with hidden input, write to the private
  server env file or configured secret store, and delete the script after a
  successful write. Never echo tokens into shell history, chat, logs, command
  output, or repo files.
- Do not deploy or start a public service unless the user explicitly requests it.
- Keep setup resume state in the private workspace/server state file
  `state/setup-progress.json`, not in the repo. It may contain only non-secret
  metadata such as completed setup steps, Codex auth status metadata, service
  install/start status, Telegram token configured metadata, and next recommended
  step. Use restrictive permissions and reconcile it with current checks instead
  of trusting it blindly. If saved progress conflicts with actual server state,
  or the safe next step is unclear, use `brainctl setup reset` to clear only
  `state/setup-progress.json`, then rerun setup inspect/status and guarded
  live/status checks before continuing. Reset before guessing or forcing
  inconsistent state, and never use it to delete secrets, config, backups, logs,
  documents, provider sessions, Telegram state, or other private data.

## Baseline checklist

1. Before first-run prompts, inspect existing local setup context/progress from
   the Brain repo (`brainctl setup status --repo <repo-root> --workspace
   <name>`). If it points at this remote host, check the remote
   `state/setup-progress.json` metadata and resume from the next incomplete
   step instead of restarting. If no context exists, confirm host label/address
   and SSH login username; default the initial SSH login username to `root` if
   omitted. Root must be preserved only for one-time bootstrap; after
   `brainctl setup remote-bootstrap` creates/validates the non-root service
   user, sudo access, authorized keys, checkout path, and workspace ownership,
   rewrite local context/SSH alias so future commands use the service user. Then
   confirm repo path, workspace path, and provider choice. Ask for
   service-user/service details only when needed for bootstrap or when the user
   asks for advanced details.
2. Install base packages: Git, curl, build tools, certificates, Node, pnpm, and any provider CLI prerequisites the user selected.
3. Clone or update the user-confirmed Brain repository.
4. Run `pnpm install` and `pnpm run check`.
5. Create private workspace directories with owner-only permissions for secrets.
6. Copy example config into the private workspace and keep real values out of git.
7. Write/update metadata-only setup progress in private state, and ensure the
   local Brain checkout has an ignored non-secret `private/setup-context.json`
   pointer for the remote host/workspace so reruns can find that progress before
   asking first-run questions. Prefer `brainctl setup defaults --target remote`
   or `brainctl setup --target remote` to create/update this pointer; the CLI
   refuses unsafe tracked or non-ignored paths.
8. Follow the core wizard order: Telegram token ref, private data/backup repo,
   Composio accounts if needed, then essential runtime choices.
9. Configure/verify Codex auth before service start or live Telegram traffic.
   Generate `pnpm run brainctl setup codex-auth-script --config
   <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root>
   --ssh-host <host> --ssh-user <ssh-login-user> --service-user
   <brain-service-user>` and give the user the returned `sshRunCommand`. Verify
   auth as the same service user that systemd will run; root's Codex login is
   not sufficient for `User=brain`. Setup progress must record the verified OS
   user and resume from auth if it differs from the service user. If auth is
   missing during remote setup, the helper itself must print the exact
   copy-paste SSH login command, such as `ssh -t root@host 'sudo -iu brain codex
   login --device-auth'`, instead of only local-on-target `codex login`
   instructions. Require explicit confirmation before writing credentials or
   running live provider checks.
10. Prepare/install/start the service only after confirmation.
11. Treat first-user pairing, OpenAI transcription, web publishing, and backup
   tuning as optional follow-ups unless explicitly requested.
12. Report remaining blockers in order: Telegram token ref, private data repo,
   Composio refs if enabled, Codex auth, service install/start, pairing,
   firewall/webhook/TLS.
