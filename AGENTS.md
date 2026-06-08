# Agent guidance for `brain`

This repo is the safe, reviewable Brain control plane. Its production role is
setup/orchestration for the servant runtime stack (`codex-chat` +
`assistant-agent-logic` + `assistant-agent-data`/workspace). Brain's in-repo
runtime/provider/entrypoint code is experimental/lab unless a task explicitly
promotes it. Keep migration work bounded and inspectable.

Brain is **not** the deployed assistant runtime. Do not install
`brainctl run/start`, `brain-personal.service`, or any Brain Telegram polling
path as the production assistant. Production deploy/update work must install,
configure, and start the real `codex-chat.service` runtime, with
`assistant-agent-logic` as the canonical assistant-domain logic repository and
`assistant-agent-data`/workspace as private state.

## Current boundaries

- Do **not** copy private workspace data, secrets, logs, generated pages/images,
  chat transcripts, or unreviewed runtime code from existing repos.
- Put channel adapters under `entrypoints/`; they translate external channels into generic Brain inbound events and outbound actions.
- Put durable runtime/web app surfaces under `apps/`.
- Put provider-neutral shared code under `packages/`, with provider implementations under `packages/providers/`.
- Put pure assistant prompts, skills, workflows, and setup docs under `assistant-packs/`.
- Treat `workspace/`, `private/`, and `data/` as user-owned/private boundaries.
  Only the checked-in README files in those folders should exist unless a task
  explicitly changes the private-boundary policy.
- For control-plane stack work, use repo-registry metadata as the source of
  truth for the separate `codex-chat`, `assistant-agent-logic`, and
  `assistant-agent-data`/workspace repos. Do not vendor, subtree, copy, or merge
  those repos into Brain. The in-repo `packages/assistant-logic` commands are
  lab compatibility helpers only.
- Deployment/update flows must fetch or clone the configured latest branch/ref
  for both `codex-chat` and `assistant-agent-logic`, verify the resolved commit
  SHA after checkout, record requested refs plus resolved SHAs in deployment
  metadata, and use those live checkouts for `codex-chat` service config. Brain
  must not deploy stale embedded copies.
- Do **not** encode Tim-assistant domain workflows, prompts, skills, or intent
  rules in Brain. Brain wraps deployment/control-plane operations for
  `codex-chat` and `assistant-agent-logic`; domain behavior belongs in
  `assistant-agent-logic`, while runtime/channel behavior belongs in
  `codex-chat` or generic Brain transport/entrypoint code only when it is truly
  provider- and domain-neutral.

## Entrypoint and provider direction

- Telegram support should live in `entrypoints/telegram` and use `packages/entrypoint-protocol` contracts.
- Prompts and workflows should use generic entrypoint/inbound/outbound language, not Telegram-specific terms, unless they are explicitly Telegram adapter docs or tests.
- Start with one primary active entrypoint per workspace, while keeping protocol metadata future-compatible with multiple entrypoints.
- Codex support should live under `packages/providers/codex`; Codex app-server mechanics are an implementation detail of that provider.
- Claude Code support should live under `packages/providers/claude-code`, but
  real Claude Code wiring remains out of scope until explicitly requested.
- Shared orchestration code must depend on entrypoint/provider interfaces, not directly on any channel or provider runtime.

## Before adding code

Read `plans/2026-05-21-brain-monorepo-consolidation.md`, `docs/directory-structure.md`, `docs/entrypoint-protocol.md`, and `docs/private-workspace-boundary.md` before porting anything substantial.

## Setup requests

If a user opens this repo root with Codex or Claude Code and asks to "make this
work", "set this up", or self-host Brain, the canonical UX is: keep the
agent at the repository root and say `setup`. Do not `cd` into a separate setup
directory. This top-level file is the shared agent entrypoint; detailed setup
docs and skills remain referenced files.

Setup is a guided operator flow. Do not require the user to infer hostnames,
paths, SSH syntax, env-file sourcing, service names, or follow-up commands from
conceptual descriptions. Whenever the next step requires user action, provide
one exact action: a copy-paste command, a short BotFather message to send, or a
single concise question for the missing value needed to build the command.
Avoid vague instructions such as "SSH into the server", "run this remotely",
"configure auth", "verify it", or "check the service" unless the exact command
or UI action is included immediately next to it. For confirmations, ask in plain
English and accept natural yes/no replies; do not require the user to reply with
an exact phrase unless they must run a command verbatim.

1. Read `docs/setup-plan.md`.
2. Read `assistant-packs/core/skills/setup-self-host/SKILL.md`. This is the
   discoverable setup skill for both Codex and Claude Code.
3. Before asking first-run questions, inspect for existing setup context and
   progress. Run `pnpm run brainctl setup status --repo <repo-root>
   --workspace <name>` (default workspace `personal`) and check the reported
   `state/setup-progress.json` or `private/setup-context.json` pointer. If a
   prior remote context is found, ask only for permission or a missing SSH host
   needed to run the reported remote metadata check, then resume from the next
   incomplete step. Do not ask "local or remote?" until saved progress has been
   checked or ruled out.
4. If no progress/context exists, ask the first setup question: local private
   directory or remote Ubuntu server over SSH?
5. For remote setup, ask before editing local `~/.ssh/config` or contacting a
   host. Use the Brain-owned deployment/self-hosting docs in this repository to
   prepare the server with its own non-root control-plane/service user, then
   use repo-registry metadata to resolve any separate servant stack checkout
   such as `assistant-agent-logic`.
   As soon as the user confirms the remote target, run
   `brainctl setup defaults --target remote` or
   `brainctl setup --target remote` with the known host/path fields so the CLI
   writes a non-secret local resume pointer at ignored path
   `private/setup-context.json`. The CLI refuses tracked or non-ignored paths.
   This file is private/local only and must never be committed; it lets a later
   Codex/Claude session find remote progress before restarting the wizard.
6. Treat the root-level `setup` request plus `brainctl setup` as the current
   safe setup flow. Keep it provider-agnostic where possible: Codex first, with
   Claude Code recorded only as a provider placeholder until real wiring exists.
7. Treat setup progress state as a resume aid, not authority. If
   `<workspace>/state/setup-progress.json` disagrees with actual config,
   remote/server state, secret metadata, provider health, or service health — or
   if setup cannot confidently determine the safe next step — run
   `pnpm run brainctl setup reset --workspace <name> --path <workspace> --dry-run`,
   then reset with `--yes` when appropriate, and rerun `setup inspect/status` plus
   guarded live/status checks. Reset before guessing, forcing inconsistent state,
   or using destructive flags; it must remove only setup progress metadata and
   must not delete secrets, config, backups, logs, documents, provider sessions,
   Telegram state, or other private data.
8. Bootstrap Telegram as the first primary entrypoint when the user wants live
   setup. Default admin bootstrap is first-user pairing: the first Telegram
   user/chat to message the newly configured bot becomes the paired/admin
   identity in private state. Explicit admin allowlists and optional `/pair`
   code bootstrap remain advanced paths. Do not require Composio or other
   optional integrations.
9. Ask before using any real remote host, credential, Telegram token/admin ID,
   provider auth, systemd unit, or secret store.
10. Any user copy-paste CLI command that inputs or stores a secret must be a
   one-use private temporary script, not an inline command containing or reading
   the secret in shell history. For Telegram bot tokens, generate the helper
   with `pnpm run brainctl setup telegram-token-script --path <workspace>` and
   run the returned command; do not hand-write the shell script. Put any helper
   script outside version control, prompt/read the secret with hidden input,
   write only to the private server env/secret store, and delete the script
   after success. Never echo tokens in chat, shell history, logs, command
   output, or repo files.
11. Treat private workspace/env files as the setup source of truth for env refs.
   `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `COMPOSIO_API_KEY`,
   `env:TELEGRAM_MAIN_CONFIG`, and similar refs should be present only in
   service/private env files such as `<workspace>/config/codex-chat.env`,
   `<workspace>/config/brain-<workspace>.env`, or `<workspace>/secrets/secrets.env`
   for services and setup metadata checks. Do not decide a setup step is
   incomplete only because a one-off SSH command's process environment lacks
   the variable; rerun `brainctl setup status --path <workspace> --config
   <workspace>/config/runtime.yaml` and inspect redacted metadata instead.
12. When setup reaches Codex auth verification, give concrete commands. Prefer
   generating `pnpm run brainctl setup codex-auth-script --config
   <workspace>/config/runtime.yaml --workspace <name> --repo <repo-root>
   --ssh-host <host> --ssh-user <ssh-login-user> --service-user <brain-service-user>`
   on the target host or via SSH context, then print the exact `sshRunCommand`
   value as a copy-paste command for the user, for example
   `ssh -t root@host 'sudo -iu brain bash /tmp/verify-brain-codex-auth.sh'`.
   Verify auth as the same non-root service user that will run Brain; root's
   Codex session is not sufficient for a `User=brain` systemd service.
   Setup progress must record which OS user verified Codex auth and must not
   treat auth verified as one user as sufficient for a different service user.
   Do not say only "SSH into the server" or "run it on the server"; always give
   the complete command including user, host, and remote script path. The helper
   must print the exact remote `ssh -t <ssh-user>@<host> 'sudo -iu
   <service-user> codex login --device-auth'` command when auth is missing, not
   only local-on-target `codex login` instructions or a JSON field.
13. Keep real workspace config, env files, tokens, Telegram IDs, logs, generated
   artifacts, hostnames, and repo-registry state outside git.
14. Run `pnpm run check` after setup, documentation, or runtime changes.
