# @brain/web

Initial home for Brain's durable web shell and generated static page publisher primitives.

Implemented now:

- static generated page validation (`index.html`, static files only, no symlinks/path traversal);
- secret-like filename/content checks;
- TTL manifest entries and local runtime copy;
- expired scratch page pruning.

Not implemented yet: web shell UI, HTTP serving, remote copy support, authentication, deployment integration, or generated page promotion lifecycle beyond manifest status.

See `docs/web-publisher.md`.
