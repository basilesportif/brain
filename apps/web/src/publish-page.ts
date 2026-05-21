#!/usr/bin/env node
import { GeneratedPageError, publishPage } from "./generated-pages.js";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`Usage: brain web publish-page --dir <page-dir> [--id <id>] [--runtime-root <path>] [--manifest-path <path>] [--public-base-url <url>] [--ttl-hours <hours>] [--promoted] [--replace] [--dry-run]\n`);
  process.exit(0);
}
if (!args.sourceDir) throwCli("--dir is required");
try {
  const result = await publishPage(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  throwCli(error instanceof Error ? error.message : String(error));
}

function parseArgs(argv: string[]) {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") out.help = true;
    else if (arg === "--dir") out.sourceDir = argv[++i];
    else if (arg === "--id") out.id = argv[++i];
    else if (arg === "--title") out.title = argv[++i];
    else if (arg === "--runtime-root") out.runtimeRoot = argv[++i];
    else if (arg === "--manifest-path") out.manifestPath = argv[++i];
    else if (arg === "--public-base-url") out.publicBaseUrl = argv[++i];
    else if (arg === "--ttl-hours") out.ttlHours = Number(argv[++i]);
    else if (arg === "--promoted") out.promoted = true;
    else if (arg === "--replace") out.replace = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else throw new GeneratedPageError(`Unknown argument: ${arg}`);
  }
  return out as unknown as Parameters<typeof publishPage>[0] & { help?: boolean };
}
function throwCli(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
