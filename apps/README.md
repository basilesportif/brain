# apps

Durable runtime applications live here when they are not channel entrypoints or provider implementation details.

Planned app placeholders:

- `web/` — durable web shell and static page publisher concepts extracted from `codex-chat-web`.

Channel ingress belongs in `entrypoints/`, and Codex app-server code belongs inside or behind `packages/providers/codex` rather than as a top-level app.
