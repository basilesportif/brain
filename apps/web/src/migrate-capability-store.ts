#!/usr/bin/env node
// Explicit capability-store migration command (NOT an endpoint, NOT auto-run).
// Drops the plan's placeholder subjects/grants/identities, converts retained
// non-enforcing grants to enforcing, backs up the pre-migration store, and
// writes atomically via the shared safe write path. Idempotent: a second run on
// an already-migrated store reports "nothing to do". --dry-run prints without
// writing.
//
// SAFETY: this is a cross-process writer. The Brain server serializes its own
// mutations with an in-process queue, but that queue cannot see this CLI. Do NOT
// run this migration while the Brain admin server may be writing the same store
// (stop the service, or run during a maintenance window); a concurrent server
// write is only caught by the store's content-hash check and will surface as a
// failure rather than a silent merge.
import { migrateCapabilityStore } from "./capability-store-write.js";

let storePath: string | undefined;
let dryRun = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--help") {
    process.stdout.write(
      `Usage: brain-web-migrate-capability-store --store <path> [--dry-run]\n` +
        `\nDo NOT run while the Brain admin server may be writing the same store.\n`,
    );
    process.exit(0);
  } else if (arg === "--store") storePath = process.argv[++i];
  else if (arg === "--dry-run") dryRun = true;
  else {
    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }
}

if (!storePath) {
  process.stderr.write(`--store <path> is required\n`);
  process.exit(1);
}

try {
  const result = await migrateCapabilityStore({ storePath, dryRun });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
