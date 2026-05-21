---
name: repo-registry
description: Resolve authoritative repository locations before reading or editing source repos used by Brain migration and setup tasks.
---

# repo-registry

Use this skill when a task references multiple source repositories, a registry, a dev server, or a path that may have a remote authoritative checkout.

## Rules

- Resolve the authoritative location before inspecting or editing a named repository.
- If the registry says a repo is remote, inspect files and git state on that remote host instead of assuming a same-looking local path is authoritative.
- For env files, credential files, and likely secrets, inspect only metadata and never print values.
- Do not copy private workspace data, logs, generated artifacts, chat transcripts, or personal overlays into Brain.
- Document which source repos were inspected and which boundaries were used.
