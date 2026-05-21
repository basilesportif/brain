---
name: generated-web-page
description: Build, validate, and publish static generated pages through Brain's web publisher boundary without committing scratch artifacts or secrets.
---

# generated-web-page

Use this skill when a user asks Brain to create a one-off static HTML/CSS/JS page, report, visualization, map-style page, calculator, or small browser tool.

## Boundaries

- Build the page package in the current task artifact directory or another explicit temporary workspace, not inside a durable source repo.
- The package must be static: root `index.html`, package-local assets, and no server-side runtime, database, background worker, private env file, cookie jar, or credential file.
- Do not embed private API keys, tokens, cookies, personal workspace paths, private hostnames, or generated scratch artifacts into source control.
- Publish only through Brain web publisher tooling or the runtime's configured publisher command; do not hand-copy files into a served pages directory.
- Use scratch TTL by default. Promote pages only when the user explicitly asks for a durable artifact.

## Workflow

1. Create a self-contained static page package with `index.html` at the root.
2. Validate the package with the Brain web publisher validation API/CLI when available.
3. For interactive pages, run a local static server or browser smoke test when practical.
4. Confirm the manifest metadata contains only safe source identifiers, not secrets.
5. Publish through the configured Brain web publisher command and return the public URL, TTL/promotion status, and validation summary.
6. If publishing is not configured, stop after validation and return the local artifact path plus the publish blocker.
