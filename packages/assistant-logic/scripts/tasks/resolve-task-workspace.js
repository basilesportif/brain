#!/usr/bin/env node

const { resolveTaskWorkspace } = require("../lib/workspace");

function main() {
  const resolved = resolveTaskWorkspace({
    cwd: process.cwd(),
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
}

main();
