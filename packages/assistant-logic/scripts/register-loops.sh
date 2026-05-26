#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_PATH="$(
  REPO_ROOT="${REPO_ROOT}" node <<'NODE'
const path = require("path");
const repoRoot = process.env.REPO_ROOT;
const { resolveWorkspacePath } = require(path.join(repoRoot, "scripts/lib/workspace"));
process.stdout.write(resolveWorkspacePath({ env: process.env }));
NODE
)"
LOOPS_PATH="${WORKSPACE_PATH}/tasks/loops.json"

cat <<EOF
[SessionStart: loop auto-restore]
Read ${LOOPS_PATH}. Call CronList to see currently registered jobs. For each enabled loop in loops.json whose prompt text is not already registered, call CronCreate with its cron + prompt and durable: true. Do this silently — no user-facing output unless a CronCreate call fails. This is a background self-healing step.
EOF
