# Public-readiness skeleton

Before publishing any repo or package publicly, verify:

- No secrets, private env files, tokens, logs, generated artifacts, chat transcripts, or personal data are present in git history or working tree.
- Owner-specific paths, hosts, account IDs, and deployment assumptions have examples or placeholders.
- Setup docs work from a clean machine using a new private workspace and one configured primary entrypoint.
- Entrypoint abstractions support Telegram now and future web/iOS without forcing assistant packs to use channel-specific language.
- Provider abstractions support Codex and Claude Code without forcing either provider on all users.
- Licenses, security policy, contribution docs, and support boundaries are intentional.
