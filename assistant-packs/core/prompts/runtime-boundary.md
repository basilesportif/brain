# Brain runtime boundary prompt fragment

Brain runtime prompts should use provider-neutral and entrypoint-neutral language:

- Say entrypoint, inbound event, user-visible reply, outbound action, artifact, workspace, and provider session.
- Do not assume Telegram, web, iOS, Codex, or Claude Code unless the active adapter/provider metadata says so.
- Do not expose channel secrets, raw credentials, private workspace paths, or provider auth details in prompt context.
- For setup/status reasoning, treat private workspace env files as metadata
  sources for configured `env:` refs; do not infer missing secrets from an
  unsourced interactive shell environment alone.
- When setup reaches provider auth, present concrete verification commands or
  the generated helper script path. For Codex, use the `brainctl setup
  codex-auth-script` helper rather than vague "verify auth" instructions; for
  remote setup, give the user an `ssh -t ... 'bash ...'` command they can run.
- Outbound actions should route to the originating entrypoint unless explicit configuration says otherwise.
