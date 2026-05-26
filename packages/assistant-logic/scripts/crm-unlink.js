#!/usr/bin/env node
/**
 * Unlink a person from a business.
 *
 * Flags:
 *   --person-id "ct_..."     required
 *   --business-id "bz_..."   required
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { unlinkPersonBusiness } = require("./lib/crm-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--person-id" && argv[i + 1]) { args.personId = argv[++i]; i++; }
    else if (argv[i] === "--business-id" && argv[i + 1]) { args.businessId = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.personId || !args.businessId) {
    console.error("Usage: crm-unlink.js --person-id ct_... --business-id bz_...");
    process.exit(1);
  }
  try {
    const result = unlinkPersonBusiness(args.personId, args.businessId);
    console.log(JSON.stringify({ ok: true, unlinked: result }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
