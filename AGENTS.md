# Agent guidance for `brain`

This repo is a safe, reviewable assistant monorepo with runtime, provider,
entrypoint, setup, and operations seams. Keep migration work bounded and
inspectable.

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

1. Read `docs/setup-plan.md`.
2. Read `assistant-packs/core/skills/setup-self-host/SKILL.md`. This is the
   discoverable setup skill for both Codex and Claude Code.
3. Ask the first setup question before taking action: local private directory or
   remote Ubuntu server over SSH?
4. For remote setup, ask before editing local `~/.ssh/config` or contacting a
   host. Use the assistant-agent-logic setup-server skill at
   `/home/tim/pkg/tim/assistant-agent-logic/config/skills/setup-server.md` to
   prepare the server with its own non-root Brain service user.
5. Treat the root-level `setup` request plus `brainctl setup` as the current
   safe setup flow. Keep it provider-agnostic where possible: Codex first, with
   Claude Code recorded only as a provider placeholder until real wiring exists.
6. Bootstrap Telegram as the first primary entrypoint when the user wants live
   setup. Default admin bootstrap is first-user pairing: the first Telegram
   user/chat to message the newly configured bot becomes the paired/admin
   identity in private state. Explicit admin allowlists and optional `/pair`
   code bootstrap remain advanced paths. Do not require Composio or other
   optional integrations.
7. Ask before using any real remote host, credential, Telegram token/admin ID,
   provider auth, systemd unit, or secret store.
8. Keep real workspace config, env files, tokens, Telegram IDs, logs, generated
   artifacts, hostnames, and repo-registry state outside git.
9. Run `pnpm run check` after setup, documentation, or runtime changes.
