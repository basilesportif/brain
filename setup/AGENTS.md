# Brain setup agent guide

Use this folder when a user asks Codex or Claude Code to set up Brain. Keep the
flow simple, inspectable, and safe: do not use real tokens, copy private data, or
deploy/start a live service until the user explicitly confirms the final live
cutover step.

## First question

Ask one question before taking action:

- **Local**: set up a private Brain workspace on this machine.
- **Remote**: prepare a user-owned Ubuntu server over SSH.

For remote mode, assume the remote service user already has an SSH key available
for Git/provider access. If it does not, pause and ask the user to add one.

## Minimal details to collect

Common:

1. Workspace id, default `personal`.
2. Provider, default `codex`; `claude-code` may be recorded as a placeholder but
   no real Claude Code wiring should be installed yet.
3. Primary entrypoint, default `telegram-main`.
4. Private workspace path outside git.
5. Whether provider auth, Telegram bot token, and Telegram admin pairing are
   ready now or should remain placeholders.

Remote-only:

1. SSH host alias and address.
2. Bootstrap user and dedicated Brain service user.
3. Remote repo checkout path and branch/ref.
4. systemd service name, default `brain-<workspace>`.

## Safe setup flow

1. Confirm local vs remote and the collected details.
2. Validate prerequisites:
   - dedicated Brain user for remote/server mode,
   - `git`, Node matching `package.json`, pnpm matching `packageManager`, and
     systemd tools for service hosts,
   - repo checkout is clean or changes are understood.
3. Clone or pull the Brain repo. For remote mode, run commands over SSH on the
   registered host/path; do not substitute a same-looking local checkout.
4. Create private directories outside git: `config/`, `secrets/`, `logs/`,
   `artifacts/`, `state/`, `backups/`, and `tmp/` with restrictive ownership.
5. Prepare runtime config from `examples/config/runtime.yaml` in the private
   config directory:
   - set `workspacePath` to the private workspace,
   - set `provider: codex` unless the user chose another supported provider,
   - keep Telegram as the single enabled primary entrypoint unless the user
     asked for fake smoke-only setup,
   - keep web/extra entrypoints disabled.
6. Create secrets/config placeholders only. Store real provider auth, Telegram
   tokens, admin IDs, and pairing data in the private workspace or host secret
   store, never in this repo.
7. Configure provider metadata:
   - Codex first: choose `stub` for safe checks, or record the intended
     `exec`/`app-server` transport for a later confirmed live pass.
   - Provider-specific credentials stay private.
8. Configure Telegram metadata:
   - token env/file ref,
   - polling as the first bootstrap mode unless the user requests webhook,
   - one-time pairing code or admin metadata stored privately.
9. Run validations from the repo root, using private paths where applicable:
   - `pnpm run check`,
   - `pnpm run brainctl -- config validate <private-runtime-config>`,
   - `pnpm run brainctl -- secrets check --config <private-runtime-config>`,
   - `pnpm run brainctl -- doctor --config <private-runtime-config> --pack assistant-packs/core`,
   - `pnpm run brainctl -- operations validate --config <private-runtime-config> --workspace <workspace> --repo <checkout>`,
   - `pnpm run brainctl -- operations systemd --config <private-runtime-config> --workspace <workspace> --repo <checkout>`.
10. Summarize exactly what is ready and what remains. Stop before installing,
    enabling, or starting a live service unless the user explicitly confirms.

## Safety rules

- Print only secret metadata: existence, owner, mode, size, and key counts.
- Do not inspect, echo, or copy secret values.
- Do not copy private workspaces, logs, transcripts, generated artifacts, or
  repo-registry state into git.
- Do not add persistent turn replay/idempotency storage.
- Keep the setup provider-agnostic where possible; Codex is the first supported
  live provider path.
