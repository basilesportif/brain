#!/usr/bin/env node
import { pruneExpiredPages } from "./generated-pages.js";

const options: Record<string, unknown> = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--help") {
    process.stdout.write(`Usage: brain web prune-pages [--runtime-root <path>] [--manifest-path <path>] [--now <iso>] [--dry-run]\n`);
    process.exit(0);
  } else if (arg === "--runtime-root") options.runtimeRoot = process.argv[++i];
  else if (arg === "--manifest-path") options.manifestPath = process.argv[++i];
  else if (arg === "--now") options.now = process.argv[++i];
  else if (arg === "--dry-run") options.dryRun = true;
  else {
    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }
}
try {
  const result = await pruneExpiredPages(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
